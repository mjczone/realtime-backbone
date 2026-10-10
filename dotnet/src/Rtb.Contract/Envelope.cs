using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace Rtb.Contract;

public sealed record Envelope
{
    [JsonPropertyName("v")] public int V { get; init; } = 1;
    [JsonPropertyName("id")] public required string Id { get; init; }
    [JsonPropertyName("type")] public required string Type { get; init; }
    [JsonPropertyName("tenant")] public required string Tenant { get; init; }
    [JsonPropertyName("source")] public required string Source { get; init; }
    [JsonPropertyName("ts")] public required string Ts { get; init; }

    [JsonPropertyName("corr")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Corr { get; init; }

    [JsonPropertyName("data")] public required JsonObject Data { get; init; }
}

public static partial class Envelopes
{
    public const int MaxBytes = 65536;
    public static readonly IReadOnlyList<string> ReservedFamilies = ["agui", "job", "entity", "notice", "system"];

    [GeneratedRegex("^[0-9A-HJKMNP-TV-Z]{26}$")]
    private static partial Regex UlidPattern();

    [GeneratedRegex(@"^[a-z][a-z0-9]*\.[A-Za-z0-9_.]+$")]
    private static partial Regex TypePattern();

    [GeneratedRegex("^[A-Za-z0-9_-]{1,64}$")]
    private static partial Regex TenantPattern();

    [GeneratedRegex(@"^[A-Za-z0-9_.-]{1,128}$")]
    private static partial Regex SourcePattern();

    [GeneratedRegex(@"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?Z$")]
    private static partial Regex TsPattern();

    /// <summary>Builds an envelope. <paramref name="data"/> is any value that serializes to a JSON object.</summary>
    public static Envelope Create(string type, string tenant, string source, object data, string? corr = null)
    {
        var obj = data as JsonObject
            ?? JsonSerializer.SerializeToNode(data, data.GetType(), JsonSerializerOptions.Web) as JsonObject
            ?? throw new ArgumentException("data must serialize to a JSON object", nameof(data));
        var env = new Envelope
        {
            Id = Ulid.NewId(),
            Type = type,
            Tenant = tenant,
            Source = source,
            Ts = DateTime.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'"),
            Corr = corr,
            Data = obj,
        };
        var problem = Validate(JsonSerializer.SerializeToNode(env));
        if (problem is not null) throw new ArgumentException($"Invalid envelope: {problem}");
        return env;
    }

    /// <summary>Returns why the JSON is not a valid envelope, or null when it is. Unknown fields are ignored.</summary>
    public static string? Validate(JsonNode? node)
    {
        if (node is not JsonObject o) return "not an object";
        if (!IsNumber(o["v"], 1)) return "v must be 1";
        if (!Matches(o["id"], UlidPattern())) return "id must be a ULID";
        if (!Matches(o["type"], TypePattern()) || Str(o["type"])!.Length > 128) return "type must be <family>.<name>";
        if (!Matches(o["tenant"], TenantPattern())) return "tenant is invalid";
        if (!Matches(o["source"], SourcePattern())) return "source is invalid";
        if (!Matches(o["ts"], TsPattern())) return "ts must be RFC 3339 UTC";
        if (o.ContainsKey("corr") && Str(o["corr"]) is not { Length: >= 1 and <= 256 }) return "corr must be a string of 1 to 256 characters";
        if (o["data"] is not JsonObject) return "data must be an object";
        return null;
    }

    public static int ByteSize(Envelope env) => Encoding.UTF8.GetByteCount(JsonSerializer.Serialize(env));

    private static string? Str(JsonNode? n) =>
        n is JsonValue v && v.GetValueKind() == JsonValueKind.String ? v.GetValue<string>() : null;

    private static bool Matches(JsonNode? n, Regex re) => Str(n) is { } s && re.IsMatch(s);

    private static bool IsNumber(JsonNode? n, int expected) =>
        n is JsonValue v && v.GetValueKind() == JsonValueKind.Number && v.TryGetValue(out double d) && d == expected;
}
