# Load test

Simulates concurrent agent runs. Each run publishes `RUN_STARTED`, a tool call, a streamed answer through the delta batcher and `RUN_FINISHED` to its own replay channel, with `@mjczone/realtime-publisher`. One viewer per run subscribes with `@mjczone/realtime-client` from `offset - 1` and checks every message arrives, in order.

Run it inside the dev stack's network, with the dev stack up:

```sh
pnpm dev:up
docker run --rm --network rtb-dev_default -v "$PWD":/repo -w /repo/tools/loadtest \
  -e RUNS=200 -e BATCH_MS=75 node:24-alpine node run.mjs
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `RUNS` | 200 | Concurrent runs (and viewers) |
| `TOKENS` | 300 | Text deltas per run |
| `TOKENS_PER_SEC` | 30 | Model speed |
| `BATCH_MS` | 75 | Delta batch interval; 0 sends roughly one message per token |

It prints publishes per second, publish and end-to-end latency (p50, p99), missing messages, offset gaps, and Valkey memory per run (`used_memory` before and after, divided by runs; history stays for `history_ttl`).

Results are in `docs/DESIGN.md` under "Load test results".
