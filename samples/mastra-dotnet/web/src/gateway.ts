// Gateway mode: no backbone packages in the page. It loads the client from realtime-gateway, which hands out realtime
// tokens and proxies runs to the Mastra service's plain AG-UI endpoint.
import { boot } from './ui.ts';

await boot(async (s, config) => {
  const rtb = await import(/* @vite-ignore */ `${config.gatewayUrl}/v1/client.js`);
  const gateway = await rtb.connectGateway({ url: config.gatewayUrl, accessToken: () => s.accessToken });
  return { client: gateway.client, channels: rtb.Channels, buildResumeArray: rtb.buildResumeArray, agent: (threadId) => gateway.agent('tasks', { threadId }) };
});
