import asyncio
import json
from collections.abc import Sequence
from typing import Any

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, AIMessageChunk, HumanMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatGenerationChunk, ChatResult
from langchain_core.tools import tool
from langgraph.graph import END, START, MessagesState, StateGraph
from langgraph.prebuilt import ToolNode, tools_condition
from rtb_agui import publish_agent_run, start_run
from rtb_agui.langgraph import langgraph_events
from rtb_publisher import Publisher, RetryOptions


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


def publisher(r):
    return Publisher(source="lg", tenant="acme", transport=r, audit=lambda e: None, retry=RetryOptions(attempts=1))


class Scripted(BaseChatModel):
    """Calls getWeather for the last word of the question, then streams the answer word by word."""

    fail: bool = False

    @property
    def _llm_type(self) -> str:
        return "scripted"

    def bind_tools(self, tools: Sequence[Any], **kw: Any) -> "Scripted":
        return self

    def _city(self, messages) -> str:
        return next(str(m.content).split()[-1].strip("?") for m in reversed(messages) if isinstance(m, HumanMessage))

    def _generate(self, messages, stop=None, run_manager=None, **kw):
        raise NotImplementedError

    async def _astream(self, messages, stop=None, run_manager=None, **kw):
        if not isinstance(messages[-1], ToolMessage):
            yield ChatGenerationChunk(
                message=AIMessageChunk(
                    content="", tool_call_chunks=[{"id": "c1", "name": "getWeather", "args": "", "index": 0}]
                )
            )
            args = json.dumps({"city": self._city(messages)})
            yield ChatGenerationChunk(
                message=AIMessageChunk(
                    content="", tool_call_chunks=[{"id": None, "name": None, "args": args, "index": 0}]
                )
            )
            return
        for i, w in enumerate(f"It is {messages[-1].content} today.".split(" ")):
            if self.fail and i == 2:
                raise RuntimeError("model down")
            yield ChatGenerationChunk(message=AIMessageChunk(content=w if i == 0 else " " + w))
            await asyncio.sleep(0)

    async def _agenerate(self, messages, stop=None, run_manager=None, **kw):
        text, calls = "", []
        async for c in self._astream(messages):
            text += c.message.content
            calls += c.message.tool_call_chunks
        if calls:
            msg = AIMessage(
                content="", tool_calls=[{"id": "c1", "name": "getWeather", "args": json.loads(calls[1]["args"])}]
            )
        else:
            msg = AIMessage(content=text)
        return ChatResult(generations=[ChatGeneration(message=msg)])


@tool
def getWeather(city: str) -> str:
    """Weather for a city."""
    return f"sunny in {city}"


def builder(fail=False):
    def build(checkpointer):
        model = Scripted(fail=fail)

        async def call_model(state: MessagesState):
            return {"messages": [await model.ainvoke(state["messages"])]}

        g = StateGraph(MessagesState)
        g.add_node("agent", call_model)
        g.add_node("tools", ToolNode([getWeather]))
        g.add_edge(START, "agent")
        g.add_conditional_edges("agent", tools_condition, {"tools": "tools", END: END})
        g.add_edge("tools", "agent")
        return g.compile(checkpointer=checkpointer)

    return build


INPUT = {"threadId": "th1", "messages": [{"id": "u1", "role": "user", "content": "Weather in Paris?"}]}


async def test_start_run_with_langgraph():
    r = Recorder()
    ref, task = await start_run(publisher(r), lambda inp: langgraph_events(builder(), inp), INPUT, "u1")
    await task
    types = r.types
    assert types[0] == "agui.RUN_STARTED" and types.count("agui.RUN_STARTED") == 1 and types[-1] == "agui.RUN_FINISHED"
    for t in ("agui.TOOL_CALL_START", "agui.TOOL_CALL_ARGS", "agui.TOOL_CALL_END", "agui.TOOL_CALL_RESULT"):
        assert t in types
    assert "agui.MESSAGES_SNAPSHOT" in types and "agui.RAW" not in types
    texts = [env["data"]["delta"] for _, env in r.calls if env["type"] == "agui.TEXT_MESSAGE_CONTENT"]
    assert texts == ["It is sunny in Paris today."]
    assert r.calls[-1][1]["data"]["runId"] == ref.run_id and r.calls[-1][1]["data"]["threadId"] == "th1"


async def test_second_turn_is_stateless():
    r = Recorder()
    turn2 = {
        "threadId": "th1",
        "messages": [
            *INPUT["messages"],
            {"id": "a1", "role": "assistant", "content": "It is sunny in Paris today."},
            {"id": "u2", "role": "user", "content": "And in Tokyo?"},
        ],
    }
    _, task = await start_run(publisher(r), lambda inp: langgraph_events(builder(), inp), turn2, "u1")
    await task
    texts = [env["data"]["delta"] for _, env in r.calls if env["type"] == "agui.TEXT_MESSAGE_CONTENT"]
    assert texts == ["It is sunny in Tokyo today."]


async def test_failure_is_one_run_error():
    r = Recorder()
    result = await publish_agent_run(
        publisher(r), "replay:t-acme.run.r1", "r1", langgraph_events(builder(fail=True), {**INPUT, "runId": "r1"})
    )
    assert r.types.count("agui.RUN_ERROR") == 1 and "agui.RUN_FINISHED" not in r.types
    assert result.error is None
