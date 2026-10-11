// SDK mode: realtime tokens come from the .NET API, runs go to the Mastra service's backbone run endpoint.
import { buildResumeArray } from '@ag-ui/client';
import { CentrifugoAgent } from '@mjczone/realtime-agui-client';
import { UnauthorizedError, createRealtimeClient } from '@mjczone/realtime-client';
import { Channels } from '@mjczone/realtime-contract';
import { boot } from './ui.ts';

await boot(async (s, config, api) => {
  const token = async (path: string, body?: unknown) => {
    try {
      return (await api('POST', path, body)).token as string;
    } catch (e) {
      if ((e as { status?: number }).status === 403) throw new UnauthorizedError((e as Error).message);
      throw e;
    }
  };
  const client = createRealtimeClient({
    url: config.backboneUrl,
    getConnectionToken: () => token('/api/realtime/connection'),
    getSubscriptionToken: (channel) => token('/api/realtime/subscription', { channel }),
  });
  client.connect();
  const auth = { Authorization: `Bearer ${s.accessToken}` };
  return {
    client,
    channels: Channels,
    buildResumeArray,
    agent: (threadId) =>
      new CentrifugoAgent({
        client,
        agentId: 'tasks',
        threadId,
        runUrl: `${config.agentUrl}/api/run`,
        headers: () => auth,
        cancelUrl: (run) => `${config.agentUrl}/api/run/${run.runId}/cancel`,
      }),
  };
});
