import { tryParseChannel, type ParsedChannel } from '@rtb/contract';
import type { TokenSigner } from './signer.js';

export interface TokenUser {
  /** Global user ID, used as the token's sub. */
  userId: string;
  tenant: string;
  /** Optional connection info for presence, such as a display name. */
  info?: Record<string, unknown>;
}

export interface TokenEndpointOptions {
  signer: TokenSigner;
  /** Who is calling. Return null for 401. This is the app's own session or auth check. */
  authenticate: (req: Request) => Promise<TokenUser | null> | TokenUser | null;
  /**
   * May this user subscribe to this channel? Runs after the built-in checks: the channel parses,
   * its tenant is the user's tenant (or it is global), and it is not a user (#) channel.
   */
  authorize: (user: TokenUser, channel: string, parsed: ParsedChannel) => Promise<boolean> | boolean;
  /** Connection token lifetime in seconds. Default 600. */
  connectionTtl?: number;
  /** Subscription token lifetime in seconds. Default 600. */
  subscriptionTtl?: number;
  /** How long an allowed authorize result is cached, in ms. Default 30000. 0 turns it off. */
  cacheTtlMs?: number;
}

export interface TokenEndpoints {
  /** POST: returns { token } for the caller's connection. */
  connection: (req: Request) => Promise<Response>;
  /** POST with { channel }: returns { token } for that channel. */
  subscription: (req: Request) => Promise<Response>;
  /** GET: the JWKS Centrifugo verifies tokens with. Serve it at /.well-known/rtb-jwks.json. */
  jwks: (req: Request) => Promise<Response>;
}

export const JWKS_PATH = '/.well-known/rtb-jwks.json';

const error = (status: number, message: string) => Response.json({ error: message }, { status });

export function createTokenEndpoints(options: TokenEndpointOptions): TokenEndpoints {
  const { signer } = options;
  const cacheTtl = options.cacheTtlMs ?? 30000;
  const allowed = new Map<string, number>();

  async function isAllowed(user: TokenUser, channel: string, parsed: ParsedChannel): Promise<boolean> {
    const key = `${user.userId}\u0000${user.tenant}\u0000${channel}`;
    const until = allowed.get(key);
    if (until !== undefined && until > Date.now()) return true;
    const ok = await options.authorize(user, channel, parsed);
    if (ok && cacheTtl > 0) {
      if (allowed.size > 10000) allowed.clear();
      allowed.set(key, Date.now() + cacheTtl);
    }
    return ok;
  }

  return {
    async connection(req) {
      const user = await options.authenticate(req);
      if (!user) return error(401, 'unauthenticated');
      const token = await signer.mintConnectionToken({ sub: user.userId, ttl: options.connectionTtl, info: user.info });
      return Response.json({ token });
    },

    async subscription(req) {
      const user = await options.authenticate(req);
      if (!user) return error(401, 'unauthenticated');
      let channel: unknown;
      try {
        channel = ((await req.json()) as { channel?: unknown }).channel;
      } catch {
        return error(400, 'body must be JSON with a channel');
      }
      const parsed = typeof channel === 'string' ? tryParseChannel(channel) : null;
      if (!parsed) return error(400, 'invalid channel');
      if (parsed.userId !== undefined) return error(400, 'user channels use the connection token');
      if (parsed.tenant !== 'global' && parsed.tenant !== user.tenant) return error(403, 'forbidden');
      if (!(await isAllowed(user, channel as string, parsed))) return error(403, 'forbidden');
      const token = await signer.mintSubscriptionToken({
        sub: user.userId,
        channel: channel as string,
        ttl: options.subscriptionTtl,
      });
      return Response.json({ token });
    },

    async jwks() {
      return Response.json(signer.jwks(), { headers: { 'Cache-Control': 'public, max-age=300' } });
    },
  };
}
