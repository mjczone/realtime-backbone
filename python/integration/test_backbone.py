import asyncio
import json

import httpx
import pytest
import websockets
from mjczone_realtime_contract import Channels, new_id, validate_envelope
from mjczone_realtime_publisher import GrpcTransport, HttpTransport, Publisher, PublishError, RetryOptions

from .conftest import API_KEY, GRPC_KEY

pytestmark = pytest.mark.integration


class Flaky:
    """Fails some requests before they reach Centrifugo and loses some responses after."""

    def __init__(self, inner):
        self.inner = inner
        self.n = 0

    async def publish(self, channel, data, key):
        self.n += 1
        if self.n % 4 == 1:
            raise OSError("lost before send")
        result = await self.inner.publish(channel, data, key)
        if self.n % 4 == 2:
            raise OSError("lost after send")
        return result

    async def aclose(self):
        await self.inner.aclose()


def make(transport) -> Publisher:
    return Publisher(
        source="it-python",
        tenant="acme",
        transport=transport,
        audit=lambda e: None,
        retry=RetryOptions(base_delay=0.001, max_delay=0.005, attempts=10),
    )


def history(stack, channel):
    res = httpx.post(
        f"{stack.api_url}/history", headers={"X-API-Key": API_KEY}, json={"channel": channel, "limit": 1000}
    )
    return res.json()["result"]["publications"]


@pytest.mark.parametrize("kind", ["http", "grpc"])
async def test_publish_returns_the_position(stack, kind):
    t = HttpTransport(stack.api_url, API_KEY) if kind == "http" else GrpcTransport(stack.grpc_address, GRPC_KEY)
    p = make(t)
    channel = Channels.run("acme", new_id())
    r = await p.publish(channel, "agui.RUN_STARTED", {"type": "RUN_STARTED"})
    assert r.offset == 1 and r.epoch
    assert (await p.publish(Channels.record("acme", "jobs", "1"), "job.progress", {"pct": 1})).offset is None
    [pub] = history(stack, channel)
    assert validate_envelope(pub["data"]) is None and pub["data"]["id"] == r.envelope["id"]
    await p.aclose()


@pytest.mark.parametrize("kind", ["http", "grpc"])
async def test_order_holds_under_injected_failures(stack, kind):
    inner = HttpTransport(stack.api_url, API_KEY) if kind == "http" else GrpcTransport(stack.grpc_address, GRPC_KEY)
    p = make(Flaky(inner))
    channel = Channels.run("acme", new_id())
    await asyncio.gather(*[p.publish(channel, "job.progress", {"jobId": "j", "pct": i}) for i in range(40)])
    assert [x["data"]["data"]["pct"] for x in history(stack, channel)] == list(range(40))
    await p.aclose()


async def test_wrong_keys_fail_without_retrying(stack):
    for t in (HttpTransport(stack.api_url, "wrong"), GrpcTransport(stack.grpc_address, "wrong")):
        with pytest.raises(PublishError) as e:
            await make(t).publish("live:t-acme.x", "a.b", {})
        assert not e.value.transient


async def command(ws, id_, method, body):
    await ws.send(json.dumps({"id": id_, method: body}))
    while True:
        for line in (await ws.recv()).splitlines():
            msg = json.loads(line)
            if msg.get("id") == id_:
                return msg


async def test_centrifugo_accepts_python_tokens_and_recovers_from_offset_minus_one(stack):
    p = make(HttpTransport(stack.api_url, API_KEY))
    channel = Channels.run("acme", new_id())
    first = await p.publish(channel, "agui.RUN_STARTED", {"type": "RUN_STARTED"})
    await p.publish(channel, "agui.RUN_FINISHED", {"type": "RUN_FINISHED"})
    async with websockets.connect(stack.ws_url) as ws:
        conn = await command(ws, 1, "connect", {"token": stack.signer.mint_connection_token("u1")})
        assert "error" not in conn
        sub = await command(
            ws,
            2,
            "subscribe",
            {
                "channel": channel,
                "token": stack.signer.mint_subscription_token("u1", channel),
                "recover": True,
                "epoch": first.epoch,
                "offset": first.offset - 1,
            },
        )
        assert "error" not in sub and sub["subscribe"]["recovered"] is True
        assert [x["data"]["type"] for x in sub["subscribe"]["publications"]] == [
            "agui.RUN_STARTED",
            "agui.RUN_FINISHED",
        ]
    await p.aclose()


async def test_backtest_worker_against_the_backbone(stack):
    import sys
    from datetime import UTC, datetime
    from pathlib import Path

    sys.path.insert(0, str(Path(__file__).parents[2] / "samples" / "py-signals"))
    from signals import candles, crossover_signals, run_backtest

    p = Publisher(source="py-signals", tenant="demo", transport=GrpcTransport(stack.grpc_address, GRPC_KEY))
    series = candles(390, datetime(2026, 3, 2, 14, 30, tzinfo=UTC))
    summary = await run_backtest(p, "sma-it", "ESZ6", series)
    assert summary["publishFailures"] == 0
    signals = history(stack, "replay:t-demo.signals.sma-it")
    orders = [x["data"]["data"] for x in history(stack, "replay:t-demo.orders.sma-it")]
    assert [s["data"]["data"]["side"] for s in signals] == [s.side for s in crossover_signals(series)]
    assert [o["status"] for o in orders[:2]] == ["submitted", "filled"]
    await p.aclose()
