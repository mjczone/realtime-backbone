using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.IdentityModel.JsonWebTokens;
using Microsoft.IdentityModel.Tokens;
using Rtb.Tokens;

namespace Rtb.Tokens.Tests;

public class SignerTests
{
    // A throwaway key; its kid was computed with jose's calculateJwkThumbprint in the TS SDK.
    private const string FixedJwk = """{"kty":"EC","x":"ovWaZluTB6WYLohUHcmnbudNEy8jh46NIOOCQiY3S1U","y":"ACZ1UWFUy8fVH_5KwwYS6sXRkUNYZUcnvQRjycy2EoA","crv":"P-256","d":"0h8LR1S7xSIGbVkWvDyEH2TCDky6gIi5GSHVLUH1rU8"}""";

    private static RealtimeTokenSigner Make(string? key = null, List<string>? extra = null) => new(new RealtimeTokenOptions
    {
        PrivateKey = key ?? RealtimeTokenSigner.GenerateSigningKey(),
        Audience = "rtb",
        Issuer = "test-app",
        AdditionalPublicKeys = extra ?? [],
    });

    internal static async Task<TokenValidationResult> Verify(string token, JsonObject jwks) =>
        await new JsonWebTokenHandler().ValidateTokenAsync(token, new TokenValidationParameters
        {
            ValidAudience = "rtb",
            ValidIssuer = "test-app",
            IssuerSigningKeys = new JsonWebKeySet(jwks.ToJsonString()).GetSigningKeys(),
            ValidAlgorithms = ["ES256"],
        });

    [Fact]
    public void KidMatchesTheTypeScriptSdk() => Assert.Equal("N_nsSsT9RsDYSt1iPHaEeVT53AveIoPiDBVxzRuVxuM", Make(FixedJwk).Kid);

    [Fact]
    public async Task ConnectionTokenVerifies()
    {
        using var s = Make();
        var token = s.MintConnectionToken("u1", info: new JsonObject { ["name"] = "Ann" });
        var r = await Verify(token, s.Jwks());
        Assert.True(r.IsValid, r.Exception?.Message);
        var jwt = (JsonWebToken)r.SecurityToken;
        Assert.Equal("u1", jwt.Subject);
        Assert.Equal(s.Kid, jwt.Kid);
        Assert.Equal(600, (jwt.ValidTo - jwt.IssuedAt).TotalSeconds);
        Assert.Contains("Ann", jwt.GetClaim("info").Value);
    }

    [Fact]
    public async Task SubscriptionTokenVerifies()
    {
        using var s = Make();
        var r = await Verify(s.MintSubscriptionToken("u1", "live:t-acme.x", TimeSpan.FromMinutes(1)), s.Jwks());
        Assert.True(r.IsValid);
        Assert.Equal("live:t-acme.x", ((JsonWebToken)r.SecurityToken).GetClaim("channel").Value);
    }

    [Fact]
    public async Task RotationPublishesTheOldKey()
    {
        var oldKey = RealtimeTokenSigner.GenerateSigningKey();
        using var oldSigner = Make(oldKey);
        using var newSigner = Make(extra: [oldKey]);
        var jwks = newSigner.Jwks();
        Assert.Equal(2, jwks["keys"]!.AsArray().Count);
        Assert.DoesNotContain("\"d\"", jwks.ToJsonString());
        Assert.True((await Verify(oldSigner.MintConnectionToken("u1"), jwks)).IsValid);
    }

    [Fact]
    public void AcceptsPem()
    {
        using var ec = System.Security.Cryptography.ECDsa.Create(System.Security.Cryptography.ECCurve.NamedCurves.nistP256);
        using var s = Make(ec.ExportPkcs8PrivateKeyPem());
        Assert.Matches("^[A-Za-z0-9_-]{43}$", s.Kid);
    }

    [Fact]
    public void RejectsOtherKeys() =>
        Assert.Throws<ArgumentException>(() => Make("""{"kty":"RSA","n":"x","e":"AQAB","d":"x"}"""));
}

public class EndpointTests : IAsyncLifetime
{
    private WebApplication _app = null!;
    private HttpClient _http = null!;
    private int _authorizeCalls;

    public async ValueTask InitializeAsync()
    {
        var builder = WebApplication.CreateBuilder();
        builder.WebHost.UseTestServer();
        builder.Services.AddRealtimeTokens(o =>
        {
            o.PrivateKey = RealtimeTokenSigner.GenerateSigningKey();
            o.Audience = "rtb";
            o.Issuer = "test-app";
        });
        _app = builder.Build();
        _app.MapRealtimeTokenEndpoints(new RealtimeTokenEndpointOptions
        {
            Authenticate = ctx => ValueTask.FromResult(ctx.Request.Headers["x-user"].ToString() is { Length: > 0 } u ? new TokenUser(u, "acme") : null),
            Authorize = (_, channel, _) =>
            {
                Interlocked.Increment(ref _authorizeCalls);
                return ValueTask.FromResult(!channel.Contains("secret"));
            },
        });
        await _app.StartAsync();
        _http = _app.GetTestClient();
        _http.DefaultRequestHeaders.Add("x-user", "u1");
    }

    public async ValueTask DisposeAsync() => await _app.DisposeAsync();

    private Task<HttpResponseMessage> Sub(object? channel) => _http.PostAsJsonAsync("/api/token/subscription", new { channel });

    [Fact]
    public async Task MintsAndVerifies()
    {
        var conn = await (await _http.PostAsync("/api/token/connection", null)).Content.ReadFromJsonAsync<JsonObject>();
        var jwks = JsonNode.Parse(await _http.GetStringAsync(TokenEndpointExtensions.JwksPath))!.AsObject();
        Assert.True((await SignerTests.Verify((string)conn!["token"]!, jwks)).IsValid);

        for (var i = 0; i < 3; i++) Assert.Equal(HttpStatusCode.OK, (await Sub("replay:t-acme.run.r1")).StatusCode);
        Assert.Equal(1, _authorizeCalls);
    }

    [Fact]
    public async Task ChecksBeforeTheAuthorizer()
    {
        Assert.Equal(HttpStatusCode.BadRequest, (await Sub("live:t-acme.a.b.c")).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await Sub(42)).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await Sub("live:t-acme.user#u1")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await Sub("live:t-globex.x")).StatusCode);
        Assert.Equal(0, _authorizeCalls);
        Assert.Equal(HttpStatusCode.Forbidden, (await Sub("live:t-acme.secret")).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await Sub("live:global.maintenance")).StatusCode);
        Assert.Equal(2, _authorizeCalls);
    }

    [Fact]
    public async Task Requires401WithoutUser()
    {
        using var anon = _app.GetTestClient();
        Assert.Equal(HttpStatusCode.Unauthorized, (await anon.PostAsync("/api/token/connection", null)).StatusCode);
    }
}
