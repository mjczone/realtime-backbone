import { tryParseChannel } from './channel.js';

export interface TenantContext {
  tenant?: string;
  allowGlobal?: boolean;
}

export type GuardReason =
  | 'invalid_channel'
  | 'global_not_allowed'
  | 'no_tenant_context'
  | 'tenant_mismatch'
  | 'envelope_tenant_mismatch';

export type GuardResult = { allow: true } | { allow: false; reason: GuardReason };

export class TenantGuardError extends Error {
  constructor(
    readonly reason: GuardReason,
    readonly channel: string,
  ) {
    super(`Tenant guard denied publish to ${channel}: ${reason}`);
    this.name = 'TenantGuardError';
  }
}

export function checkTenant(context: TenantContext, channel: string, envelope: { tenant: string }): GuardResult {
  const c = tryParseChannel(channel);
  if (!c) return { allow: false, reason: 'invalid_channel' };
  if (c.tenant === 'global') {
    if (context.allowGlobal !== true) return { allow: false, reason: 'global_not_allowed' };
  } else {
    if (!context.tenant) return { allow: false, reason: 'no_tenant_context' };
    if (context.tenant !== c.tenant) return { allow: false, reason: 'tenant_mismatch' };
  }
  if (envelope.tenant !== c.tenant) return { allow: false, reason: 'envelope_tenant_mismatch' };
  return { allow: true };
}

export function assertTenant(context: TenantContext, channel: string, envelope: { tenant: string }): void {
  const r = checkTenant(context, channel, envelope);
  if (!r.allow) throw new TenantGuardError(r.reason, channel);
}
