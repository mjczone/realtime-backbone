# maf-chat

A Microsoft Agent Framework agent behind `Rtb.AgUi`'s run endpoint (with `Rtb.AgUi.AgentFramework` as the event source), publishing over gRPC. See `../README.md` to run it.

- `ScriptedChatClient` in `Program.cs` stands in for a model, so the sample needs no key. Swap in any `IChatClient` (OpenAI, Azure OpenAI, Ollama) to use a real model.
- `AIAgentEventSource` turns the agent's updates into AG-UI events with `AGUI.Server`.
- `MapRealtimeTokenEndpoints` and `MapAgentRunEndpoints` serve the same API as `mastra-chat`, so the same page works with both.

The service keeps driving the agent after it answers `202`, so it must be a long-running process.
