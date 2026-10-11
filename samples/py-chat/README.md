# py-chat

One weather agent on two Python frameworks, behind `mjczone-realtime-agui`'s run endpoints, with the same API and page as `mastra-chat` and `maf-chat`. See `../README.md` to run it.

| `AGENT` | Framework | Compose service | Port |
| --- | --- | --- | --- |
| `pydantic-ai` (default) | Pydantic AI, through its `AGUIAdapter` | `py-chat` | 3003 |
| `langgraph` | LangGraph, through `ag-ui-langgraph` | `py-langgraph` | 3004 |

| File | What |
| --- | --- |
| `app.py` | The server: token endpoints, run endpoints, the thread store and the background run. The same for both frameworks |
| `agent_pydantic_ai.py` | The agent on Pydantic AI; a `FunctionModel` stands in for a model |
| `agent_langgraph.py` | The agent as a LangGraph graph (model node, tool node); a small `BaseChatModel` stands in for a model |
| `scripted.py` | What the scripted model says: the city from your question and made-up weather, the same in every sample |

Set `MODEL` to use a real model: for example `openai:gpt-5-mini` with `OPENAI_API_KEY` (LangGraph also needs `langchain` and `langchain-openai` installed).

LangGraph notes:

- Its AG-UI integration needs a checkpointer. `langgraph_events()` gives the graph a fresh in-memory one on every run, because this server gets the full history from the client each time. A stateful server passes a graph compiled with its own checkpointer instead.
- It sends `STATE_SNAPSHOT` after every step and a `MESSAGES_SNAPSHOT` at the end of a run. This page shows neither shared state nor steps, so the agent module sets `SKIP_TYPES = {"STATE_SNAPSHOT", "STEP_STARTED", "STEP_FINISHED"}` and the sink doesn't publish them (`skip_types` on `RunEndpoints` and `start_run`). The final `MESSAGES_SNAPSHOT` still goes out. Raw events are turned off too (`emit_raw_events=False`), which cuts a run from about 58 KB to 4 KB.

It publishes over HTTP by default, or over gRPC when `RTB_GRPC_ADDRESS` is set. The service keeps driving the agent after it answers `202`, so it must be a long-running process.
