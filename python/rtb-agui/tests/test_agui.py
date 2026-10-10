import asyncio
import json
import time

from pydantic_ai import Agent
from pydantic_ai.messages import ModelRequest, ToolReturnPart
from pydantic_ai.models.function import DeltaToolCall, FunctionModel
from rtb_agui import RunEndpoints, publish_agent_run, start_run
from rtb_agui.pydantic_ai import pydantic_ai_events
from rtb_publisher import Publisher, RetryOptions
from rtb_tokens import TokenSigner, generate_signing_key
from rtb_tokens.endpoints import TokenUser
from starlette.applications import Starlette
from starlette.testclient import TestClient


class Recorder:
    def __init__(self):
        self.calls: list[tuple[str, dict]] = []

    async def publish(self, channel, data, key):
        self.calls.append((channel, json.loads(data)))
        return len(self.calls), "e1"

    async def aclose(self):
        pass

    @property
    def types(self):
        return [env["type"] for _, env in self.calls]


def publisher(r: Recorder) -> Publisher:
    return Publisher(
        source="py-agent", tenant="acme", transport=r, audit=lambda e: None, retry=RetryOptions(attempts=1)
    )


def weather_agent(words=("It is ", "sunny ", "in ", "Paris."), delay=0.0) -> Agent:
    async def scripted(messages, info):
        last = messages[-1]
        if not (isinstance(last, ModelRequest) and any(isinstance(p, ToolReturnPart) for p in last.parts)):
            yield {0: DeltaToolCall(name="get_weather", json_args='{"city": "Paris"}', tool_call_id="call_1")}
            return
        for w in words:
            await asyncio.sleep(delay)
            yield w

    agent = Agent(FunctionModel(stream_function=scripted))

    @agent.tool_plain
    def get_weather(city: str) -> str:
        return f"sunny in {city}"

    return agent


INPUT = {"threadId": "th1", "messages": [{"id": "u1", "role": "user", "content": "Weather in Paris?"}]}


async def test_start_run_with_pydantic_ai():
    r = Recorder()
    finished = {}

    async def on_finished(info, result):
        finished["result"] = result

    agent = weather_agent()
    ref, task = await start_run(
        publisher(r), lambda inp: pydantic_ai_events(agent, inp), INPUT, "u1", on_run_finished=on_finished
    )
    await task
    assert ref.channel == f"replay:t-acme.run.{ref.run_id}" and ref.offset == 1 and ref.thread_id == "th1"
    types = r.types
    assert types.count("agui.RUN_STARTED") == 1 and types[0] == "agui.RUN_STARTED" and types[-1] == "agui.RUN_FINISHED"
    for t in ("agui.TOOL_CALL_START", "agui.TOOL_CALL_ARGS", "agui.TOOL_CALL_END", "agui.TOOL_CALL_RESULT"):
        assert t in types
    texts = [env["data"]["delta"] for _, env in r.calls if env["type"] == "agui.TEXT_MESSAGE_CONTENT"]
    assert texts == ["It is sunny in Paris."]
    events = [env["data"] for _, env in r.calls]
    assert events[0] == {"type": "RUN_STARTED", "threadId": "th1", "runId": ref.run_id}
    assert events[-1]["runId"] == ref.run_id
    assert all(c == ref.channel for c, _ in r.calls)
    assert finished["result"].error is None


async def test_notify_user():
    r = Recorder()
    ref, task = await start_run(publisher(r), lambda inp: pydantic_ai_events(weather_agent(), inp), INPUT, "u1", True)
    await task
    channel, env = next(c for c in r.calls if c[1]["type"] == "notice.run_started")
    assert channel == "live:t-acme.user#u1"
    assert env["data"] == {"runId": ref.run_id, "threadId": "th1", "channel": ref.channel, "offset": 1, "epoch": "e1"}


async def gen(*events, error=None, hang=False):
    for e in events:
        yield e
    if error:
        raise error
    if hang:
        await asyncio.sleep(3600)


async def test_failure_becomes_run_error():
    r = Recorder()
    result = await publish_agent_run(
        publisher(r), "replay:t-acme.run.r1", "r1", gen({"type": "RUN_STARTED"}, error=RuntimeError("model down"))
    )
    assert str(result.error) == "model down"
    assert r.calls[-1][1]["data"] == {"type": "RUN_ERROR", "message": "model down", "code": "rtb.agent_error"}


async def test_no_second_run_error():
    r = Recorder()
    await publish_agent_run(
        publisher(r),
        "replay:t-acme.run.r1",
        "r1",
        gen({"type": "RUN_ERROR", "message": "bad"}, error=RuntimeError("bad")),
    )
    assert r.types == ["agui.RUN_ERROR"]


async def test_oversize_marker():
    r = Recorder()
    big = {"type": "STATE_SNAPSHOT", "snapshot": {"blob": "x" * 70000}}
    await publish_agent_run(
        publisher(r), "replay:t-acme.run.r1", "r1", gen(big, {"type": "RUN_FINISHED", "runId": "r1"})
    )
    assert (
        r.calls[0][1]["data"]["name"] == "rtb.oversize" and r.calls[0][1]["data"]["value"]["type"] == "STATE_SNAPSHOT"
    )
    assert r.types[1] == "agui.RUN_FINISHED"


async def test_chunks_are_normalized():
    r = Recorder()
    events = gen(
        {"type": "TEXT_MESSAGE_CHUNK", "messageId": "m", "delta": "Hel"},
        {"type": "TEXT_MESSAGE_CHUNK", "messageId": "m", "delta": "lo"},
        {"type": "RUN_FINISHED", "runId": "r1"},
    )
    await publish_agent_run(publisher(r), "replay:t-acme.run.r1", "r1", events)
    assert r.types == [
        "agui.TEXT_MESSAGE_START",
        "agui.TEXT_MESSAGE_CONTENT",
        "agui.TEXT_MESSAGE_END",
        "agui.RUN_FINISHED",
    ]
    assert r.calls[1][1]["data"]["delta"] == "Hello"


async def test_cancel():
    r = Recorder()
    cancel = asyncio.Event()
    task = asyncio.ensure_future(
        publish_agent_run(
            publisher(r),
            "replay:t-acme.run.r1",
            "r1",
            gen({"type": "TEXT_MESSAGE_START", "messageId": "m"}, hang=True),
            cancel,
        )
    )
    await asyncio.sleep(0.05)
    cancel.set()
    result = await task
    assert result.error is not None
    assert r.calls[-1][1]["data"]["code"] == "rtb.cancelled"


def test_endpoints_return_202_and_only_the_owner_cancels():
    r = Recorder()
    signer = TokenSigner(generate_signing_key(), "a", "i")

    async def authenticate(request):
        u = request.headers.get("x-user")
        return TokenUser(u, "acme") if u else None

    endpoints = RunEndpoints(
        Publisher(source="py-agent", transport=r, audit=lambda e: None),
        signer,
        authenticate,
        lambda inp, user: pydantic_ai_events(weather_agent(words=["word "] * 200, delay=0.01), inp),
    )
    with TestClient(Starlette(routes=endpoints.routes())) as client:
        assert client.post("/api/run", json=INPUT).status_code == 401
        assert client.post("/api/run", json={"messages": "nope"}, headers={"x-user": "u1"}).status_code == 400
        res = client.post("/api/run", json=INPUT, headers={"x-user": "u1"})
        assert res.status_code == 202
        body = res.json()
        assert body["threadId"] == "th1" and body["offset"] == 1 and body["token"]
        run_id = body["runId"]
        assert client.post(f"/api/run/{run_id}/cancel", headers={"x-user": "u2"}).status_code == 404
        assert client.post(f"/api/run/{run_id}/cancel", headers={"x-user": "u1"}).status_code == 200
        for _ in range(100):
            if "agui.RUN_ERROR" in r.types:
                break
            time.sleep(0.02)
        assert r.calls[-1][1]["data"]["code"] == "rtb.cancelled"
