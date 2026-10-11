import { Centrifuge, type Subscription as CfSubscription, type TransportEndpoint } from 'centrifuge';

/** Throw this from a token callback on 401 or 403, so the client stops retrying. */
export { UnauthorizedError } from 'centrifuge';
import { tryParseChannel, validateEnvelope, type Envelope } from '@mjczone/realtime-contract';

export type ConnectionState = 'disconnected' | 'connecting' | 'connected';

export interface StreamPosition {
  offset: number;
  epoch: string;
}

export interface ClientOptions {
  /** Backbone client endpoint, for example https://rt.example.com */
  url: string;
  getConnectionToken: () => Promise<string>;
  getSubscriptionToken: (channel: string) => Promise<string>;
  /** Transports to try, in order. Default: websocket, then http_stream, then sse. */
  transports?: Array<'websocket' | 'http_stream' | 'sse'>;
  /** Passed to centrifuge-js, for example a WebSocket implementation outside the browser. */
  websocket?: unknown;
  debug?: boolean;
}

export interface MessageContext {
  channel: string;
  /** Position of this message in the stream, for channels with history. */
  offset?: number;
}

export interface SubscribedInfo {
  /** True when this subscribe tried to recover from a position. */
  wasRecovering: boolean;
  /** True when every missed message was recovered. False after wasRecovering means history was lost. */
  recovered: boolean;
  position?: StreamPosition;
}

export interface PresenceMember {
  clientId: string;
  userId: string;
  info?: unknown;
}

export interface SubscribeOptions {
  /** Start from this stream position. Messages strictly after `offset` are delivered. */
  since?: StreamPosition;
  /** A subscription token already in hand, such as the one a run endpoint returns. Refreshes still use getSubscriptionToken. */
  token?: string;
  /** How many recent message IDs to remember for dedupe. Default 1000. */
  dedupeSize?: number;
  onSubscribed?: (info: SubscribedInfo) => void;
  /** A transient error. The client keeps retrying. */
  onError?: (error: { code: number; message: string }) => void;
  /** The subscription ended and will not retry, for example 103 permission denied or an UnauthorizedError from the token callback. */
  onFailed?: (error: { code: number; message: string }) => void;
  onJoin?: (member: PresenceMember) => void;
  onLeave?: (member: PresenceMember) => void;
}

export interface RealtimeSubscription {
  readonly channel: string;
  /** The last seen stream position, for reattaching later. */
  readonly position: StreamPosition | undefined;
  roster(): Promise<PresenceMember[]>;
  unsubscribe(): void;
}

export interface RealtimeClient {
  readonly state: ConnectionState;
  onStateChange(cb: (state: ConnectionState) => void): () => void;
  connect(): void;
  disconnect(): void;
  subscribe<T extends object = Record<string, unknown>>(
    channel: string,
    handler: (envelope: Envelope<T>, ctx: MessageContext) => void,
    options?: SubscribeOptions,
  ): RealtimeSubscription;
}

class RecentIds {
  private readonly ids = new Set<string>();
  constructor(private readonly max: number) {}

  /** Returns false when the ID was already seen. */
  add(id: string): boolean {
    if (this.ids.has(id)) return false;
    this.ids.add(id);
    if (this.ids.size > this.max) this.ids.delete(this.ids.values().next().value as string);
    return true;
  }
}

function endpoints(url: string, names: Array<'websocket' | 'http_stream' | 'sse'>): TransportEndpoint[] {
  const base = url.replace(/\/$/, '');
  const ws = base.replace(/^http/, 'ws');
  return names.map((transport) => ({
    transport,
    endpoint: transport === 'websocket' ? `${ws}/connection/websocket` : `${base}/connection/${transport}`,
  }));
}

function member(info: { client: string; user: string; connInfo?: unknown }): PresenceMember {
  return { clientId: info.client, userId: info.user, info: info.connInfo };
}

export function createRealtimeClient(options: ClientOptions): RealtimeClient {
  const base = options.url.replace(/\/$/, '');
  const centrifuge = new Centrifuge(endpoints(base, options.transports ?? ['websocket', 'http_stream', 'sse']), {
    getToken: options.getConnectionToken,
    emulationEndpoint: `${base}/emulation`,
    debug: options.debug ?? false,
    ...(options.websocket ? { websocket: options.websocket } : {}),
  });
  const listeners = new Set<(s: ConnectionState) => void>();
  let state: ConnectionState = 'disconnected';
  const setState = (s: ConnectionState) => {
    state = s;
    listeners.forEach((cb) => cb(s));
  };
  centrifuge.on('connecting', () => setState('connecting'));
  centrifuge.on('connected', () => setState('connected'));
  centrifuge.on('disconnected', () => setState('disconnected'));

  return {
    get state() {
      return state;
    },
    onStateChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    connect: () => centrifuge.connect(),
    disconnect: () => centrifuge.disconnect(),

    subscribe(channel, handler, opts = {}) {
      const parsed = tryParseChannel(channel);
      if (!parsed) throw new Error(`Invalid channel name: ${channel}`);
      const old = centrifuge.getSubscription(channel);
      if (old) centrifuge.removeSubscription(old);

      const seen = new RecentIds(opts.dedupeSize ?? 1000);
      let position: StreamPosition | undefined = opts.since ? { ...opts.since } : undefined;
      const sub: CfSubscription = centrifuge.newSubscription(channel, {
        getToken: parsed.userId === undefined ? () => options.getSubscriptionToken(channel) : null,
        since: opts.since ?? null,
        ...(opts.token ? { token: opts.token } : {}),
      });

      sub.on('subscribed', (ctx) => {
        if (ctx.streamPosition) position = { offset: ctx.streamPosition.offset, epoch: ctx.streamPosition.epoch };
        opts.onSubscribed?.({
          wasRecovering: ctx.wasRecovering,
          recovered: ctx.recovered,
          position: position && { ...position },
        });
      });
      sub.on('publication', (ctx) => {
        if (ctx.offset !== undefined && position) position = { offset: ctx.offset, epoch: position.epoch };
        const problem = validateEnvelope(ctx.data);
        if (problem) {
          console.warn(`realtime: dropped invalid envelope on ${channel}: ${problem}`);
          return;
        }
        const env = ctx.data as Envelope<never>;
        if (!seen.add(env.id)) return;
        handler(env, { channel, offset: ctx.offset });
      });
      sub.on('error', (ctx) => opts.onError?.(ctx.error));
      sub.on('unsubscribed', (ctx) => {
        if (ctx.code !== 0) opts.onFailed?.({ code: ctx.code, message: ctx.reason });
      });
      if (opts.onJoin) sub.on('join', (ctx) => opts.onJoin!(member(ctx.info)));
      if (opts.onLeave) sub.on('leave', (ctx) => opts.onLeave!(member(ctx.info)));
      sub.subscribe();

      return {
        channel,
        get position() {
          return position && { ...position };
        },
        async roster() {
          const r = await sub.presence();
          return Object.values(r.clients).map(member);
        },
        unsubscribe() {
          sub.unsubscribe();
          centrifuge.removeSubscription(sub);
        },
      };
    },
  };
}
