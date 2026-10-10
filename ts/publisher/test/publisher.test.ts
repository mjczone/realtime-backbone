import { describe, expect, it, vi } from 'vitest';
import { TenantGuardError } from '@rtb/contract';
import { DeltaBatcher, EnvelopeTooLargeError, PublishError, createPublisher, type AuditEntry } from '../src/index.js';

interface Call {
  channel: string;
  data: { id: string; type: string; tenant: string; data: Record<string, unknown> };
  idempotency_key: string;
}

function fakeApi(handler: (call: Call, n: number) => Promise<Response> | Response) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const call = JSON.parse(init!.body as string) as Call;
    calls.push(call);
    return handler(call, calls.length);
  });
  return { calls, fetch: fetch as unknown as typeof globalThis.fetch };
}

const ok = (offset = 1) => Response.json({ result: { offset, epoch: 'e1' } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function make(fetch: typeof globalThis.fetch, extra = {}) {
  const audit: AuditEntry[] = [];
  const p = createPublisher({
    apiUrl: 'http://cf/api',
    apiKey: 'k',
    source: 'test',
    tenant: 'acme',
    fetch,
    audit: (e) => audit.push(e),
    retry: { baseMs: 1, maxMs: 5 },
    ...extra,
  });
  return { p, audit };
}

describe('publish', () => {
  it('sends the envelope with the idempotency key and returns the position', async () => {
    const api = fakeApi(() => ok(7));
    const { p, audit } = make(api.fetch);
    const r = await p.publish('replay:t-acme.run.r1', 'agui.RUN_STARTED', { type: 'RUN_STARTED' }, { corr: 'r1' });
    expect(r.offset).toBe(7);
    expect(r.epoch).toBe('e1');
    expect(api.calls[0].idempotency_key).toBe(r.envelope.id);
    expect(api.calls[0].data).toMatchObject({ v: 1, type: 'agui.RUN_STARTED', tenant: 'acme', source: 'test', corr: 'r1' });
    expect(audit).toMatchObject([{ outcome: 'ok', channel: 'replay:t-acme.run.r1', attempts: 1, component: 'test' }]);
  });

  it('denies another tenant and audits it', async () => {
    const api = fakeApi(() => ok());
    const { p, audit } = make(api.fetch);
    await expect(p.publish('live:t-globex.x', 'job.progress', {})).rejects.toBeInstanceOf(TenantGuardError);
    expect(api.calls).toHaveLength(0);
    expect(audit).toMatchObject([{ outcome: 'denied', reason: 'tenant_mismatch' }]);
  });

  it('needs allowGlobal for global channels', async () => {
    const api = fakeApi(() => ok());
    await expect(make(api.fetch).p.publish('live:global.x', 'system.maintenance', {})).rejects.toThrow(/global_not_allowed/);
    const r = await make(api.fetch, { allowGlobal: true }).p.publish('live:global.x', 'system.maintenance', {});
    expect(r.envelope.tenant).toBe('global');
  });

  it('forTenant switches tenant', async () => {
    const api = fakeApi(() => ok());
    const { p } = make(api.fetch, { tenant: undefined });
    await expect(p.publish('live:t-acme.x', 'a.b', {})).rejects.toThrow(/no_tenant_context/);
    const r = await p.forTenant('globex').publish('live:t-globex.x', 'a.b', {});
    expect(r.envelope.tenant).toBe('globex');
  });

  it('rejects envelopes over 64 KB', async () => {
    const api = fakeApi(() => ok());
    const { p, audit } = make(api.fetch);
    await expect(p.publish('live:t-acme.x', 'a.b', { s: 'x'.repeat(70000) })).rejects.toBeInstanceOf(EnvelopeTooLargeError);
    expect(audit[0].outcome).toBe('too_large');
  });

  it('retries transient errors with the same envelope', async () => {
    const api = fakeApi((_c, n) => (n < 3 ? Response.json({ error: { code: 108, message: 'not available' } }) : ok()));
    const { p, audit } = make(api.fetch);
    await p.publish('live:t-acme.x', 'a.b', {});
    expect(api.calls).toHaveLength(3);
    expect(new Set(api.calls.map((c) => c.data.id)).size).toBe(1);
    expect(audit[0]).toMatchObject({ outcome: 'ok', attempts: 3 });
  });

  it('does not retry permanent errors', async () => {
    const api = fakeApi(() => Response.json({ error: { code: 107, message: 'bad request' } }));
    const { p, audit } = make(api.fetch);
    await expect(p.publish('live:t-acme.x', 'a.b', {})).rejects.toBeInstanceOf(PublishError);
    expect(api.calls).toHaveLength(1);
    expect(audit[0].outcome).toBe('failed');
  });

  it('does not retry a bad API key', async () => {
    const api = fakeApi(() => new Response('', { status: 401 }));
    await expect(make(api.fetch).p.publish('live:t-acme.x', 'a.b', {})).rejects.toThrow(/401/);
    expect(api.calls).toHaveLength(1);
  });
});

describe('per-channel ordering', () => {
  it('keeps order on one channel under random failures and delays', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const api = fakeApi(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await sleep(Math.random() * 3);
      inFlight--;
      if (Math.random() < 0.3) throw new TypeError('network down');
      return ok();
    });
    const { p } = make(api.fetch, { retry: { baseMs: 1, maxMs: 2, attempts: 50 } });
    const n = 60;
    await Promise.all(Array.from({ length: n }, (_, i) => p.publish('live:t-acme.x', 'a.b', { i })));
    expect(maxInFlight).toBe(1);
    const delivered: number[] = [];
    for (const c of api.calls) {
      const i = c.data.data.i as number;
      if (delivered[delivered.length - 1] !== i) delivered.push(i);
    }
    expect(delivered).toEqual(Array.from({ length: n }, (_, i) => i));
  });

  it('publishes different channels concurrently', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const api = fakeApi(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await sleep(5);
      inFlight--;
      return ok();
    });
    const { p } = make(api.fetch);
    await Promise.all(['a', 'b', 'c'].map((t) => p.publish(`live:t-acme.${t}`, 'a.b', {})));
    expect(maxInFlight).toBe(3);
  });

  it('a failed publish does not block the next one', async () => {
    const api = fakeApi((c) => (c.data.data.fail ? Response.json({ error: { code: 107, message: 'x' } }) : ok()));
    const { p } = make(api.fetch);
    const a = p.publish('live:t-acme.x', 'a.b', { fail: true });
    const b = p.publish('live:t-acme.x', 'a.b', {});
    await expect(a).rejects.toThrow();
    await expect(b).resolves.toBeTruthy();
    await p.idle();
  });
});

describe('DeltaBatcher', () => {
  it('joins deltas and flushes on other events', () => {
    const out: Record<string, unknown>[] = [];
    const b = new DeltaBatcher((e) => out.push(e), { intervalMs: 1000 });
    b.push({ type: 'TEXT_MESSAGE_START', messageId: 'm' });
    b.push({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm', delta: 'Hel' });
    b.push({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm', delta: 'lo' });
    b.push({ type: 'TOOL_CALL_ARGS', toolCallId: 't', delta: '{"a"' });
    b.push({ type: 'TOOL_CALL_ARGS', toolCallId: 't', delta: ':1}' });
    b.push({ type: 'TEXT_MESSAGE_END', messageId: 'm' });
    expect(out).toEqual([
      { type: 'TEXT_MESSAGE_START', messageId: 'm' },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm', delta: 'Hello' },
      { type: 'TOOL_CALL_ARGS', toolCallId: 't', delta: '{"a":1}' },
      { type: 'TEXT_MESSAGE_END', messageId: 'm' },
    ]);
  });

  it('flushes on the interval and on size', async () => {
    const out: { delta?: unknown }[] = [];
    const b = new DeltaBatcher((e) => out.push(e), { intervalMs: 10, maxBytes: 4 });
    b.push({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm', delta: 'ab' });
    b.push({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm', delta: 'cd' });
    expect(out).toEqual([{ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm', delta: 'abcd' }]);
    b.push({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm', delta: 'e' });
    await sleep(30);
    expect(out[1].delta).toBe('e');
  });

  it('a new messageId flushes the old one', () => {
    const out: { messageId?: unknown }[] = [];
    const b = new DeltaBatcher((e) => out.push(e));
    b.push({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'a', delta: '1' });
    b.push({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'b', delta: '2' });
    b.flush();
    expect(out.map((e) => e.messageId)).toEqual(['a', 'b']);
  });
});
