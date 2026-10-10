# Samples

Two agent services that stream over the backbone, and one chat page they both serve.

| Sample | Stack | Port |
| --- | --- | --- |
| `mastra-chat` | Node, Hono, Mastra, `@rtb/mastra` | 3001 |
| `maf-chat` | ASP.NET Core, Microsoft Agent Framework, `Rtb.AgentFramework` | 3002 |
| `chat-web` | The page, built on `@rtb/agui-client` | served by both |

Both use a scripted model by default, so they run without an API key.

## Run

```sh
pnpm dev:up
docker compose --profile samples up -d --build
```

Open http://localhost:3001 (Mastra) or http://localhost:3002 (MAF).

Things to try:

- Send a message, then reload while the answer is typing. The page picks up where it left off.
- Open a second tab. It joins the run through a `notice.run_started` on your user channel.
- Click "Start a background run". Nobody started it from the page, but the page hears about it and joins.
- Click "Cancel run" while it types.

These samples are dev only: the caller picks a user name with an `X-Demo-User` header, threads live in memory, and they sign tokens with the dev stack's key from `.data/keys/`.

## The API both samples serve

| Route | Does |
| --- | --- |
| `GET /api/config` | `{ backboneUrl, tenant, agentName }` |
| `POST /api/token/connection` | `{ token }` |
| `POST /api/token/subscription` with `{ channel }` | `{ token }` |
| `GET /api/threads/:threadId` | `{ messages }` from the app's own store |
| `POST /api/run` with `RunAgentInput` | `202 { runId, threadId, channel, offset, epoch, token }` |
| `POST /api/run/:runId/cancel` | Stops the run; the run ends with `RUN_ERROR` code `rtb.cancelled` |
| `POST /api/background-run` with `{ threadId, prompt }` | Starts a run and notifies the user's channel |

## Tests

```sh
pnpm --filter @rtb/e2e test tests/chat.spec.ts                                   # Mastra
RTB_SAMPLE_URL=http://localhost:3002 pnpm --filter @rtb/e2e test tests/chat.spec.ts  # MAF
```
