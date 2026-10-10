using System.Text.RegularExpressions;

namespace Rtb.Contract;

/// <summary>A parsed channel name. Tenant is the literal "global" for global channels.</summary>
public sealed record ParsedChannel(string Tier, string Tenant, string Topic, string? Id = null, string? UserId = null)
{
    public bool IsGlobal => Tenant == "global";
}

public static partial class Channel
{
    public const int MaxLength = 255;
    public static readonly IReadOnlyList<string> Tiers = ["live", "replay", "presence"];
    public static readonly IReadOnlyList<string> ReservedTopics = ["all", "grp", "user", "run"];

    [GeneratedRegex("^[A-Za-z0-9_-]+$")]
    private static partial Regex Segment();

    [GeneratedRegex("^[A-Za-z0-9_-]{1,64}$")]
    private static partial Regex TenantPattern();

    [GeneratedRegex("^[A-Za-z0-9_-]{1,128}$")]
    private static partial Regex UserIdPattern();

    public static bool IsValidTenant(string tenant) => TenantPattern().IsMatch(tenant) && tenant != "global";

    public static bool IsValidUserId(string userId) => UserIdPattern().IsMatch(userId);

    public static ParsedChannel? TryParse(string? name)
    {
        if (name is null || name.Length > MaxLength) return null;
        var colon = name.IndexOf(':');
        if (colon < 0) return null;
        var tier = name[..colon];
        if (!Tiers.Contains(tier)) return null;
        var rest = name[(colon + 1)..];

        if (rest.StartsWith("global.", StringComparison.Ordinal))
        {
            if (tier == "presence") return null;
            var parts = rest["global.".Length..].Split('.');
            if (parts.Length > 2 || !parts.All(p => Segment().IsMatch(p))) return null;
            if (ReservedTopics.Contains(parts[0])) return null;
            return new ParsedChannel(tier, "global", parts[0], parts.Length == 2 ? parts[1] : null);
        }

        if (!rest.StartsWith("t-", StringComparison.Ordinal)) return null;
        var dot = rest.IndexOf('.');
        if (dot < 0) return null;
        var tenant = rest[2..dot];
        if (!IsValidTenant(tenant)) return null;
        var tail = rest[(dot + 1)..];

        if (tail.StartsWith("user#", StringComparison.Ordinal))
        {
            var userId = tail["user#".Length..];
            if (tier == "presence" || !IsValidUserId(userId)) return null;
            return new ParsedChannel(tier, tenant, "user", UserId: userId);
        }

        var segs = tail.Split('.');
        if (segs.Length > 2 || !segs.All(p => Segment().IsMatch(p))) return null;
        var topic = segs[0];
        var id = segs.Length == 2 ? segs[1] : null;
        switch (topic)
        {
            case "all" when id is not null || tier == "presence":
            case "grp" or "run" when id is null:
            case "user":
                return null;
        }
        return new ParsedChannel(tier, tenant, topic, id);
    }

    public static ParsedChannel Parse(string name) =>
        TryParse(name) ?? throw new ArgumentException($"Invalid channel name: \"{name}\"", nameof(name));

    public static bool IsValid(string? name) => TryParse(name) is not null;
}

/// <summary>Builders per audience. They throw on any input that would not parse back to the same parts.</summary>
public static class Channels
{
    public static string Global(string topic, string? id = null, string tier = "live") =>
        Build($"{tier}:global.{topic}{Suffix(id)}", "global", topic, id);

    public static string TenantAll(string tenant, string tier = "live") => Build($"{tier}:t-{tenant}.all", tenant, "all");

    public static string Record(string tenant, string topic, string? id = null, string tier = "live") =>
        Build($"{tier}:t-{tenant}.{topic}{Suffix(id)}", tenant, topic, id);

    public static string Group(string tenant, string group, string tier = "live") =>
        Build($"{tier}:t-{tenant}.grp.{group}", tenant, "grp", group);

    public static string User(string tenant, string userId, string tier = "live") =>
        Build($"{tier}:t-{tenant}.user#{userId}", tenant, "user", userId: userId);

    public static string Run(string tenant, string runId) => Build($"replay:t-{tenant}.run.{runId}", tenant, "run", runId);

    public static string Presence(string tenant, string topic, string? id = null) =>
        Build($"presence:t-{tenant}.{topic}{Suffix(id)}", tenant, topic, id);

    private static string Suffix(string? id) => id is null ? "" : $".{id}";

    private static string Build(string name, string tenant, string topic, string? id = null, string? userId = null)
    {
        var c = Channel.Parse(name);
        if (c.Tenant != tenant || c.Topic != topic || c.Id != id || c.UserId != userId)
            throw new ArgumentException($"Invalid channel parts for \"{name}\"");
        return name;
    }
}
