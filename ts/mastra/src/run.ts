import type { BaseEvent, RunAgentInput } from '@ag-ui/client';
import { throwError, type Observable } from 'rxjs';
import { Channels, newId } from '@rtb/contract';
import type { Publisher } from '@rtb/publisher';
import type { TokenSigner, TokenUser } from '@rtb/tokens';
import { publishAgentRun, type SinkResult } from './sink.js';

/** Anything with an AG-UI run method, such as a MastraAgent from @ag-ui/mastra. */
export interface AgUiRunnable {
  run(input: RunAgentInput): Observable<BaseEvent>;
}

export interface RunInfo {
  /** The input the agent runs with, including the client's messages. */
  input: RunAgentInput;
  runId: string;
  threadId: string;
  channel: string;
  tenant: string;
  userId: string;
}

export interface RunRef {
  runId: string;
  threadId: string;
  channel: string;
  offset: number;
  epoch: string;
  token?: string;
}

export interface StartRunOptions {
  /** Publisher for the run's tenant. */
  publisher: Publisher;
  agent: AgUiRunnable;
  input: Partial<RunAgentInput>;
  /** The user who owns the run. */
  userId: string;
  /** Publish notice.run_started to the user's live channel. Use it for background runs. */
  notifyUser?: boolean;
  /** Called before anything is published, so the app can record who may watch the run. */
  onRunCreated?: (run: RunInfo) => Promise<void> | void;
  /** Called after the run ends, with every published event, so the app can store the thread. */
  onRunFinished?: (run: RunInfo, result: SinkResult) => Promise<void> | void;
  signal?: AbortSignal;
  /** AG-UI event types not to publish, for example ['STATE_SNAPSHOT'] when the UI doesn't use shared state. */
  skipTypes?: string[];
}

/**
 * Starts an agent run on its own replay channel. Publishes RUN_STARTED, then drives the agent in the
 * background. Resolves with the run's stream position once RUN_STARTED is published; `done` resolves
 * when the run has ended. Needs a long-running process, not a request-scoped serverless function.
 */
export async function startRun(options: StartRunOptions): Promise<RunRef & { done: Promise<void> }> {
  const { publisher, userId } = options;
  const tenant = publisher.tenant;
  if (!tenant) throw new Error('startRun needs a publisher with a tenant (publisher.forTenant(t))');
  const runId = newId();
  const threadId = options.input.threadId || newId();
  const channel = Channels.run(tenant, runId);
  const input: RunAgentInput = {
    messages: [],
    tools: [],
    context: [],
    state: {},
    forwardedProps: {},
    ...options.input,
    threadId,
    runId,
  } as RunAgentInput;
  const info: RunInfo = { input, runId, threadId, channel, tenant, userId };

  await options.onRunCreated?.(info);
  const started = await publisher.publish(channel, 'agui.RUN_STARTED', { type: 'RUN_STARTED', threadId, runId }, { corr: runId });
  const ref = { runId, threadId, channel, offset: started.offset!, epoch: started.epoch! };
  if (options.notifyUser) {
    await publisher.publish(Channels.user(tenant, userId), 'notice.run_started', ref).catch(() => {});
  }

  const done = (async () => {
    let events: Observable<BaseEvent>;
    try {
      events = options.agent.run(input);
    } catch (e) {
      events = throwError(() => e);
    }
    const result = await publishAgentRun({
      publisher,
      channel,
      runId,
      threadId,
      events,
      signal: options.signal,
      skipTypes: options.skipTypes,
    });
    try {
      await options.onRunFinished?.(info, result);
    } catch (e) {
      console.error(`rtb: onRunFinished failed for ${runId}`, e);
    }
  })();
  return { ...ref, done };
}

export interface RunEndpointOptions {
  /** Base publisher; each run uses publisher.forTenant(user.tenant). */
  publisher: Publisher;
  signer: TokenSigner;
  authenticate: (req: Request) => Promise<TokenUser | null> | TokenUser | null;
  /** The agent to run for this request. */
  agent: (input: RunAgentInput, user: TokenUser) => AgUiRunnable | Promise<AgUiRunnable>;
  onRunCreated?: StartRunOptions['onRunCreated'];
  onRunFinished?: StartRunOptions['onRunFinished'];
  /** Also publish notice.run_started to the user's live channel, so the user's other tabs can join. */
  notifyUser?: boolean;
  /** AG-UI event types not to publish, for example ['STATE_SNAPSHOT'] when the UI doesn't use shared state. */
  skipTypes?: string[];
}

export interface RunEndpoints {
  /** POST RunAgentInput: returns 202 with { runId, threadId, channel, offset, epoch, token }. */
  run: (req: Request) => Promise<Response>;
  /** POST: cancels a run the caller owns. */
  cancel: (req: Request, runId: string) => Promise<Response>;
}

const error = (status: number, message: string) => Response.json({ error: message }, { status });

export function createRunEndpoints(options: RunEndpointOptions): RunEndpoints {
  const active = new Map<string, { userId: string; tenant: string; abort: AbortController }>();

  return {
    async run(req) {
      const user = await options.authenticate(req);
      if (!user) return error(401, 'unauthenticated');
      let input: RunAgentInput;
      try {
        input = (await req.json()) as RunAgentInput;
      } catch {
        return error(400, 'body must be RunAgentInput JSON');
      }
      if (typeof input !== 'object' || input === null || (input.messages !== undefined && !Array.isArray(input.messages))) {
        return error(400, 'body must be RunAgentInput JSON');
      }
      const abort = new AbortController();
      const ref = await startRun({
        publisher: options.publisher.forTenant(user.tenant),
        agent: await options.agent(input, user),
        input,
        userId: user.userId,
        notifyUser: options.notifyUser,
        skipTypes: options.skipTypes,
        onRunCreated: options.onRunCreated,
        onRunFinished: options.onRunFinished,
        signal: abort.signal,
      });
      active.set(ref.runId, { userId: user.userId, tenant: user.tenant, abort });
      void ref.done.finally(() => active.delete(ref.runId));
      const token = await options.signer.mintSubscriptionToken({ sub: user.userId, channel: ref.channel });
      const { done: _done, ...body } = ref;
      return Response.json({ ...body, token }, { status: 202 });
    },

    async cancel(req, runId) {
      const user = await options.authenticate(req);
      if (!user) return error(401, 'unauthenticated');
      const run = active.get(runId);
      if (!run || run.userId !== user.userId || run.tenant !== user.tenant) return error(404, 'no such run');
      run.abort.abort();
      return Response.json({ cancelled: true });
    },
  };
}
