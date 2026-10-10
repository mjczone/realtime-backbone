using System.Collections.Concurrent;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.Json.Nodes;
using AGUI.Abstractions;
using Microsoft.Agents.AI;
using Microsoft.Extensions.AI;
using Rtb.AgentFramework;
using Rtb.Publisher;
using Rtb.Tokens;

const string Tenant = "demo";
string Env(string key, string fallback) => Environment.GetEnvironmentVariable(key) is { Length: > 0 } v ? v : fallback;

var builder = WebApplication.CreateBuilder(args);
builder.WebHost.UseUrls($"http://0.0.0.0:{Env("PORT", "3002")}");
builder.Services.AddRealtimePublisher(o =>
{
    o.Address = Env("RTB_GRPC_ADDRESS", "http://backbone:10000");
    o.ApiKey = Env("RTB_GRPC_KEY", "dev-grpc-key");
    o.Source = "maf-chat";
});
// Dev only: the samples sign with the demo's dev key, so the dev stack's JWKS already covers them.
builder.Services.AddRealtimeTokens(o =>
{
    o.PrivateKey = File.ReadAllText(Env("RTB_DEV_KEY_FILE", "../../.data/keys/signing.jwk"));
    o.Audience = Env("RTB_TOKEN_AUDIENCE", "realtime-backbone-dev");
    o.Issuer = Env("RTB_TOKEN_ISSUER", "rtb-demo");
    o.AuthorizeCacheTtl = TimeSpan.Zero;
});
var app = builder.Build();
var web = Path.GetFullPath(Env("RTB_WEB_DIR", "../chat-web/public"));

// Dev only: the caller says who they are. A real app uses its own auth.
ValueTask<TokenUser?> Authenticate(HttpContext ctx)
{
    var id = ctx.Request.Headers["x-demo-user"].ToString();
    var ok = id.Length is > 0 and <= 64 && id.All(c => char.IsAsciiLetterOrDigit(c) || c is '_' or '-');
    return ValueTask.FromResult(ok ? new TokenUser(id, Tenant, new JsonObject { ["name"] = id }) : null);
}

// The app's own stores. A real app keeps these in its database.
var threads = new ConcurrentDictionary<string, (string Owner, JsonArray Messages)>();
var runOwners = new ConcurrentDictionary<string, string>();

Task OnRunCreated(RunInfo run)
{
    runOwners[run.RunId] = run.UserId;
    if (threads.TryGetValue(run.ThreadId, out var t) && t.Owner != run.UserId) throw new InvalidOperationException("not your thread");
    var messages = JsonSerializer.SerializeToNode(run.Input.Messages, AGUIJsonSerializerContext.Default.IListAGUIMessage)!.AsArray();
    threads[run.ThreadId] = (run.UserId, messages);
    return Task.CompletedTask;
}

Task OnRunFinished(RunInfo run, SinkResult result)
{
    if (threads.TryGetValue(run.ThreadId, out var t))
        lock (t.Messages) foreach (var m in Messages.FromEvents(result.Events)) t.Messages.Add(m);
    return Task.CompletedTask;
}

IAgUiEventSource Agent() => new AIAgentEventSource(new ChatClientAgent(new ScriptedChatClient(), new ChatClientAgentOptions
{
    Name = "weather",
    ChatOptions = new ChatOptions
    {
        Tools = [AIFunctionFactory.Create((string city) =>
        {
            var w = Weather.For(city);
            return new { city = w.City, forecast = w.Forecast, celsius = w.Celsius };
        }, "getWeather", "Current weather for a city")],
    },
}));

app.MapGet("/healthz", () => "ok");
app.MapGet("/", () => Results.File(Path.Combine(web, "index.html"), "text/html"));
app.MapGet("/app.js", () => Results.File(Path.Combine(web, "app.js"), "text/javascript"));
app.MapGet("/api/config", () => new { backboneUrl = Env("RTB_PUBLIC_BACKBONE_URL", "http://localhost:8000"), tenant = Tenant, agentName = "a Microsoft Agent Framework agent" });
app.MapRealtimeTokenEndpoints(new RealtimeTokenEndpointOptions
{
    Authenticate = Authenticate,
    Authorize = (user, _, parsed) => ValueTask.FromResult(parsed.Topic != "run" || runOwners.GetValueOrDefault(parsed.Id!) == user.UserId),
});
app.MapGet("/api/threads/{threadId}", async (HttpContext ctx, string threadId) =>
{
    var user = await Authenticate(ctx);
    if (user is null) return Results.Json(new { error = "unauthenticated" }, statusCode: 401);
    var found = threads.TryGetValue(threadId, out var t) && t.Owner == user.UserId;
    return Results.Text(new JsonObject { ["messages"] = found ? t.Messages.DeepClone() : new JsonArray() }.ToJsonString(), "application/json");
});
app.MapAgentRunEndpoints(new AgentRunEndpointOptions
{
    Authenticate = Authenticate,
    Agent = (_, _) => Agent(),
    NotifyUser = true,
    OnRunCreated = OnRunCreated,
    OnRunFinished = OnRunFinished,
});

// A run nobody started from this page: the user hears about it on their own channel.
app.MapPost("/api/background-run", async (HttpContext ctx, IRealtimePublisher publisher) =>
{
    var user = await Authenticate(ctx);
    if (user is null) return Results.Json(new { error = "unauthenticated" }, statusCode: 401);
    var body = (await JsonNode.ParseAsync(ctx.Request.Body))!;
    var threadId = (string)body["threadId"]!;
    var messages = threads.TryGetValue(threadId, out var t) && t.Owner == user.UserId ? t.Messages.DeepClone().AsArray() : new JsonArray();
    messages.Add(new JsonObject { ["id"] = Guid.NewGuid().ToString(), ["role"] = "user", ["content"] = (string)body["prompt"]! });
    var input = new JsonObject { ["threadId"] = threadId, ["runId"] = "", ["messages"] = messages }
        .Deserialize(AGUIJsonSerializerContext.Default.RunAgentInput)!;
    var (runRef, _) = await AgentRunner.StartRunAsync(new StartRunOptions
    {
        Publisher = publisher.ForTenant(Tenant),
        Agent = Agent(),
        Input = input,
        UserId = user.UserId,
        NotifyUser = true,
        OnRunCreated = OnRunCreated,
        OnRunFinished = OnRunFinished,
    });
    return Results.Json(runRef, statusCode: 202);
});

app.Run();

/// <summary>
/// Stands in for a model: finds the city in the last question, calls getWeather with it, then streams an answer
/// word by word. Without a city it asks for one. The sample needs no key.
/// </summary>
sealed class ScriptedChatClient : IChatClient
{
    private const string Tail =
        "This answer comes from a scripted model, so the sample runs without an API key. Each word is a separate " +
        "delta from the model. The sink batches them, publishes them to the run channel, and every open tab sees " +
        "the same text. Reload the page while it types and it picks up where it left off.";

    public async IAsyncEnumerable<ChatResponseUpdate> GetStreamingResponseAsync(
        IEnumerable<ChatMessage> messages, ChatOptions? options = null, [EnumeratorCancellation] CancellationToken ct = default)
    {
        var list = messages.ToList();
        var id = Guid.NewGuid().ToString("N");
        var city = Weather.CityFrom(list.LastOrDefault(m => m.Role == ChatRole.User)?.Text ?? "");
        await Task.Delay(200, ct);
        string answer;
        if (city is null)
        {
            answer = $"Ask me about the weather in a city, for example: what is the weather in Lisbon? {Tail}";
        }
        else if (!list.Last().Contents.OfType<FunctionResultContent>().Any())
        {
            yield return new ChatResponseUpdate(ChatRole.Assistant,
                [new FunctionCallContent($"call_{id}", "getWeather", new Dictionary<string, object?> { ["city"] = city })]) { MessageId = id };
            yield break;
        }
        else
        {
            var w = Weather.For(city);
            answer = $"The forecast says it is {w.Forecast} in {w.City} today, {w.Celsius} degrees. {Tail}";
        }
        foreach (var word in answer.Split(' '))
        {
            await Task.Delay(60, ct);
            yield return new ChatResponseUpdate(ChatRole.Assistant, word + " ") { MessageId = id };
        }
    }

    public async Task<ChatResponse> GetResponseAsync(IEnumerable<ChatMessage> m, ChatOptions? o = null, CancellationToken ct = default)
    {
        var updates = new List<ChatResponseUpdate>();
        await foreach (var u in GetStreamingResponseAsync(m, o, ct)) updates.Add(u);
        return updates.ToChatResponse();
    }

    public object? GetService(Type serviceType, object? key = null) => null;
    public void Dispose() { }
}

static class Weather
{
    public sealed record Report(string City, string Forecast, int Celsius);

    private static readonly string[] Forecasts = ["sunny", "cloudy", "rainy", "windy"];

    /// <summary>The city after the last "in" in the question: "What is the weather in new york?" gives "New York".</summary>
    public static string? CityFrom(string question)
    {
        var matches = System.Text.RegularExpressions.Regex.Matches(question, @"\bin\s+([A-Za-z][A-Za-z .'-]*)",
            System.Text.RegularExpressions.RegexOptions.IgnoreCase);
        if (matches.Count == 0) return null;
        var raw = System.Text.RegularExpressions.Regex.Replace(matches[^1].Groups[1].Value.Trim(), @"[\s.'-]+$", "");
        if (raw.Length == 0) return null;
        return string.Join(' ', raw.Split(' ', StringSplitOptions.RemoveEmptyEntries)
            .Select(w => char.ToUpperInvariant(w[0]) + w[1..].ToLowerInvariant()));
    }

    /// <summary>Made-up weather that is always the same for the same city.</summary>
    public static Report For(string city)
    {
        var sum = city.ToLowerInvariant().Where(c => c is >= 'a' and <= 'z').Sum(c => c);
        return new Report(city, Forecasts[sum % 4], 5 + sum % 25);
    }
}

static class Messages
{
    /// <summary>Turns a run's AG-UI events into AG-UI messages for the thread store.</summary>
    public static List<JsonObject> FromEvents(IEnumerable<JsonObject> events)
    {
        var output = new List<JsonObject>();
        var byId = new Dictionary<string, JsonObject>();
        foreach (var e in events)
        {
            switch ((string?)e["type"])
            {
                case "TEXT_MESSAGE_START":
                    var m = new JsonObject { ["id"] = (string?)e["messageId"], ["role"] = "assistant", ["content"] = "" };
                    byId[(string)e["messageId"]!] = m;
                    output.Add(m);
                    break;
                case "TEXT_MESSAGE_CONTENT":
                    var msg = byId[(string)e["messageId"]!];
                    msg["content"] = (string?)msg["content"] + (string?)e["delta"];
                    break;
                case "TOOL_CALL_START":
                    var parentId = (string?)e["parentMessageId"] ?? (string)e["toolCallId"]!;
                    if (!byId.TryGetValue(parentId, out var parent))
                    {
                        parent = new JsonObject { ["id"] = parentId, ["role"] = "assistant" };
                        byId[parentId] = parent;
                        output.Add(parent);
                    }
                    var call = new JsonObject
                    {
                        ["id"] = (string?)e["toolCallId"], ["type"] = "function",
                        ["function"] = new JsonObject { ["name"] = (string?)e["toolCallName"], ["arguments"] = "" },
                    };
                    ((JsonArray)(parent["toolCalls"] ??= new JsonArray())).Add(call);
                    byId[$"call:{e["toolCallId"]}"] = call;
                    break;
                case "TOOL_CALL_ARGS":
                    var fn = byId[$"call:{e["toolCallId"]}"]["function"]!;
                    fn["arguments"] = (string?)fn["arguments"] + (string?)e["delta"];
                    break;
                case "TOOL_CALL_RESULT":
                    output.Add(new JsonObject
                    {
                        ["id"] = (string?)e["messageId"], ["role"] = "tool", ["toolCallId"] = (string?)e["toolCallId"], ["content"] = (string?)e["content"],
                    });
                    break;
            }
        }
        return output;
    }
}
