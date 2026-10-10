export interface AguiLikeEvent {
  type: string;
  messageId?: string;
  toolCallId?: string;
  delta?: string;
  [key: string]: unknown;
}

export interface BatcherOptions {
  /** Flush buffered deltas after this many ms. Default 75. */
  intervalMs?: number;
  /** Flush when the buffered delta reaches this many UTF-8 bytes. Default 32768. */
  maxBytes?: number;
}

interface Buffer {
  key: string;
  event: AguiLikeEvent;
  parts: string[];
  bytes: number;
}

const encoder = new TextEncoder();

function batchKey(e: AguiLikeEvent): string | null {
  if (e.type === 'TEXT_MESSAGE_CONTENT' && e.messageId) return `text:${e.messageId}`;
  if (e.type === 'TOOL_CALL_ARGS' && e.toolCallId) return `args:${e.toolCallId}`;
  return null;
}

/**
 * Joins consecutive TEXT_MESSAGE_CONTENT deltas for one messageId, and TOOL_CALL_ARGS deltas for one
 * toolCallId, into one event. Any other event flushes the buffer first, so order is kept.
 * `emit` is called synchronously, in order.
 */
export class DeltaBatcher {
  private buffer: Buffer | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly intervalMs: number;
  private readonly maxBytes: number;

  constructor(
    private readonly emit: (event: AguiLikeEvent) => void,
    options: BatcherOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? 75;
    this.maxBytes = options.maxBytes ?? 32768;
  }

  push(event: AguiLikeEvent): void {
    const key = batchKey(event);
    if (key === null) {
      this.flush();
      this.emit(event);
      return;
    }
    if (this.buffer && this.buffer.key !== key) this.flush();
    const delta = event.delta ?? '';
    if (!this.buffer) {
      this.buffer = { key, event, parts: [], bytes: 0 };
      this.timer = setTimeout(() => this.flush(), this.intervalMs);
    }
    this.buffer.parts.push(delta);
    this.buffer.bytes += encoder.encode(delta).length;
    if (this.buffer.bytes >= this.maxBytes) this.flush();
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const b = this.buffer;
    this.buffer = null;
    if (b) this.emit({ ...b.event, delta: b.parts.join('') });
  }
}
