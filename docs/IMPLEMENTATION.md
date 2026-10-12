# Realtime Backbone Implementation Plan

Derived from [DESIGN.md](DESIGN.md) (Oct 10, 2026). Covers v0 in full and sketches v1.

## Status (Oct 10, 2026)

Phases 0 to 7 are built and tested locally. What is left needs the user, a GitHub remote or a cloud account; see "Not done yet".

| Phase | State | Proof |
| --- | --- | --- |
| 0 Spec and spikes | Done | `spec/`, spike table below, answers in DESIGN.md |
| 1 Config, image, doctor, dev stack | Done | `pnpm dev:up`; Playwright test page tests (ticks over WebSocket, SSE and HTTP-stream; reload mid-run; two tabs; access denied); backbone restart mid-run kept every delta |
| 2 Contract libraries | Done | Both languages pass every vector in `spec/vectors/` |
| 3 Publishers and tokens | Done | Unit tests (ordering under injected failures, retries, guard, size) and Testcontainers integration tests in both languages; Centrifugo accepts tokens from both SDKs, and both derive the same `kid` |
| 4 Browser client and AG-UI adapter | Done | `@mjczone/realtime-client`, `@mjczone/realtime-agui-client`; Playwright reload and second-viewer tests |
| 5 Agent sinks and samples | Done | `@mjczone/realtime-agui-server`, `MJCZone.Realtime.AgUi` with `MJCZone.Realtime.AgUi.AgentFramework`, `samples/mastra-chat`, `samples/maf-chat`; the same 5 Playwright tests pass against both samples with scripted models |
| 6 Packaging and operations | Done locally | Compose deployment smoke-tested; Helm chart installed on kind with `helm test` passing and the NetworkPolicy enforced; runbooks; load test with results in DESIGN.md |
| 7 Release | Done | v0.1.0 released Oct 11, 2026: images and chart on ghcr.io (public), packages on npm, NuGet and PyPI, all through trusted publishing |
| Mastra + .NET sample (added Oct 10, 2026) | Done | `samples/mastra-dotnet`: a plain `@ag-ui/client` page, a .NET API (login, tasks, threads, realtime tokens, `entity.changed` over gRPC) and a Mastra service (`@mjczone/realtime-agui-server`) whose tools call the API as the user; frontend tools and approvals with resume, including after a reload; 8 Playwright tests |
| realtime-gateway (added Oct 10, 2026) | Done locally | `gateway/` (Go) and `images/gateway`: scoped publish keys, server and browser token endpoints, the AG-UI run proxy with webhooks, run owners and cancels shared through Valkey, the browser client at `/v1/client.js`; Go tests pass the shared vectors and full runs against a fake agent and Centrifugo; `samples/mastra-dotnet` on port 3012 runs through it (plain AG-UI endpoint, HTTP publish, gateway client) and passes the same 8 Playwright tests |
| Python track (added Oct 10, 2026) | Done | `python/`: `mjczone-realtime-contract`, `mjczone-realtime-publisher` (HTTP and gRPC), `mjczone-realtime-tokens`, `mjczone-realtime-agui`; same vectors as TS and .NET, same `kid` for the same key; Testcontainers integration tests over HTTP and gRPC; `samples/py-chat` passes the same Playwright tests on both Pydantic AI and LangGraph (`AGENT=langgraph`); `samples/py-signals` replays candles through a strategy and publishes progress, signals and order status |

**Where the build differs from this plan, and why**

- **Helm and `realtime-doctor`.** The upstream chart sets `command: centrifugo`, which bypasses the image entrypoint, and mounts its own ConfigMap over `/centrifugo`. So in Kubernetes `realtime-doctor` runs as an init container (`--mode warn` or `strict`) and as `helm test`, names are fixed (`fullnameOverride: realtime-backbone`) so values can reference them, and `scripts/sync-helm-config.mjs` copies `config/centrifugo.json` into the chart's values (CI checks it).
- **`realtime-doctor --mode`.** Added `warn`, `strict` and `off` for the init container; the default still exits 0, 1 or 2.
- **Dashboard.** The chart ships a small dashboard of its own. The official one (grafana.com 13039) has no clear license to vendor; the docs say to import it.
- **`MJCZone.Realtime.Publisher`.** No scoped `ITenantContext`. `IRealtimePublisher.ForTenant(t)` covers multi-tenant callers, the same as the TS SDK.
- **`MJCZone.Realtime.Tokens`.** Signs with `System.Security.Cryptography.ECDsa` directly; no JWT library at runtime.
- **`@mjczone/realtime-client`.** `onError` is for transient errors (it retries) and `onFailed` for a subscription that ended for good. It re-exports centrifuge-js's `UnauthorizedError`; token callbacks throw it on 401 or 403, or the client retries forever.
- **`@mjczone/realtime-agui-server`, not `@mjczone/realtime-mastra`.** The sink and run helpers take any agent whose `run(input)` returns AG-UI events and don't depend on `@ag-ui/mastra`, so the name says what it does. Mastra is only used in its tests.
- **`MJCZone.Realtime.AgUi` and `MJCZone.Realtime.AgUi.AgentFramework`, not `MJCZone.Realtime.AgentFramework`.** The sink, runner and run endpoints work with any `IAgUiEventSource` and only need `AGUI.Abstractions`; the MAF adapter, with `AGUI.Server` and `Microsoft.Agents.AI`, is its own package so other .NET apps don't pull MAF in.
- **`@mjczone/realtime-agui-client`.** Reattach is AG-UI's own `connectAgent()`; the agent implements `connect()`. Lost history becomes `RUN_ERROR` with code `rtb.history_lost`. A run that ends with an interrupt stays stored, so a reload replays it and the agent gets its `pendingInterrupts` back.
- **Run endpoint.** Every sample run also publishes `notice.run_started`, so the user's other tabs join. Cancel publishes `RUN_ERROR` with code `rtb.cancelled`.
- **`history_size`** is 2000, not 1000, from the load test: a run replays from its start only while all of it fits in history.
- **Load test** is a Node script (`tools/loadtest`) using the real SDKs, not k6.
- **.NET** targets `net10.0` only.
- **Dev stack ports** are configurable (`RTB_CLIENT_PORT` and others), because 8000 is often taken.
- **Samples** sign tokens with the dev stack's key (`.data/keys/`), so the one JWKS covers them.

**Not done yet**

- Reserving the `MJCZone.` prefix on NuGet is optional.
- Build the Railway template in the Railway dashboard from `deploy/railway`.
- Run `realtime-doctor` against a managed Valkey and record it in `docs/deploy/backplane.md`.
- Re-run the load test on production-sized infrastructure with real agent runs.

## Shape of the work

v0 has three kinds of deliverable, and they depend on each other in this order:

```
spec (channel grammar, envelope schema, test vectors)
  ├─► runtime (Centrifugo config, backbone image + doctor, dev stack, later Compose deploy, Railway, Helm)
  ├─► TS track:   contract ─► publisher ─► tokens ─► browser client ─► Mastra sink ─► sample
  └─► .NET track: contract ─► publisher ─► tokens ──────────────────► MAF sink ────► sample
                                                    (browser client is shared by both samples)
```

The spec is the only hard serial step. After it is frozen, the runtime, TS and .NET tracks run in parallel. Build the **TS track first as a vertical slice** (Compose, then publisher, tokens, browser client and Mastra sink), because it proves the full agent-chat loop end to end with the fewest unknowns. The .NET track follows and reuses the browser client and the conformance vectors.

## Repo layout

Placeholder names until open question 1 (name and home) is settled. Pick the final names before the first package is published, because package IDs are permanent.

```
realtime-backbone/
├─ package.json              Root scripts (dev:up, dev:down, dev:purge, …); also the pnpm workspace root
├─ pnpm-workspace.yaml       ts/*, samples/*, images/demo
├─ scripts/                  dev-purge.mjs and other repo scripts (Node, so they run on Windows too)
├─ compose.yaml              Dev stack only; builds images from this repo
├─ .data/                    Dev volumes as bind mounts (gitignored)
├─ .gitignore                dotnet template plus .env, tmp/, private/, node_modules/; Phase 1 adds .data/
├─ tmp/                      Working notes and scratch, per CLAUDE.md (gitignored)
├─ docs/                     DESIGN.md, IMPLEMENTATION.md, runbooks/, channel-spec.md, deploy/backplane.md
├─ spec/
│  ├─ envelope.schema.json   JSON Schema for the envelope (v1)
│  ├─ channels.md            Formal grammar for channel names
│  └─ vectors/               Shared conformance cases, read by both test suites
│     ├─ channels.valid.json / channels.invalid.json
│     ├─ envelopes.valid.json / envelopes.invalid.json
│     └─ guard.json          (tenant context, channel, expected allow/deny)
│  └─ events.md              Catalogue of built-in event types and their data shapes
├─ config/
│  └─ centrifugo.json        Base config; secrets only via CENTRIFUGO_* env
├─ tools/doctor/             realtime-doctor (Go): backplane and config checks, shipped in the backbone image
├─ images/
│  ├─ backbone/Dockerfile    Pinned Centrifugo v6 + config/centrifugo.json + realtime-doctor
│  └─ demo/Dockerfile        Demo publisher + test page + dev token endpoint
├─ deploy/
│  ├─ compose/               compose.yaml using published images, .env.example, README
│  ├─ railway/               Railway template source: per-service railway.json, variables, README
│  └─ helm/realtime-backbone Chart wrapping centrifugal/centrifugo, using the backbone image
├─ proto/centrifugo/         Vendored api.proto pinned to the Centrifugo v6 tag
├─ ts/                       Workspace packages
│  ├─ contract/              @mjczone/realtime-contract   channel build/parse, envelope types, ULID, guard
│  ├─ publisher/             @mjczone/realtime-publisher  HTTP publish, audit, batching
│  ├─ tokens/                @mjczone/realtime-tokens     connection/subscription JWTs + fetch handlers
│  ├─ client/                @mjczone/realtime-client     centrifuge-js wrapper, dedupe, envelope parsing
│  ├─ agui-client/           @mjczone/realtime-agui-client AG-UI AbstractAgent over a subscription
│  └─ agui-server/           @mjczone/realtime-agui-server AG-UI sink + run endpoint helper (Mastra or any AG-UI agent)
├─ python/                   uv workspace: mjczone-realtime-contract, mjczone-realtime-publisher, mjczone-realtime-tokens, mjczone-realtime-agui, integration tests
├─ dotnet/                   one solution
│  ├─ src/MJCZone.Realtime.Contract       channel, envelope, guard (no dependencies)
│  ├─ src/MJCZone.Realtime.Publisher      gRPC client from vendored proto, DI, audit, batching
│  ├─ src/MJCZone.Realtime.Tokens         JWT minting + MapRealtimeTokenEndpoints()
│  ├─ src/MJCZone.Realtime.AgUi           AG-UI sink + run endpoint helper (any AG-UI event source)
│  ├─ src/MJCZone.Realtime.AgUi.AgentFramework  MAF as an AG-UI event source
│  └─ test/…
├─ samples/
│  ├─ mastra-chat/           Mastra agent service + web page
│  └─ maf-chat/              ASP.NET Core MAF agent service + same web page
└─ .github/workflows/        CI, integration tests, release
```

**Repo state at handoff (Oct 10, 2026):** git is initialized with no remote. The root holds `CLAUDE.md` (KISS rules; `tmp/` for working notes), a `.gitignore` from the `dotnet new gitignore` template plus `.env`, `tmp/`, `private/` and `node_modules/`, and an `npm init` stub `package.json` (ISC, `commonjs`). Phase 1 replaces the stub with `private: true`, `license: MIT`, `type: module`, a `packageManager` pin for pnpm and the `dev:*` scripts, and adds `.data/` to `.gitignore`. One trap in the template: `**/[Pp]ackages/*` ignores any directory named `packages/`, so workspace packages live in `ts/`, never in a `packages/` folder.

**One deliberate split from DESIGN.md:** the design lists one TypeScript publisher package that also does the Mastra sink and token minting. Splitting it keeps a plain Node worker from pulling in Mastra and AG-UI dependencies, and keeps the browser bundle free of Node code. The browser package also splits, so `@ag-ui/client` is only a dependency for apps that use the agent adapter.

## Phase 0: spec and spikes

Settle the contract and retire the unknowns that could change it.

**Spec**

- **Channel grammar** (`spec/channels.md`), written as a regex per audience plus a parser contract:
  - `tier` ∈ `live | replay | presence`.
  - `scope` is `global` or `t-<tenant>`. Tenant IDs are alphanumeric plus `-` and `_`: `[A-Za-z0-9_-]{1,64}`. That excludes `.`, `:`, `#` and `,`, which would break parsing. `global` is rejected as a tenant ID. Matching is exact and case-sensitive (Centrifugo channel names are), so `Acme` and `acme` are different tenants. Apps that want case-insensitive tenants should lowercase before minting or publishing.
  - `topic` and `id` are `[A-Za-z0-9_-]+`. A channel has exactly `topic` or `topic.id` after the scope. Deeper nesting is rejected in v0; it can be opened later without breaking existing names.
  - Reserved topic words: `all`, `grp`, `user`, `run`. They carry the meanings in DESIGN.md's audience table and can't be used for ordinary records.
  - `#` appears only in the `user#<userId>` form, in `live` and `replay` (both have `allow_user_limited_channels` in DESIGN.md's config), never in `presence`. User IDs are `[A-Za-z0-9_-]{1,128}`.
  - 255 ASCII characters at most.
  - `channel_regex` per namespace (confirmed in the spike) lets Centrifugo reject malformed names at the edge, so the grammar isn't enforced only in the SDKs. Go regexp has no lookahead, so the edge checks the shape and the SDKs also check reserved words.
  - `presence` has no `global`, `all` or `#` channels, so a presence call never returns a tenant-wide roster.
  - Written up in `spec/channels.md`, with vectors in `spec/vectors/`.
- **Envelope schema** (`spec/envelope.schema.json`): required `v`, `id`, `type`, `tenant`, `source`, `ts`, `data`; optional `corr`. `type` pattern `^[a-z][a-z0-9]*\.[A-Za-z0-9_.]+$`. The families `agui`, `job`, `entity`, `notice` and `system` are reserved and defined by us; apps may add their own (`inventory.low`). `agui.*` carries the AG-UI event type verbatim. The 64 KB cap is enforced by the SDKs, since a schema cannot express it. The JSON Schema is for docs and tests; the SDK validators are hand-written so the browser bundle needs no schema library.
- **Event catalogue** (`spec/events.md`): data shapes for the built-in types we rely on, so every app agrees: `entity.changed` (`{ entity, id, op }`), `notice.run_started` (`{ runId, threadId, channel, offset, epoch }`), `job.progress` (`{ jobId, pct, step? }`), `job.finished`, `system.maintenance`. Anything not listed is app-defined.
- **Presence guidance:** Centrifugo returns the whole subscriber set on a presence call, so presence channels must stay small: one per record or room, never tenant-wide. "Who is online" at tenant scope should use `presence_stats` (counts only) or the app's own last-seen store.
- **Guard rules** as test vectors (`spec/vectors/guard.json`, with fixed reason codes so both languages fail the same way), including publishing to `global`. A single publisher flag, `allowGlobal` (or the `RTB_ALLOW_GLOBAL=true` environment variable), lets that publisher write to `global.*` channels. On a private network, set it on every publisher that needs it. It is off by default, so a tenant-scoped worker can't broadcast to everyone by mistake. Like the rest of the tenant guard, it is enforced in the SDK: Centrifugo doesn't check it, and a raw `curl` with the API key can still publish anywhere.

**Spikes** (answered Oct 10, 2026 against Centrifugo v6.9.7, the latest v6 release, its docs and source, and a real Centrifugo plus Valkey 8.1 in containers; spike scripts live in `tmp/spike/`)

| Spike | Question | Answer |
| --- | --- | --- |
| v6 config keys | Exact v6 keys for the API, TLS, tokens, internal port, Sentinel, transports, health, `channel_regex` | Confirmed from `centrifugo defaultconfig`: `http_api.key`; `grpc_api.{enabled,port,key,tls.{enabled,cert_pem,key_pem,client_ca_pem}}` (PEM fields take a file path, raw PEM or base64); `client.token.{jwks_public_endpoint,audience,issuer}`; `client.subscription_token.{enabled,jwks_public_endpoint,audience,issuer}`; `http_server.internal_port` (moves API, health, Prometheus and admin off the client port; checked: client-port `/api/publish` is 404); `engine.type: redis` with `engine.redis.{address,password,sentinel_address,sentinel_master_name,tls}`; `sse.enabled`, `http_stream.enabled`; `health.enabled` (`/health`); `prometheus.enabled` (`/metrics`); `client.allowed_origins`. Env vars are the path upper-cased with `_`, for example `CENTRIFUGO_HTTP_API_KEY`, `CENTRIFUGO_ENGINE_REDIS_ADDRESS`, `CENTRIFUGO_CLIENT_TOKEN_JWKS_PUBLIC_ENDPOINT`. Centrifugo exits at startup if Redis is unreachable. Minimum Redis is 6.2; Valkey is "should work, not tested" upstream, so our tests are the proof. [configuration](https://centrifugal.dev/docs/server/configuration), [engines](https://centrifugal.dev/docs/server/engines) |
| `publication_data_format` | Does `json_object` exist in v6? | Yes, since v6.5.2. Checked: an array or string payload gets `107: bad request` on the server API, an object is accepted. Applies to server API and client publishes. [channels](https://centrifugal.dev/docs/server/channels#publication_data_format) |
| JWKS verification | EC keys? Subscription tokens? Caching? | `RSA`, `EC` and `OKP` (Ed25519) are supported. `client.subscription_token` takes its own `jwks_public_endpoint`. Keys are cached per URL and `kid` for one hour; an unknown `kid` triggers a fetch (1 s timeout, one retry). Checked: ES256 connection and subscription tokens from a local JWKS are accepted. Tokens must carry `kid`. [authentication](https://centrifugal.dev/docs/server/authentication#json-web-key-support), [channel tokens](https://centrifugal.dev/docs/server/channel_token_auth#separate-subscription-token-config) |
| API key rotation | More than one API key at a time? | No. One `http_api.key` and one `grpc_api.key`. Rotation needs a short coordinated window (or the v1 edge). |
| Image base | Shell or scratch? | `centrifugo/centrifugo:v6.9.7` is Alpine with `/bin/sh`, runs as `centrifugo` (uid 1000), workdir `/centrifugo`, `CMD ["centrifugo"]`, no entrypoint. `realtime-doctor` stays the entrypoint anyway (signals, PID 1). |
| mTLS reality | Is the client certificate's identity logged? CRL or OCSP? | Neither. With `client_ca_pem` set, Centrifugo uses `RequireAndVerifyClientCert` and nothing more (no `PeerCertificates`, CRL or OCSP code in the v6.9.7 source). Use short-lived certificates; attribution is the SDK audit log. DESIGN.md's SOC 2 table is updated. `http_server.internal_tls.client_ca_pem` can do the same for the HTTP API. |
| Recovery from a known position | Does `since` deliver the publication at `offset`? | No, only those after it. Checked with centrifuge-js 5.7.4: `since: {offset: offset - 1, epoch}` delivers `RUN_STARTED` first and exactly once, including `offset - 1 = 0` on a new channel and a `RUN_STARTED` in the middle of a stream. A wrong epoch subscribes with `recovered: false` and no publications, so the client must then load state from the app's API. |
| History metadata TTL | Name and default? | `history_meta_ttl`, per namespace or `channel.history_meta_ttl`, default `720h` (30 days). Must be larger than `history_ttl`. [channels](https://centrifugal.dev/docs/server/channels#history_meta_ttl) |
| `channel_regex` | Does it exist per namespace? | Yes. Go regexp (no lookahead), matched against the part after `<namespace>:`, checked only for client subscriptions. Checked: `live:t-acme.a.b.c` is refused with `107` even with a valid subscription token. [channels](https://centrifugal.dev/docs/server/channels#channel_regex) |
| Idempotency window | How long are idempotency keys kept? | 5 minutes, per channel. Publisher retries stop well inside it (default total retry time 30 s). [server API](https://centrifugal.dev/docs/server/server_api) |
| MAF AG-UI stream | Can MAF hand us an `IAsyncEnumerable` of events? Does it honor our `runId`? | Yes to both, with public APIs only. `AGUI.Server` 1.0.0 (stable, from the AG-UI project) plus `Microsoft.Agents.AI` 1.24.0: `input.ToChatRequestContext(jsonOptions)`, then `agent.RunStreamingAsync(ctx.Messages, session, new ChatClientAgentRunOptions { ChatOptions = ctx.ChatOptions }).AsChatResponseUpdatesAsync().AsAGUIEventStreamAsync(ctx)` gives `IAsyncEnumerable<BaseEvent>`; serialize with `AGUIJsonSerializerContext.Default.BaseEvent`. `RUN_STARTED`/`RUN_FINISHED` carry `input.RunId` verbatim (an empty `RunId` is emitted as `""`, so we always set it). The JSON options must chain the agent and AG-UI resolvers, or the stream is just `RUN_STARTED`, `RUN_ERROR`. Events: `TEXT_MESSAGE_START`/`CONTENT`/`END`, one `TOOL_CALL_ARGS` per call, `TOOL_CALL_RESULT`; no `MESSAGES_SNAPSHOT`, and state events only when opted in per tool. A scripted `IChatClient` in a `ChatClientAgent` drives it with no key. `Microsoft.Agents.AI.Hosting.AGUI.AspNetCore` (still preview) is not needed. So the MAF sink is small, and `IAgUiEventSource` stays a thin seam. |
| Mastra AG-UI stream | Does `MastraAgent.run(input)` return the Observable, honoring our `runId`? | Yes. `@ag-ui/mastra` 1.1.6: `new MastraAgent({ agent, resourceId }).run(input): Observable<BaseEvent>`, and `RUN_STARTED`/`RUN_FINISHED` carry `input.runId`. Text arrives as `TEXT_MESSAGE_CHUNK`, so the sink pipes the stream through `transformChunks` from `@ag-ui/client` to get `TEXT_MESSAGE_START`/`CONTENT`/`END`. Server tool calls arrive as one `TOOL_CALL_ARGS` unless `streamServerToolCalls: true`. `RUN_ERROR` is emitted once, then the Observable errors. A scripted model works with `MockLanguageModelV3` from `ai/test`, so CI needs no key. Peers: `@ag-ui/core`/`@ag-ui/client` 1.0.2, `@mastra/core` >=1.29 <2, `rxjs` 7.8. |
| Pydantic AI AG-UI stream (Oct 10, 2026, for the Python track) | Can Pydantic AI hand us an async iterator of AG-UI events? Does it honor our `runId`? | Yes. `pydantic-ai-slim[ag-ui]` 2.55.0: `AGUIAdapter(agent=agent, run_input=AGUIAdapter.build_run_input(body)).run_stream()` yields `ag_ui.core` events; `RUN_STARTED`/`RUN_FINISHED` carry the input's `threadId` and `runId`. Text is `TEXT_MESSAGE_START`/`CONTENT`/`END` (no chunks); an empty text message opens before a tool call so it has a `parentMessageId`; no snapshots by default. Errors become a `RUN_ERROR` event and are not raised. `FunctionModel(stream_function=…)` scripts it with no key. Serialize with `model_dump(mode="json", by_alias=True, exclude_none=True)`. It pins `ag-ui-protocol<1`, so `mjczone-realtime-agui` takes events as dicts or pydantic models and doesn't depend on that package. LangGraph's `ag-ui-langgraph` also yields events and honors the run ID; see the next row. |
| LangGraph AG-UI stream (Oct 10, 2026) | Same questions for LangGraph | Yes. `ag-ui-langgraph` 0.0.47: `LangGraphAgent(name=, graph=).run(RunAgentInput)` yields events; `RUN_STARTED`/`RUN_FINISHED` carry our IDs; text is START/CONTENT/END with one CONTENT per model chunk; tool calls stream as START/ARGS/END plus RESULT. It also sends `STEP_STARTED`/`STEP_FINISHED` and a `STATE_SNAPSHOT` per node, a `MESSAGES_SNAPSHOT` at the end, and RAW events unless `emit_raw_events=False` (58 KB vs 4 KB for a small run). It needs a checkpointer: a fresh `InMemorySaver` per run works for a stateless server that sends the full history. A failure yields `RUN_ERROR` without raising. Its package imports fastapi, so install `ag-ui-langgraph[fastapi]`. It coexists with Pydantic AI in one environment (both resolve to `ag-ui-protocol` 0.1.22), which corrects the row above. |
| Frontend tools and approvals with Mastra (Oct 10, 2026) | Do AG-UI frontend tools and human-in-the-loop interrupts work through `@ag-ui/mastra` and our transport? | Yes, with `@ag-ui/mastra` 1.1.6 and `@ag-ui/client` 1.0.2. **Frontend tools:** tools in `RunAgentInput.tools` become Mastra client tools; when the model calls one, the run streams `TOOL_CALL_START`/`ARGS`/`END` and ends with `RUN_FINISHED` without running it; `@ag-ui/client` reports `pendingToolCallIds`; the page runs the tool and starts a new run with the assistant tool call and a `tool` message. **Approvals:** a tool with `requireApproval: true` pauses the run: a CUSTOM `on_interrupt` and `RUN_FINISHED` with `outcome: { type: "interrupt", interrupts: [...] }` (no tool-call events in that run); the client sets `pendingInterrupts`, and resumes with `runAgent({ resume: buildResumeArray(...) })` (`{ status: "resolved", payload: { approved: true } }` or `{ status: "cancelled" }`). Resuming loads the paused run from Mastra storage, so the agent must be registered on a `Mastra` with a store every run shares (a shared DB across processes). One interrupt per resume run. Proven in `samples/mastra-dotnet` (8 Playwright tests). |
| Oversize AG-UI events | How large are `MESSAGES_SNAPSHOT` and `STATE_SNAPSHOT`? | Neither framework emits `MESSAGES_SNAPSHOT`. Mastra emits `STATE_SNAPSHOT` only for working memory (a few KB); MAF only when a tool is mapped to state. The `rtb.oversize` marker stays as a safety net; real sizes get measured in the Phase 6 load test. |

**Done when** the spec and vectors are committed and every spike has a recorded answer.

## Phase 1: config, backbone image, doctor and dev stack

**`config/centrifugo.json`**: start from the design's namespace block and add:

- `presence` namespace: `allow_presence_for_subscriber: true`. Without it, clients get join and leave pushes but cannot fetch the initial roster.
- `channel_regex` on each namespace, matching the grammar in `spec/channels.md`.
- Engine set to Redis/Valkey, with the address from the environment.
- Client token verification through a JWKS endpoint (`jwks_public_endpoint`, for connection tokens and the separate subscription-token block), with `audience` and `issuer`. One config shape covers both app-held keys and IdP keys; see Phase 3.
- HTTP API key and gRPC API from environment variables only.
- SSE and HTTP-stream transports enabled, so centrifuge-js has fallbacks where WebSockets are blocked. Without these keys DESIGN.md's "SSE and HTTP-streaming fallbacks" don't exist.
- Internal port carrying the HTTP API, health endpoint, Prometheus and (dev only) the admin UI. The health endpoint is what Compose health checks and Kubernetes probes hit.
- `allowed_origins` from the environment.
- `history_meta_ttl` set to a few multiples of `history_ttl` (`1800s` against `600s`), per the Phase 0 spike.

**`images/backbone/Dockerfile`**: `FROM centrifugo/centrifugo:v6.x.y` (an exact tag), with `config/centrifugo.json` copied in as the default config. Everything environment-specific (keys, Valkey address, origins) comes from `CENTRIFUGO_*` variables, so the same image runs in dev, Compose deployments, Helm and Railway. A multi-stage build compiles `realtime-doctor` and copies it into the image. `realtime-doctor` is the image's entrypoint: it runs its checks, then `exec`s Centrifugo with the same arguments. That works whether or not the base image has a shell, and keeps Centrifugo as PID 1 so signals reach it.

**`realtime-doctor`** (`tools/doctor/`, Go, one static binary):

- **Why Go:** it ships inside the backbone image with no runtime to install, and the v1 edge is planned in Go anyway.
- **Same settings as Centrifugo:** it reads the same `CENTRIFUGO_*` variables and config file, so it checks exactly what the backbone will use.

| Check | How | Fails on |
| --- | --- | --- |
| Reachable, auth, TLS | Connect using the configured engine address (plain, `rediss://` or Sentinel) | Any connection, auth or certificate error |
| Server and version | `INFO server`: Valkey or Redis, and the version | Below Centrifugo's documented minimum, Redis 6.2 (Valkey 7.2 and later report a compatible version) |
| Topology | `INFO replication` and `INFO cluster` | Cluster mode on while the config is single-node, or the reverse |
| Eviction policy | `maxmemory_policy` and `maxmemory` from `INFO memory`, since managed services often block `CONFIG GET` | `allkeys-*` policies, which can evict replay history. Warns on anything other than `noeviction`, and warns when `maxmemory` is `0` on a self-hosted instance, because then a full Valkey is OOM-killed instead of failing publishes |
| Persistence | `INFO persistence`: `aof_enabled` | Warns only. Managed services may persist differently and report it differently |
| Pub/sub | Subscribe and publish a round trip on a `realtime-doctor:*` channel | No message within 2 s |
| Lua | `SCRIPT LOAD` then `EVALSHA` on a trivial script | Command refused (restricted managed plans) |
| Streams | `XADD`, `XRANGE` and `DEL` on a temporary key with a TTL | Command refused |
| Latency | 50 `PING`s, report median and max | Warns above 5 ms max, which usually means the backbone and Valkey aren't on the same private network |
| Backbone config | Parse the effective config and check: API key set, token verification set, `aud` and `iss` set | Missing values. Warns (never fails) when `allowed_origins` is `*`, so dev tolerates it and production sees it in the log |

- **Output:** a table with pass, warn or fail per check. Exit code 0 means all pass, 1 means warnings, 2 means a failure. `--json` gives machine-readable output.
- **On startup:** as the entrypoint, it runs before Centrifugo. `RTB_DOCTOR=warn` (the default) logs results and starts anyway, `strict` refuses to start on a failure, and `off` skips it. Misconfiguration then shows up in the first lines of the log on every platform. In `strict` mode a Valkey outage during a rollout makes pods crash-loop until Valkey is back, which is the intended fail-fast behavior; the restart policy recovers them.
- **On demand:**
  - Any host: `docker run --rm --env-file .env ghcr.io/<owner>/realtime-backbone realtime-doctor`.
  - Railway: as a one-off command.
  - Kubernetes: a Helm test hook.
  - Dev: `pnpm dev:doctor`.
- The probes write only `realtime-doctor:*` keys with short TTLs and clean up after themselves, so running it against production is safe.

**Dev stack: root `package.json` plus root `compose.yaml`**

```json
{
  "scripts": {
    "dev:up":    "docker compose up -d --build --wait && echo Test page: http://localhost:8080",
    "dev:down":  "docker compose down",
    "dev:purge":  "node scripts/dev-purge.mjs",
    "dev:logs":   "docker compose logs -f",
    "dev:doctor": "docker compose exec backbone realtime-doctor"
  }
}
```

- `dev:up` builds the backbone and demo images from the repo and starts everything in the background. `--wait` blocks until the health checks pass, so the command returns only when the stack is usable.
- `dev:down` stops and removes the containers. Data in `.data/` is kept.
- `dev:purge` runs `docker compose down --remove-orphans`, then deletes `.data/`. Valkey writes its files as its container user, not as you, so a plain host `rm -rf` can fail with permission errors on Linux and WSL. The script therefore deletes the contents from inside a throwaway container (`docker run --rm -v <absolute path to .data>:/data alpine rm -rf /data/*`, with the path resolved in Node, since `docker run -v` wants an absolute path), then removes the directory. Running it as a Node script also keeps it working on Windows without a shell.
- Volumes are bind mounts under the repo: `./.data/valkey:/data`. `.data/` is created on first `dev:up`; add it to `.gitignore` when the dev stack lands (it isn't there yet).
- No secrets to set up: the dev stack uses a fixed, obviously-dev API key. Token signing keys are generated by the demo container on first start, kept in `.data/keys/`, and published at `http://demo:3000/.well-known/jwks.json`; the backbone's dev config points its JWKS verification at that URL. Nothing is shared between containers but a URL, so there's no startup-ordering problem: Centrifugo fetches keys on the first token it sees and retries on failure.
- Dev Valkey runs with `--maxmemory 256mb --maxmemory-policy noeviction --appendonly yes`, so dev fails the same way production does when history outgrows memory.
- The admin UI is enabled on the internal port in dev only, reachable through a published port, for poking at channels and presence.

**Dev services** (`compose.yaml`):

- `valkey` with AOF on, so dev uses the same persistence path as production.
- `backbone` (built from `images/backbone`). The client port is published to the host. The internal port (HTTP API, health, metrics, admin) is on the Compose network only, except the admin UI port in dev.
- `demo` (built from `images/demo`). One container that runs three things:
  - A publisher that sends job ticks to `live:t-demo.jobs.<id>` and a scripted fake agent run to `replay:t-demo.run.<id>`.
  - A dev-only token endpoint plus JWKS endpoint using `@mjczone/realtime-tokens`. It can start as a stub until Phase 3 lands.
  - The test page: static HTML with centrifuge-js (WebSocket with SSE fallback configured) showing live ticks, a replay run, a presence roster and a reload-mid-run demo.

**Done when**:

- `pnpm dev:up` from a clean clone shows ticks on the test page.
- Restarting the `backbone` container mid-run, then reloading, resumes the run from history.
- A `curl` to the internal port from the host fails, and `POST /api/publish` on the public client port returns 404, proving the API really moved to the internal port.
- `pnpm dev:purge` leaves no containers, networks or `.data/`.
- `pnpm dev:doctor` passes against the dev Valkey. In CI, it fails against a Valkey deliberately misconfigured with `allkeys-lru` and scripting denied through an ACL (`ACL SETUSER default -@scripting`).

## Phase 2: contract libraries (TS and .NET in parallel)

`@mjczone/realtime-contract` and `MJCZone.Realtime.Contract` expose the same surface:

- `Channel.parse(name) → { tier, tenant | global, topic, id?, userId? }` and builders per audience: `Channels.tenantAll(t)`, `Channels.record(t, topic, id)`, `Channels.group(t, g)`, `Channels.user(t, u)`, `Channels.run(t, runId)`, `Channels.presence(t, topic, id)`, `Channels.global(topic)`.
- An `Envelope` type, `createEnvelope({ type, tenant, source, corr?, data })` that fills in `v`, `id` (a monotonic ULID) and `ts`, plus a validator.
- `TenantGuard.check(context, channel, envelope)`: for a tenant channel, the channel's tenant must equal both the context tenant and `envelope.tenant`. For a `global` channel, `envelope.tenant` must be the literal `global` and the context must have `allowGlobal`; the context tenant is not compared.
- Both test suites run every file in `spec/vectors/`. That is the mechanism that keeps the two languages identical.

The contract packages have no runtime dependencies beyond a ULID implementation, so the browser client can use `@mjczone/realtime-contract` too.

## Phase 3: publishers and token minting

**Shared publisher behavior (both languages)**

```
publish(channel, type, data, { corr? })
  → validate channel → build envelope → size check (64 KB) → tenant guard
  → per-channel serial queue → API call (idempotency_key = envelope.id)
  → retry with backoff and jitter on transient errors (same envelope, same key)
  → audit log entry {component, tenant, channel, type, id, ts, outcome}
  → returns { offset, epoch } for history channels
```

- **Per-channel serial queue.** Retries and batching must not reorder messages on a channel, so each channel gets a FIFO queue with at most one request in flight. Different channels publish concurrently. This is the most important correctness property in the SDKs; test it directly.
- **Audit log.** Write a structured log event only, never the payload. The .NET SDK uses `ILogger` with a dedicated category. The TS SDK takes a logger interface and defaults to JSON on stdout.
- **Guard failures.** Throw, and write an audit entry with `outcome: denied` at warning level.
- **Idempotency key retention.** Centrifugo keeps idempotency keys for a limited window, so retries stop well inside it.

**TS publisher** (`@mjczone/realtime-publisher`): POST to `/api/publish` with `X-API-Key` using `fetch`. Configuration: `{ apiUrl, apiKey, source, tenant?, allowGlobal?, logger?, retry? }`. Expose `forTenant(t)` for multi-tenant workers.

**.NET publisher** (`MJCZone.Realtime.Publisher`):

- `Grpc.Net.Client` generated from the vendored proto, with `authorization: apikey <key>` metadata and a client certificate from configuration or a certificate store.
- `services.AddRealtimePublisher(o => …)` registers `IRealtimePublisher` and a scoped `ITenantContext`.
- Options are bound from configuration, with the key and certificate from the vault through standard configuration providers.

**Delta batcher** (both languages, used by the sinks but usable on its own):

- Buffers consecutive `TEXT_MESSAGE_CONTENT` events for the same `messageId` and concatenates their `delta`.
- Flushes when the interval elapses (default 75 ms, configurable 50 to 100 ms), when any other event type arrives (so ordering holds), or when the buffer nears the size cap.
- Applies the same rule to `TOOL_CALL_ARGS` deltas per `toolCallId`.

**Token minting** (`@mjczone/realtime-tokens` and `MJCZone.Realtime.Tokens`):

- `mintConnectionToken({ sub, ttl = 10m, info? })` sets `aud`, `iss` and `kid`. The `info` claim carries a display name for presence; it is visible to every subscriber of a presence channel, so apps put a display name there and nothing more.
- `mintSubscriptionToken({ sub, channel, ttl })`.
- **Signing and verification (answers open question 2):** the app holds an ES256 key (from the vault) and the SDK serves its public half at a JWKS endpoint (`/.well-known/rtb-jwks.json`, part of the endpoint helpers below). Centrifugo is always configured with a JWKS URL, never a pasted public key. If the adopter wants the IdP to mint connection tokens instead, only the URL changes; subscription tokens still come from the app through the separate subscription-token block, which has its own JWKS URL. Key rotation is then: add the new key to the JWKS, switch signing, drop the old key after the longest token TTL. If the spike finds Centrifugo's JWKS support lacks EC keys, use RS256; the SDK surface doesn't change. Symmetric (HS256) signing is deliberately not offered, per DESIGN.md's rule that Centrifugo holds only public keys.
- **Endpoint helpers** take an authorizer callback, so the app's own tenant and group checks stay the only source of authorization:
  - .NET: `app.MapRealtimeTokenEndpoints(authorize: (user, channel) => …)`.
  - TS: a framework-agnostic `(Request) => Response` handler with the same callback, usable from Hono, Next.js route handlers or Express through a small adapter.
- **Built-in checks before the callback:** the channel parses, its tenant equals the caller's tenant, and no subscription tokens are minted for `#` user channels, which use the connection token.
- **Run channels need the app to remember ownership.** A reattach after reload, or after the subscription token expires, goes through this same endpoint, so the `authorize` callback must be able to answer "may this user watch run X?". The run endpoint helper in Phase 5 therefore calls an app-supplied `onRunCreated(runId, threadId, ownerUserId)` hook so the app can persist it; the samples store it next to the thread.
- **Token endpoint load.** Reconnect storms hit this endpoint, so the helpers cache the user and group lookup for a short TTL. Document how to size the endpoint.

**Done when**:

- Integration tests run against Centrifugo and Valkey in Testcontainers in both languages, covering publish, recovery from a returned offset, ordering under injected failures, guard denials and token acceptance by Centrifugo.
- The conformance vectors pass in both languages.

## Phase 4: browser client

**`@mjczone/realtime-client`** wraps centrifuge-js:

- `createRealtimeClient({ url, getConnectionToken, getSubscriptionToken })`.
- `subscribe(channel, handler, { since? })` parses envelopes, drops invalid ones with a warning, and dedupes by `envelope.id` using a bounded LRU per subscription. Duplicates are possible after recovery and retried publishes.
- Exposes a typed event stream and connection state.
- User channels (`#`) skip the subscription-token callback.
- Presence helpers: `roster(channel)`, plus join and leave events.

**`@mjczone/realtime-agui-client`** provides `CentrifugoAgent extends AbstractAgent` from `@ag-ui/client`:

1. `run(input)` POSTs `RunAgentInput` to the agent service's run URL.
2. It receives `202 { runId, threadId, channel, token, epoch, offset }`.
3. It subscribes from that position, applying the Phase 0 offset rule (`offset - 1`).
4. It unwraps `agui.*` envelopes to AG-UI events and completes on `RUN_FINISHED` or `RUN_ERROR`.
5. Cancel and abort POST to the agent service. Nothing is published from the client.
6. Reattach: `CentrifugoAgent.attach(runChannel, position?)` resumes a run after reload or from a "run started" notice on the user channel. Store the run channel and last offset in `sessionStorage`.

**Done when** a Playwright test against Compose reloads mid-run and sees the full, unduplicated message, and two tabs watch one run.

## Phase 5: agent sinks and samples

**Run endpoint helper** (both languages) carries out run flow steps 2 to 5 in DESIGN.md:

1. Authorize the caller, create a `runId` (ULID), and call `onRunCreated` so the app records ownership (see Phase 3).
2. Publish our own `RUN_STARTED` (with `threadId` and `runId`) and capture `{ offset, epoch }`.
3. Mint a subscription token for `replay:t-<tenant>.run.<runId>`.
4. Return 202, then drive the agent in the background, passing our `runId` in `RunAgentInput`.
5. On completion, call an app-supplied `onRunFinished(messages)` so the app persists to its own thread store.

Three details the design doesn't spell out:

- **Two `RUN_STARTED`s.** Both frameworks emit their own `RUN_STARTED` at the head of the stream, and we already published one in step 2 (we need its offset before we can answer the request). The sink drops the framework's `RUN_STARTED`. The Phase 0 spike confirmed both frameworks honor the supplied `runId`, so no rewriting is needed.
- **Oversize events.** `MESSAGES_SNAPSHOT` and `STATE_SNAPSHOT` carry whole message lists and can exceed the 64 KB cap. Policy: the sink replaces an oversize event with `agui.CUSTOM` `{ name: "rtb.oversize", type, bytes }`, and the client fetches the current state from the app's API when it sees one. Text deltas never hit the cap because the batcher flushes before it.
- **The agent service must be a long-running process.** Step 4 does work after the response is sent. That's fine for ASP.NET Core and a Node service, and wrong for request-scoped serverless functions unless the platform offers a `waitUntil`-style primitive. Say so in the package READMEs.

**`@mjczone/realtime-agui-server`** (planned as `@mjczone/realtime-mastra`) subscribes to the `MastraAgent` Observable (or any AG-UI agent's), normalizes `TEXT_MESSAGE_CHUNK` with `transformChunks` (per the Phase 0 spike), and pipes it into the batcher and publisher. On error it publishes `RUN_ERROR`; the background task never fails silently.

**`MJCZone.Realtime.AgUi`** (planned as `MJCZone.Realtime.AgentFramework`) reads the AG-UI event stream through `IAgUiEventSource`; `MJCZone.Realtime.AgUi.AgentFramework` implements it for MAF (built on `AGUI.Server`'s `AsAGUIEventStreamAsync`, per the Phase 0 spike) and pipes it into the batcher and gRPC publisher. Pin `AGUI.Server` and `Microsoft.Agents.AI` exactly.

**Background runs:** an optional `notifyUser(userId, runChannel)` publishes `notice.run_started` (shape in `spec/events.md`) to the user's `live` channel.

**Thread versus run channels (answers open question 4):** one channel per run is enough for v0. The run channel carries the AG-UI stream; the thread's history comes from the app's API. If a UI needs to learn that a *new* run started on a thread it has open, that's a `notice.run_started` on the user channel, not a thread channel. Add `live:t-<tenant>.thread.<threadId>` later only if multi-user threads need it.

**Samples:**

- `samples/mastra-chat` and `samples/maf-chat` share one web page using `@mjczone/realtime-agui-client`.
- Each sample's README shows reload-mid-run, a second viewer, and a background run that notifies the user.

**Done when** both samples run against the Compose stack, and CI runs a smoke e2e test of both against a scripted or mock model, so no model key is needed.

## Phase 6: production packaging and operations

**Published images**

| Image | Contents | Used by |
| --- | --- | --- |
| `realtime-backbone` | Pinned Centrifugo v6 with our config baked in | Compose deployments, Helm, Railway, any container host |
| `realtime-backbone-demo` | Demo publisher, test page and dev token endpoint | Trying it out; never production |

- **Registries:** ghcr.io is the primary registry (`ghcr.io/<owner>/realtime-backbone`); it is free for public images and tied to the repo's permissions. The same workflow also pushes the `realtime-backbone` image (only that one) to Docker Hub when `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` secrets are set, under the `DOCKERHUB_NAMESPACE` repository variable (default: the GitHub owner, `mjczone`). Skip Docker Hub if you don't need it for discoverability.
- **Builds:** multi-arch (`linux/amd64`, `linux/arm64`) with buildx, plus SBOM and provenance attestations.
- **Tags:** `X.Y.Z`, `X.Y`, `latest` and `sha-<short git sha>`, with an OCI label recording the Centrifugo version inside.
- The image tracks the repo's version, not Centrifugo's. A Centrifugo patch bump is a backbone patch release.

**Compose deployment** (`deploy/compose/`, for single-host deployments):

- `compose.yaml` pulls `realtime-backbone:<version>` and the official `valkey/valkey` image (an exact tag). It builds nothing.
- `.env.example` lists every setting: API key, JWKS URLs for connection and subscription tokens, `aud`/`iss`, allowed origins, Valkey address, `DATA_DIR`, ports. Copy it to `.env`, which is gitignored.
- **Bundled Valkey is a Compose profile** (`COMPOSE_PROFILES=valkey`, on in `.env.example`). Drop the profile and set the Valkey address to use a managed Redis or Valkey instead. The backbone has no `depends_on` the `valkey` service, because Compose refuses a dependency on an inactive profile; startup ordering comes from `restart: unless-stopped` plus `realtime-doctor`, which fails fast until Valkey answers.
- **Data** goes to `${DATA_DIR:-./data}` as bind mounts, with AOF on, so backups are a directory copy.
- **Ports:**
  - The client port is published.
  - The API port binds to `${API_BIND:-127.0.0.1}`, so it is never public by accident.
  - The backbone's Docker network has a fixed name (`rtb`). Publishers on the same host declare it as `external` in their own Compose file and reach the API at `backbone:<port>` without any published port. Publishers elsewhere on the private network reach it through a private interface address set in `API_BIND`.
- `restart: unless-stopped` and health checks on every service.
- **TLS:** the client endpoint needs TLS. An optional `tls` profile adds Caddy with automatic HTTPS for a given domain. Otherwise, put the backbone behind your own reverse proxy or platform.
- **Limits:** this is one host and one Centrifugo node, which is fine for small installs and staging. Use Helm for high availability.
- README: upgrade (`docker compose pull && docker compose up -d`), backup and the API key rotation steps.

**Backplane by platform** (`docs/deploy/backplane.md`)

One rule decides the setup: Valkey only needs to be as available as Centrifugo. On a single host, bundled Valkey is the right choice, because a highly available Valkey can't outlive the host that Centrifugo runs on.

| Setup | What it is | When |
| --- | --- | --- |
| Bundled | The Compose `valkey` profile: one Valkey next to Centrifugo, with AOF and data in `DATA_DIR` | A single VM or Droplet, dev and staging, small installs |
| Platform-managed | The provider runs Valkey with automatic failover behind one endpoint, usually `rediss://`. Centrifugo needs only the address; Sentinel isn't involved | Anything with more than one Centrifugo node, when the platform offers it |
| Self-managed HA | 3 VMs running a primary, a replica and Sentinels. Centrifugo is given the Sentinel address | Bare VMs with no managed option and a real need for availability across hosts |

| Host | Recommended | Notes |
| --- | --- | --- |
| Railway | A Valkey service in the same project and environment, reached at `<service>.railway.internal` (this is the Railway template below) | Single instance with a volume, no failover. Private networking doesn't cross projects |
| DigitalOcean | Managed Caching for Valkey in the same VPC, with a standby node for failover. Backbone on App Platform or a Droplet | TLS required. A single Droplet with bundled Valkey is fine for small installs |
| Vultr | Managed Databases for Valkey in the same VPC, with at least 1 replica for automatic failover | Or a VM with bundled Valkey for small installs |
| OVHcloud | Public Cloud Databases for Valkey, on the private network | Or a VM with bundled Valkey |
| Hetzner and other VM-only hosts | Bundled Valkey on one VM, or self-managed Sentinel across 3 VMs | No first-party managed Valkey; see the provider-neutral options below |
| AWS | ElastiCache for Valkey, **node-based** | Avoid ElastiCache Serverless, which bills by request units (the same problem as pay-per-request Redis) |
| Google Cloud | Memorystore for Valkey, **cluster mode disabled** | The mode is fixed at creation. Cluster mode needs Centrifugo's cluster configuration and is a "Large profile" decision |
| Azure | Azure Managed Redis | Azure Cache for Redis is being retired. Confirm the clustering policy gives Centrifugo a single endpoint, or configure Centrifugo for cluster mode |
| Any cloud, provider-neutral | Aiven for Valkey (runs on AWS, GCP, Azure, DigitalOcean and others), or Redis Cloud on a fixed-size plan | For adopters who want one vendor across clouds |

What every backplane must support. `realtime-doctor` checks all of these:

- PUB/SUB, Lua scripting (`EVALSHA`) and Streams.
- Eviction policy `noeviction`, so a full Valkey fails publishes visibly instead of silently evicting history.
- AOF or the provider's equivalent persistence, if replay must survive a Valkey restart.
- Private network access, and TLS where offered.
- **Fixed-capacity pricing, not per-request.** Centrifugo holds pub/sub connections open and pings constantly, which makes per-request billing expensive. This applies to Upstash pay-as-you-go and to ElastiCache Serverless. Fixed-price plans from those vendors may be fine, but run the load test against them first.

**Railway template** (`deploy/railway/`)

A one-click deploy with two services in one project:

- **`valkey`:**
  - The official `valkey/valkey` image with a volume at `/data`.
  - Start command: `valkey-server --bind "* -::*" --appendonly yes --maxmemory <plan size> --maxmemory-policy noeviction --requirepass $VALKEY_PASSWORD`. The `-::*` makes Valkey listen on IPv6, which Railway's private network needs. Verify whether Railway expands `$VAR` in start commands; if not, wrap it in `sh -c '…'`.
  - If Railway's marketplace has an official Valkey template by then, use it in place of this service and only add the flags above.
  - No public domain.
- **`backbone`:**
  - The `realtime-backbone` image from ghcr.io.
  - Engine address from Railway variable references (`${{valkey.RAILWAY_PRIVATE_DOMAIN}}`).
  - API key and Valkey password generated at deploy time with Railway's secret generator.
  - `RTB_DOCTOR=strict`, so a broken setup fails the deploy instead of running half-configured.
  - A public domain for the client port only. The API port stays on the private network.

Railway composes templates in its dashboard rather than from a file in the repo. So `deploy/railway/` holds the per-service `railway.json`, the variable list and a README for rebuilding the template, and the template itself is published from the Railway dashboard with a "Deploy on Railway" button in our README.

Two things to verify while building it:

- Railway's private network has historically been IPv6-only; the `--bind` flag above covers it, and the doctor's connect check catches it if not.
- Railway private networking doesn't cross projects. The template README says so, and links to DESIGN.md's public-endpoint guidance for publishers elsewhere.

**Helm chart** (`deploy/helm/realtime-backbone`):

- Depends on the upstream `centrifugal/centrifugo` chart, pinned, rather than reimplementing it, and points it at our `realtime-backbone` image. Our values set the namespaces, internal-port separation, 3 replicas, a PodDisruptionBudget, and a rolling update with `maxUnavailable: 1`.
- Two Services: public client (behind ingress, with WebSocket support and SSE/HTTP-streaming paths), and internal API (HTTP and gRPC) restricted by a NetworkPolicy to labeled publisher namespaces.
- Secrets reference existing Kubernetes Secrets (populated by External Secrets or the CSI driver from the vault). The chart never takes secret values.
- **Valkey:** the production profile in DESIGN.md needs a highly available Valkey (a primary, replicas and 3 Sentinels). The chart doesn't install that. It takes the address of a Valkey or Redis the adopter already runs: a managed service from the backplane table above, or their own Sentinel deployment. Bundling HA Valkey is where most charts reach for Bitnami's Redis chart, and Bitnami stopped publishing free, maintained images in 2025, so bundling would mean picking and maintaining another chart. Revisit only if adopters ask.
- mTLS: optional cert-manager `Certificate` resources for the gRPC server and per-component client certificates, with short lifetimes if the Phase 0 spike shows no CRL support.

**Observability:**

- ServiceMonitor, the official Centrifugo Grafana dashboard as a ConfigMap, and a PrometheusRule with the alerts from DESIGN.md: pub/sub lag, Valkey memory and CPU, connections per node, and API error rate.
- Token-endpoint latency is the app's metric; document it.

**Runbooks** (`docs/runbooks/`):

- API key rotation. If v6 takes a single key (Phase 0 spike), plan a short, coordinated window, or put the v1 edge in front first; if it takes several, rotate by overlap.
- Token signing key rotation through the JWKS endpoint (Phase 3).
- Certificate revocation, Valkey failover, rolling upgrade, reconnect storm and an incident checklist.

**Load test:** a k6 or Go script that simulates N concurrent agent runs at a realistic delta rate. It answers open question 3 (batch interval and `history_size`) and gives the history-memory sizing guidance.

**Done when**:

- `deploy/compose` comes up on a clean host from published images.
- The Railway template deploys from its button with `realtime-doctor` passing.
- `realtime-doctor` has been run against at least one managed Valkey (DigitalOcean or Vultr), with the results recorded in `backplane.md`.
- The chart installs on kind in CI with an e2e smoke test.
- The load test results are written into DESIGN.md.

## Phase 7: release

- CI on every PR: lint and unit tests (both languages), conformance vectors, Testcontainers integration tests, a Compose smoke test and a chart lint/kind install.
- Release, triggered by one tag: npm (with provenance) and NuGet (signed) packages, the `realtime-backbone` and `realtime-backbone-demo` images to ghcr.io (and Docker Hub if configured), and the chart to ghcr.io as an OCI artifact. Everything shares one version.
- Docs: a quickstart (Compose in 5 minutes), "publish from any language with curl", a SOC 2 controls page and the channel spec.
- Add the MIT `LICENSE` and a `NOTICE` crediting Centrifugo (Apache 2.0) and the vendored proto.

## v1 sketch: scoped publisher edge

- A small proxy, preferably a Go service so it ships as one container, placed in front of the server API. It maps each component key (hashed) to allowed tenants and channel prefixes, enforces rate limits, writes an audit log, and forwards with the single Centrifugo key.
- The SDKs change only the endpoint and key. The guard stays client-side as defense in depth.
- This unlocks public publish endpoints, including for publishers in other Railway projects.

**Built as `realtime-gateway` (Oct 10, 2026), with more than the sketch.** It takes plain `{ channel, type, data }` and builds the envelope itself, so callers need no SDK at all. It also mints realtime tokens (for servers with a key, and for browsers with the app's access token) and proxies AG-UI runs: the page posts a run to the gateway, which calls the agent's own AG-UI endpoint and publishes the stream, so an existing AG-UI app adopts the backbone with config only. Still open from the sketch: channel prefixes per key, rate limits, hashed keys, and the SDKs pointing at the gateway (today they still talk to Centrifugo).

- **Run ownership** lives in Valkey (`realtime-gateway:run:<id>`, one hour) so any gateway copy can authorize the run channel and take the cancel; a cancel for a run another copy drives goes over Valkey pub/sub. Without `valkey` in the config it stays in memory, for one copy.
- **Same rules as the SDK sinks:** the agent's `RUN_STARTED` is dropped, chunks normalized, deltas batched at 75 ms, oversize events replaced, `skipTypes` guarded, and a stream that ends early becomes `RUN_ERROR` `rtb.agent_error`.
- **The app keeps its data.** The `runCreated` webhook can refuse a run (the thread belongs to someone else); `runFinished` gets the new messages, the same as `onRunFinished` in the SDK run endpoints.
- **Tokens.** In the dev stack the gateway signs with the same key as the demo, so Centrifugo's one JWKS covers both. In a deployment, Centrifugo's JWKS endpoints point at the gateway.
- **Packaging.** Image `realtime-gateway` (released with the others), a `gateway` profile in `deploy/compose`, `gateway.enabled` in the Helm chart (tested on kind: the NetworkPolicy blocks an unlabeled namespace from the API while the gateway publishes for it), and a Railway service. The config can come from `RTB_GATEWAY_CONFIG_JSON` for hosts without files.
- **Not done yet:** a rate limit per key.

## Gaps found in DESIGN.md

Each item below is folded into the phases above and has been applied to DESIGN.md (Oct 10, 2026 review). The list stays here as the record of what changed and why.

1. **Broken diagram:** line 53 is a leftover export placeholder (`[embedded content: backbone topology …]`), not a diagram. Replace it with a Mermaid diagram or an image in `docs/`.
2. **Presence roster:** the presence namespace config needs `allow_presence_for_subscriber`. Otherwise clients see join and leave events but cannot load who is already there.
3. **`publication_data_format`:** the config block uses `"publication_data_format": "json_object"`, and the text relies on it to reject non-object publications. Verify the key exists in v6; if not, drop it and the sentence that depends on it.
4. **SSE and HTTP-stream fallbacks:** the design promises them but the config block doesn't enable the transports. Add them, and note that centrifuge-js must be configured with the fallback list too.
5. **Offset off-by-one:** "Subscribe from that position" needs a defined rule so `RUN_STARTED` is neither lost nor duplicated. Proposed: the 202 returns the offset of `RUN_STARTED` and the client subscribes from `offset - 1`.
6. **Two `RUN_STARTED`s:** the run flow publishes `RUN_STARTED` before the framework starts, and the framework then emits its own. Say which one the client sees (this plan: ours, with the framework's dropped).
7. **Oversize AG-UI events:** `MESSAGES_SNAPSHOT` and `STATE_SNAPSHOT` can exceed the 64 KB cap. The design needs a policy; this plan replaces them with an `rtb.oversize` marker and a fetch from the app's API.
8. **Ordering:** Retries and batching need a per-channel serial queue in the publisher. The design does not say so, and parallel publishes would reorder deltas.
9. **mTLS claims:** Revocation and attribution through mTLS may not hold if Centrifugo does not check CRLs or log certificate identity. The TS publisher uses HTTP with only the key, so it has no mTLS identity at all. Either add client-certificate TLS on the HTTP API or state that the SDK audit log is the attribution control for HTTP publishers.
10. **Reattach authorization:** a user who reloads mid-run needs a fresh subscription token, so the app must persist who may watch each run. The design's run flow doesn't mention it.
11. **Presence scale:** "who is online" at tenant scope would make Centrifugo return every subscriber on each presence call. Keep presence channels per record; use counts (`presence_stats`) tenant-wide.
12. **User channels in `replay`:** the config enables `allow_user_limited_channels` on `replay` too, but the audience table only shows `#` channels under `live`. Either document `replay:t-<tenant>.user#<userId>` (useful for per-user notifications that survive a reload) or drop the flag from `replay`.
13. **Global publishing (resolved):** a single `allowGlobal` publisher flag, off by default (Phase 0).
14. **Tenant ID grammar (resolved):** `[A-Za-z0-9_-]{1,64}`, case-sensitive, with `global` reserved (Phase 0). Topic nesting is closed at `topic.id`, and `all`, `grp`, `user`, `run` are reserved topic words.
15. **Token signing (open question 2, proposed answer):** app-held ES256 key published through a JWKS endpoint the SDK serves; Centrifugo always verifies via JWKS URL. The IdP case is the same config with a different URL.
16. **Thread versus run channel (open question 4, proposed answer):** one channel per run; new-run notices go to the user channel.
17. **Stream metadata:** each agent run gets its own channel, so short-lived streams accumulate. Each can leave a small metadata key in Valkey long after its history expires unless `history_meta_ttl` is set.
18. **HA Valkey for Helm:** the design's production profile assumes Sentinel but doesn't say who provides it. This plan has adopters bring their own (Phase 6).
19. **Compose as a deployment target:** the design lists Compose for dev only. This plan also ships a single-host Compose deployment built on published images, plus a Railway template.
20. **Packages table:** the TypeScript side is now six packages (contract, publisher, tokens, client, agui-client, mastra), not one publisher plus one browser client.

## Suggested order and rough size

| Order | Work | Size (one engineer) |
| --- | --- | --- |
| 1 | Phase 0: spec and spikes | 3–4 days |
| 2 | Phase 1: config, backbone image, dev stack, `realtime-doctor` | 4–5 days |
| 3 | Phase 2 (TS) and 3 (TS): contract, publisher, tokens | 4–5 days |
| 4 | Phase 4: browser client and AG-UI adapter | 3–4 days |
| 5 | Phase 5 (TS): Mastra sink and sample, the **first full vertical slice** | 3 days |
| 6 | Phases 2, 3 and 5 for .NET: contract, gRPC publisher, tokens, MAF sink and sample | 7–9 days |
| 7 | Phase 6: image publishing, Compose deployment, backplane guide, Railway template, Helm, observability, runbooks, load test | 9–12 days |
| 8 | Phase 7: CI, release, docs | 3 days |

That comes to about 7 to 10 weeks for one engineer, or about 5 weeks with the .NET track running in parallel after Phase 2. The Phase 0 spikes are answered (see the table in Phase 0); the Centrifugo facts in this plan are checked against v6.9.7.
