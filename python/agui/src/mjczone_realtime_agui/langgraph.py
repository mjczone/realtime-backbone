"""LangGraph as an AG-UI event source. Needs mjczone-realtime-agui[langgraph]."""

from collections.abc import AsyncIterator, Callable
from typing import Any

from ag_ui.core import RunAgentInput
from ag_ui_langgraph import LangGraphAgent
from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.pregel import Pregel

GraphOrBuilder = Pregel | Callable[[BaseCheckpointSaver], Pregel]


def langgraph_events(graph: GraphOrBuilder, input: dict[str, Any], **agent_kwargs: Any) -> AsyncIterator[Any]:
    """
    Runs a LangGraph graph on a RunAgentInput (camelCase dict) and yields its AG-UI events. RUN_STARTED and
    RUN_FINISHED carry the input's runId and threadId. Failures arrive as a RUN_ERROR event, not an exception.

    `graph` is a compiled graph with its own checkpointer (a stateful server), or a function that compiles the graph
    with the checkpointer it is given. The function gets a fresh in-memory checkpointer on every run, which suits a
    stateless server that receives the full history in `messages`. LangGraph's AG-UI integration needs a checkpointer.
    """
    compiled = graph if isinstance(graph, Pregel) else graph(InMemorySaver())
    agent_kwargs.setdefault("emit_raw_events", False)
    # LangGraphAgent keeps per-run state, so each run gets its own.
    agent = LangGraphAgent(name=agent_kwargs.pop("name", "agent"), graph=compiled, **agent_kwargs)
    defaults = {"messages": [], "tools": [], "context": [], "state": {}, "forwardedProps": {}}
    return agent.run(RunAgentInput.model_validate({**defaults, **input}))
