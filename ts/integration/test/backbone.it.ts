import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';
import { Centrifuge } from 'centrifuge';
import { Channels, createEnvelope, newId, type Envelope } from '@mjczone/realtime-contract';
import { createPublisher, type Publisher } from '@mjczone/realtime-publisher';
import { createRealtimeClient, type RealtimeClient, type SubscribedInfo } from '@mjczone/realtime-client';
import { API_KEY, startStack, type Stack } from './stack.js';

let stack: Stack;
let publisher: Publisher;
const clients: RealtimeClient[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const config = JSON.parse(readFileSync(new URL('../../../config/centrifugo.json', import.meta.url), 'utf8'));
const replayHistorySize: number = config.channel.namespaces.find((n: { name: string }) => n.name === 'replay').history_size;

beforeAll(async () => {
  stack = await startStack();
  publisher = createPublisher({ apiUrl: stack.apiUrl, apiKey: API_KEY, source: 'it', tenant: 'acme', audit: () => {} });
});

afterAll(async () => {
  clients.forEach((c) => c.disconnect());
  await stack?.stop();
});

function client(userId = 'u1', subToken?: (channel: string) => Promise<string>) {
  const c = createRealtimeClient({
    url: stack.clientUrl,
    getConnectionToken: () => stack.signer.mintConnectionToken({ sub: userId, info: { name: userId } }),
    getSubscriptionToken: subToken ?? ((channel) => stack.signer.mintSubscriptionToken({ sub: userId, channel })),
  });
  clients.push(c);
  c.connect();
  return c;
}

async function api(method: string, body: object) {
  const r = await fetch(`${stack.apiUrl}/${method}`, {
    method: 'POST',
    headers: { 'X-API-Key': API_KEY },
    body: JSON.stringify(body),
  });
  return (await r.json()) as { result?: any; error?: { code: number } };
}

async function waitFor(cond: () => boolean, ms = 5000) {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error('timed out');
    await sleep(20);
  }
}

describe('run flow', () => {
  it('subscribing from offset - 1 delivers RUN_STARTED first, once', async () => {
    const channel = Channels.run('acme', newId());
    const first = await publisher.publish(channel, 'agui.RUN_STARTED', { type: 'RUN_STARTED' });
    expect(first.offset).toBe(1);
    await publisher.publish(channel, 'agui.TEXT_MESSAGE_CONTENT', { type: 'TEXT_MESSAGE_CONTENT', delta: 'a' });

    const got: string[] = [];
    let subscribed: SubscribedInfo | undefined;
    const c = client();
    c.subscribe(channel, (e) => got.push(e.type), {
      since: { offset: first.offset! - 1, epoch: first.epoch! },
      onSubscribed: (i) => (subscribed = i),
    });
    await waitFor(() => got.length === 2);
    await publisher.publish(channel, 'agui.RUN_FINISHED', { type: 'RUN_FINISHED' });
    await waitFor(() => got.length === 3);
    expect(got).toEqual(['agui.RUN_STARTED', 'agui.TEXT_MESSAGE_CONTENT', 'agui.RUN_FINISHED']);
    expect(subscribed).toMatchObject({ wasRecovering: true, recovered: true });
  });

  it('a reload replays a whole run up to history_size', async () => {
    const channel = Channels.run('acme', newId());
    const first = await publisher.publish(channel, 'agui.RUN_STARTED', { type: 'RUN_STARTED' });
    const delta = 'x'.repeat(400);
    for (let i = 1; i < replayHistorySize; i++) {
      await publisher.publish(channel, 'agui.TEXT_MESSAGE_CONTENT', { type: 'TEXT_MESSAGE_CONTENT', delta });
    }

    let count = 0;
    const subscribed: SubscribedInfo[] = [];
    client().subscribe(channel, () => count++, {
      since: { offset: first.offset! - 1, epoch: first.epoch! },
      onSubscribed: (i) => subscribed.push(i),
    });
    await waitFor(() => subscribed.length > 0);
    expect(subscribed[0]).toMatchObject({ wasRecovering: true, recovered: true });
    await waitFor(() => count === replayHistorySize);
    // A reply over client.queue_max_size arrives, then Centrifugo drops the connection and the client subscribes again.
    await sleep(1500);
    expect(subscribed).toHaveLength(1);
  }, 120000);

  it('a wrong epoch reports recovered: false', async () => {
    const channel = Channels.run('acme', newId());
    await publisher.publish(channel, 'agui.RUN_STARTED', { type: 'RUN_STARTED' });
    let subscribed: SubscribedInfo | undefined;
    const got: string[] = [];
    client().subscribe(channel, (e) => got.push(e.type), {
      since: { offset: 0, epoch: 'nope' },
      onSubscribed: (i) => (subscribed = i),
    });
    await waitFor(() => subscribed !== undefined);
    expect(subscribed).toMatchObject({ wasRecovering: true, recovered: false });
    expect(got).toEqual([]);
  });
});

describe('ordering', () => {
  it('keeps order with no duplicates when requests fail before or after Centrifugo', async () => {
    let n = 0;
    const flaky: typeof fetch = async (input, init) => {
      n++;
      if (n % 4 === 1) throw new TypeError('lost before send');
      const res = await fetch(input, init);
      if (n % 4 === 2) throw new TypeError('lost after send');
      return res;
    };
    const p = createPublisher({
      apiUrl: stack.apiUrl,
      apiKey: API_KEY,
      source: 'it',
      tenant: 'acme',
      fetch: flaky,
      audit: () => {},
      retry: { baseMs: 1, maxMs: 5, attempts: 10 },
    });
    const channel = Channels.run('acme', newId());
    await Promise.all(Array.from({ length: 40 }, (_, i) => p.publish(channel, 'job.progress', { jobId: 'j', pct: i })));
    const h = await api('history', { channel, limit: 1000 });
    const pcts = h.result.publications.map((x: { data: Envelope<{ pct: number }> }) => x.data.data.pct);
    expect(pcts).toEqual(Array.from({ length: 40 }, (_, i) => i));
  });
});

describe('edge checks', () => {
  it('json_object rejects a non-object publication', async () => {
    expect((await api('publish', { channel: 'live:t-acme.x', data: [1] })).error?.code).toBe(107);
  });

  it('the API is not on the client port', async () => {
    const r = await fetch(`${stack.clientUrl}/api/publish`, { method: 'POST', headers: { 'X-API-Key': API_KEY }, body: '{}' });
    expect(r.status).toBe(404);
  });

  it('refuses a malformed channel even with a signed token', async () => {
    const channel = 'live:t-acme.a.b.c';
    const c = new Centrifuge(`${stack.clientUrl.replace('http', 'ws')}/connection/websocket`, {
      getToken: () => stack.signer.mintConnectionToken({ sub: 'u1' }),
    });
    let err: { code?: number } | undefined;
    const sub = c.newSubscription(channel, { token: await stack.signer.mintSubscriptionToken({ sub: 'u1', channel }) });
    sub.on('error', (ctx) => (err = ctx.error));
    sub.on('unsubscribed', (ctx) => (err = err ?? { code: ctx.code }));
    sub.subscribe();
    c.connect();
    await waitFor(() => err !== undefined);
    c.disconnect();
    expect(err?.code).toBe(107);
  });

  it('rejects a subscription token for another audience', async () => {
    let err: { code?: number } | undefined;
    const bad = async (channel: string) =>
      new SignJWT({ channel }).setProtectedHeader({ alg: 'HS256' }).setSubject('u1').setExpirationTime('5m').sign(new Uint8Array(32));
    client('u1', bad).subscribe('live:t-acme.secret', () => {}, { onFailed: (e) => (err = e) });
    await waitFor(() => err !== undefined);
    expect(err?.code).toBeGreaterThanOrEqual(100);
  });
});

describe('client', () => {
  it('drops duplicates and invalid envelopes', async () => {
    const channel = Channels.record('acme', 'jobs', newId());
    const got: string[] = [];
    let ready = false;
    client().subscribe(channel, (e) => got.push(e.id), { onSubscribed: () => (ready = true) });
    await waitFor(() => ready);
    const env = createEnvelope({ type: 'job.progress', tenant: 'acme', source: 'it', data: { jobId: 'j', pct: 1 } });
    await api('publish', { channel, data: env });
    await api('publish', { channel, data: env });
    await api('publish', { channel, data: { hello: 'not an envelope' } });
    const second = await publisher.publish(channel, 'job.progress', { jobId: 'j', pct: 2 });
    await waitFor(() => got.length === 2);
    await sleep(200);
    expect(got).toEqual([env.id, second.envelope.id]);
  });

  it('user channels need only the connection token, and only for that user', async () => {
    const mine: string[] = [];
    let otherErr: unknown;
    let tokenCalls = 0;
    const c = client('u_me', async () => {
      tokenCalls++;
      return '';
    });
    let ready = false;
    c.subscribe(Channels.user('acme', 'u_me'), (e) => mine.push(e.type), { onSubscribed: () => (ready = true) });
    c.subscribe(Channels.user('acme', 'u_other'), () => {}, { onFailed: (e) => (otherErr = e) });
    await waitFor(() => ready && otherErr !== undefined);
    await publisher.publish(Channels.user('acme', 'u_me'), 'notice.hello', {});
    await waitFor(() => mine.length === 1);
    expect(tokenCalls).toBe(0);
    expect((otherErr as { code: number }).code).toBe(103);
  });

  it('presence roster and join events', async () => {
    const channel = Channels.presence('acme', 'doc', newId());
    const joins: string[] = [];
    let ready = 0;
    const a = client('u_a').subscribe(channel, () => {}, { onJoin: (m) => joins.push(m.userId), onSubscribed: () => ready++ });
    await waitFor(() => ready === 1);
    client('u_b').subscribe(channel, () => {}, { onSubscribed: () => ready++ });
    await waitFor(() => ready === 2 && joins.includes('u_b'));
    const roster = await a.roster();
    expect(roster.map((m) => m.userId).sort()).toEqual(['u_a', 'u_b']);
    expect(roster.find((m) => m.userId === 'u_b')?.info).toEqual({ name: 'u_b' });
  });
});

describe('reconnect', () => {
  it('a replay subscription recovers messages missed while disconnected', async () => {
    const channel = Channels.run('acme', newId());
    const first = await publisher.publish(channel, 'agui.RUN_STARTED', { type: 'RUN_STARTED' });
    const got: number[] = [];
    const c = client();
    const sub = c.subscribe(channel, (_e, ctx) => got.push(ctx.offset!), { since: { offset: 0, epoch: first.epoch! } });
    await waitFor(() => got.length === 1);
    c.disconnect();
    await publisher.publish(channel, 'agui.TEXT_MESSAGE_CONTENT', { type: 'TEXT_MESSAGE_CONTENT', delta: 'x' });
    await publisher.publish(channel, 'agui.RUN_FINISHED', { type: 'RUN_FINISHED' });
    expect(sub.position?.offset).toBe(1);
    c.connect();
    await waitFor(() => got.length === 3);
    expect(got).toEqual([1, 2, 3]);
  });
});
