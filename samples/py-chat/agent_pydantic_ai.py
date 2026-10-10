"""The weather agent on Pydantic AI."""

import asyncio
import json
import os
import uuid
from collections.abc import AsyncIterator
from typing import Any

from pydantic_ai import Agent
from pydantic_ai.messages import ModelRequest, ToolReturnPart, UserPromptPart
from pydantic_ai.models.function import DeltaToolCall, FunctionModel
from rtb_agui.pydantic_ai import pydantic_ai_events
from scripted import answer, city_from, weather

NAME = "a Pydantic AI agent"
SKIP_TYPES: frozenset[str] = frozenset()


def _last_user_text(messages) -> str:
    for m in reversed(messages):
        if isinstance(m, ModelRequest):
            texts = [p.content for p in m.parts if isinstance(p, UserPromptPart) and isinstance(p.content, str)]
            if texts:
                return " ".join(texts)
    return ""


async def _scripted(messages, info):
    """Finds the city in the last question, calls getWeather with it, then streams the answer word by word."""
    await asyncio.sleep(0.2)
    city = city_from(_last_user_text(messages))
    last = messages[-1]
    if city and not (isinstance(last, ModelRequest) and any(isinstance(p, ToolReturnPart) for p in last.parts)):
        call_id = f"call_{uuid.uuid4().hex}"
        yield {0: DeltaToolCall(name="getWeather", json_args=json.dumps({"city": city}), tool_call_id=call_id)}
        return
    for word in answer(city).split(" "):
        await asyncio.sleep(0.06)
        yield word + " "


# MODEL=openai:gpt-5-mini (with OPENAI_API_KEY) uses a real model.
agent = Agent(
    os.environ.get("MODEL") or FunctionModel(stream_function=_scripted), instructions="You answer weather questions."
)


@agent.tool_plain
def getWeather(city: str) -> dict[str, Any]:
    """Current weather for a city."""
    return weather(city)


def events(input: dict[str, Any]) -> AsyncIterator[Any]:
    return pydantic_ai_events(agent, input)
