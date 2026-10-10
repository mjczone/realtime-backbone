# realtime-backbone

A realtime service for every workload: AI agent chat, background jobs, UI updates and system broadcasts. It is [Centrifugo](https://centrifugal.dev) (Apache 2.0, unmodified) on a Valkey backplane, packaged with a channel and event contract, thin SDKs for TypeScript, .NET and Python, and deployment for Compose, Railway and Kubernetes.

Backends publish over Centrifugo's server API. Browsers subscribe with short-lived tokens that the app's backend mints. Centrifugo never calls back into an app.

```mermaid
flowchart LR
  pub["Backends, workers, agents<br/>@rtb/publisher, Rtb.Publisher, rtb-publisher"] -- "server API (private)" --> cf["Centrifugo nodes"]
  cf <--> valkey[("Valkey")]
  cf -- "WebSocket, SSE, HTTP-stream" --> web["Browsers<br/>@rtb/client, @rtb/agui-client"]
  web -- "tokens, run requests" --> pub
```

- Design: [docs/DESIGN.md](docs/DESIGN.md). Plan and status: [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md).
- Channel names: [spec/channels.md](spec/channels.md). Envelope and events: [spec/events.md](spec/events.md).

## Quickstart (dev stack, 5 minutes)

Needs Docker, Node 22+ and pnpm.

```sh
pnpm install
pnpm dev:up          # Valkey, the backbone and a demo; test page at http://localhost:8080
pnpm dev:doctor      # checks the config and the backplane
```

The test page shows job ticks, an agent run that survives a reload, presence and per-user notices. Try `?transport=sse` to see the fallback transport.

Agent chat samples (Mastra, Microsoft Agent Framework, Pydantic AI and LangGraph, scripted models, no API key), and a Python backtest worker:

```sh
docker compose --profile samples up -d --build
# Mastra: http://localhost:3001   MAF: http://localhost:3002   Pydantic AI: http://localhost:3003   LangGraph: http://localhost:3004
docker compose --profile signals run --rm py-signals
```

`pnpm dev:down` stops everything; `pnpm dev:purge` also deletes the data in `.data/`. Ports can be changed with `RTB_CLIENT_PORT`, `RTB_DEMO_PORT`, `RTB_SAMPLE_PORT`, `RTB_MAF_SAMPLE_PORT`, `RTB_PY_SAMPLE_PORT` and `RTB_LANGGRAPH_SAMPLE_PORT`.

## What's in the repo

| Path | What |
| --- | --- |
| `spec/` | Channel grammar, envelope schema and the conformance vectors both SDKs run |
| `config/centrifugo.json` | The backbone's Centrifugo config; secrets come from `CENTRIFUGO_*` env vars |
| `images/backbone` | The backbone image: pinned Centrifugo plus the config and `rtb-doctor` |
| `tools/doctor` | `rtb-doctor` (Go): checks the config and the Valkey backplane |
| `ts/` | `@rtb/contract`, `@rtb/publisher`, `@rtb/tokens`, `@rtb/client`, `@rtb/agui-client`, `@rtb/mastra` |
| `dotnet/` | `Rtb.Contract`, `Rtb.Publisher` (gRPC), `Rtb.Tokens`, `Rtb.AgentFramework` |
| `python/` | `rtb-contract`, `rtb-publisher` (HTTP and gRPC), `rtb-tokens`, `rtb-agui`; see [python/README.md](python/README.md) |
| `samples/` | `mastra-chat`, `maf-chat`, `py-chat` (Pydantic AI and LangGraph), the chat page they share, and the `py-signals` backtest worker |
| `deploy/compose` | Single-host deployment from published images |
| `deploy/railway` | Railway template |
| `deploy/helm` | Helm chart wrapping the upstream Centrifugo chart |
| `docs/` | Design, plan, [backplane guide](docs/deploy/backplane.md), [runbooks](docs/runbooks/), [publishing with curl](docs/publish-with-curl.md), [SDK spec](docs/sdk-spec.md), [SOC 2 controls](docs/soc2-controls.md) |

Package names (`@rtb/*`, `Rtb.*`, `rtb-*`) are placeholders until the project's name is settled. Nothing is published to npm, NuGet or PyPI yet.

## Tests

| Command | What |
| --- | --- |
| `pnpm build && pnpm test` | TypeScript unit tests and conformance vectors |
| `pnpm --filter @rtb/integration test:integration` | TypeScript against the backbone and Valkey in containers |
| `cd dotnet && dotnet test` | .NET unit tests, conformance vectors and integration tests |
| `cd python && uv run pytest` (add `-m integration` for containers) | Python unit tests, conformance vectors and integration tests |
| `pnpm --filter @rtb/e2e test` | Browser tests against the running dev stack and samples |

## License

MIT, see [LICENSE](LICENSE). Centrifugo is Apache 2.0; see [NOTICE](NOTICE).
