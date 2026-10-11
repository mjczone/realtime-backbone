import { Agent } from '@mastra/core/agent';
import { Mastra } from '@mastra/core/mastra';
import { InMemoryStore } from '@mastra/core/storage';
import { createTool } from '@mastra/core/tools';
import type { BaseEvent, Message } from '@ag-ui/client';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { z } from 'zod';

// Resuming after an approval loads the paused run from Mastra storage, so every run uses this one store.
// A service with more than one process needs a shared store (LibSQL, Postgres) instead.
const store = new InMemoryStore();

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};
const TAIL = '(A scripted model wrote this, so the sample needs no API key. Reload while it types and it picks up where it left off.)';

type Prompt = Array<{ role: string; content: unknown }>;
type Part = { type: string; text?: string; toolName?: string; output?: { type: string; value: unknown } };

function lastUserText(prompt: Prompt): string {
  const msg = [...prompt].reverse().find((m) => m.role === 'user');
  if (!msg) return '';
  if (typeof msg.content === 'string') return msg.content;
  return (msg.content as Part[]).filter((p) => p.type === 'text').map((p) => p.text).join(' ');
}

/** What the user asked for, from their last message. */
export function intentOf(text: string): { tool: string; args: Record<string, unknown> } | null {
  const add = /\b(?:add|create)\s+(?:a\s+)?task[:\s-]+(.+)/i.exec(text) ?? /\badd\s+(.+?)\s+to\s+(?:my\s+|the\s+)?(?:tasks|list)\b/i.exec(text);
  if (add) return { tool: 'createTask', args: { title: add[1].trim().replace(/[.!?]+$/, '') } };
  if (/\b(?:delete|clear|remove)\s+(?:all|every)\b.*\btasks?\b/i.test(text)) return { tool: 'deleteAllTasks', args: {} };
  if (/\b(?:list|show|what are|what's on)\b.*\btasks?\b/i.test(text)) return { tool: 'listTasks', args: {} };
  const theme = /\b(dark|light)\s+(?:mode|theme)\b/i.exec(text);
  if (theme) return { tool: 'setTheme', args: { theme: theme[1].toLowerCase() } };
  return null;
}

function answerFor(toolName: string, output: unknown, args: Record<string, unknown>): string {
  const text = typeof output === 'string' ? output : JSON.stringify(output);
  const value = (() => {
    try {
      return typeof output === 'string' ? JSON.parse(output) : output;
    } catch {
      return output;
    }
  })() as Record<string, unknown> & Array<{ title: string }>;
  switch (toolName) {
    case 'createTask':
      return `Added "${args.title}" to your tasks.`;
    case 'listTasks':
      return Array.isArray(value) && value.length
        ? `You have ${value.length} task${value.length === 1 ? '' : 's'}: ${value.map((t) => t.title).join(', ')}.`
        : 'You have no tasks.';
    case 'deleteAllTasks':
      return /not approved|denied|declined/i.test(text) ? 'OK, I left your tasks alone.' : `Deleted ${value.deleted ?? 'all'} tasks.`;
    case 'setTheme':
      return `Done, the theme is now ${args.theme}.`;
  }
  return 'Done.';
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
 * Stands in for a model. It picks a tool from the last message ("add a task: buy milk", "list my tasks",
 * "delete all tasks", "switch to dark mode"), calls it, and answers from the tool's result. setTheme is a frontend
 * tool: the page offers it in RunAgentInput.tools and runs it itself.
 */
function scriptedModel() {
  return new MockLanguageModelV3({
    provider: 'scripted',
    modelId: 'scripted-tasks',
    doStream: async ({ prompt, tools }) => {
      const p = prompt as unknown as Prompt;
      const intent = intentOf(lastUserText(p));
      const last = p.at(-1);
      let parts;
      if (last?.role === 'tool' && intent) {
        const result = (last.content as Part[]).find((c) => c.type === 'tool-result');
        parts = textParts(`${answerFor(result?.toolName ?? intent.tool, result?.output?.value, intent.args)} ${TAIL}`);
      } else if (intent && (intent.tool !== 'setTheme' || tools?.some((t) => t.name === 'setTheme'))) {
        const input = JSON.stringify(intent.args);
        const id = `call_${Date.now()}`;
        parts = [
          { type: 'stream-start', warnings: [] },
          { type: 'tool-input-start', id, toolName: intent.tool },
          { type: 'tool-input-delta', id, delta: input },
          { type: 'tool-input-end', id },
          { type: 'tool-call', toolCallId: id, toolName: intent.tool, input },
          { type: 'finish', finishReason: 'tool-calls', usage },
        ];
      } else {
        parts = textParts(
          `I manage your tasks. Try: add a task: buy milk. List my tasks. Delete all tasks. Switch to dark mode. ${TAIL}`,
        );
      }
      return { stream: simulateReadableStream({ chunks: parts as never[], initialDelayInMs: 200, chunkDelayInMs: 50 }) };
    },
  });
}

/** The agent for one request. Its tools call the .NET API as the user, with their access token. */
export function createAppAgent(apiUrl: string, accessToken: string) {
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${apiUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`.NET API ${method} ${path}: HTTP ${res.status}`);
    return res.json();
  };
  const createTask = createTool({
    id: 'createTask',
    description: 'Add a task to the user\'s task list',
    inputSchema: z.object({ title: z.string() }),
    execute: async ({ title }) => api('POST', '/api/tasks', { title }),
  });
  const listTasks = createTool({
    id: 'listTasks',
    description: 'List the user\'s tasks',
    inputSchema: z.object({}),
    execute: async () => api('GET', '/api/tasks'),
  });
  const deleteAllTasks = createTool({
    id: 'deleteAllTasks',
    description: 'Delete every task. Needs the user\'s approval.',
    inputSchema: z.object({}),
    requireApproval: true,
    execute: async () => api('DELETE', '/api/tasks'),
  });
  const agent = new Agent({
    id: 'tasks',
    name: 'Tasks assistant',
    instructions: 'You manage the user\'s tasks with your tools. Ask before deleting.',
    // MODEL=openai/gpt-5-mini (with OPENAI_API_KEY) uses a real model through Mastra's model router.
    model: process.env.MODEL || scriptedModel(),
    tools: { createTask, listTasks, deleteAllTasks },
  });
  new Mastra({ agents: { tasks: agent }, storage: store, logger: false });
  return agent;
}

/** Turns a run's AG-UI events into AG-UI messages for the thread store. */
export function messagesFromEvents(events: BaseEvent[]): Message[] {
  const out: any[] = [];
  const byId = new Map<string, any>();
  for (const e of events as any[]) {
    if (e.type === 'TEXT_MESSAGE_START') {
      const m = { id: e.messageId, role: 'assistant', content: '' };
      byId.set(e.messageId, m);
      out.push(m);
    } else if (e.type === 'TEXT_MESSAGE_CONTENT') {
      byId.get(e.messageId).content += e.delta;
    } else if (e.type === 'TOOL_CALL_START') {
      let parent = byId.get(e.parentMessageId ?? e.toolCallId);
      if (!parent) {
        parent = { id: e.parentMessageId ?? e.toolCallId, role: 'assistant' };
        byId.set(parent.id, parent);
        out.push(parent);
      }
      parent.toolCalls ??= [];
      parent.toolCalls.push({ id: e.toolCallId, type: 'function', function: { name: e.toolCallName, arguments: '' } });
      byId.set(`call:${e.toolCallId}`, parent.toolCalls.at(-1));
    } else if (e.type === 'TOOL_CALL_ARGS') {
      byId.get(`call:${e.toolCallId}`).function.arguments += e.delta;
    } else if (e.type === 'TOOL_CALL_RESULT') {
      out.push({ id: e.messageId, role: 'tool', toolCallId: e.toolCallId, content: e.content });
    }
  }
  return out;
}
