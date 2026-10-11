// The Mastra agent service. It runs the agent and streams over the backbone; everything the app owns (users, tasks,
// threads, who may watch a run) stays in the .NET API, which this service calls.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { MastraAgent } from '@ag-ui/mastra';
import type { BaseEvent, RunAgentInput } from '@ag-ui/client';
import { createRunEndpoints } from '@mjczone/realtime-agui-server';
import { createPublisher } from '@mjczone/realtime-publisher';
import { createTokenSigner, type TokenUser } from '@mjczone/realtime-tokens';
import { createAppAgent, messagesFromEvents } from './agent.ts';

const env = (k: string, d: string) => process.env[k] || d;
const API_URL = env('MDN_API_URL', 'http://mdn-api:3010');
const INTERNAL_KEY = env('MDN_INTERNAL_KEY', 'dev-internal-key');

// Access tokens come from the app's login (the .NET API here, an IdP in a real app). Verify them with its public keys.
const appKeys = createRemoteJWKSet(new URL(`${API_URL}/.well-known/app-jwks.json`));

export interface AppUser extends TokenUser {
  /** The caller's access token, so the agent's tools can call the .NET API as this user. */
  accessToken: string;
}

async function authenticate(req: Request): Promise<AppUser | null> {
  const token = req.headers.get('authorization')?.replace(/^Bearer /, '');
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, appKeys, { audience: 'mdn-app', issuer: 'mdn-api', algorithms: ['ES256'] });
    const tenant = (payload.info as { tenant?: string } | undefined)?.tenant;
    return payload.sub && tenant ? { userId: payload.sub, tenant, accessToken: token } : null;
  } catch {
    return null;
  }
}

async function internal(path: string, body: unknown) {
  const res = await fetch(`${API_URL}/internal${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Internal-Key': INTERNAL_KEY },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`.NET API ${path}: HTTP ${res.status}`);
}

// Dev only: signs realtime tokens with the dev stack's key, like the .NET API does.
const signer = await createTokenSigner({
  privateKey: readFileSync(env('RTB_DEV_KEY_FILE', fileURLToPath(new URL('../../../../.data/keys/signing.jwk', import.meta.url))), 'utf8'),
  audience: env('RTB_TOKEN_AUDIENCE', 'realtime-backbone-dev'),
  issuer: env('RTB_TOKEN_ISSUER', 'rtb-demo'),
});
const publisher = createPublisher({
  apiUrl: env('RTB_API_URL', 'http://backbone:9000/api'),
  apiKey: env('RTB_API_KEY', 'dev-api-key'),
  source: 'mdn-agent',
});

const runs = createRunEndpoints({
  publisher,
  signer,
  authenticate,
  agent: (_input, user) => new MastraAgent({ agent: createAppAgent(API_URL, (user as AppUser).accessToken), resourceId: user.userId }),
  notifyUser: true,
  // The .NET API records who owns the run (so it can authorize realtime tokens) and keeps the thread.
  onRunCreated: (run) =>
    internal('/runs', { runId: run.runId, threadId: run.threadId, userId: run.userId, messages: run.input.messages }),
  onRunFinished: (run, result) =>
    internal(`/runs/${run.runId}/finished`, { threadId: run.threadId, messages: messagesFromEvents(result.events as BaseEvent[]) }),
});

const app = new Hono();
app.use('/api/*', cors({ origin: env('MDN_PAGE_ORIGIN', 'http://localhost:3010'), allowHeaders: ['Authorization', 'Content-Type'] }));
app.get('/healthz', (c) => c.text('ok'));
app.post('/api/run', (c) => runs.run(c.req.raw));
app.post('/api/run/:runId/cancel', (c) => runs.cancel(c.req.raw, c.req.param('runId')));

// A plain AG-UI endpoint (RunAgentInput in, server-sent events out), the kind an app has before the backbone.
// realtime-gateway calls it and publishes the stream; this service then needs no backbone packages at all.
app.post('/agui', async (c) => {
  const user = await authenticate(c.req.raw);
  if (!user) return c.json({ error: 'unauthenticated' }, 401);
  const input = (await c.req.json()) as RunAgentInput;
  const agent = new MastraAgent({ agent: createAppAgent(API_URL, user.accessToken), resourceId: user.userId });
  const encoder = new TextEncoder();
  let subscription: { unsubscribe(): void } | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      subscription = agent.run(input).subscribe({
        next: (e) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`)),
        error: (err) => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'RUN_ERROR', message: String(err?.message ?? err) })}\n\n`));
          controller.close();
        },
        complete: () => controller.close(),
      });
    },
    cancel: () => subscription?.unsubscribe(),
  });
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } });
});

serve({ fetch: app.fetch, port: Number(env('PORT', '3011')), hostname: '0.0.0.0' });
console.log('mdn-agent: listening');
