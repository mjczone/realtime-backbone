import { EventType, transformChunks, type BaseEvent } from '@ag-ui/client';
import type { Observable } from 'rxjs';
import { MAX_ENVELOPE_BYTES } from '@mjczone/realtime-contract';
import { DeltaBatcher, type BatcherOptions, type Publisher } from '@mjczone/realtime-publisher';

export interface SinkOptions {
  /** A publisher for the run's tenant. */
  publisher: Publisher;
  channel: string;
  runId: string;
  threadId: string;
  /** The agent's AG-UI events, for example MastraAgent.run(input). */
  events: Observable<BaseEvent>;
  batcher?: BatcherOptions;
  /** Aborting stops the agent and publishes RUN_ERROR with code rtb.cancelled. */
  signal?: AbortSignal;
  /** AG-UI event types not to publish, for example ['STATE_SNAPSHOT'] when the UI doesn't use shared state. */
  skipTypes?: string[];
}

/**
 * Events a run can't work without: the client completes on RUN_FINISHED or RUN_ERROR, and the text and tool-call
 * events are the conversation itself. skipTypes may not contain them.
 */
export const REQUIRED_EVENT_TYPES: readonly string[] = [
  'RUN_FINISHED',
  'RUN_ERROR',
  'TEXT_MESSAGE_START',
  'TEXT_MESSAGE_CONTENT',
  'TEXT_MESSAGE_END',
  'TEXT_MESSAGE_CHUNK',
  'TOOL_CALL_START',
  'TOOL_CALL_ARGS',
  'TOOL_CALL_END',
  'TOOL_CALL_RESULT',
  'TOOL_CALL_CHUNK',
];

/** Returns skipTypes as a set, or throws if it contains an event type a run needs. */
export function checkSkipTypes(skipTypes: readonly string[] = []): Set<string> {
  const required = skipTypes.filter((t) => REQUIRED_EVENT_TYPES.includes(t));
  if (required.length) throw new Error(`these AG-UI event types can't be skipped: ${required.join(', ')}`);
  return new Set(skipTypes);
}

export interface SinkResult {
  /** Every event that was published, in order, after batching. */
  events: BaseEvent[];
  error?: Error;
}

// Room for the envelope fields around the AG-UI event.
const ENVELOPE_OVERHEAD = 1024;
const encoder = new TextEncoder();

function oversizeMarker(event: BaseEvent, bytes: number): BaseEvent {
  return { type: EventType.CUSTOM, name: 'rtb.oversize', value: { type: event.type, bytes } } as BaseEvent;
}

/**
 * Publishes an agent's AG-UI events to a run channel. It drops the agent's own RUN_STARTED (the run
 * endpoint already published one), normalizes TEXT_MESSAGE_CHUNK events, batches deltas, replaces
 * events over the envelope cap with an rtb.oversize marker, and publishes RUN_ERROR if the agent fails
 * without one. Resolves when everything is published; it never rejects. It throws right away for a skipTypes
 * it refuses.
 */
export function publishAgentRun(options: SinkOptions): Promise<SinkResult> {
  const skip = checkSkipTypes(options.skipTypes);
  const { publisher, channel, runId } = options;
  const published: BaseEvent[] = [];
  const pending: Promise<unknown>[] = [];
  let ended = false;

  const send = (event: BaseEvent) => {
    const bytes = encoder.encode(JSON.stringify(event)).length;
    const out = bytes + ENVELOPE_OVERHEAD > MAX_ENVELOPE_BYTES ? oversizeMarker(event, bytes) : event;
    if (out.type === EventType.RUN_FINISHED || out.type === EventType.RUN_ERROR) ended = true;
    published.push(out);
    pending.push(publisher.publish(channel, `agui.${out.type}`, out, { corr: runId }).catch(() => {}));
  };
  const batcher = new DeltaBatcher((e) => send(e as unknown as BaseEvent), options.batcher);

  return new Promise<SinkResult>((resolve) => {
    let done = false;
    const finish = async (error?: Error, code = 'rtb.agent_error') => {
      if (done) return;
      done = true;
      options.signal?.removeEventListener('abort', onAbort);
      batcher.flush();
      if (error && !ended) send({ type: EventType.RUN_ERROR, message: error.message, code } as BaseEvent);
      await Promise.all(pending);
      resolve({ events: published, ...(error ? { error } : {}) });
    };
    const onAbort = () => {
      subscription.unsubscribe();
      void finish(new Error('Run cancelled'), 'rtb.cancelled');
    };
    const subscription = options.events.pipe(transformChunks()).subscribe({
      next: (event) => {
        if (event.type === EventType.RUN_STARTED || skip.has(event.type)) return;
        batcher.push(event as unknown as Parameters<DeltaBatcher['push']>[0]);
      },
      error: (e) => void finish(e instanceof Error ? e : new Error(String(e))),
      complete: () => void finish(),
    });
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener('abort', onAbort, { once: true });
  });
}
