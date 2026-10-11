# py-signals

A worker that steps back through time: it replays a candle sequence through a moving-average crossover and publishes what happens, the way a backtest or a strategy replay would.

| Channel | Type | Why this tier |
| --- | --- | --- |
| `live:t-demo.backtests.<backtestId>` | `job.progress`, `job.finished` | Progress only matters to someone watching now |
| `replay:t-demo.signals.<strategyId>` | `trade.signal` | A UI that reconnects catches up on recent signals |
| `replay:t-demo.orders.<strategyId>` | `trade.order` (`submitted`, then `filled` at the next candle's open) | Same |

`trade.*` is an app-defined family; the envelope allows those. The backbone carries what happened so UIs update live. In a real system, orders and fills live in your own database, and a UI that needs the full history loads it from your API.

## Run

With the dev stack up:

```sh
pnpm samples:signals
SPEED=200 CANDLES=1000 SYMBOL=NQZ6 pnpm samples:signals
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `SPEED` | 50 in Compose (0 runs as fast as it can) | Candles per second |
| `CANDLES` | 390 | One session of 1-minute candles |
| `SYMBOL` | `ESZ6` | Goes into the message data, not the channel name |
| `SEED` | 7 | The candles are a seeded random walk, so runs repeat |
| `STRATEGY` | `sma-5-20` | Goes into the channel names, through `encode_id` |
| `TENANT` | `demo` | |

It publishes over gRPC in Compose (`RTB_GRPC_ADDRESS`), or over HTTP with `RTB_API_URL`.

To use real history, replace `candles()` with your data loader; `run_backtest()` takes any list of `Candle`s.

If you key channels by symbol (say, one signals channel per symbol), pass the symbol through `encode_id` so any symbol fits: `Channels.record(tenant, "signals", encode_id("BRK.B"))` gives `live:t-demo.signals.BRK_2EB`, and every SDK computes the same name.
