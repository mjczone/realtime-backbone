"""Replays a candle sequence through a moving-average crossover and publishes what happens.

Channels (tenant "demo" by default):
  live:t-<tenant>.backtests.<backtestId>   job.progress, job.finished   progress for a UI, dropped if nobody listens
  replay:t-<tenant>.signals.<strategyId>   trade.signal                 a reconnecting UI catches up on recent signals
  replay:t-<tenant>.orders.<strategyId>    trade.order                  order status: submitted, then filled

The backbone carries what happened so UIs update live. Orders and fills of a real system belong in its own
database; a UI that needs the full picture loads it from the app's API.
"""

import asyncio
import logging
import os
import random
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from mjczone_realtime_contract import Channels, encode_id, new_id
from mjczone_realtime_publisher import GrpcTransport, HttpTransport, Publisher


@dataclass(frozen=True)
class Candle:
    t: datetime
    o: float
    h: float
    l: float
    c: float
    v: int

    def to_json(self) -> dict[str, Any]:
        return {
            "t": self.t.isoformat().replace("+00:00", "Z"),
            "o": self.o,
            "h": self.h,
            "l": self.l,
            "c": self.c,
            "v": self.v,
        }


def candles(
    n: int, start: datetime, seed: int = 7, price: float = 5000.0, step: timedelta = timedelta(minutes=1)
) -> list[Candle]:
    """A deterministic random walk of n candles, starting at `start`. Stands in for historical data."""
    rnd = random.Random(seed)
    out = []
    for i in range(n):
        o = price
        moves = [rnd.gauss(0, 2.5) for _ in range(4)]
        path = [o + sum(moves[: k + 1]) for k in range(4)]
        c = round(path[-1], 2)
        out.append(
            Candle(
                start + i * step,
                round(o, 2),
                round(max(o, *path), 2),
                round(min(o, *path), 2),
                c,
                rnd.randint(100, 5000),
            )
        )
        price = c
    return out


@dataclass(frozen=True)
class Signal:
    index: int
    side: str  # "buy" or "sell"
    price: float


def crossover_signals(series: list[Candle], fast: int = 5, slow: int = 20) -> list[Signal]:
    """Buy when the fast moving average crosses above the slow one, sell when it crosses below. Long only."""
    closes = [c.c for c in series]
    signals: list[Signal] = []
    long = False
    for i in range(slow, len(closes)):
        f_prev, s_prev = sum(closes[i - fast : i]) / fast, sum(closes[i - slow : i]) / slow
        f_now, s_now = sum(closes[i - fast + 1 : i + 1]) / fast, sum(closes[i - slow + 1 : i + 1]) / slow
        if not long and f_prev <= s_prev and f_now > s_now:
            signals.append(Signal(i, "buy", closes[i]))
            long = True
        elif long and f_prev >= s_prev and f_now < s_now:
            signals.append(Signal(i, "sell", closes[i]))
            long = False
    return signals


async def run_backtest(
    publisher: Publisher,
    strategy_id: str,
    symbol: str,
    series: list[Candle],
    speed: float = 0,
    fast: int = 5,
    slow: int = 20,
) -> dict[str, Any]:
    """
    Steps through the candles at `speed` candles per second (0 means as fast as possible) and publishes progress,
    signals and order status as it goes. Returns a summary. `publisher` must have a tenant.
    """
    tenant = publisher.tenant or ""
    backtest_id = new_id()
    progress = Channels.record(tenant, "backtests", backtest_id)
    signals_ch = Channels.record(tenant, "signals", encode_id(strategy_id), tier="replay")
    orders_ch = Channels.record(tenant, "orders", encode_id(strategy_id), tier="replay")
    by_index = {s.index: s for s in crossover_signals(series, fast, slow)}
    pending_order: dict[str, Any] | None = None
    entry: float | None = None
    pnl = 0.0
    trades = 0
    every = max(1, len(series) // 20)
    sent: list[asyncio.Future[Any]] = []

    def pub(channel: str, type: str, data: dict[str, Any]) -> None:
        sent.append(publisher.publish(channel, type, data, corr=backtest_id))

    for i, candle in enumerate(series):
        if pending_order:
            # Fill at the next candle's open, the way a market order placed at the close would.
            fill = {**pending_order, "status": "filled", "fillPrice": candle.o, "filledAt": candle.to_json()["t"]}
            pub(orders_ch, "trade.order", fill)
            if fill["side"] == "buy":
                entry = candle.o
            elif entry is not None:
                pnl += candle.o - entry
                trades += 1
                entry = None
            pending_order = None

        if s := by_index.get(i):
            signal = {
                "strategyId": strategy_id,
                "symbol": symbol,
                "side": s.side,
                "price": s.price,
                "candle": candle.to_json(),
            }
            pub(signals_ch, "trade.signal", signal)
            pending_order = {"orderId": new_id(), "strategyId": strategy_id, "symbol": symbol, "side": s.side, "qty": 1}
            pub(orders_ch, "trade.order", {**pending_order, "status": "submitted"})

        if i % every == 0:
            pct = round(100 * i / len(series))
            pub(progress, "job.progress", {"jobId": backtest_id, "pct": pct, "step": candle.to_json()["t"]})
        if speed:
            await asyncio.sleep(1 / speed)

    summary = {
        "jobId": backtest_id,
        "ok": True,
        "symbol": symbol,
        "candles": len(series),
        "trades": trades,
        "pnl": round(pnl, 2),
    }
    pub(progress, "job.progress", {"jobId": backtest_id, "pct": 100, "step": "done"})
    pub(progress, "job.finished", summary)
    results = await asyncio.gather(*sent, return_exceptions=True)
    summary["publishFailures"] = sum(isinstance(r, BaseException) for r in results)
    return summary


async def main() -> None:
    logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(name)s %(message)s")
    env = os.environ.get
    if env("RTB_GRPC_ADDRESS"):
        transport = GrpcTransport(env("RTB_GRPC_ADDRESS"), env("RTB_GRPC_KEY", "dev-grpc-key"))
    else:
        transport = HttpTransport(env("RTB_API_URL", "http://backbone:9000/api"), env("RTB_API_KEY", "dev-api-key"))
    publisher = Publisher(source="py-signals", tenant=env("TENANT", "demo"), transport=transport)
    symbol = env("SYMBOL", "ESZ6")
    start = datetime(2026, 3, 2, 14, 30, tzinfo=UTC)
    series = candles(int(env("CANDLES", "390")), start, seed=int(env("SEED", "7")))
    summary = await run_backtest(publisher, env("STRATEGY", "sma-5-20"), symbol, series, speed=float(env("SPEED", "0")))
    print(summary)
    await publisher.aclose()


if __name__ == "__main__":
    asyncio.run(main())
