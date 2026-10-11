import { AbstractAgent, EventType, type AgentConfig, type BaseEvent, type RunAgentInput } from '@ag-ui/client';
import { Observable } from 'rxjs';
import type { RealtimeClient } from '@mjczone/realtime-client';

/** What the run endpoint returns with 202, and what the agent stores to reattach. */
export interface RunRef {
  runId: string;
  threadId: string;
  channel: string;
  /** Stream position of the run's RUN_STARTED. */
  offset: number;
  epoch: string;
  /** Subscription token for the channel, when the endpoint returns one. */
  token?: string;
}

export interface CentrifugoAgentConfig extends AgentConfig {
  client: RealtimeClient;
  /** The agent service's run endpoint. It takes RunAgentInput and returns 202 with a RunRef. */
  runUrl: string;
  /** Extra headers for run and cancel requests, such as auth. */
  headers?: () => Record<string, string> | Promise<Record<string, string>>;
  /** Cancel endpoint for a run. When set, abortRun() POSTs to it. */
  cancelUrl?: (run: RunRef) => string;
  /** Where the active run is kept so a reload can reattach. Default sessionStorage when available; null turns it off. */
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
  fetch?: typeof fetch;
}

const END_EVENTS = new Set<string>([EventType.RUN_FINISHED, EventType.RUN_ERROR]);

function defaultStorage(): CentrifugoAgentConfig['storage'] {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

/**
 * An AG-UI agent whose events arrive over a realtime backbone subscription instead of an SSE response.
 * runAgent() starts a run over HTTP; connectAgent() reattaches to the active run after a reload.
 */
export class CentrifugoAgent extends AbstractAgent {
  private readonly config: CentrifugoAgentConfig;
  private readonly storage: CentrifugoAgentConfig['storage'];
  private activeRun: RunRef | null = null;
  private attachTarget: RunRef | null = null;

  constructor(config: CentrifugoAgentConfig) {
    super(config);
    this.config = config;
    this.storage = config.storage === undefined ? defaultStorage() : config.storage;
  }

  /** The run this agent would reattach to, if any. */
  get storedRun(): RunRef | null {
    try {
      const raw = this.storage?.getItem(this.storageKey());
      return raw ? (JSON.parse(raw) as RunRef) : null;
    } catch {
      return null;
    }
  }

  /** Reattach to a specific run, such as one from a notice.run_started message. Then call connectAgent(). */
  attach(run: RunRef): this {
    this.attachTarget = run;
    return this;
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      const abort = new AbortController();
      let inner: { unsubscribe(): void } | undefined;
      (async () => {
        const res = await (this.config.fetch ?? fetch)(this.config.runUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(await this.config.headers?.()) },
          body: JSON.stringify(input),
          signal: abort.signal,
        });
        if (!res.ok) throw new Error(`Run request failed: HTTP ${res.status}`);
        const run = (await res.json()) as RunRef;
        if (abort.signal.aborted) return;
        inner = this.stream(run).subscribe(subscriber);
      })().catch((e) => {
        if (!abort.signal.aborted) subscriber.error(e);
      });
      return () => {
        abort.abort();
        inner?.unsubscribe();
      };
    });
  }

  protected connect(): Observable<BaseEvent> {
    const run = this.attachTarget ?? this.storedRun;
    this.attachTarget = null;
    if (!run) return new Observable((s) => s.complete());
    return this.stream({ ...run, token: undefined });
  }

  abortRun(): void {
    const run = this.activeRun;
    if (run && this.config.cancelUrl) {
      void (async () => {
        await (this.config.fetch ?? fetch)(this.config.cancelUrl!(run), {
          method: 'POST',
          headers: { ...(await this.config.headers?.()) },
        });
      })().catch(() => {});
    }
    void this.detachActiveRun();
  }

  private stream(run: RunRef): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      this.activeRun = run;
      this.save(run);
      const finish = () => {
        this.activeRun = null;
        this.save(null);
      };
      const sub = this.config.client.subscribe(
        run.channel,
        (envelope) => {
          if (!envelope.type.startsWith('agui.')) return;
          const event = envelope.data as unknown as BaseEvent;
          subscriber.next(event);
          if (END_EVENTS.has(event.type)) {
            // A run paused for the user (an interrupt) isn't done: keep it stored, so a reload replays it and the
            // agent gets its pendingInterrupts back. The resume run replaces it.
            if ((event as { outcome?: { type?: string } }).outcome?.type === 'interrupt') this.activeRun = null;
            else finish();
            subscriber.complete();
          }
        },
        {
          since: { offset: run.offset - 1, epoch: run.epoch },
          token: run.token,
          onSubscribed: (info) => {
            if (info.wasRecovering && !info.recovered) {
              finish();
              subscriber.next({
                type: EventType.RUN_ERROR,
                message: 'The run is no longer in the backbone history. Load the thread from the app.',
                code: 'rtb.history_lost',
              } as BaseEvent);
              subscriber.complete();
            }
          },
          onFailed: (err) => {
            finish();
            subscriber.error(new Error(`Subscription to ${run.channel} failed: ${err.code} ${err.message}`));
          },
        },
      );
      return () => sub.unsubscribe();
    });
  }

  private storageKey(): string {
    return `rtb.agui.run.${this.agentId ?? 'agent'}.${this.threadId}`;
  }

  private save(run: RunRef | null): void {
    try {
      if (run) this.storage?.setItem(this.storageKey(), JSON.stringify({ ...run, token: undefined }));
      else this.storage?.removeItem(this.storageKey());
    } catch {
      /* storage may be full or blocked */
    }
  }
}
