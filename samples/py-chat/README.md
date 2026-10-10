# py-chat

A Pydantic AI agent behind `rtb-agui`'s run endpoints, with the same API and page as `mastra-chat` and `maf-chat`. See `../README.md` to run it; it serves http://localhost:3003.

- `scripted()` in `app.py` stands in for a model through Pydantic AI's `FunctionModel`, so the sample needs no key. Set `MODEL` (for example `openai:gpt-5-mini` with `OPENAI_API_KEY`) to use a real model.
- `pydantic_ai_events()` runs the agent with Pydantic AI's `AGUIAdapter` and yields its AG-UI events; `RunEndpoints` publishes them to the run channel.
- It publishes over HTTP by default, or over gRPC when `RTB_GRPC_ADDRESS` is set.

The service keeps driving the agent after it answers `202`, so it must be a long-running process.
