import { describe, expect, it } from 'vitest';
import { createEnvelope } from '@rtb/contract';
import type { RealtimeClient, SubscribeOptions } from '@rtb/client';
import { CentrifugoAgent, type RunRef } from '../src/index.js';

interface FakeSub {
  channel: string;
  handler: (env: any, ctx: any) => void;
  opts: SubscribeOptions;
  closed: boolean;
}

function fakeClient() {
  const subs: FakeSub[] = [];
  const client = {
    state: 'connected',
    onStateChange: () => () => {},
    connect() {},
    disconnect() {},
    subscribe(channel: string, handler: FakeSub['handler'], opts: SubscribeOptions = {}) {
      const s: FakeSub = { channel, handler, opts, closed: false };
      subs.push(s);
      return { channel, position: undefined, roster: async () => [], unsubscribe: () => (s.closed = true) };
    },
  } as unknown as RealtimeClient;
  return { client, subs };
}

function memoryStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m };
}

const run: RunRef = { runId: 'r1', threadId: 't1', channel: 'replay:t-acme.run.r1', offset: 1, epoch: 'e1', token: 'tok' };
const agui = (data: Record<string, unknown>) =>
  createEnvelope({ type: `agui.${data.type}`, tenant: 'acme', source: 'svc', data });

function emitRun(sub: FakeSub, text = 'Hello') {
  sub.opts.onSubscribed?.({ wasRecovering: true, recovered: true });
  sub.handler(agui({ type: 'RUN_STARTED', threadId: 't1', runId: 'r1' }), {});
  sub.handler(createEnvelope({ type: 'job.progress', tenant: 'acme', source: 'svc', data: {} }), {});
  sub.handler(agui({ type: 'TEXT_MESSAGE_START', messageId: 'm1', role: 'assistant' }), {});
  sub.handler(agui({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: text }), {});
  sub.handler(agui({ type: 'TEXT_MESSAGE_END', messageId: 'm1' }), {});
  sub.handler(agui({ type: 'RUN_FINISHED', threadId: 't1', runId: 'r1' }), {});
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('CentrifugoAgent', () => {
  it('posts the input, subscribes from offset - 1 and builds the message', async () => {
    const { client, subs } = fakeClient();
    const storage = memoryStorage();
    const posted: any[] = [];
    const agent = new CentrifugoAgent({
      client,
      storage,
      threadId: 't1',
      runUrl: 'http://svc/run',
      headers: () => ({ Authorization: 'Bearer x' }),
      fetch: (async (_u: string, init: RequestInit) => {
        posted.push({ body: JSON.parse(init.body as string), headers: init.headers });
        return Response.json(run, { status: 202 });
      }) as typeof fetch,
    });
    const done = agent.runAgent({ runId: 'client-side-id' });
    await tick();
    await tick();
    expect(posted[0].body.threadId).toBe('t1');
    expect(posted[0].headers.Authorization).toBe('Bearer x');
    expect(subs[0].opts.since).toEqual({ offset: 0, epoch: 'e1' });
    expect(subs[0].opts.token).toBe('tok');
    expect(storage.m.size).toBe(1);
    expect([...storage.m.values()][0]).not.toContain('tok');
    emitRun(subs[0]);
    const result = await done;
    expect(result.newMessages).toMatchObject([{ role: 'assistant', content: 'Hello' }]);
    expect(storage.m.size).toBe(0);
    expect(subs[0].closed).toBe(true);
  });

  it('reattaches after a reload with connectAgent', async () => {
    const storage = memoryStorage();
    const first = fakeClient();
    const a = new CentrifugoAgent({
      client: first.client,
      storage,
      agentId: 'chat',
      threadId: 't1',
      runUrl: 'http://svc/run',
      fetch: (async () => Response.json(run, { status: 202 })) as unknown as typeof fetch,
    });
    void a.runAgent().catch(() => {});
    await tick();
    await tick();
    expect(storage.m.size).toBe(1);

    const second = fakeClient();
    const b = new CentrifugoAgent({ client: second.client, storage, agentId: 'chat', threadId: 't1', runUrl: 'http://svc/run' });
    expect(b.storedRun?.channel).toBe(run.channel);
    const done = b.connectAgent();
    await tick();
    expect(second.subs[0].opts.since).toEqual({ offset: 0, epoch: 'e1' });
    expect(second.subs[0].opts.token).toBeUndefined();
    emitRun(second.subs[0], 'Again');
    expect((await done).newMessages).toMatchObject([{ content: 'Again' }]);
  });

  it('connectAgent with nothing stored completes with no messages', async () => {
    const { client, subs } = fakeClient();
    const agent = new CentrifugoAgent({ client, storage: memoryStorage(), runUrl: 'http://svc/run' });
    expect((await agent.connectAgent()).newMessages).toEqual([]);
    expect(subs).toHaveLength(0);
  });

  it('attach() joins a given run', async () => {
    const { client, subs } = fakeClient();
    const agent = new CentrifugoAgent({ client, storage: null, runUrl: 'http://svc/run' });
    const done = agent.attach({ ...run, offset: 5 }).connectAgent();
    await tick();
    expect(subs[0].opts.since).toEqual({ offset: 4, epoch: 'e1' });
    emitRun(subs[0]);
    await done;
  });

  it('lost history becomes RUN_ERROR rtb.history_lost', async () => {
    const { client, subs } = fakeClient();
    const agent = new CentrifugoAgent({ client, storage: null, runUrl: 'http://svc/run' });
    const errors: any[] = [];
    const done = agent.attach(run).connectAgent({}, { onRunErrorEvent: ({ event }) => void errors.push(event) });
    await tick();
    subs[0].opts.onSubscribed?.({ wasRecovering: true, recovered: false });
    await done.catch(() => {});
    expect(errors[0]).toMatchObject({ code: 'rtb.history_lost' });
  });

  it('a failed subscription rejects the run', async () => {
    const { client, subs } = fakeClient();
    const agent = new CentrifugoAgent({ client, storage: null, runUrl: 'http://svc/run' });
    const done = agent.attach(run).connectAgent();
    await tick();
    subs[0].opts.onFailed?.({ code: 103, message: 'permission denied' });
    await expect(done).rejects.toThrow(/103/);
  });

  it('abortRun posts to the cancel URL and detaches', async () => {
    const { client, subs } = fakeClient();
    const calls: string[] = [];
    const agent = new CentrifugoAgent({
      client,
      storage: null,
      runUrl: 'http://svc/run',
      cancelUrl: (r) => `http://svc/run/${r.runId}/cancel`,
      fetch: (async (u: string) => {
        calls.push(u);
        return Response.json(run, { status: 202 });
      }) as typeof fetch,
    });
    const done = agent.runAgent();
    await tick();
    await tick();
    subs[0].handler(agui({ type: 'RUN_STARTED', threadId: 't1', runId: 'r1' }), {});
    agent.abortRun();
    await done.catch(() => {});
    await tick();
    expect(calls).toEqual(['http://svc/run', 'http://svc/run/r1/cancel']);
    expect(subs[0].closed).toBe(true);
  });
});
