import asyncio
import json
import random

import httpx
import pytest
from mjczone_realtime_contract import TenantGuardError, validate_envelope
from mjczone_realtime_publisher import (
    DeltaBatcher,
    EnvelopeTooLargeError,
    HttpTransport,
    Publisher,
    PublishError,
    RetryOptions,
)


class FakeTransport:
    def __init__(self, handler):
        self.handler = handler
        self.calls: list[tuple[str, dict, str]] = []

    async def publish(self, channel, data, key):
        env = json.loads(data)
        self.calls.append((channel, env, key))
        return await self.handler(len(self.calls), env)

    async def aclose(self):
        pass


async def ok(*_):
    return 1, "e1"


def make(t, **kw):
    audit: list[dict] = []
    kw.setdefault("tenant", "acme")
    p = Publisher(
        source="test",
        transport=t,
        audit=audit.append,
        retry=RetryOptions(base_delay=0.001, max_delay=0.005, attempts=kw.pop("attempts", 8)),
        **kw,
    )
    return p, audit


async def test_sends_envelope_with_idempotency_key():
    t = FakeTransport(ok)
    p, audit = make(t)
    r = await p.publish("replay:t-acme.run.r1", "agui.RUN_STARTED", {"type": "RUN_STARTED"}, corr="r1")
    assert (r.offset, r.epoch) == (1, "e1")
    _, env, key = t.calls[0]
    assert key == r.envelope["id"] and env["tenant"] == "acme" and env["corr"] == "r1" and env["source"] == "test"
    assert validate_envelope(env) is None
    assert audit[0]["outcome"] == "ok" and audit[0]["attempts"] == 1


async def test_guard_denies_and_audits():
    t = FakeTransport(ok)
    p, audit = make(t)
    with pytest.raises(TenantGuardError) as e:
        await p.publish("live:t-globex.x", "a.b", {})
    assert e.value.reason == "tenant_mismatch" and audit[0]["outcome"] == "denied"
    with pytest.raises(TenantGuardError):
        await p.publish("live:global.x", "a.b", {})
    with pytest.raises(TenantGuardError):
        await make(t, tenant=None)[0].publish("live:t-acme.x", "a.b", {})
    assert t.calls == []
    r = await make(t, allow_global=True)[0].publish("live:global.x", "system.maintenance", {})
    assert r.envelope["tenant"] == "global"
    g = await make(t, tenant=None)[0].for_tenant("globex").publish("live:t-globex.x", "a.b", {})
    assert g.envelope["tenant"] == "globex"


async def test_rejects_too_large():
    t = FakeTransport(ok)
    p, audit = make(t)
    with pytest.raises(EnvelopeTooLargeError):
        await p.publish("live:t-acme.x", "a.b", {"s": "x" * 70000})
    assert t.calls == [] and audit[0]["outcome"] == "too_large"


async def test_retries_transient_with_same_envelope():
    async def handler(n, _):
        if n < 3:
            raise PublishError("not available", True, 108)
        return 1, "e1"

    t = FakeTransport(handler)
    p, audit = make(t)
    await p.publish("live:t-acme.x", "a.b", {})
    assert len(t.calls) == 3 and len({k for _, _, k in t.calls}) == 1 and audit[0]["attempts"] == 3


async def test_does_not_retry_permanent():
    async def handler(*_):
        raise PublishError("bad request", False, 107)

    t = FakeTransport(handler)
    p, audit = make(t)
    with pytest.raises(PublishError):
        await p.publish("live:t-acme.x", "a.b", {})
    assert len(t.calls) == 1 and audit[0]["outcome"] == "failed"


async def test_keeps_order_on_one_channel_under_failures():
    in_flight = max_in_flight = 0

    async def handler(*_):
        nonlocal in_flight, max_in_flight
        in_flight += 1
        max_in_flight = max(max_in_flight, in_flight)
        await asyncio.sleep(random.random() * 0.003)
        in_flight -= 1
        if random.random() < 0.3:
            raise OSError("network down")
        return 1, "e1"

    t = FakeTransport(handler)
    p, _ = make(t, attempts=50)
    futures = [p.publish("live:t-acme.x", "a.b", {"i": i}) for i in range(60)]
    await asyncio.gather(*futures)
    assert max_in_flight == 1
    delivered: list[int] = []
    for _, env, _ in t.calls:
        i = env["data"]["i"]
        if not delivered or delivered[-1] != i:
            delivered.append(i)
    assert delivered == list(range(60))


async def test_different_channels_run_concurrently():
    in_flight = max_in_flight = 0

    async def handler(*_):
        nonlocal in_flight, max_in_flight
        in_flight += 1
        max_in_flight = max(max_in_flight, in_flight)
        await asyncio.sleep(0.02)
        in_flight -= 1
        return 1, "e1"

    p, _ = make(FakeTransport(handler))
    await asyncio.gather(*(p.publish(f"live:t-acme.{c}", "a.b", {}) for c in "abc"))
    assert max_in_flight == 3


async def test_failed_publish_does_not_block_the_next():
    async def handler(_, env):
        if env["data"].get("fail"):
            raise PublishError("x", False)
        return 1, "e1"

    p, _ = make(FakeTransport(handler))
    a = p.publish("live:t-acme.x", "a.b", {"fail": True})
    b = p.publish("live:t-acme.x", "a.b", {})
    with pytest.raises(PublishError):
        await a
    await b
    await p.idle()


async def test_http_transport_reads_errors_and_positions():
    def handler(req: httpx.Request) -> httpx.Response:
        body = json.loads(req.content)
        assert req.headers["x-api-key"] == "k" and body["idempotency_key"] == body["data"]["id"]
        if body["channel"].endswith("bad"):
            return httpx.Response(200, json={"error": {"code": 107, "message": "bad request"}})
        if body["channel"].endswith("busy"):
            return httpx.Response(503)
        if body["channel"].startswith("live"):
            return httpx.Response(200, json={"result": {}})
        return httpx.Response(200, json={"result": {"offset": 4, "epoch": "e"}})

    t = HttpTransport("http://cf/api", "k", client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    p, _ = make(t, attempts=2)
    r = await p.publish("replay:t-acme.run.r1", "a.b", {})
    assert (r.offset, r.epoch) == (4, "e")
    assert (await p.publish("live:t-acme.x", "a.b", {})).offset is None
    with pytest.raises(PublishError) as e:
        await p.publish("live:t-acme.bad", "a.b", {})
    assert e.value.code == 107 and not e.value.transient
    with pytest.raises(PublishError) as e:
        await p.publish("live:t-acme.busy", "a.b", {})
    assert e.value.transient


async def test_batcher_joins_and_flushes_on_other_events():
    out: list[dict] = []
    b = DeltaBatcher(out.append, interval=10)
    b.push({"type": "TEXT_MESSAGE_START", "messageId": "m"})
    b.push({"type": "TEXT_MESSAGE_CONTENT", "messageId": "m", "delta": "Hel"})
    b.push({"type": "TEXT_MESSAGE_CONTENT", "messageId": "m", "delta": "lo"})
    b.push({"type": "TOOL_CALL_ARGS", "toolCallId": "t", "delta": '{"a"'})
    b.push({"type": "TOOL_CALL_ARGS", "toolCallId": "t", "delta": ":1}"})
    b.push({"type": "TEXT_MESSAGE_END", "messageId": "m"})
    assert out == [
        {"type": "TEXT_MESSAGE_START", "messageId": "m"},
        {"type": "TEXT_MESSAGE_CONTENT", "messageId": "m", "delta": "Hello"},
        {"type": "TOOL_CALL_ARGS", "toolCallId": "t", "delta": '{"a":1}'},
        {"type": "TEXT_MESSAGE_END", "messageId": "m"},
    ]


async def test_batcher_flushes_on_interval_and_size():
    out: list[str] = []
    b = DeltaBatcher(lambda e: out.append(e["delta"]), interval=0.01, max_bytes=4)
    b.push({"type": "TEXT_MESSAGE_CONTENT", "messageId": "m", "delta": "ab"})
    b.push({"type": "TEXT_MESSAGE_CONTENT", "messageId": "m", "delta": "cd"})
    assert out == ["abcd"]
    b.push({"type": "TEXT_MESSAGE_CONTENT", "messageId": "m", "delta": "e"})
    await asyncio.sleep(0.05)
    assert out == ["abcd", "e"]
