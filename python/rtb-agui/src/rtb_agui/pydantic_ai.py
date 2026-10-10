"""Pydantic AI as an AG-UI event source. Needs rtb-agui[pydantic-ai]."""

import json
from collections.abc import AsyncIterator
from typing import Any

from pydantic_ai import Agent as PydanticAgent
from pydantic_ai.ui.ag_ui import AGUIAdapter


def pydantic_ai_events(agent: PydanticAgent[Any, Any], input: dict[str, Any], **run_kwargs: Any) -> AsyncIterator[Any]:
    """
    Runs a Pydantic AI agent on a RunAgentInput (camelCase dict) and yields its AG-UI events. RUN_STARTED and
    RUN_FINISHED carry the input's runId and threadId. Failures arrive as a RUN_ERROR event, not an exception.
    """
    run_input = AGUIAdapter.build_run_input(json.dumps(input).encode())
    return AGUIAdapter(agent=agent, run_input=run_input).run_stream(**run_kwargs)
