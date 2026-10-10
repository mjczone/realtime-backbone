using System.Net.Http.Json;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json.Nodes;
using Rtb.Contract;
using Rtb.Publisher;

namespace Rtb.IntegrationTests;

/// <summary>Fails some requests before they reach Centrifugo and loses some responses after.</summary>
sealed class FlakyTransport(ICentrifugoTransport inner) : ICentrifugoTransport
{
    private int _n;

    public async Task<(ulong? Offset, string? Epoch)> PublishAsync(string channel, byte[] data, string key, CancellationToken ct)
    {
        var n = Interlocked.Increment(ref _n);
        if (n % 4 == 1) throw new HttpRequestException("lost before send");
        var r = await inner.PublishAsync(channel, data, key, ct);
        if (n % 4 == 2) throw new HttpRequestException("lost after send");
        return r;
    }
}

/// <summary>A tiny Centrifugo JSON-protocol client, enough to prove tokens are accepted.</summary>
sealed class RawClient(ClientWebSocket ws) : IAsyncDisposable
{
    private int _id;

    public static async Task<RawClient> ConnectAsync(string url)
    {
        var ws = new ClientWebSocket();
        await ws.ConnectAsync(new Uri(url), CancellationToken.None);
        return new RawClient(ws);
    }

    public async Task<JsonObject> SendAsync(string method, JsonObject body)
    {
        var id = ++_id;
        var cmd = new JsonObject { ["id"] = id, [method] = body };
        await ws.SendAsync(Encoding.UTF8.GetBytes(cmd.ToJsonString()), WebSocketMessageType.Text, true, CancellationToken.None);
        while (true)
        {
            foreach (var msg in await ReceiveAsync())
                if ((int?)msg["id"] == id) return msg;
        }
    }

    public async Task<List<JsonObject>> ReceiveAsync()
    {
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var buffer = new byte[64 * 1024];
        var sb = new StringBuilder();
        WebSocketReceiveResult r;
        do
        {
            r = await ws.ReceiveAsync(buffer, cts.Token);
            sb.Append(Encoding.UTF8.GetString(buffer, 0, r.Count));
        } while (!r.EndOfMessage);
        return sb.ToString().Split('\n', StringSplitOptions.RemoveEmptyEntries).Select(l => JsonNode.Parse(l)!.AsObject()).ToList();
    }

    public WebSocketState State => ws.State;

    public async ValueTask DisposeAsync()
    {
        try { await ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "", CancellationToken.None); } catch { }
        ws.Dispose();
    }
}

public class BackboneTests(BackboneFixture f) : IClassFixture<BackboneFixture>
{
    private RealtimePublisher Publisher(ICentrifugoTransport? transport = null, string key = BackboneFixture.GrpcKey)
    {
        var options = new RealtimePublisherOptions
        {
            Address = f.GrpcAddress,
            ApiKey = key,
            Source = "it-dotnet",
            Tenant = "acme",
            RetryAttempts = 10,
            RetryBaseDelay = TimeSpan.FromMilliseconds(1),
            RetryMaxDelay = TimeSpan.FromMilliseconds(5),
        };
        return new RealtimePublisher(options, transport ?? new GrpcTransport(options));
    }

    private async Task<JsonArray> History(string channel)
    {
        using var http = new HttpClient();
        http.DefaultRequestHeaders.Add("X-API-Key", BackboneFixture.ApiKey);
        var res = await http.PostAsJsonAsync($"{f.ApiUrl}/history", new { channel, limit = 1000 });
        return (await res.Content.ReadFromJsonAsync<JsonObject>())!["result"]!["publications"]!.AsArray();
    }

    [Fact]
    public async Task PublishesOverGrpcAndReturnsThePosition()
    {
        var channel = Channels.Run("acme", Ulid.NewId());
        var r = await Publisher().PublishAsync(channel, "agui.RUN_STARTED", new { type = "RUN_STARTED" });
        Assert.Equal(1UL, r.Offset);
        Assert.False(string.IsNullOrEmpty(r.Epoch));
        var pub = Assert.Single(await History(channel));
        Assert.Null(Envelopes.Validate(pub!["data"]));
        Assert.Equal(r.Envelope.Id, (string?)pub["data"]!["id"]);
    }

    [Fact]
    public async Task LiveChannelsHaveNoPosition()
    {
        var r = await Publisher().PublishAsync(Channels.Record("acme", "jobs", "1"), "job.progress", new { jobId = "1", pct = 5 });
        Assert.Null(r.Offset);
    }

    [Fact]
    public async Task KeepsOrderWithNoDuplicatesUnderInjectedFailures()
    {
        var options = new RealtimePublisherOptions { Address = f.GrpcAddress, ApiKey = BackboneFixture.GrpcKey };
        var p = Publisher(new FlakyTransport(new GrpcTransport(options)));
        var channel = Channels.Run("acme", Ulid.NewId());
        await Task.WhenAll(Enumerable.Range(0, 40).Select(i => p.PublishAsync(channel, "job.progress", new { jobId = "j", pct = i })));
        var pcts = (await History(channel)).Select(x => (int)x!["data"]!["data"]!["pct"]!).ToList();
        Assert.Equal(Enumerable.Range(0, 40), pcts);
    }

    [Fact]
    public async Task WrongKeyFailsWithoutRetrying()
    {
        var e = await Assert.ThrowsAsync<PublishException>(() => Publisher(key: "wrong").PublishAsync("live:t-acme.x", "a.b", new { }));
        Assert.False(e.Transient);
    }

    [Fact]
    public async Task CentrifugoAcceptsDotnetTokensAndRecoversFromOffsetMinusOne()
    {
        var channel = Channels.Run("acme", Ulid.NewId());
        var p = Publisher();
        var first = await p.PublishAsync(channel, "agui.RUN_STARTED", new { type = "RUN_STARTED" });
        await p.PublishAsync(channel, "agui.RUN_FINISHED", new { type = "RUN_FINISHED" });

        await using var c = await RawClient.ConnectAsync(f.WsUrl);
        var conn = await c.SendAsync("connect", new JsonObject { ["token"] = f.Signer.MintConnectionToken("u1") });
        Assert.Null(conn["error"]);
        var sub = await c.SendAsync("subscribe", new JsonObject
        {
            ["channel"] = channel,
            ["token"] = f.Signer.MintSubscriptionToken("u1", channel),
            ["recover"] = true,
            ["epoch"] = first.Epoch,
            ["offset"] = first.Offset!.Value - 1,
        });
        Assert.Null(sub["error"]);
        Assert.True((bool?)sub["subscribe"]!["recovered"]);
        var types = sub["subscribe"]!["publications"]!.AsArray().Select(x => (string)x!["data"]!["type"]!).ToList();
        Assert.Equal(["agui.RUN_STARTED", "agui.RUN_FINISHED"], types);
    }

    [Fact]
    public async Task RejectsASubscriptionTokenForAnotherChannel()
    {
        await using var c = await RawClient.ConnectAsync(f.WsUrl);
        await c.SendAsync("connect", new JsonObject { ["token"] = f.Signer.MintConnectionToken("u1") });
        // Centrifugo answers a token for the wrong channel with an error or by closing the connection.
        try
        {
            var sub = await c.SendAsync("subscribe", new JsonObject
            {
                ["channel"] = "live:t-acme.secret",
                ["token"] = f.Signer.MintSubscriptionToken("u1", "live:t-acme.other"),
            });
            Assert.NotNull(sub["error"]);
        }
        catch (WebSocketException)
        {
            Assert.Equal(WebSocketState.CloseReceived, c.State);
        }
    }
}
