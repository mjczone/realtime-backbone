# mastra-chat

A Mastra agent behind `@rtb/mastra`'s run endpoint. See `../README.md` to run it.

- `src/agent.ts`: a weather agent with one tool. It uses a scripted model unless `MODEL` is set, for example `MODEL=openai/gpt-5-mini` with `OPENAI_API_KEY`.
- `src/server.ts`: token endpoints, the run endpoint, the thread store and the background run.

The agent service keeps driving the agent after it answers `202`, so it must be a long-running process, not a request-scoped serverless function.
