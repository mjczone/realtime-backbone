export type Tier = 'live' | 'replay' | 'presence';

export interface ParsedChannel {
  tier: Tier;
  /** The tenant ID, or `global` for global channels. */
  tenant: string;
  topic: string;
  id?: string;
  userId?: string;
}

export const MAX_CHANNEL_LENGTH = 255;
export const RESERVED_TOPICS = ['all', 'grp', 'user', 'run'] as const;

const SEGMENT = /^[A-Za-z0-9_-]+$/;
const TENANT = /^[A-Za-z0-9_-]{1,64}$/;
const USER_ID = /^[A-Za-z0-9_-]{1,128}$/;
const TIERS: readonly string[] = ['live', 'replay', 'presence'];

export function isValidTenant(tenant: string): boolean {
  return TENANT.test(tenant) && tenant !== 'global';
}

export function isValidUserId(userId: string): boolean {
  return USER_ID.test(userId);
}

export function tryParseChannel(name: string): ParsedChannel | null {
  if (typeof name !== 'string' || name.length > MAX_CHANNEL_LENGTH) return null;
  const colon = name.indexOf(':');
  const tier = name.slice(0, colon);
  if (colon < 0 || !TIERS.includes(tier)) return null;
  const rest = name.slice(colon + 1);

  if (rest.startsWith('global.')) {
    if (tier === 'presence') return null;
    const parts = rest.slice('global.'.length).split('.');
    if (parts.length > 2 || !parts.every((p) => SEGMENT.test(p))) return null;
    const [topic, id] = parts;
    if ((RESERVED_TOPICS as readonly string[]).includes(topic)) return null;
    return withId({ tier: tier as Tier, tenant: 'global', topic }, id);
  }

  if (!rest.startsWith('t-')) return null;
  const dot = rest.indexOf('.');
  if (dot < 0) return null;
  const tenant = rest.slice(2, dot);
  if (!isValidTenant(tenant)) return null;
  const tail = rest.slice(dot + 1);

  if (tail.startsWith('user#')) {
    const userId = tail.slice('user#'.length);
    if (tier === 'presence' || !isValidUserId(userId)) return null;
    return { tier: tier as Tier, tenant, topic: 'user', userId };
  }

  const parts = tail.split('.');
  if (parts.length > 2 || !parts.every((p) => SEGMENT.test(p))) return null;
  const [topic, id] = parts;
  switch (topic) {
    case 'all':
      if (id !== undefined || tier === 'presence') return null;
      break;
    case 'grp':
    case 'run':
      if (id === undefined) return null;
      break;
    case 'user':
      return null;
  }
  return withId({ tier: tier as Tier, tenant, topic }, id);
}

function withId(c: ParsedChannel, id: string | undefined): ParsedChannel {
  if (id !== undefined) c.id = id;
  return c;
}

export function parseChannel(name: string): ParsedChannel {
  const c = tryParseChannel(name);
  if (!c) throw new Error(`Invalid channel name: ${JSON.stringify(name)}`);
  return c;
}

export function isValidChannel(name: string): boolean {
  return tryParseChannel(name) !== null;
}

function build(name: string, want: Omit<ParsedChannel, 'tier'>): string {
  const c = parseChannel(name);
  if (c.tenant !== want.tenant || c.topic !== want.topic || c.id !== want.id || c.userId !== want.userId) {
    throw new Error(`Invalid channel parts: ${JSON.stringify(want)}`);
  }
  return name;
}

function suffix(id?: string): string {
  return id === undefined ? '' : `.${id}`;
}

export const Channels = {
  global: (topic: string, id?: string, tier: Tier = 'live') =>
    build(`${tier}:global.${topic}${suffix(id)}`, { tenant: 'global', topic, id }),
  tenantAll: (tenant: string, tier: Tier = 'live') => build(`${tier}:t-${tenant}.all`, { tenant, topic: 'all' }),
  record: (tenant: string, topic: string, id?: string, tier: Tier = 'live') =>
    build(`${tier}:t-${tenant}.${topic}${suffix(id)}`, { tenant, topic, id }),
  group: (tenant: string, group: string, tier: Tier = 'live') =>
    build(`${tier}:t-${tenant}.grp.${group}`, { tenant, topic: 'grp', id: group }),
  user: (tenant: string, userId: string, tier: Tier = 'live') =>
    build(`${tier}:t-${tenant}.user#${userId}`, { tenant, topic: 'user', userId }),
  run: (tenant: string, runId: string) => build(`replay:t-${tenant}.run.${runId}`, { tenant, topic: 'run', id: runId }),
  presence: (tenant: string, topic: string, id?: string) =>
    build(`presence:t-${tenant}.${topic}${suffix(id)}`, { tenant, topic, id }),
};
