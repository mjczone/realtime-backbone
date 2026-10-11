# Samples

Four agent services that stream over the backbone, one chat page they all serve, and a backtest worker.

| Sample | Stack | Port |
| --- | --- | --- |
| `mastra-chat` | Node, Hono, Mastra, `@mjczone/realtime-agui-server` | 3001 |
| `maf-chat` | ASP.NET Core, Microsoft Agent Framework, `MJCZone.Realtime.AgUi` and `MJCZone.Realtime.AgUi.AgentFramework` | 3002 |
| `py-chat` | Python, Starlette, Pydantic AI, `mjczone-realtime-agui` | 3003 |
| `py-chat` with `AGENT=langgraph` (Compose service `py-langgraph`) | Python, Starlette, LangGraph, `mjczone-realtime-agui` | 3004 |
| `chat-web` | The page, built on `@mjczone/realtime-agui-client` | served by all four |
| `mastra-dotnet` | A plain `@ag-ui/client` page, a .NET REST API and a Mastra agent service working together, with frontend tools and approvals | 3010 (page and API), 3011 (agent) |
| `py-signals` | A Python worker that replays candles through a strategy and publishes progress, signals and order status | one-shot |

The chat samples use a scripted model by default, so they run without an API key. It behaves the same in every sample: it takes the city after the last "in" in your message ("what is the weather in Lisbon?", "and in buenos aires?"), calls the `getWeather` tool with it, and streams an answer built from the tool's result. The weather is made up but always the same for the same city. Without a city it asks for one. To use a real model, set `MODEL` and the provider's key for `mastra-chat` and `py-chat` (both frameworks), or swap the `IChatClient` in `maf-chat`.

## Run

```sh
pnpm dev:up
pnpm samples:up
```

Open http://localhost:3001 (Mastra), http://localhost:3002 (MAF), http://localhost:3003 (Pydantic AI) or http://localhost:3004 (LangGraph).

Run the backtest worker with `pnpm samples:signals`; see `py-signals/README.md`.

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
pnpm e2e                          # every sample and the test page
pnpm e2e tests/chat.spec.ts       # the chat samples only (all four)
pnpm e2e tests/mastra-dotnet.spec.ts
```
