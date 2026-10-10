import {
  MAX_ENVELOPE_BYTES,
  TenantGuardError,
  checkTenant,
  createEnvelope,
  envelopeBytes,
  tryParseChannel,
  type Envelope,
  type TenantContext,
} from '@rtb/contract';

export interface AuditEntry {
  component: string;
  tenant: string;
  channel: string;
  type: string;
  id?: string;
  ts: string;
  outcome: 'ok' | 'denied' | 'too_large' | 'failed';
  reason?: string;
  attempts?: number;
}

export type AuditLogger = (entry: AuditEntry) => void;

export interface RetryOptions {
  /** Most attempts per publish, including the first. Default 8. */
  attempts?: number;
  /** First backoff step in ms. Default 100. */
  baseMs?: number;
  /** Longest single backoff in ms. Default 5000. */
  maxMs?: number;
  /** Stop retrying after this long in ms. Default 30000, well inside Centrifugo's 5 minute idempotency window. */
  totalMs?: number;
}

export interface PublisherOptions {
  /** Centrifugo HTTP API base, for example http://backbone:9000/api */
  apiUrl: string;
  apiKey: string;
  /** This component's ID, written to every envelope and audit entry. */
  source: string;
  tenant?: string;
  /** Allow publishing to global channels. Defaults to RTB_ALLOW_GLOBAL=true. */
  allowGlobal?: boolean;
  audit?: AuditLogger;
  retry?: RetryOptions;
  /** Per request timeout in ms. Default 10000. */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export interface PublishOptions {
  corr?: string;
}

export interface PublishResult {
  envelope: Envelope<object>;
  /** Stream position, for channels with history. */
  offset?: number;
  epoch?: string;
}

export class PublishError extends Error {
  constructor(
    message: string,
    readonly transient: boolean,
    readonly code?: number,
  ) {
    super(message);
    this.name = 'PublishError';
  }
}

export class EnvelopeTooLargeError extends Error {
  constructor(
    readonly bytes: number,
    readonly channel: string,
  ) {
    super(`Envelope of ${bytes} bytes for ${channel} is over the ${MAX_ENVELOPE_BYTES} byte cap`);
    this.name = 'EnvelopeTooLargeError';
  }
}

// Centrifugo codes worth retrying: internal (100), not available (108), too many requests (111).
const TRANSIENT_CODES = new Set([100, 108, 111]);

export const defaultAudit: AuditLogger = (entry) => {
  const level = entry.outcome === 'ok' ? 'info' : 'warn';
  console.log(JSON.stringify({ level, msg: 'rtb.audit', ...entry }));
};

interface Shared {
  options: PublisherOptions;
  queues: Map<string, Promise<unknown>>;
  fetch: typeof fetch;
  audit: AuditLogger;
  retry: Required<RetryOptions>;
}

export class Publisher {
  private constructor(
    private readonly shared: Shared,
    private readonly context: TenantContext,
  ) {}

  static create(options: PublisherOptions): Publisher {
    const env = typeof process !== 'undefined' ? process.env : {};
    const shared: Shared = {
      options,
      queues: new Map(),
      fetch: options.fetch ?? globalThis.fetch,
      audit: options.audit ?? defaultAudit,
      retry: { attempts: 8, baseMs: 100, maxMs: 5000, totalMs: 30000, ...options.retry },
    };
    const allowGlobal = options.allowGlobal ?? env.RTB_ALLOW_GLOBAL === 'true';
    return new Publisher(shared, { tenant: options.tenant, allowGlobal });
  }

  /** A view of this publisher for another tenant. It shares the per-channel queues. */
  forTenant(tenant: string): Publisher {
    return new Publisher(this.shared, { ...this.context, tenant });
  }

  get tenant(): string | undefined {
    return this.context.tenant;
  }

  /**
   * Publishes one envelope. Publishes to the same channel are sent one at a time, in call order,
   * so retries never reorder messages. Different channels publish concurrently.
   */
  publish(channel: string, type: string, data: object, opts: PublishOptions = {}): Promise<PublishResult> {
    const { options, audit } = this.shared;
    const parsed = tryParseChannel(channel);
    const tenant = parsed?.tenant === 'global' ? 'global' : (this.context.tenant ?? '');
    const base = { component: options.source, tenant, channel, type, ts: new Date().toISOString() };

    const guard = checkTenant(this.context, channel, { tenant });
    if (!guard.allow) {
      audit({ ...base, outcome: 'denied', reason: guard.reason });
      return Promise.reject(new TenantGuardError(guard.reason, channel));
    }

    let envelope: Envelope<object>;
    try {
      envelope = createEnvelope({ type, tenant, source: options.source, corr: opts.corr, data });
    } catch (e) {
      audit({ ...base, outcome: 'denied', reason: (e as Error).message });
      return Promise.reject(e);
    }
    const bytes = envelopeBytes(envelope);
    if (bytes > MAX_ENVELOPE_BYTES) {
      audit({ ...base, id: envelope.id, outcome: 'too_large', reason: `${bytes} bytes` });
      return Promise.reject(new EnvelopeTooLargeError(bytes, channel));
    }

    return this.enqueue(channel, async () => {
      let attempts = 0;
      try {
        const r = await this.sendWithRetry(channel, envelope, () => ++attempts);
        audit({ ...base, id: envelope.id, outcome: 'ok', attempts });
        return { envelope, ...r };
      } catch (e) {
        audit({ ...base, id: envelope.id, outcome: 'failed', reason: (e as Error).message, attempts });
        throw e;
      }
    });
  }

  /** Resolves when every publish queued so far has finished. */
  async idle(): Promise<void> {
    while (this.shared.queues.size > 0) {
      await Promise.allSettled([...this.shared.queues.values()]);
    }
  }

  private enqueue<T>(channel: string, task: () => Promise<T>): Promise<T> {
    const { queues } = this.shared;
    const prev = queues.get(channel) ?? Promise.resolve();
    const next = prev.then(task, task);
    const tail = next.catch(() => {});
    queues.set(channel, tail);
    void tail.then(() => {
      if (queues.get(channel) === tail) queues.delete(channel);
    });
    return next;
  }

  private async sendWithRetry(
    channel: string,
    envelope: Envelope<object>,
    countAttempt: () => number,
  ): Promise<{ offset?: number; epoch?: string }> {
    const { attempts, baseMs, maxMs, totalMs } = this.shared.retry;
    const started = Date.now();
    for (let i = 0; ; i++) {
      countAttempt();
      try {
        return await this.send(channel, envelope);
      } catch (e) {
        const transient = !(e instanceof PublishError) || e.transient;
        const delay = Math.random() * Math.min(maxMs, baseMs * 2 ** i);
        if (!transient || i + 1 >= attempts || Date.now() - started + delay > totalMs) throw e;
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  private async send(channel: string, envelope: Envelope<object>): Promise<{ offset?: number; epoch?: string }> {
    const { options } = this.shared;
    const res = await this.shared.fetch(`${options.apiUrl.replace(/\/$/, '')}/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': options.apiKey },
      body: JSON.stringify({ channel, data: envelope, idempotency_key: envelope.id }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 10000),
    });
    if (!res.ok) {
      throw new PublishError(`HTTP ${res.status} from Centrifugo API`, res.status >= 500 || res.status === 429);
    }
    const body = (await res.json()) as {
      result?: { offset?: number; epoch?: string };
      error?: { code: number; message: string };
    };
    if (body.error) {
      throw new PublishError(
        `Centrifugo error ${body.error.code}: ${body.error.message}`,
        TRANSIENT_CODES.has(body.error.code),
        body.error.code,
      );
    }
    const out: { offset?: number; epoch?: string } = {};
    if (body.result?.offset !== undefined) out.offset = body.result.offset;
    if (body.result?.epoch !== undefined) out.epoch = body.result.epoch;
    return out;
  }
}

export function createPublisher(options: PublisherOptions): Publisher {
  return Publisher.create(options);
}
