import { EventType, transformChunks, type BaseEvent } from '@ag-ui/client';
import type { Observable } from 'rxjs';
import { MAX_ENVELOPE_BYTES } from '@rtb/contract';
import { DeltaBatcher, type BatcherOptions, type Publisher } from '@rtb/publisher';

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
 * without one. Resolves when everything is published; it never rejects.
 */
export function publishAgentRun(options: SinkOptions): Promise<SinkResult> {
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
        if (event.type === EventType.RUN_STARTED) return;
        batcher.push(event as unknown as Parameters<DeltaBatcher['push']>[0]);
      },
      error: (e) => void finish(e instanceof Error ? e : new Error(String(e))),
      complete: () => void finish(),
    });
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener('abort', onAbort, { once: true });
  });
}
