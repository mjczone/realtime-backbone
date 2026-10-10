import { describe, expect, it } from 'vitest';
import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { MastraAgent } from '@ag-ui/mastra';
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import { Observable } from 'rxjs';
import { z } from 'zod';
import { createPublisher } from '@rtb/publisher';
import { createTokenSigner, generateSigningKey } from '@rtb/tokens';
import { createRunEndpoints, publishAgentRun, startRun } from '../src/index.js';

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

function weatherAgent(words = ['It is ', 'sunny ', 'in ', 'Paris.']) {
  let call = 0;
  const model = new MockLanguageModelV3({
    provider: 'mock',
    modelId: 'mock-1',
    doStream: async () => {
      call++;
      const parts =
        call === 1
          ? [
              { type: 'stream-start', warnings: [] },
              { type: 'tool-input-start', id: 'tc1', toolName: 'getWeather' },
              { type: 'tool-input-delta', id: 'tc1', delta: '{"city":"Paris"}' },
              { type: 'tool-input-end', id: 'tc1' },
              { type: 'tool-call', toolCallId: 'tc1', toolName: 'getWeather', input: '{"city":"Paris"}' },
              { type: 'finish', finishReason: 'tool-calls', usage },
            ]
          : [
              { type: 'stream-start', warnings: [] },
              { type: 'text-start', id: 't1' },
              ...words.map((delta) => ({ type: 'text-delta', id: 't1', delta })),
              { type: 'text-end', id: 't1' },
              { type: 'finish', finishReason: 'stop', usage },
            ];
      return { stream: convertArrayToReadableStream(parts as never[]) };
    },
  });
  const getWeather = createTool({
    id: 'getWeather',
    description: 'Weather for a city',
    inputSchema: z.object({ city: z.string() }),
    execute: async ({ city }) => ({ city, forecast: 'sunny' }),
  });
  const agent = new Agent({ id: 'weather', name: 'weather', instructions: 'x', model, tools: { getWeather } });
  return new MastraAgent({ agent, resourceId: 'u1' });
}

function fakeBackbone() {
  const published: { channel: string; type: string; data: any }[] = [];
  let offset = 0;
  const fetch = (async (_u: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    published.push({ channel: body.channel, type: body.data.type, data: body.data.data });
    return Response.json({ result: { offset: ++offset, epoch: 'e1' } });
  }) as typeof globalThis.fetch;
  const publisher = createPublisher({ apiUrl: 'http://cf/api', apiKey: 'k', source: 'agent', tenant: 'acme', fetch, audit: () => {} });
  return { publisher, published };
}

const input = { messages: [{ id: 'm1', role: 'user', content: 'Weather in Paris?' }] } as any;

describe('startRun with a Mastra agent', () => {
  it('publishes our RUN_STARTED, drops the agent one, batches text and finishes', async () => {
    const { publisher, published } = fakeBackbone();
    const created: string[] = [];
    let finished: any;
    const ref = await startRun({
      publisher,
      agent: weatherAgent(),
      input: { ...input, threadId: 'th1' },
      userId: 'u1',
      onRunCreated: (r) => void created.push(r.runId),
      onRunFinished: (_r, result) => void (finished = result),
    });
    expect(ref).toMatchObject({ threadId: 'th1', offset: 1, epoch: 'e1' });
    expect(ref.channel).toBe(`replay:t-acme.run.${ref.runId}`);
    expect(created).toEqual([ref.runId]);
    await ref.done;

    const types = published.map((p) => p.type);
    expect(types.filter((t) => t === 'agui.RUN_STARTED')).toHaveLength(1);
    expect(published[0].data).toMatchObject({ type: 'RUN_STARTED', runId: ref.runId, threadId: 'th1' });
    expect(types).toEqual([
      'agui.RUN_STARTED',
      'agui.TOOL_CALL_START',
      'agui.TOOL_CALL_ARGS',
      'agui.TOOL_CALL_END',
      'agui.TOOL_CALL_RESULT',
      'agui.TEXT_MESSAGE_START',
      'agui.TEXT_MESSAGE_CONTENT',
      'agui.TEXT_MESSAGE_END',
      'agui.RUN_FINISHED',
    ]);
    expect(published.find((p) => p.type === 'agui.TEXT_MESSAGE_CONTENT')!.data.delta).toBe('It is sunny in Paris.');
    expect(published.at(-1)!.data.runId).toBe(ref.runId);
    expect(published.every((p) => p.channel === ref.channel)).toBe(true);
    expect(finished.events).toHaveLength(8);
    expect(finished.error).toBeUndefined();
  });

  it('notifyUser publishes notice.run_started to the user channel', async () => {
    const { publisher, published } = fakeBackbone();
    const ref = await startRun({ publisher, agent: weatherAgent(), input, userId: 'u1', notifyUser: true });
    await ref.done;
    const notice = published.find((p) => p.type === 'notice.run_started')!;
    expect(notice.channel).toBe('live:t-acme.user#u1');
    expect(notice.data).toEqual({ runId: ref.runId, threadId: ref.threadId, channel: ref.channel, offset: 1, epoch: 'e1' });
  });
});

describe('publishAgentRun', () => {
  const run = { channel: 'replay:t-acme.run.r1', runId: 'r1', threadId: 't1' };

  it('publishes RUN_ERROR when the agent fails without one', async () => {
    const { publisher, published } = fakeBackbone();
    const events = new Observable<any>((s) => {
      s.next({ type: 'RUN_STARTED', threadId: 't1', runId: 'r1' });
      s.error(new Error('model down'));
    });
    const r = await publishAgentRun({ publisher, events, ...run });
    expect(r.error?.message).toBe('model down');
    expect(published.map((p) => p.data)).toEqual([{ type: 'RUN_ERROR', message: 'model down', code: 'rtb.agent_error' }]);
  });

  it('does not add a second RUN_ERROR', async () => {
    const { publisher, published } = fakeBackbone();
    const events = new Observable<any>((s) => {
      s.next({ type: 'RUN_ERROR', message: 'bad' });
      s.error(new Error('bad'));
    });
    await publishAgentRun({ publisher, events, ...run });
    expect(published).toHaveLength(1);
  });

  it('skips the event types it is told to', async () => {
    const { publisher, published } = fakeBackbone();
    const events = new Observable<any>((s) => {
      s.next({ type: 'STATE_SNAPSHOT', snapshot: { a: 1 } });
      s.next({ type: 'RUN_FINISHED', threadId: 't1', runId: 'r1' });
      s.complete();
    });
    const r = await publishAgentRun({ publisher, events, skipTypes: ['STATE_SNAPSHOT'], ...run });
    expect(published.map((p) => p.type)).toEqual(['agui.RUN_FINISHED']);
    expect(r.events.map((e) => e.type)).toEqual(['RUN_FINISHED']);
  });

  it('replaces an oversize event with an rtb.oversize marker', async () => {
    const { publisher, published } = fakeBackbone();
    const events = new Observable<any>((s) => {
      s.next({ type: 'STATE_SNAPSHOT', snapshot: { blob: 'x'.repeat(70000) } });
      s.next({ type: 'RUN_FINISHED', threadId: 't1', runId: 'r1' });
      s.complete();
    });
    await publishAgentRun({ publisher, events, ...run });
    expect(published[0].type).toBe('agui.CUSTOM');
    expect(published[0].data).toMatchObject({ type: 'CUSTOM', name: 'rtb.oversize', value: { type: 'STATE_SNAPSHOT' } });
    expect(published[0].data.value.bytes).toBeGreaterThan(70000);
    expect(published[1].type).toBe('agui.RUN_FINISHED');
  });

  it('abort stops the agent and publishes RUN_ERROR rtb.cancelled', async () => {
    const { publisher, published } = fakeBackbone();
    let stopped = false;
    const events = new Observable<any>((s) => {
      s.next({ type: 'TEXT_MESSAGE_START', messageId: 'm', role: 'assistant' });
      return () => (stopped = true);
    });
    const abort = new AbortController();
    const p = publishAgentRun({ publisher, events, signal: abort.signal, ...run });
    abort.abort();
    await p;
    expect(stopped).toBe(true);
    expect(published.at(-1)!.data).toMatchObject({ type: 'RUN_ERROR', code: 'rtb.cancelled' });
  });
});

describe('createRunEndpoints', () => {
  it('returns 202 with a token and lets only the owner cancel', async () => {
    const { publisher, published } = fakeBackbone();
    const signer = await createTokenSigner({ privateKey: await generateSigningKey(), audience: 'a', issuer: 'i' });
    const slow = new Observable<any>(() => {});
    const endpoints = createRunEndpoints({
      publisher,
      signer,
      authenticate: (req) => {
        const u = req.headers.get('x-user');
        return u ? { userId: u, tenant: 'acme' } : null;
      },
      agent: () => ({ run: () => slow }),
    });
    const post = (user?: string, body: unknown = input) =>
      new Request('http://svc/run', { method: 'POST', headers: user ? { 'x-user': user } : {}, body: JSON.stringify(body) });

    expect((await endpoints.run(post())).status).toBe(401);
    expect((await endpoints.run(post('u1', { messages: 'nope' }))).status).toBe(400);
    const r = await endpoints.run(post('u1'));
    expect(r.status).toBe(202);
    const ref = (await r.json()) as any;
    expect(ref).toMatchObject({ offset: 1, epoch: 'e1' });
    expect(typeof ref.token).toBe('string');
    expect(ref).not.toHaveProperty('done');

    expect((await endpoints.cancel(post('u2'), ref.runId)).status).toBe(404);
    expect((await endpoints.cancel(post('u1'), ref.runId)).status).toBe(200);
    await new Promise((res) => setTimeout(res, 20));
    expect(published.at(-1)!.data).toMatchObject({ type: 'RUN_ERROR', code: 'rtb.cancelled' });
  });
});
