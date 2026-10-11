using System.Text.Json;
using System.Text.Json.Nodes;
using MJCZone.Realtime.Contract;

namespace MJCZone.Realtime.Contract.Tests;

public class VectorTests
{
    private static JsonArray Load(string name) =>
        JsonNode.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "vectors", name)))!.AsArray();

    public static TheoryData<string> Files(string name) => new(Load(name).Select(v => v!.ToJsonString()));

    [Theory]
    [MemberData(nameof(Files), "channels.valid.json")]
    public void ValidChannelsParse(string json)
    {
        var v = JsonNode.Parse(json)!;
        var c = Channel.TryParse(v["name"]!.GetValue<string>());
        Assert.NotNull(c);
        var p = v["parsed"]!;
        Assert.Equal(p["tier"]!.GetValue<string>(), c.Tier);
        Assert.Equal(p["tenant"]!.GetValue<string>(), c.Tenant);
        Assert.Equal(p["topic"]!.GetValue<string>(), c.Topic);
        Assert.Equal(p["id"]?.GetValue<string>(), c.Id);
        Assert.Equal(p["userId"]?.GetValue<string>(), c.UserId);
    }

    [Theory]
    [MemberData(nameof(Files), "channels.invalid.json")]
    public void InvalidChannelsFail(string json) =>
        Assert.Null(Channel.TryParse(JsonNode.Parse(json)!["name"]!.GetValue<string>()));

    [Theory]
    [MemberData(nameof(Files), "envelopes.valid.json")]
    public void ValidEnvelopes(string json) => Assert.Null(Envelopes.Validate(JsonNode.Parse(json)!["envelope"]));

    [Theory]
    [MemberData(nameof(Files), "envelopes.invalid.json")]
    public void InvalidEnvelopes(string json) => Assert.NotNull(Envelopes.Validate(JsonNode.Parse(json)!["envelope"]));

    [Theory]
    [MemberData(nameof(Files), "guard.json")]
    public void Guard(string json)
    {
        var v = JsonNode.Parse(json)!;
        var ctx = v["context"]!;
        var context = new TenantContext(ctx["tenant"]?.GetValue<string>(), ctx["allowGlobal"]?.GetValue<bool>() ?? false);
        var r = TenantGuard.Check(context, v["channel"]!.GetValue<string>(), v["envelopeTenant"]!.GetValue<string>());
        Assert.Equal(v["allow"]!.GetValue<bool>(), r.Allow);
        Assert.Equal(v["reason"]?.GetValue<string>(), r.Reason);
    }
}

public class ContractTests
{
    [Fact]
    public void BuildersMakeEveryForm()
    {
        Assert.Equal("live:global.maintenance", Channels.Global("maintenance"));
        Assert.Equal("live:t-acme.all", Channels.TenantAll("acme"));
        Assert.Equal("live:t-acme.jobs.01JB7Q", Channels.Record("acme", "jobs", "01JB7Q"));
        Assert.Equal("live:t-acme.grp.ops", Channels.Group("acme", "ops"));
        Assert.Equal("replay:t-acme.user#u1", Channels.User("acme", "u1", "replay"));
        Assert.Equal("replay:t-acme.run.r1", Channels.Run("acme", "r1"));
        Assert.Equal("presence:t-acme.doc.881", Channels.Presence("acme", "doc", "881"));
    }

    [Theory]
    [InlineData("ac.me", "jobs", null)]
    [InlineData("acme", "jobs.1", null)]
    [InlineData("acme", "all", "1")]
    [InlineData("global", "x", null)]
    public void BuildersRejectBadParts(string tenant, string topic, string? id) =>
        Assert.Throws<ArgumentException>(() => Channels.Record(tenant, topic, id));

    [Fact]
    public void CreateFillsFields()
    {
        var e = Envelopes.Create("job.progress", "acme", "w1", new { jobId = "j", pct = 5 }, corr: "c1");
        Assert.Equal(1, e.V);
        Assert.Matches("^[0-9A-HJKMNP-TV-Z]{26}$", e.Id);
        Assert.EndsWith("Z", e.Ts);
        Assert.Equal(5, e.Data["pct"]!.GetValue<int>());
        var json = JsonSerializer.SerializeToNode(e)!;
        Assert.Null(Envelopes.Validate(json));
        Assert.Equal("c1", json["corr"]!.GetValue<string>());
        Assert.False(JsonSerializer.SerializeToNode(Envelopes.Create("a.b", "t", "s", new { }))!.AsObject().ContainsKey("corr"));
    }

    [Fact]
    public void UlidsAreMonotonic()
    {
        var ids = Enumerable.Range(0, 5000).Select(_ => Ulid.NewId()).ToList();
        Assert.Equal(ids.Order(StringComparer.Ordinal), ids);
        Assert.Equal(ids.Count, ids.Distinct().Count());
    }

    [Fact]
    public void CreateRejectsBadInput()
    {
        Assert.Throws<ArgumentException>(() => Envelopes.Create("nofamily", "acme", "w", new { }));
        Assert.Throws<ArgumentException>(() => Envelopes.Create("a.b", "acme", "w", new[] { 1 }));
    }

    [Fact]
    public void ByteSizeCountsUtf8()
    {
        var e = Envelopes.Create("a.b", "t", "s", new { s = new string('é', Envelopes.MaxBytes / 2) });
        Assert.True(Envelopes.ByteSize(e) > Envelopes.MaxBytes);
    }
}
