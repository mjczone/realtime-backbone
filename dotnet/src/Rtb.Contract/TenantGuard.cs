namespace Rtb.Contract;

public sealed record TenantContext(string? Tenant = null, bool AllowGlobal = false);

public static class GuardReasons
{
    public const string InvalidChannel = "invalid_channel";
    public const string GlobalNotAllowed = "global_not_allowed";
    public const string NoTenantContext = "no_tenant_context";
    public const string TenantMismatch = "tenant_mismatch";
    public const string EnvelopeTenantMismatch = "envelope_tenant_mismatch";
}

public sealed record GuardResult(bool Allow, string? Reason = null)
{
    public static readonly GuardResult Allowed = new(true);
}

public sealed class TenantGuardException(string reason, string channel)
    : Exception($"Tenant guard denied publish to {channel}: {reason}")
{
    public string Reason { get; } = reason;
    public string Channel { get; } = channel;
}

public static class TenantGuard
{
    public static GuardResult Check(TenantContext context, string channel, string envelopeTenant)
    {
        var c = Channel.TryParse(channel);
        if (c is null) return new(false, GuardReasons.InvalidChannel);
        if (c.IsGlobal)
        {
            if (!context.AllowGlobal) return new(false, GuardReasons.GlobalNotAllowed);
        }
        else
        {
            if (string.IsNullOrEmpty(context.Tenant)) return new(false, GuardReasons.NoTenantContext);
            if (context.Tenant != c.Tenant) return new(false, GuardReasons.TenantMismatch);
        }
        if (envelopeTenant != c.Tenant) return new(false, GuardReasons.EnvelopeTenantMismatch);
        return GuardResult.Allowed;
    }

    public static void Assert(TenantContext context, string channel, string envelopeTenant)
    {
        var r = Check(context, channel, envelopeTenant);
        if (!r.Allow) throw new TenantGuardException(r.Reason!, channel);
    }
}
