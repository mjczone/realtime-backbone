import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { MastraAgent } from '@ag-ui/mastra';
import type { BaseEvent, Message } from '@ag-ui/client';
import { createPublisher } from '@rtb/publisher';
import { JWKS_PATH, createTokenEndpoints, createTokenSigner, type TokenUser } from '@rtb/tokens';
import { createRunEndpoints, startRun } from '@rtb/mastra';
import { createWeatherAgent } from './agent.ts';

const env = (k: string, d: string) => process.env[k] || d;
const TENANT = 'demo';
const PORT = Number(env('PORT', '3001'));
const WEB = fileURLToPath(new URL('../../chat-web/public/', import.meta.url));

// Dev only: the samples sign with the demo's dev key, so the dev stack's JWKS already covers them.
const signer = await createTokenSigner({
  privateKey: readFileSync(env('RTB_DEV_KEY_FILE', fileURLToPath(new URL('../../../.data/keys/signing.jwk', import.meta.url))), 'utf8'),
  audience: env('RTB_TOKEN_AUDIENCE', 'realtime-backbone-dev'),
  issuer: env('RTB_TOKEN_ISSUER', 'rtb-demo'),
});
const publisher = createPublisher({
  apiUrl: env('RTB_API_URL', 'http://backbone:9000/api'),
  apiKey: env('RTB_API_KEY', 'dev-api-key'),
  source: 'mastra-chat',
});

// Dev only: the caller says who they are. A real app uses its own session.
function authenticate(req: Request): TokenUser | null {
  const userId = req.headers.get('x-demo-user') ?? '';
  return /^[A-Za-z0-9_-]{1,64}$/.test(userId) ? { userId, tenant: TENANT, info: { name: userId } } : null;
}

// The app's own stores. A real app keeps these in its database.
const threads = new Map<string, { owner: string; messages: Message[] }>();
const runOwners = new Map<string, string>();

function messagesFromEvents(events: BaseEvent[]): Message[] {
  const out: any[] = [];
  const byId = new Map<string, any>();
  for (const e of events as any[]) {
    if (e.type === 'TEXT_MESSAGE_START') {
      const m = { id: e.messageId, role: 'assistant', content: '' };
      byId.set(e.messageId, m);
      out.push(m);
    } else if (e.type === 'TEXT_MESSAGE_CONTENT') {
      byId.get(e.messageId).content += e.delta;
    } else if (e.type === 'TOOL_CALL_START') {
      let parent = byId.get(e.parentMessageId ?? e.toolCallId);
      if (!parent) {
        parent = { id: e.parentMessageId ?? e.toolCallId, role: 'assistant', toolCalls: [] };
        byId.set(parent.id, parent);
        out.push(parent);
      }
      parent.toolCalls ??= [];
      parent.toolCalls.push({ id: e.toolCallId, type: 'function', function: { name: e.toolCallName, arguments: '' } });
      byId.set(`call:${e.toolCallId}`, parent.toolCalls.at(-1));
    } else if (e.type === 'TOOL_CALL_ARGS') {
      byId.get(`call:${e.toolCallId}`).function.arguments += e.delta;
    } else if (e.type === 'TOOL_CALL_RESULT') {
      out.push({ id: e.messageId, role: 'tool', toolCallId: e.toolCallId, content: e.content });
    }
  }
  return out;
}

const hooks = {
  onRunCreated: ({ runId, threadId, userId, input }: any) => {
    runOwners.set(runId, userId);
    const t = threads.get(threadId);
    if (t && t.owner !== userId) throw new Error('not your thread');
    threads.set(threadId, { owner: userId, messages: input.messages });
  },
  onRunFinished: ({ threadId }: any, result: { events: BaseEvent[] }) => {
    threads.get(threadId)?.messages.push(...messagesFromEvents(result.events));
  },
};

const tokens = createTokenEndpoints({
  signer,
  authenticate,
  authorize: (user, _channel, parsed) => (parsed.topic === 'run' ? runOwners.get(parsed.id!) === user.userId : true),
  cacheTtlMs: 0,
});

const runs = createRunEndpoints({
  publisher,
  signer,
  authenticate,
  agent: (_input, user) => new MastraAgent({ agent: createWeatherAgent(), resourceId: user.userId }),
  notifyUser: true,
  ...hooks,
});

const app = new Hono();
app.get('/healthz', (c) => c.text('ok'));
app.get('/', (c) => c.html(readFileSync(`${WEB}index.html`, 'utf8')));
app.get('/app.js', (c) => c.body(readFileSync(`${WEB}app.js`), 200, { 'Content-Type': 'text/javascript' }));
app.get(JWKS_PATH, (c) => tokens.jwks(c.req.raw));
app.get('/api/config', (c) =>
  c.json({ backboneUrl: env('RTB_PUBLIC_BACKBONE_URL', 'http://localhost:8000'), tenant: TENANT, agentName: 'a Mastra agent' }),
);
app.post('/api/token/connection', (c) => tokens.connection(c.req.raw));
app.post('/api/token/subscription', (c) => tokens.subscription(c.req.raw));
app.get('/api/threads/:threadId', (c) => {
  const user = authenticate(c.req.raw);
  const t = threads.get(c.req.param('threadId'));
  if (!user) return c.json({ error: 'unauthenticated' }, 401);
  return c.json({ messages: t && t.owner === user.userId ? t.messages : [] });
});
app.post('/api/run', (c) => runs.run(c.req.raw));
app.post('/api/run/:runId/cancel', (c) => runs.cancel(c.req.raw, c.req.param('runId')));

// A run nobody started from this page: the user hears about it on their own channel.
app.post('/api/background-run', async (c) => {
  const user = authenticate(c.req.raw);
  if (!user) return c.json({ error: 'unauthenticated' }, 401);
  const { threadId, prompt } = (await c.req.json()) as { threadId: string; prompt: string };
  const t = threads.get(threadId);
  const messages = [...(t?.owner === user.userId ? t.messages : []), { id: crypto.randomUUID(), role: 'user', content: prompt }];
  const ref = await startRun({
    publisher: publisher.forTenant(TENANT),
    agent: new MastraAgent({ agent: createWeatherAgent(), resourceId: user.userId }),
    input: { threadId, messages: messages as Message[] },
    userId: user.userId,
    notifyUser: true,
    ...hooks,
  });
  const { done: _done, ...body } = ref;
  return c.json(body, 202);
});

serve({ fetch: app.fetch, port: PORT, hostname: '0.0.0.0' });
console.log(`mastra-chat: listening on :${PORT}`);
