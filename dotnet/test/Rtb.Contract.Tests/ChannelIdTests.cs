using System.Text.Json.Nodes;
using Rtb.Contract;

namespace Rtb.Contract.Tests;

public class ChannelIdTests
{
    private static readonly JsonObject Ids =
        JsonNode.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "vectors", "ids.json")))!.AsObject();

    public static TheoryData<string, string> RoundTrips() =>
        new(Ids["roundtrip"]!.AsArray().Select(v => ((string)v!["key"]!, (string)v["id"]!)));

    public static TheoryData<string> EncodeErrors() => new(Ids["encodeErrors"]!.AsArray().Select(v => (string)v!["key"]!));

    public static TheoryData<string> DecodeErrors() => new(Ids["decodeErrors"]!.AsArray().Select(v => (string)v!["id"]!));

    [Theory]
    [MemberData(nameof(RoundTrips))]
    public void RoundTrip(string key, string id)
    {
        Assert.Equal(id, ChannelId.Encode(key));
        Assert.Equal(key, ChannelId.Decode(id));
    }

    [Theory]
    [MemberData(nameof(EncodeErrors))]
    public void EncodeRejects(string key) => Assert.Throws<ArgumentException>(() => ChannelId.Encode(key));

    [Theory]
    [MemberData(nameof(DecodeErrors))]
    public void DecodeRejects(string id) => Assert.Throws<ArgumentException>(() => ChannelId.Decode(id));

    [Fact]
    public void RejectsALoneSurrogate() => Assert.Throws<ArgumentException>(() => ChannelId.Encode("a\uD800"));

    [Fact]
    public void AnEncodedIdFitsAChannel()
    {
        Assert.True(Channel.IsValid($"live:t-acme.quotes.{ChannelId.Encode("BRK.B")}"));
        Assert.True(Channel.IsValid($"live:t-acme.user#{ChannelId.Encode("auth0|42")}"));
    }
}
