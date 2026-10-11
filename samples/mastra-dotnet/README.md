# mastra-dotnet

An app shaped like a common setup: a plain AG-UI page (`@ag-ui/client`, no CopilotKit), a .NET REST API that owns the app's data, and a Mastra service that runs the agent.

```mermaid
flowchart LR
  page["Page<br/>@ag-ui/client + CentrifugoAgent"]
  api[".NET API :3010<br/>login, tasks, threads,<br/>realtime tokens"]
  agent["Mastra service :3011<br/>@rtb/agui-server"]
  cf["Backbone"]
  page -- "REST, access token" --> api
  page -- "RunAgentInput, access token" --> agent
  agent -- "tools call the API as the user" --> api
  agent -- "records runs and threads" --> api
  agent -- "AG-UI events" --> cf
  api -- "entity.changed" --> cf
  cf -- "WebSocket" --> page
```

## Run

```sh
pnpm dev:up
pnpm samples:up
```

Open http://localhost:3010, sign in with any name, and try:

- **add a task: buy milk** · the agent's `createTask` tool calls `POST /api/tasks` on the .NET API with your access token. The API publishes `entity.changed`, and every open page refreshes its task list.
- **list my tasks** · a server tool reading from the API.
- **switch to dark mode** · a frontend tool. The page offers `setTheme` in `RunAgentInput.tools`; the agent asks for it, the run ends, the page runs it and sends the result in a new run, and the agent finishes.
- **delete all tasks** · a tool that needs approval (`requireApproval: true`). The run pauses with an AG-UI interrupt; the page shows Approve and Reject and resumes the run with `RunAgentInput.resume`. Reload while it waits and the prompt comes back.
- Add a task with the form in a second browser, or reload while the agent answers.

## How the pieces connect

| Concern | Where |
| --- | --- |
| Login | The .NET API issues an ES256 access token (dev only; a real app uses its identity provider). The agent service verifies it with the API's public keys (`/.well-known/app-jwks.json`) |
| Realtime tokens | The .NET API (`MapRealtimeTokenEndpoints` at `/api/realtime`). It knows who owns each run because the agent service records it |
| Runs | The agent service (`createRunEndpoints`). `onRunCreated` and `onRunFinished` call the API's `/internal/runs` endpoints with a service key |
| Threads | The .NET API stores them; the page loads a thread from `GET /api/threads/{id}` |
| Live data | The .NET API publishes `entity.changed` on `live:t-acme.tasks` with `Rtb.Publisher` over gRPC; the page refetches |
| Agent tools | Created per request with the caller's access token, so the API sees the real user |

Both services sign realtime tokens with the dev stack's key here. In production, put one signing key in the vault for both, and serve its JWKS from the .NET API.

## Approval needs Mastra storage

Resuming after an approval loads the paused run from Mastra storage, so the agent is registered on a `Mastra` with a store that every run shares (`InMemoryStore` here). With more than one agent-service process, use a shared store such as LibSQL or Postgres. The page keeps the paused run stored, so a reload replays it and AG-UI restores `pendingInterrupts`, within the backbone's 10-minute history window.

## Tests

```sh
pnpm e2e tests/mastra-dotnet.spec.ts
```
