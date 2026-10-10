# Python SDK

Four packages in one uv workspace, following [docs/sdk-spec.md](../docs/sdk-spec.md). Python 3.11 or later, asyncio.

| Package | Does |
| --- | --- |
| `rtb-contract` | Channel builders and parser, envelopes, ULIDs, tenant guard. No dependencies |
| `rtb-publisher` | Async publisher over HTTP (`httpx`) or gRPC (`rtb-publisher[grpc]`): per-channel ordering, retries, audit log, delta batcher |
| `rtb-tokens` | ES256 connection and subscription tokens and their JWKS; token endpoints for Starlette and FastAPI (`rtb-tokens[starlette]`) |
| `rtb-agui` | Publishes an AG-UI agent run (Pydantic AI with `rtb-agui[pydantic-ai]`, or any AG-UI event source); `start_run` and Starlette run endpoints |

Names are placeholders until the project's name is settled. Nothing is on PyPI yet.

## Publish

```python
from rtb_contract import Channels
from rtb_publisher import Publisher, GrpcTransport

publisher = Publisher(source="billing-worker", tenant="acme", api_url="http://backbone:9000/api", api_key=API_KEY)
# or over gRPC: Publisher(source=..., tenant=..., transport=GrpcTransport("backbone:10000", GRPC_KEY))

result = await publisher.publish(
    Channels.record("acme", "jobs", job_id, tier="replay"),
    "job.progress",
    {"jobId": job_id, "pct": 40},
)
print(result.offset, result.epoch)
```

- `publish()` checks, builds and queues the envelope right away and returns a future. Calls made in order go out in order on each channel, one request at a time, even when you don't await each one. Await the futures (or `publisher.idle()`) before exiting.
- Retries transient errors for up to 30 seconds with the same envelope and idempotency key. `TenantGuardError`, `EnvelopeTooLargeError` and permanent `PublishError`s raise from the future.
- Every publish writes an audit entry to the `rtb.audit` logger (JSON, never the payload). Configure logging to see it, or pass `audit=`.
- A multi-tenant worker leaves out `tenant` and uses `publisher.for_tenant(t)`. Global channels need `allow_global=True` (or `RTB_ALLOW_GLOBAL=true`).
- Channel IDs must fit the grammar (`[A-Za-z0-9_-]`). Use opaque IDs (ULIDs, UUIDs, database keys) where you can; for keys with other characters use `encode_id(key)` and `decode_id(id)` from `rtb_contract`, which every SDK implements the same way (`BRK.B` → `BRK_2EB`).

## Tokens

```python
from rtb_tokens import TokenSigner
from rtb_tokens.endpoints import TokenEndpoints, TokenUser

signer = TokenSigner(PRIVATE_JWK, audience="realtime-backbone", issuer="app.example.com")
endpoints = TokenEndpoints(signer, authenticate=my_auth, authorize=my_check)
app = Starlette(routes=endpoints.routes())  # FastAPI: app.router.routes.extend(endpoints.routes())
```

## Agents

```python
from rtb_agui import RunEndpoints
from rtb_agui.pydantic_ai import pydantic_ai_events

runs = RunEndpoints(publisher, signer, my_auth, lambda input, user: pydantic_ai_events(agent, input), notify_user=True)
```

The service keeps driving the agent after it answers `202`, so it must be a long-running process. `samples/py-chat` is a full example.

## Develop

```sh
cd python
uv sync --all-packages --all-extras
uv run pytest                        # unit tests, conformance vectors, sample tests
uv run pytest -m integration         # against the backbone image and Valkey in containers (needs Docker)
uv run ruff check . && uv run ruff format --check .
```

The gRPC stubs in `rtb-publisher/src/rtb_publisher/_proto` are generated from `proto/centrifugo/api.proto`:

```sh
uv run --with grpcio-tools==1.84.0 python rtb-publisher/gen_proto.py
```
