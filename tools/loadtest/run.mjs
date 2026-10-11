// Simulates concurrent agent runs: each run publishes RUN_STARTED, a tool call, a streamed answer
// and RUN_FINISHED to its own replay channel, and one viewer per run checks every message arrives.
// Run it inside the dev stack's network (see README.md).
import { readFileSync } from 'node:fs';
import net from 'node:net';
import { Channels, newId } from '@mjczone/realtime-contract';
import { DeltaBatcher, createPublisher } from '@mjczone/realtime-publisher';
import { createRealtimeClient } from '@mjczone/realtime-client';
import { createTokenSigner } from '@mjczone/realtime-tokens';

const env = (k, d) => process.env[k] || d;
const RUNS = Number(env('RUNS', '200'));
const TOKENS = Number(env('TOKENS', '300'));
const TOKENS_PER_SEC = Number(env('TOKENS_PER_SEC', '30'));
const BATCH_MS = Number(env('BATCH_MS', '75'));
const API_URL = env('RTB_API_URL', 'http://backbone:9000/api');
const CLIENT_URL = env('RTB_CLIENT_URL', 'http://backbone:8000');
const VALKEY = env('VALKEY_HOST', 'valkey');

const signer = await createTokenSigner({
  privateKey: readFileSync(env('RTB_DEV_KEY_FILE', '/repo/.data/keys/signing.jwk'), 'utf8'),
  audience: env('RTB_TOKEN_AUDIENCE', 'realtime-backbone-dev'),
  issuer: env('RTB_TOKEN_ISSUER', 'rtb-demo'),
});
const publishLatency = [];
const publisher = createPublisher({
  apiUrl: API_URL,
  apiKey: env('RTB_API_KEY', 'dev-api-key'),
  source: 'loadtest',
  tenant: 'load',
  audit: () => {},
});

function valkeyUsedMemory() {
  return new Promise((resolve, reject) => {
    const s = net.connect(6379, VALKEY, () => s.write('INFO memory\r\n'));
    let buf = '';
    s.on('data', (d) => {
      buf += d;
      const m = buf.match(/used_memory:(\d+)/);
      if (m) {
        s.end();
        resolve(Number(m[1]));
      }
    });
    s.on('error', reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (xs, p) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))] : 0);

async function run(i, viewerReady) {
  const runId = newId();
  const channel = Channels.run('load', runId);
  const userId = `load_${i}`;
  const timed = (type, data) => {
    const t = performance.now();
    return publisher.publish(channel, type, { ...data, sentAt: Date.now() }).then((r) => {
      publishLatency.push(performance.now() - t);
      return r;
    });
  };
  const started = await timed('agui.RUN_STARTED', { type: 'RUN_STARTED', runId });
  const expected = { count: 0 };
  const done = viewerReady(channel, userId, started, expected);

  const batcher = new DeltaBatcher((e) => {
    expected.count++;
    void timed(`agui.${e.type}`, e).catch(() => {});
  }, { intervalMs: BATCH_MS });
  const push = (e) => batcher.push(e);
  push({ type: 'TOOL_CALL_START', toolCallId: 't1', toolCallName: 'search' });
  push({ type: 'TOOL_CALL_ARGS', toolCallId: 't1', delta: '{"q":"load"}' });
  push({ type: 'TOOL_CALL_END', toolCallId: 't1' });
  const messageId = newId();
  push({ type: 'TEXT_MESSAGE_START', messageId, role: 'assistant' });
  for (let t = 0; t < TOKENS; t++) {
    push({ type: 'TEXT_MESSAGE_CONTENT', messageId, delta: 'tok ' });
    await sleep(1000 / TOKENS_PER_SEC);
  }
  push({ type: 'TEXT_MESSAGE_END', messageId });
  push({ type: 'RUN_FINISHED', runId });
  batcher.flush();
  await publisher.idle();
  return done;
}

const e2eLatency = [];
let missing = 0;
let lost = 0;
const clients = [];

function viewer(channel, userId, started, expected) {
  return new Promise((resolve) => {
    const client = createRealtimeClient({
      url: CLIENT_URL,
      getConnectionToken: () => signer.mintConnectionToken({ sub: userId }),
      getSubscriptionToken: (ch) => signer.mintSubscriptionToken({ sub: userId, channel: ch }),
    });
    clients.push(client);
    let got = 0;
    let lastOffset = started.offset - 1;
    const timer = setTimeout(() => finish(), (TOKENS / TOKENS_PER_SEC) * 1000 + 30000);
    const finish = () => {
      clearTimeout(timer);
      missing += Math.max(0, expected.count + 1 - got);
      client.disconnect();
      resolve();
    };
    client.connect();
    client.subscribe(
      channel,
      (e, ctx) => {
        got++;
        if (ctx.offset !== lastOffset + 1) lost++;
        lastOffset = ctx.offset;
        if (e.data.sentAt) e2eLatency.push(Date.now() - e.data.sentAt);
        if (e.type === 'agui.RUN_FINISHED') finish();
      },
      { since: { offset: started.offset - 1, epoch: started.epoch } },
    );
  });
}

console.log(`loadtest: ${RUNS} runs, ${TOKENS} tokens each at ${TOKENS_PER_SEC}/s, batch ${BATCH_MS} ms`);
const memBefore = await valkeyUsedMemory();
const t0 = performance.now();
await Promise.all(Array.from({ length: RUNS }, (_, i) => sleep(Math.random() * 1000).then(() => run(i, viewer))));
const seconds = (performance.now() - t0) / 1000;
await sleep(1000);
const memAfter = await valkeyUsedMemory();

const result = {
  runs: RUNS,
  batchMs: BATCH_MS,
  publishes: publishLatency.length,
  publishesPerSecond: Math.round(publishLatency.length / seconds),
  publishPerRun: Math.round(publishLatency.length / RUNS),
  publishMs: { p50: +pct(publishLatency, 0.5).toFixed(1), p99: +pct(publishLatency, 0.99).toFixed(1) },
  endToEndMs: { p50: pct(e2eLatency, 0.5), p99: pct(e2eLatency, 0.99) },
  missingMessages: missing,
  offsetGaps: lost,
  valkeyBytesPerRun: Math.round((memAfter - memBefore) / RUNS),
};
console.log(JSON.stringify(result, null, 2));
process.exit(0);
