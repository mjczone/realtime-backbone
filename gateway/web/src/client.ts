// Served by rtb-gateway at /v1/client.js. A page loads it with:
//   const { connectGateway } = await import('https://gateway.example.com/v1/client.js');
export { buildResumeArray, EventType } from '@ag-ui/client';
export { CentrifugoAgent, type RunRef } from '@rtb/agui-client';
export { UnauthorizedError, createRealtimeClient } from '@rtb/client';
export { Channels, decodeId, encodeId } from '@rtb/contract';

import { CentrifugoAgent } from '@rtb/agui-client';
import { UnauthorizedError, createRealtimeClient } from '@rtb/client';

export interface GatewayOptions {
  /** The gateway's URL, for example https://gateway.example.com */
  url: string;
  /** The signed-in user's access token, the one the app's API accepts. */
  accessToken: () => string | Promise<string>;
}

/** Connects to the backbone through the gateway: realtime tokens and agent runs all go through it. */
export async function connectGateway(options: GatewayOptions) {
  const base = options.url.replace(/\/$/, '');
  const config = (await (await fetch(`${base}/v1/config`)).json()) as { backboneUrl: string; agents: string[] };
  const headers = async () => ({ Authorization: `Bearer ${await options.accessToken()}` });
  const token = async (path: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { ...(await headers()), 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 401 || res.status === 403) throw new UnauthorizedError(`${path}: HTTP ${res.status}`);
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    return ((await res.json()) as { token: string }).token;
  };
  const client = createRealtimeClient({
    url: config.backboneUrl,
    getConnectionToken: () => token('/v1/me/tokens/connection'),
    getSubscriptionToken: (channel) => token('/v1/me/tokens/subscription', { channel }),
  });
  client.connect();
  return {
    client,
    config,
    /** An AG-UI agent whose runs go through the gateway to the agent named in the gateway's config. */
    agent(name: string, opts: { threadId?: string; agentId?: string } = {}) {
      return new CentrifugoAgent({
        client,
        agentId: opts.agentId ?? name,
        threadId: opts.threadId,
        runUrl: `${base}/v1/agents/${encodeURIComponent(name)}/runs`,
        cancelUrl: (run) => `${base}/v1/runs/${run.runId}/cancel`,
        headers,
      });
    },
  };
}
