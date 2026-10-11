import json
from datetime import UTC, datetime
from itertools import pairwise

from mjczone_realtime_publisher import Publisher
from signals import candles, crossover_signals, run_backtest

START = datetime(2026, 3, 2, 14, 30, tzinfo=UTC)


class Recorder:
    def __init__(self):
        self.calls: list[tuple[str, dict]] = []

    async def publish(self, channel, data, key):
        self.calls.append((channel, json.loads(data)))
        return len(self.calls), "e1"

    async def aclose(self):
        pass


def test_candles_are_deterministic():
    a, b = candles(100, START, seed=3), candles(100, START, seed=3)
    assert a == b and len(a) == 100
    assert all(c.l <= min(c.o, c.c) and c.h >= max(c.o, c.c) for c in a)
    assert a[1].t > a[0].t


def test_signals_alternate_starting_with_buy():
    sides = [s.side for s in crossover_signals(candles(1000, START))]
    assert sides and sides[0] == "buy"
    assert all(x != y for x, y in pairwise(sides))


async def test_backtest_publishes_progress_signals_and_orders():
    r = Recorder()
    series = candles(390, START)
    summary = await run_backtest(
        Publisher(source="t", tenant="demo", transport=r, audit=lambda e: None), "sma", "ESZ6", series
    )
    by_channel: dict[str, list[dict]] = {}
    for channel, env in r.calls:
        by_channel.setdefault(channel.split(".")[1], []).append(env)
    signals, orders, progress = by_channel["signals"], by_channel["orders"], by_channel["backtests"]
    assert len(signals) == len(crossover_signals(series))
    submitted = [o["data"] for o in orders if o["data"]["status"] == "submitted"]
    filled = [o["data"] for o in orders if o["data"]["status"] == "filled"]
    assert len(submitted) == len(signals) and len(filled) >= len(submitted) - 1
    assert {o["orderId"] for o in filled} <= {o["orderId"] for o in submitted}
    assert progress[-2]["data"]["pct"] == 100 and progress[-1]["type"] == "job.finished"
    assert summary["publishFailures"] == 0 and summary["trades"] == sum(1 for o in filled if o["side"] == "sell")
