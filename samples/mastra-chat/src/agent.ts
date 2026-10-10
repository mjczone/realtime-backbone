import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { z } from 'zod';

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

const ANSWER =
  'The forecast says it is sunny in Paris today. This answer comes from a scripted model, so the sample ' +
  'runs without an API key. Each word is a separate delta from the model. The sink batches them, publishes ' +
  'them to the run channel, and every open tab sees the same text. Reload the page while it types and it ' +
  'picks up where it left off.';

/** A model that calls getWeather once, then streams a fixed answer word by word. */
function scriptedModel() {
  return new MockLanguageModelV3({
    provider: 'scripted',
    modelId: 'scripted-weather',
    doStream: async ({ prompt }) => {
      const hasToolResult = JSON.stringify(prompt).includes('"tool-result"');
      const parts = hasToolResult
        ? [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 't1' },
            ...ANSWER.split(' ').map((w) => ({ type: 'text-delta', id: 't1', delta: `${w} ` })),
            { type: 'text-end', id: 't1' },
            { type: 'finish', finishReason: 'stop', usage },
          ]
        : [
            { type: 'stream-start', warnings: [] },
            { type: 'tool-call', toolCallId: `call_${Date.now()}`, toolName: 'getWeather', input: '{"city":"Paris"}' },
            { type: 'finish', finishReason: 'tool-calls', usage },
          ];
      return { stream: simulateReadableStream({ chunks: parts as never[], initialDelayInMs: 200, chunkDelayInMs: 60 }) };
    },
  });
}

const getWeather = createTool({
  id: 'getWeather',
  description: 'Current weather for a city',
  inputSchema: z.object({ city: z.string() }),
  execute: async ({ city }) => ({ city, forecast: 'sunny', celsius: 21 }),
});

/** MODEL=openai/gpt-5-mini (with OPENAI_API_KEY) uses a real model through Mastra's model router. */
export function createWeatherAgent() {
  return new Agent({
    id: 'weather',
    name: 'Weather agent',
    instructions: 'You answer weather questions. Use the getWeather tool.',
    model: process.env.MODEL || scriptedModel(),
    tools: { getWeather },
  });
}
