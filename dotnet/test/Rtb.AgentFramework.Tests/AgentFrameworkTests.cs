using System.Collections.Concurrent;
using System.Net;
using System.Net.Http.Json;
using System.Runtime.CompilerServices;
using System.Text.Json.Nodes;
using AGUI.Abstractions;
using Microsoft.Agents.AI;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.AI;
using Microsoft.Extensions.DependencyInjection;
using Rtb.AgentFramework;
using Rtb.Publisher;
using Rtb.Tokens;

namespace Rtb.AgentFramework.Tests;

/// <summary>First call asks for get_weather, second call streams the answer word by word.</summary>
sealed class ScriptedChatClient(string answer = "It is sunny in Paris.", int delayMs = 0) : IChatClient
{
    public async IAsyncEnumerable<ChatResponseUpdate> GetStreamingResponseAsync(
        IEnumerable<ChatMessage> messages, ChatOptions? options = null, [EnumeratorCancellation] CancellationToken ct = default)
    {
        var id = Guid.NewGuid().ToString("N");
        if (!messages.Any(m => m.Contents.OfType<FunctionResultContent>().Any()))
        {
            yield return new ChatResponseUpdate(ChatRole.Assistant,
                [new FunctionCallContent("call_1", "get_weather", new Dictionary<string, object?> { ["city"] = "Paris" })]) { MessageId = id };
            yield break;
        }
        foreach (var w in answer.Split(' '))
        {
            await Task.Delay(delayMs, ct);
            yield return new ChatResponseUpdate(ChatRole.Assistant, w + " ") { MessageId = id };
        }
    }

    public async Task<ChatResponse> GetResponseAsync(IEnumerable<ChatMessage> m, ChatOptions? o = null, CancellationToken ct = default)
    {
        var l = new List<ChatResponseUpdate>();
        await foreach (var u in GetStreamingResponseAsync(m, o, ct)) l.Add(u);
        return l.ToChatResponse();
    }

    public object? GetService(Type t, object? key = null) => null;
    public void Dispose() { }
}

sealed class RecordingTransport : ICentrifugoTransport
{
    public readonly ConcurrentQueue<(string Channel, JsonObject Envelope)> Calls = new();
    private ulong _offset;

    public Task<(ulong? Offset, string? Epoch)> PublishAsync(string channel, byte[] data, string key, CancellationToken ct)
    {
        Calls.Enqueue((channel, JsonNode.Parse(data)!.AsObject()));
        return Task.FromResult<(ulong?, string?)>((Interlocked.Increment(ref _offset), "e1"));
    }

    public List<string> Types => Calls.Select(c => (string)c.Envelope["type"]!).ToList();
}

static class Fixtures
{
    public static IAgUiEventSource Agent(string answer = "It is sunny in Paris.", int delayMs = 0) =>
        new AIAgentEventSource(new ChatClientAgent(new ScriptedChatClient(answer, delayMs), new ChatClientAgentOptions
        {
            Name = "weather",
            ChatOptions = new ChatOptions { Tools = [AIFunctionFactory.Create((string city) => $"sunny in {city}", "get_weather")] },
        }));

    public static RunAgentInput Input(string threadId = "th1") => new()
    {
        ThreadId = threadId,
        Messages = [new AGUIUserMessage { Id = "u1", Content = "Weather in Paris?" }],
    };

    public static RealtimePublisher Publisher(RecordingTransport t) =>
        new(new RealtimePublisherOptions { Source = "maf", Tenant = "acme" }, t);
}

public class AgentRunnerTests
{
    [Fact]
    public async Task PublishesOneRunStartedAndTheAgentEvents()
    {
        var t = new RecordingTransport();
        SinkResult? finished = null;
        var (runRef, done) = await AgentRunner.StartRunAsync(new StartRunOptions
        {
            Publisher = Fixtures.Publisher(t),
            Agent = Fixtures.Agent(),
            Input = Fixtures.Input(),
            UserId = "u1",
            OnRunFinished = (_, r) => { finished = r; return Task.CompletedTask; },
        });
        await done;
        Assert.Equal($"replay:t-acme.run.{runRef.RunId}", runRef.Channel);
        Assert.Equal(1UL, runRef.Offset);
        Assert.Equal(
        [
            "agui.RUN_STARTED", "agui.TOOL_CALL_START", "agui.TOOL_CALL_ARGS", "agui.TOOL_CALL_END", "agui.TOOL_CALL_RESULT",
            "agui.TEXT_MESSAGE_START", "agui.TEXT_MESSAGE_CONTENT", "agui.TEXT_MESSAGE_END", "agui.RUN_FINISHED",
        ], t.Types);
        var events = t.Calls.Select(c => c.Envelope["data"]!).ToList();
        Assert.Equal(runRef.RunId, (string?)events[0]["runId"]);
        Assert.Equal("th1", (string?)events[0]["threadId"]);
        Assert.Equal("It is sunny in Paris. ", (string?)events[6]["delta"]);
        Assert.Equal(runRef.RunId, (string?)events[^1]["runId"]);
        Assert.All(t.Calls, c => Assert.Equal(runRef.Channel, c.Channel));
        Assert.NotNull(finished);
        Assert.Null(finished!.Error);
        Assert.Equal(8, finished.Events.Count);
    }

    [Fact]
    public async Task NotifyUserPublishesTheNotice()
    {
        var t = new RecordingTransport();
        var (runRef, done) = await AgentRunner.StartRunAsync(new StartRunOptions
        {
            Publisher = Fixtures.Publisher(t), Agent = Fixtures.Agent(), Input = Fixtures.Input(), UserId = "u1", NotifyUser = true,
        });
        await done;
        var notice = t.Calls.Single(c => (string)c.Envelope["type"]! == "notice.run_started");
        Assert.Equal("live:t-acme.user#u1", notice.Channel);
        var d = notice.Envelope["data"]!;
        Assert.Equal(runRef.RunId, (string?)d["runId"]);
        Assert.Equal(runRef.Channel, (string?)d["channel"]);
        Assert.Equal(1, (int)d["offset"]!);
        Assert.Equal("e1", (string?)d["epoch"]);
    }

    [Fact]
    public async Task CancelPublishesRunError()
    {
        var t = new RecordingTransport();
        using var cts = new CancellationTokenSource();
        var (_, done) = await AgentRunner.StartRunAsync(new StartRunOptions
        {
            Publisher = Fixtures.Publisher(t), Agent = Fixtures.Agent(string.Join(' ', Enumerable.Repeat("word", 200)), 20),
            Input = Fixtures.Input(), UserId = "u1",
        }, cts.Token);
        await Task.Delay(300);
        await cts.CancelAsync();
        await done;
        var last = t.Calls.Last().Envelope["data"]!;
        Assert.Equal("RUN_ERROR", (string?)last["type"]);
        Assert.Equal("rtb.cancelled", (string?)last["code"]);
        Assert.DoesNotContain("agui.RUN_FINISHED", t.Types);
    }
}

public class SinkTests
{
    private static async IAsyncEnumerable<BaseEvent> Events(params BaseEvent[] events)
    {
        foreach (var e in events) yield return e;
        await Task.CompletedTask;
    }

    private static async IAsyncEnumerable<BaseEvent> Failing()
    {
        yield return new TextMessageStartEvent { MessageId = "m" };
        await Task.CompletedTask;
        throw new InvalidOperationException("model down");
    }

    [Fact]
    public async Task FailureBecomesRunError()
    {
        var t = new RecordingTransport();
        var r = await AgUiSink.PublishRunAsync(Fixtures.Publisher(t), "replay:t-acme.run.r1", "r1", Failing());
        Assert.Equal("model down", r.Error!.Message);
        var last = t.Calls.Last().Envelope["data"]!;
        Assert.Equal("rtb.agent_error", (string?)last["code"]);
    }

    [Fact]
    public async Task OversizeBecomesAMarker()
    {
        var t = new RecordingTransport();
        var big = new StateSnapshotEvent { Snapshot = System.Text.Json.JsonSerializer.SerializeToElement(new { blob = new string('x', 70000) }) };
        await AgUiSink.PublishRunAsync(Fixtures.Publisher(t), "replay:t-acme.run.r1", "r1",
            Events(big, new RunFinishedEvent { ThreadId = "t", RunId = "r1" }));
        var first = t.Calls.First().Envelope["data"]!;
        Assert.Equal("rtb.oversize", (string?)first["name"]);
        Assert.Equal("STATE_SNAPSHOT", (string?)first["value"]!["type"]);
        Assert.Equal("agui.RUN_FINISHED", t.Types[1]);
    }
}

public class EndpointTests : IAsyncLifetime
{
    private WebApplication _app = null!;
    private readonly RecordingTransport _transport = new();

    public async ValueTask InitializeAsync()
    {
        var builder = WebApplication.CreateBuilder();
        builder.WebHost.UseTestServer();
        builder.Services.AddSingleton<IRealtimePublisher>(new RealtimePublisher(new RealtimePublisherOptions { Source = "maf" }, _transport));
        builder.Services.AddRealtimeTokens(o =>
        {
            o.PrivateKey = RealtimeTokenSigner.GenerateSigningKey();
            o.Audience = "a";
            o.Issuer = "i";
        });
        _app = builder.Build();
        _app.MapAgentRunEndpoints(new AgentRunEndpointOptions
        {
            Authenticate = ctx => ValueTask.FromResult(ctx.Request.Headers["x-user"].ToString() is { Length: > 0 } u ? new TokenUser(u, "acme") : null),
            Agent = (_, _) => Fixtures.Agent(string.Join(' ', Enumerable.Repeat("word", 200)), 20),
        });
        await _app.StartAsync();
    }

    public async ValueTask DisposeAsync() => await _app.DisposeAsync();

    private HttpClient Client(string? user)
    {
        var c = _app.GetTestClient();
        if (user is not null) c.DefaultRequestHeaders.Add("x-user", user);
        return c;
    }

    [Fact]
    public async Task RunReturns202AndOnlyTheOwnerCanCancel()
    {
        var body = new { threadId = "th1", messages = new[] { new { id = "u1", role = "user", content = "hi" } } };
        Assert.Equal(HttpStatusCode.Unauthorized, (await Client(null).PostAsJsonAsync("/api/run", body)).StatusCode);
        var res = await Client("u1").PostAsJsonAsync("/api/run", body);
        Assert.Equal(HttpStatusCode.Accepted, res.StatusCode);
        var r = (await res.Content.ReadFromJsonAsync<JsonObject>())!;
        Assert.Equal("th1", (string?)r["threadId"]);
        Assert.Equal(1, (int)r["offset"]!);
        Assert.False(string.IsNullOrEmpty((string?)r["token"]));
        var runId = (string)r["runId"]!;
        Assert.Equal(HttpStatusCode.NotFound, (await Client("u2").PostAsync($"/api/run/{runId}/cancel", null)).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await Client("u1").PostAsync($"/api/run/{runId}/cancel", null)).StatusCode);
        for (var i = 0; i < 50 && !_transport.Types.Contains("agui.RUN_ERROR"); i++) await Task.Delay(50);
        Assert.Equal("rtb.cancelled", (string?)_transport.Calls.Last().Envelope["data"]!["code"]);
    }
}
