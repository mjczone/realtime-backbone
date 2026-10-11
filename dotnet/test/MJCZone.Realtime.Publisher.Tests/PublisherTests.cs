using System.Collections.Concurrent;
using System.Text.Json.Nodes;
using MJCZone.Realtime.Contract;
using MJCZone.Realtime.Publisher;

namespace MJCZone.Realtime.Publisher.Tests;

sealed class FakeTransport(Func<int, JsonObject, Task<(ulong?, string?)>> handler) : ICentrifugoTransport
{
    public readonly ConcurrentQueue<(string Channel, JsonObject Envelope, string Key)> Calls = new();
    private int _n;

    public Task<(ulong? Offset, string? Epoch)> PublishAsync(string channel, byte[] data, string key, CancellationToken ct)
    {
        var env = JsonNode.Parse(data)!.AsObject();
        Calls.Enqueue((channel, env, key));
        return handler(Interlocked.Increment(ref _n), env);
    }
}

public class PublisherTests
{
    private static readonly Task<(ulong?, string?)> Ok = Task.FromResult<(ulong?, string?)>((1UL, "e1"));

    private static RealtimePublisher Make(FakeTransport t, string? tenant = "acme", bool allowGlobal = false, int attempts = 8) =>
        new(new RealtimePublisherOptions
        {
            Source = "test",
            Tenant = tenant,
            AllowGlobal = allowGlobal,
            RetryAttempts = attempts,
            RetryBaseDelay = TimeSpan.FromMilliseconds(1),
            RetryMaxDelay = TimeSpan.FromMilliseconds(5),
        }, t);

    [Fact]
    public async Task SendsEnvelopeWithIdempotencyKey()
    {
        var t = new FakeTransport((_, _) => Ok);
        var r = await Make(t).PublishAsync("replay:t-acme.run.r1", "agui.RUN_STARTED", new { type = "RUN_STARTED" }, corr: "r1");
        Assert.Equal(1UL, r.Offset);
        Assert.Equal("e1", r.Epoch);
        var call = Assert.Single(t.Calls);
        Assert.Equal(r.Envelope.Id, call.Key);
        Assert.Equal("acme", (string?)call.Envelope["tenant"]);
        Assert.Equal("test", (string?)call.Envelope["source"]);
        Assert.Equal("r1", (string?)call.Envelope["corr"]);
        Assert.Null(Envelopes.Validate(call.Envelope));
    }

    [Fact]
    public async Task GuardDenies()
    {
        var t = new FakeTransport((_, _) => Ok);
        var e = await Assert.ThrowsAsync<TenantGuardException>(() => Make(t).PublishAsync("live:t-globex.x", "a.b", new { }));
        Assert.Equal(GuardReasons.TenantMismatch, e.Reason);
        await Assert.ThrowsAsync<TenantGuardException>(() => Make(t).PublishAsync("live:global.x", "a.b", new { }));
        await Assert.ThrowsAsync<TenantGuardException>(() => Make(t, tenant: null).PublishAsync("live:t-acme.x", "a.b", new { }));
        Assert.Empty(t.Calls);
        var r = await Make(t, allowGlobal: true).PublishAsync("live:global.x", "system.maintenance", new { });
        Assert.Equal("global", r.Envelope.Tenant);
        var g = await Make(t, tenant: null).ForTenant("globex").PublishAsync("live:t-globex.x", "a.b", new { });
        Assert.Equal("globex", g.Envelope.Tenant);
    }

    [Fact]
    public async Task RejectsTooLarge()
    {
        var t = new FakeTransport((_, _) => Ok);
        await Assert.ThrowsAsync<EnvelopeTooLargeException>(() => Make(t).PublishAsync("live:t-acme.x", "a.b", new { s = new string('x', 70000) }));
        Assert.Empty(t.Calls);
    }

    [Fact]
    public async Task RetriesTransientWithSameEnvelope()
    {
        var t = new FakeTransport((n, _) => n < 3 ? throw new PublishException("not available", true, 108) : Ok);
        await Make(t).PublishAsync("live:t-acme.x", "a.b", new { });
        Assert.Equal(3, t.Calls.Count);
        Assert.Single(t.Calls.Select(c => c.Key).Distinct());
    }

    [Fact]
    public async Task DoesNotRetryPermanent()
    {
        var t = new FakeTransport((_, _) => throw new PublishException("bad request", false, 107));
        await Assert.ThrowsAsync<PublishException>(() => Make(t).PublishAsync("live:t-acme.x", "a.b", new { }));
        Assert.Single(t.Calls);
    }

    [Fact]
    public async Task KeepsOrderOnOneChannelUnderFailures()
    {
        var inFlight = 0;
        var maxInFlight = 0;
        var t = new FakeTransport(async (_, _) =>
        {
            var now = Interlocked.Increment(ref inFlight);
            InterlockedMax(ref maxInFlight, now);
            await Task.Delay(Random.Shared.Next(0, 3));
            Interlocked.Decrement(ref inFlight);
            if (Random.Shared.NextDouble() < 0.3) throw new HttpRequestException("network down");
            return (1UL, "e1");
        });
        var p = Make(t, attempts: 50);
        await Task.WhenAll(Enumerable.Range(0, 60).Select(i => p.PublishAsync("live:t-acme.x", "a.b", new { i })));
        Assert.Equal(1, maxInFlight);
        var delivered = new List<int>();
        foreach (var c in t.Calls)
        {
            var i = (int)c.Envelope["data"]!["i"]!;
            if (delivered.Count == 0 || delivered[^1] != i) delivered.Add(i);
        }
        Assert.Equal(Enumerable.Range(0, 60), delivered);
    }

    [Fact]
    public async Task DifferentChannelsRunConcurrently()
    {
        var inFlight = 0;
        var maxInFlight = 0;
        var t = new FakeTransport(async (_, _) =>
        {
            InterlockedMax(ref maxInFlight, Interlocked.Increment(ref inFlight));
            await Task.Delay(20);
            Interlocked.Decrement(ref inFlight);
            return (1UL, "e1");
        });
        var p = Make(t);
        await Task.WhenAll(new[] { "a", "b", "c" }.Select(x => p.PublishAsync($"live:t-acme.{x}", "a.b", new { })));
        Assert.Equal(3, maxInFlight);
    }

    [Fact]
    public async Task FailedPublishDoesNotBlockTheNext()
    {
        var t = new FakeTransport((_, env) => env["data"]!["fail"] is not null ? throw new PublishException("x", false) : Ok);
        var p = Make(t);
        var a = p.PublishAsync("live:t-acme.x", "a.b", new { fail = true });
        var b = p.PublishAsync("live:t-acme.x", "a.b", new { });
        await Assert.ThrowsAsync<PublishException>(() => a);
        await b;
        await p.IdleAsync();
    }

    private static void InterlockedMax(ref int target, int value)
    {
        int current;
        while ((current = Volatile.Read(ref target)) < value && Interlocked.CompareExchange(ref target, value, current) != current) { }
    }
}

public class DeltaBatcherTests
{
    private static JsonObject E(string json) => JsonNode.Parse(json)!.AsObject();

    [Fact]
    public void JoinsDeltasAndFlushesOnOtherEvents()
    {
        var out_ = new List<string>();
        using var b = new DeltaBatcher(e => out_.Add(e.ToJsonString()), TimeSpan.FromSeconds(10));
        b.Push(E("""{"type":"TEXT_MESSAGE_START","messageId":"m"}"""));
        b.Push(E("""{"type":"TEXT_MESSAGE_CONTENT","messageId":"m","delta":"Hel"}"""));
        b.Push(E("""{"type":"TEXT_MESSAGE_CONTENT","messageId":"m","delta":"lo"}"""));
        b.Push(E("""{"type":"TOOL_CALL_ARGS","toolCallId":"t","delta":"{\"a\""}"""));
        b.Push(E("""{"type":"TOOL_CALL_ARGS","toolCallId":"t","delta":":1}"}"""));
        b.Push(E("""{"type":"TEXT_MESSAGE_END","messageId":"m"}"""));
        Assert.Equal(
        [
            """{"type":"TEXT_MESSAGE_START","messageId":"m"}""",
            """{"type":"TEXT_MESSAGE_CONTENT","messageId":"m","delta":"Hello"}""",
            new JsonObject { ["type"] = "TOOL_CALL_ARGS", ["toolCallId"] = "t", ["delta"] = "{\"a\":1}" }.ToJsonString(),
            """{"type":"TEXT_MESSAGE_END","messageId":"m"}""",
        ], out_);
    }

    [Fact]
    public async Task FlushesOnIntervalAndSize()
    {
        var out_ = new List<string?>();
        using var b = new DeltaBatcher(e => { lock (out_) out_.Add((string?)e["delta"]); }, TimeSpan.FromMilliseconds(10), maxBytes: 4);
        b.Push(E("""{"type":"TEXT_MESSAGE_CONTENT","messageId":"m","delta":"ab"}"""));
        b.Push(E("""{"type":"TEXT_MESSAGE_CONTENT","messageId":"m","delta":"cd"}"""));
        Assert.Equal(["abcd"], out_);
        b.Push(E("""{"type":"TEXT_MESSAGE_CONTENT","messageId":"m","delta":"e"}"""));
        await Task.Delay(100);
        lock (out_) Assert.Equal(["abcd", "e"], out_);
    }
}
