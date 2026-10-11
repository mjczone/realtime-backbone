using System.Collections.Concurrent;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using MJCZone.Realtime.Contract;

namespace MJCZone.Realtime.Tokens;

/// <summary>The caller, as the app's own auth sees them.</summary>
public sealed record TokenUser(string UserId, string Tenant, JsonObject? Info = null);

public sealed class RealtimeTokenEndpointOptions
{
    /// <summary>Who is calling. Return null for 401. This is the app's own session or auth check.</summary>
    public required Func<HttpContext, ValueTask<TokenUser?>> Authenticate { get; init; }

    /// <summary>
    /// May this user subscribe to this channel? Runs after the built-in checks: the channel parses,
    /// its tenant is the user's tenant (or it is global), and it is not a user (#) channel.
    /// </summary>
    public required Func<TokenUser, string, ParsedChannel, ValueTask<bool>> Authorize { get; init; }

    /// <summary>Route prefix for POST {prefix}/connection and POST {prefix}/subscription.</summary>
    public string Prefix { get; init; } = "/api/token";
}

public static class TokenEndpointExtensions
{
    public const string JwksPath = "/.well-known/rtb-jwks.json";

    public static IServiceCollection AddRealtimeTokens(this IServiceCollection services, Action<RealtimeTokenOptions> configure)
    {
        services.AddOptions<RealtimeTokenOptions>().Configure(configure);
        services.AddSingleton(sp => new RealtimeTokenSigner(sp.GetRequiredService<IOptions<RealtimeTokenOptions>>().Value));
        return services;
    }

    public static IServiceCollection AddRealtimeTokens(this IServiceCollection services, IConfiguration section)
    {
        services.AddOptions<RealtimeTokenOptions>().Bind(section);
        services.AddSingleton(sp => new RealtimeTokenSigner(sp.GetRequiredService<IOptions<RealtimeTokenOptions>>().Value));
        return services;
    }

    /// <summary>Maps the connection and subscription token endpoints and the JWKS endpoint.</summary>
    public static IEndpointRouteBuilder MapRealtimeTokenEndpoints(this IEndpointRouteBuilder app, RealtimeTokenEndpointOptions endpoint)
    {
        var signer = app.ServiceProvider.GetRequiredService<RealtimeTokenSigner>();
        var options = app.ServiceProvider.GetRequiredService<IOptions<RealtimeTokenOptions>>().Value;
        var allowed = new ConcurrentDictionary<string, DateTime>();

        app.MapGet(JwksPath, (HttpContext ctx) =>
        {
            ctx.Response.Headers.CacheControl = "public, max-age=300";
            return Results.Text(signer.Jwks().ToJsonString(), "application/json");
        });

        app.MapPost($"{endpoint.Prefix}/connection", async (HttpContext ctx) =>
        {
            var user = await endpoint.Authenticate(ctx);
            if (user is null) return Error(401, "unauthenticated");
            return Results.Json(new { token = signer.MintConnectionToken(user.UserId, info: user.Info) });
        });

        app.MapPost($"{endpoint.Prefix}/subscription", async (HttpContext ctx) =>
        {
            var user = await endpoint.Authenticate(ctx);
            if (user is null) return Error(401, "unauthenticated");
            string? channel;
            try
            {
                var body = await JsonNode.ParseAsync(ctx.Request.Body);
                channel = body?["channel"] is JsonValue v && v.GetValueKind() == JsonValueKind.String ? v.GetValue<string>() : null;
            }
            catch (JsonException)
            {
                return Error(400, "body must be JSON with a channel");
            }
            var parsed = Channel.TryParse(channel);
            if (parsed is null) return Error(400, "invalid channel");
            if (parsed.UserId is not null) return Error(400, "user channels use the connection token");
            if (!parsed.IsGlobal && parsed.Tenant != user.Tenant) return Error(403, "forbidden");

            var key = $"{user.UserId}\0{user.Tenant}\0{channel}";
            var cached = allowed.TryGetValue(key, out var until) && until > DateTime.UtcNow;
            if (!cached)
            {
                if (!await endpoint.Authorize(user, channel!, parsed)) return Error(403, "forbidden");
                if (options.AuthorizeCacheTtl > TimeSpan.Zero)
                {
                    if (allowed.Count > 10000) allowed.Clear();
                    allowed[key] = DateTime.UtcNow + options.AuthorizeCacheTtl;
                }
            }
            return Results.Json(new { token = signer.MintSubscriptionToken(user.UserId, channel!) });
        });

        return app;
    }

    private static IResult Error(int status, string message) => Results.Json(new { error = message }, statusCode: status);
}
