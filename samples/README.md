# Samples

Three agent services that stream over the backbone, one chat page they all serve, and a backtest worker.

| Sample | Stack | Port |
| --- | --- | --- |
| `mastra-chat` | Node, Hono, Mastra, `@rtb/mastra` | 3001 |
| `maf-chat` | ASP.NET Core, Microsoft Agent Framework, `Rtb.AgentFramework` | 3002 |
| `py-chat` | Python, Starlette, Pydantic AI, `rtb-agui` | 3003 |
| `chat-web` | The page, built on `@rtb/agui-client` | served by all three |
| `py-signals` | A Python worker that replays candles through a strategy and publishes progress, signals and order status | one-shot |

The chat samples use a scripted model by default, so they run without an API key.

## Run

```sh
pnpm dev:up
docker compose --profile samples up -d --build
```

Open http://localhost:3001 (Mastra), http://localhost:3002 (MAF) or http://localhost:3003 (Pydantic AI).

Run the backtest worker with `docker compose --profile signals run --rm py-signals`; see `py-signals/README.md`.

Things to try:

- Send a message, then reload while the answer is typing. The page picks up where it left off.
- Open a second tab. It joins the run through a `notice.run_started` on your user channel.
- Click "Start a background run". Nobody started it from the page, but the page hears about it and joins.
- Click "Cancel run" while it types.

These samples are dev only: the caller picks a user name with an `X-Demo-User` header, threads live in memory, and they sign tokens with the dev stack's key from `.data/keys/`.

## The API the chat samples serve

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
RTB_SAMPLE_URL=http://localhost:3003 pnpm --filter @rtb/e2e test tests/chat.spec.ts  # Pydantic AI
```
