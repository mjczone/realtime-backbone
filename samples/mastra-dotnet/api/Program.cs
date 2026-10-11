// The app's .NET REST API: users, tasks, threads, and the realtime token endpoints.
// The Mastra agent service (../agent) runs the agent and calls this API for everything the app owns.
using System.Collections.Concurrent;
using System.Security.Claims;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.IdentityModel.Tokens;
using Rtb.Contract;
using Rtb.Publisher;
using Rtb.Tokens;

string Env(string key, string fallback) => Environment.GetEnvironmentVariable(key) is { Length: > 0 } v ? v : fallback;

const string Tenant = "acme";
const string AppAudience = "mdn-app";
const string AppIssuer = "mdn-api";
var internalKey = Env("MDN_INTERNAL_KEY", "dev-internal-key");
// Gateway mode: publish through rtb-gateway with a plain HTTP POST, and the page gets realtime tokens and runs there.
var gatewayUrl = Env("RTB_GATEWAY_URL", "");
var gatewayPublicUrl = Env("RTB_PUBLIC_GATEWAY_URL", gatewayUrl);
var gatewayKey = Env("RTB_GATEWAY_KEY", "");

// Dev only: this signer stands in for the app's identity provider. It issues the access tokens that both this API
// and the agent service accept. A real app uses its IdP, and both services validate the IdP's tokens.
var appTokens = new RealtimeTokenSigner(new RealtimeTokenOptions
{
    PrivateKey = RealtimeTokenSigner.GenerateSigningKey(),
    Audience = AppAudience,
    Issuer = AppIssuer,
    ConnectionTtl = TimeSpan.FromHours(8),
});

var builder = WebApplication.CreateBuilder(args);
builder.WebHost.UseUrls($"http://0.0.0.0:{Env("PORT", "3010")}");
builder.Logging.AddFilter("Microsoft.AspNetCore", LogLevel.Warning);
builder.Services.AddRealtimePublisher(o =>
{
    o.Address = Env("RTB_GRPC_ADDRESS", "http://backbone:10000");
    o.ApiKey = Env("RTB_GRPC_KEY", "dev-grpc-key");
    o.Source = "mdn-api";
});
// Dev only: signs realtime tokens with the dev stack's key, so the dev stack's JWKS already covers them.
builder.Services.AddRealtimeTokens(o =>
{
    o.PrivateKey = File.ReadAllText(Env("RTB_DEV_KEY_FILE", "../../../.data/keys/signing.jwk"));
    o.Audience = Env("RTB_TOKEN_AUDIENCE", "realtime-backbone-dev");
    o.Issuer = Env("RTB_TOKEN_ISSUER", "rtb-demo");
    o.AuthorizeCacheTtl = TimeSpan.Zero;
});
builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme).AddJwtBearer(o =>
{
    o.MapInboundClaims = false;
    o.TokenValidationParameters = new TokenValidationParameters
    {
        ValidAudience = AppAudience,
        ValidIssuer = AppIssuer,
        IssuerSigningKeys = new JsonWebKeySet(appTokens.Jwks().ToJsonString()).GetSigningKeys(),
        ValidAlgorithms = ["ES256"],
    };
});
builder.Services.AddAuthorization();
var app = builder.Build();
app.UseAuthentication();
app.UseAuthorization();
var web = Path.GetFullPath(Env("RTB_WEB_DIR", "../web/public"));
var publisher = app.Services.GetRequiredService<IRealtimePublisher>().ForTenant(Tenant);
var http = new HttpClient();

async Task Publish(string channel, string type, object data)
{
    if (gatewayUrl == "")
    {
        await publisher.PublishAsync(channel, type, data);
        return;
    }
    using var req = new HttpRequestMessage(HttpMethod.Post, $"{gatewayUrl}/v1/publish") { Content = JsonContent.Create(new { channel, type, data }) };
    req.Headers.Authorization = new("Bearer", gatewayKey);
    (await http.SendAsync(req)).EnsureSuccessStatusCode();
}

// The app's own stores. A real app keeps these in its database.
var tasks = new ConcurrentDictionary<string, TaskItem>();
var threads = new ConcurrentDictionary<string, ThreadRecord>();
var runOwners = new ConcurrentDictionary<string, string>();

string UserId(ClaimsPrincipal user) => user.FindFirstValue("sub")!;

// ---- Dev login and the public keys the agent service validates access tokens with ----

app.MapPost("/api/login", (LoginRequest body) =>
{
    if (!Channel.IsValidUserId(body.UserId ?? "")) return Results.BadRequest(new { error = "userId must be [A-Za-z0-9_-]{1,128}" });
    var token = appTokens.MintConnectionToken(body.UserId!, info: new JsonObject { ["tenant"] = Tenant, ["name"] = body.UserId });
    return Results.Json(new { accessToken = token, userId = body.UserId, tenant = Tenant });
});
app.MapGet("/.well-known/app-jwks.json", () => Results.Text(appTokens.Jwks().ToJsonString(), "application/json"));

// ---- Realtime tokens: the browser asks this API, which knows the user and who owns which run ----

app.MapRealtimeTokenEndpoints(new RealtimeTokenEndpointOptions
{
    Prefix = "/api/realtime",
    Authenticate = async ctx =>
    {
        var result = await ctx.AuthenticateAsync();
        return result.Succeeded ? new TokenUser(UserId(result.Principal!), Tenant, new JsonObject { ["name"] = UserId(result.Principal!) }) : null;
    },
    Authorize = (user, _, parsed) =>
        ValueTask.FromResult(parsed.Topic != "run" || runOwners.GetValueOrDefault(parsed.Id!) == user.UserId),
});

// ---- The app's REST API ----

var api = app.MapGroup("/api").RequireAuthorization();

api.MapGet("/config", () => new
{
    backboneUrl = Env("RTB_PUBLIC_BACKBONE_URL", "http://localhost:8000"),
    agentUrl = Env("MDN_PUBLIC_AGENT_URL", "http://localhost:3011"),
    gatewayUrl = gatewayPublicUrl == "" ? null : gatewayPublicUrl,
    tenant = Tenant,
}).AllowAnonymous();

api.MapGet("/tasks", () => tasks.Values.OrderBy(t => t.Created));

api.MapPost("/tasks", async (NewTask body, ClaimsPrincipal user) =>
{
    if (string.IsNullOrWhiteSpace(body.Title)) return Results.BadRequest(new { error = "title is required" });
    var task = new TaskItem(Ulid.NewId(), body.Title.Trim(), UserId(user), DateTime.UtcNow);
    tasks[task.Id] = task;
    // Tell every open page to refetch. The event carries the ID, not the record.
    await Publish(Channels.Record(Tenant, "tasks"), "entity.changed", new { entity = "task", id = task.Id, op = "created" });
    return Results.Json(task, statusCode: 201);
});

api.MapDelete("/tasks", async () =>
{
    var count = tasks.Count;
    tasks.Clear();
    await Publish(Channels.Record(Tenant, "tasks"), "entity.changed", new { entity = "task", id = "*", op = "deleted" });
    return Results.Json(new { deleted = count });
});

api.MapGet("/threads/{threadId}", (string threadId, ClaimsPrincipal user) =>
{
    var found = threads.TryGetValue(threadId, out var t) && t.Owner == UserId(user);
    return Results.Text(new JsonObject { ["messages"] = found ? t!.Messages.DeepClone() : new JsonArray() }.ToJsonString(), "application/json");
});

// ---- Internal: the agent service records runs and threads here (service to service) ----

var internalApi = app.MapGroup("/internal").AddEndpointFilter(async (ctx, next) =>
    ctx.HttpContext.Request.Headers["x-internal-key"] == internalKey ? await next(ctx) : Results.Unauthorized());

internalApi.MapPost("/runs", (RunCreated body) =>
{
    if (threads.TryGetValue(body.ThreadId, out var existing) && existing.Owner != body.UserId) return Results.Forbid();
    runOwners[body.RunId] = body.UserId;
    threads[body.ThreadId] = new ThreadRecord(body.UserId, body.Messages);
    return Results.NoContent();
});

internalApi.MapPost("/runs/{runId}/finished", (string runId, RunFinished body) =>
{
    if (runOwners.ContainsKey(runId) && threads.TryGetValue(body.ThreadId, out var t))
        lock (t.Messages) foreach (var m in body.Messages) t.Messages.Add(m?.DeepClone());
    return Results.NoContent();
});

app.MapGet("/healthz", () => "ok");
app.MapGet("/", () => Results.File(Path.Combine(web, "index.html"), "text/html"));
app.MapGet("/app.js", () => Results.File(Path.Combine(web, gatewayUrl == "" ? "app.js" : "gateway.js"), "text/javascript"));

app.Run();

record LoginRequest(string? UserId);
record NewTask(string? Title);
record TaskItem(string Id, string Title, string CreatedBy, DateTime Created);
record ThreadRecord(string Owner, JsonArray Messages);
record RunCreated(string RunId, string ThreadId, string UserId, JsonArray Messages);
record RunFinished(string ThreadId, JsonArray Messages);
