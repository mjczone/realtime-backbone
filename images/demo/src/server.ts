import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { Channels, newId } from '@rtb/contract';
import { DeltaBatcher, createPublisher } from '@rtb/publisher';
import { JWKS_PATH, createTokenEndpoints, createTokenSigner, generateSigningKey } from '@rtb/tokens';

const env = (k: string, d: string) => process.env[k] || d;
const TENANT = 'demo';
const PORT = Number(env('PORT', '8080'));
const KEY_FILE = env('RTB_DEMO_KEY_FILE', '/data/keys/signing.jwk');
const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

async function loadKey() {
  if (existsSync(KEY_FILE)) return JSON.parse(readFileSync(KEY_FILE, 'utf8'));
  const jwk = await generateSigningKey();
  mkdirSync(dirname(KEY_FILE), { recursive: true });
  // Dev only: readable so the samples on the host can sign with the same key.
  writeFileSync(KEY_FILE, JSON.stringify(jwk), { mode: 0o644 });
  console.log(`demo: generated a dev signing key at ${KEY_FILE}`);
  return jwk;
}

const signer = await createTokenSigner({
  privateKey: await loadKey(),
  audience: env('RTB_TOKEN_AUDIENCE', 'realtime-backbone-dev'),
  issuer: env('RTB_TOKEN_ISSUER', 'rtb-demo'),
});

const publisher = createPublisher({
  apiUrl: env('RTB_API_URL', 'http://backbone:9000/api'),
  apiKey: env('RTB_API_KEY', 'dev-api-key'),
  source: 'demo',
  tenant: TENANT,
  retry: { totalMs: 3000 },
  audit: (e) => {
    if (e.outcome !== 'ok') console.warn(JSON.stringify({ level: 'warn', msg: 'rtb.audit', ...e }));
  },
});

// Dev only: the caller says who they are. A real app uses its own session here.
const runOwners = new Map<string, string>();
const userOf = (req: Request) => {
  const id = req.headers.get('x-demo-user') || 'u_demo';
  return /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : null;
};

const tokens = createTokenEndpoints({
  signer,
  authenticate: (req) => {
    const userId = userOf(req);
    return userId ? { userId, tenant: TENANT, info: { name: userId } } : null;
  },
  authorize: (user, _channel, parsed) => (parsed.topic === 'run' ? runOwners.get(parsed.id!) === user.userId : true),
  cacheTtlMs: 0,
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const STORY =
  'This is a scripted agent run. Each word is a text delta, batched every 75 ms before it is published ' +
  'to a replay channel. Reload the page while this is still typing: the page resubscribes from its last ' +
  'position and the backbone sends what it missed, so nothing is lost or repeated. Open a second tab to ' +
  'watch the same run from another viewer. When the text stops, a RUN_FINISHED event closes the run.';

async function scriptedRun(runId: string, threadId: string, channel: string) {
  const batcher = new DeltaBatcher((event) => {
    void publisher.publish(channel, `agui.${event.type}`, event, { corr: runId }).catch(() => {});
  });
  const messageId = newId();
  batcher.push({ type: 'TEXT_MESSAGE_START', messageId, role: 'assistant' });
  for (const word of STORY.split(' ')) {
    batcher.push({ type: 'TEXT_MESSAGE_CONTENT', messageId, delta: `${word} ` });
    await sleep(90);
  }
  batcher.push({ type: 'TEXT_MESSAGE_END', messageId });
  batcher.push({ type: 'RUN_FINISHED', threadId, runId });
  batcher.flush();
}

const app = new Hono();
app.get('/healthz', (c) => c.text('ok'));
app.get(JWKS_PATH, (c) => tokens.jwks(c.req.raw));
app.post('/api/token/connection', (c) => tokens.connection(c.req.raw));
app.post('/api/token/subscription', (c) => tokens.subscription(c.req.raw));
app.get('/api/config', (c) => c.json({ backboneUrl: env('RTB_PUBLIC_BACKBONE_URL', 'http://localhost:8000'), tenant: TENANT }));

app.post('/api/runs', async (c) => {
  const userId = userOf(c.req.raw);
  if (!userId) return c.json({ error: 'unauthenticated' }, 401);
  const runId = newId();
  const threadId = 'thread-demo';
  const channel = Channels.run(TENANT, runId);
  runOwners.set(runId, userId);
  const started = await publisher.publish(channel, 'agui.RUN_STARTED', { type: 'RUN_STARTED', threadId, runId }, { corr: runId });
  const position = { offset: started.offset!, epoch: started.epoch! };
  await publisher.publish(Channels.user(TENANT, userId), 'notice.run_started', { runId, threadId, channel, ...position });
  void scriptedRun(runId, threadId, channel).catch((e) => console.error('demo run failed', e));
  const token = await signer.mintSubscriptionToken({ sub: userId, channel });
  return c.json({ runId, threadId, channel, token, ...position }, 202);
});

app.get('/', (c) => c.html(readFileSync(join(PUBLIC_DIR, 'index.html'), 'utf8')));
app.get('/app.js', (c) => c.body(readFileSync(join(PUBLIC_DIR, 'app.js')), 200, { 'Content-Type': 'text/javascript' }));

const job = 'demo-job';
let pct = 0;
setInterval(() => {
  pct = (pct + 5) % 105;
  publisher
    .publish(Channels.record(TENANT, 'jobs', job), 'job.progress', { jobId: job, pct, step: pct === 100 ? 'done' : 'working' })
    .catch((e) => console.warn(`demo: tick failed: ${(e as Error).message}`));
}, 1000);

serve({ fetch: app.fetch, port: PORT, hostname: '0.0.0.0' });
console.log(`demo: listening on :${PORT}`);
