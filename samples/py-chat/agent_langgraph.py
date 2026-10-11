"""The weather agent on LangGraph."""

import asyncio
import json
import os
import uuid
from collections.abc import AsyncIterator, Sequence
from typing import Any

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, AIMessageChunk, HumanMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatGenerationChunk, ChatResult
from langchain_core.tools import tool
from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.graph import END, START, MessagesState, StateGraph
from langgraph.prebuilt import ToolNode, tools_condition
from mjczone_realtime_agui.langgraph import langgraph_events
from scripted import answer, city_from, weather

NAME = "a LangGraph agent"
# LangGraph sends a STATE_SNAPSHOT and step events for every node. This page shows neither, so the sink skips them.
SKIP_TYPES = frozenset({"STATE_SNAPSHOT", "STEP_STARTED", "STEP_FINISHED"})


class ScriptedChatModel(BaseChatModel):
    """Finds the city in the last question, calls getWeather with it, then streams the answer word by word."""

    @property
    def _llm_type(self) -> str:
        return "scripted"

    def bind_tools(self, tools: Sequence[Any], **kwargs: Any) -> "ScriptedChatModel":
        return self

    @staticmethod
    def _city(messages) -> str | None:
        last_human = next((m for m in reversed(messages) if isinstance(m, HumanMessage)), None)
        return city_from(str(last_human.content)) if last_human else None

    async def _astream(self, messages, stop=None, run_manager=None, **kwargs):
        await asyncio.sleep(0.2)
        city = self._city(messages)
        if city and not isinstance(messages[-1], ToolMessage):
            call_id = f"call_{uuid.uuid4().hex}"
            # The name first, then the arguments, so AG-UI sees TOOL_CALL_START and TOOL_CALL_ARGS.
            chunks = [
                {"id": call_id, "name": "getWeather", "args": "", "index": 0},
                {"id": None, "name": None, "args": json.dumps({"city": city}), "index": 0},
            ]
            for c in chunks:
                yield ChatGenerationChunk(message=AIMessageChunk(content="", tool_call_chunks=[c]))
            return
        for word in answer(city).split(" "):
            await asyncio.sleep(0.06)
            yield ChatGenerationChunk(message=AIMessageChunk(content=word + " "))

    async def _agenerate(self, messages, stop=None, run_manager=None, **kwargs):
        content, args, call_id = "", "", None
        async for c in self._astream(messages):
            content += c.message.content
            for t in c.message.tool_call_chunks:
                call_id = call_id or t["id"]
                args += t["args"] or ""
        tool_calls = [{"id": call_id, "name": "getWeather", "args": json.loads(args)}] if call_id else []
        return ChatResult(generations=[ChatGeneration(message=AIMessage(content=content, tool_calls=tool_calls))])

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        raise NotImplementedError("use the async API")


@tool
def getWeather(city: str) -> dict[str, Any]:
    """Current weather for a city."""
    return weather(city)


def _model() -> BaseChatModel:
    # MODEL=openai:gpt-5-mini (with OPENAI_API_KEY, and langchain plus langchain-openai installed) uses a real model.
    if os.environ.get("MODEL"):
        from langchain.chat_models import init_chat_model

        return init_chat_model(os.environ["MODEL"]).bind_tools([getWeather])
    return ScriptedChatModel()


def build_graph(checkpointer: BaseCheckpointSaver):
    model = _model()

    async def call_model(state: MessagesState):
        return {"messages": [await model.ainvoke(state["messages"])]}

    g = StateGraph(MessagesState)
    g.add_node("agent", call_model)
    g.add_node("tools", ToolNode([getWeather]))
    g.add_edge(START, "agent")
    g.add_conditional_edges("agent", tools_condition, {"tools": "tools", END: END})
    g.add_edge("tools", "agent")
    return g.compile(checkpointer=checkpointer)


def events(input: dict[str, Any]) -> AsyncIterator[Any]:
    # A fresh in-memory checkpointer per run: this server is stateless and gets the full history every time.
    return langgraph_events(build_graph, input, name="weather")
