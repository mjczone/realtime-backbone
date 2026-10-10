import { describe, expect, it } from 'vitest';
import { Channels, MAX_ENVELOPE_BYTES, assertTenant, createEnvelope, envelopeBytes, TenantGuardError } from '../src/index.js';

describe('Channels', () => {
  it('builds every form', () => {
    expect(Channels.global('maintenance')).toBe('live:global.maintenance');
    expect(Channels.tenantAll('acme')).toBe('live:t-acme.all');
    expect(Channels.record('acme', 'jobs', '01JB7Q')).toBe('live:t-acme.jobs.01JB7Q');
    expect(Channels.group('acme', 'ops')).toBe('live:t-acme.grp.ops');
    expect(Channels.user('acme', 'u1', 'replay')).toBe('replay:t-acme.user#u1');
    expect(Channels.run('acme', 'r1')).toBe('replay:t-acme.run.r1');
    expect(Channels.presence('acme', 'doc', '881')).toBe('presence:t-acme.doc.881');
  });

  it('throws on bad input', () => {
    expect(() => Channels.record('ac.me', 'jobs')).toThrow();
    expect(() => Channels.record('acme', 'all', '1')).toThrow();
    expect(() => Channels.user('acme', 'u1', 'presence')).toThrow();
    expect(() => Channels.tenantAll('global')).toThrow();
    expect(() => Channels.record('acme', 'jobs.1')).toThrow();
    expect(() => Channels.global('x', 'y.z')).toThrow();
    expect(() => Channels.group('acme', 'a.b')).toThrow();
  });
});

describe('createEnvelope', () => {
  it('fills v, id and ts', () => {
    const e = createEnvelope({ type: 'job.progress', tenant: 'acme', source: 'w1', data: { pct: 1 } });
    expect(e.v).toBe(1);
    expect(e.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(e.ts).toMatch(/Z$/);
    expect(e).not.toHaveProperty('corr');
  });

  it('ids are monotonic', () => {
    const ids = Array.from({ length: 1000 }, () => createEnvelope({ type: 'a.b', tenant: 't', source: 's', data: {} }).id);
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('rejects a bad type', () => {
    expect(() => createEnvelope({ type: 'nofamily', tenant: 'acme', source: 'w', data: {} })).toThrow();
  });

  it('measures UTF-8 bytes', () => {
    const e = createEnvelope({ type: 'a.b', tenant: 't', source: 's', data: { s: 'é'.repeat(MAX_ENVELOPE_BYTES / 2) } });
    expect(envelopeBytes(e)).toBeGreaterThan(MAX_ENVELOPE_BYTES);
  });
});

describe('assertTenant', () => {
  it('throws a TenantGuardError with the reason', () => {
    try {
      assertTenant({ tenant: 'acme' }, 'live:t-globex.x', { tenant: 'globex' });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(TenantGuardError);
      expect((e as TenantGuardError).reason).toBe('tenant_mismatch');
    }
  });
});
