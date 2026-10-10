import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { z } from 'zod';

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

const TAIL =
  'This answer comes from a scripted model, so the sample runs without an API key. Each word is a separate ' +
  'delta from the model. The sink batches them, publishes them to the run channel, and every open tab sees ' +
  'the same text. Reload the page while it types and it picks up where it left off.';

/** The city after the last "in" in the question: "What is the weather in new york?" gives "New York". */
export function cityFrom(question: string): string | null {
  const matches = [...question.matchAll(/\bin\s+([A-Za-z][A-Za-z .'-]*)/gi)];
  const raw = matches.at(-1)?.[1].trim().replace(/[\s.'-]+$/, '');
  if (!raw) return null;
  return raw
    .split(/\s+/)
    .map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

/** Made-up weather that is always the same for the same city. */
export function weather(city: string) {
  const sum = [...city.toLowerCase()].filter((c) => c >= 'a' && c <= 'z').reduce((s, c) => s + c.charCodeAt(0), 0);
  return { city, forecast: ['sunny', 'cloudy', 'rainy', 'windy'][sum % 4], celsius: 5 + (sum % 25) };
}

function lastUserText(prompt: Array<{ role: string; content: unknown }>): string {
  const msg = [...prompt].reverse().find((m) => m.role === 'user');
  if (!msg) return '';
  if (typeof msg.content === 'string') return msg.content;
  return (msg.content as Array<{ type: string; text?: string }>)
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join(' ');
}

function textParts(text: string) {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't1' },
    ...text.split(' ').map((w) => ({ type: 'text-delta', id: 't1', delta: `${w} ` })),
    { type: 'text-end', id: 't1' },
    { type: 'finish', finishReason: 'stop', usage },
  ];
}

/**
 * Stands in for a model: finds the city in the last question, calls getWeather with it, then streams an answer
 * word by word. Without a city it asks for one.
 */
function scriptedModel() {
  return new MockLanguageModelV3({
    provider: 'scripted',
    modelId: 'scripted-weather',
    doStream: async ({ prompt }) => {
      const city = cityFrom(lastUserText(prompt as never));
      let parts;
      if (prompt.at(-1)?.role === 'tool' && city) {
        const w = weather(city);
        parts = textParts(`The forecast says it is ${w.forecast} in ${w.city} today, ${w.celsius} degrees. ${TAIL}`);
      } else if (city) {
        parts = [
          { type: 'stream-start', warnings: [] },
          { type: 'tool-call', toolCallId: `call_${Date.now()}`, toolName: 'getWeather', input: JSON.stringify({ city }) },
          { type: 'finish', finishReason: 'tool-calls', usage },
        ];
      } else {
        parts = textParts(`Ask me about the weather in a city, for example: what is the weather in Lisbon? ${TAIL}`);
      }
      return { stream: simulateReadableStream({ chunks: parts as never[], initialDelayInMs: 200, chunkDelayInMs: 60 }) };
    },
  });
}

const getWeather = createTool({
  id: 'getWeather',
  description: 'Current weather for a city',
  inputSchema: z.object({ city: z.string() }),
  execute: async ({ city }) => weather(city),
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
