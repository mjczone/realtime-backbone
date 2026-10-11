from dataclasses import dataclass

from .channel import try_parse_channel

INVALID_CHANNEL = "invalid_channel"
GLOBAL_NOT_ALLOWED = "global_not_allowed"
NO_TENANT_CONTEXT = "no_tenant_context"
TENANT_MISMATCH = "tenant_mismatch"
ENVELOPE_TENANT_MISMATCH = "envelope_tenant_mismatch"


@dataclass(frozen=True)
class TenantContext:
    tenant: str | None = None
    allow_global: bool = False


@dataclass(frozen=True)
class GuardResult:
    allow: bool
    reason: str | None = None


class TenantGuardError(Exception):
    def __init__(self, reason: str, channel: str):
        super().__init__(f"Tenant guard denied publish to {channel}: {reason}")
        self.reason = reason
        self.channel = channel


def check_tenant(context: TenantContext, channel: str, envelope_tenant: str) -> GuardResult:
    c = try_parse_channel(channel)
    if c is None:
        return GuardResult(False, INVALID_CHANNEL)
    if c.is_global:
        if not context.allow_global:
            return GuardResult(False, GLOBAL_NOT_ALLOWED)
    else:
        if not context.tenant:
            return GuardResult(False, NO_TENANT_CONTEXT)
        if context.tenant != c.tenant:
            return GuardResult(False, TENANT_MISMATCH)
    if envelope_tenant != c.tenant:
        return GuardResult(False, ENVELOPE_TENANT_MISMATCH)
    return GuardResult(True)


def assert_tenant(context: TenantContext, channel: str, envelope_tenant: str) -> None:
    r = check_tenant(context, channel, envelope_tenant)
    if not r.allow:
        raise TenantGuardError(r.reason or "", channel)
