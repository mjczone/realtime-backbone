import { monotonicFactory } from 'ulid';

export interface Envelope<T extends object = Record<string, unknown>> {
  v: 1;
  id: string;
  type: string;
  tenant: string;
  source: string;
  ts: string;
  corr?: string;
  data: T;
}

export interface EnvelopeInput<T extends object = Record<string, unknown>> {
  type: string;
  tenant: string;
  source: string;
  corr?: string;
  data: T;
}

export const MAX_ENVELOPE_BYTES = 65536;
export const RESERVED_FAMILIES = ['agui', 'job', 'entity', 'notice', 'system'] as const;

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const TYPE = /^[a-z][a-z0-9]*\.[A-Za-z0-9_.]+$/;
const TENANT = /^[A-Za-z0-9_-]{1,64}$/;
const SOURCE = /^[A-Za-z0-9_.-]{1,128}$/;
const TS = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?Z$/;

const nextUlid = monotonicFactory();

export function newId(): string {
  return nextUlid();
}

export function createEnvelope<T extends object>(input: EnvelopeInput<T>): Envelope<T> {
  const env: Envelope<T> = {
    v: 1,
    id: newId(),
    type: input.type,
    tenant: input.tenant,
    source: input.source,
    ts: new Date().toISOString(),
    data: input.data,
  };
  if (input.corr !== undefined) env.corr = input.corr;
  const problem = validateEnvelope(env);
  if (problem) throw new Error(`Invalid envelope: ${problem}`);
  return env;
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function matches(x: unknown, re: RegExp): boolean {
  return typeof x === 'string' && re.test(x);
}

/** Returns why the value is not a valid envelope, or null when it is. Unknown fields are ignored. */
export function validateEnvelope(x: unknown): string | null {
  if (!isPlainObject(x)) return 'not an object';
  if (x.v !== 1) return 'v must be 1';
  if (!matches(x.id, ULID)) return 'id must be a ULID';
  if (!matches(x.type, TYPE) || (x.type as string).length > 128) return 'type must be <family>.<name>';
  if (!matches(x.tenant, TENANT)) return 'tenant is invalid';
  if (!matches(x.source, SOURCE)) return 'source is invalid';
  if (!matches(x.ts, TS)) return 'ts must be RFC 3339 UTC';
  if (x.corr !== undefined && (typeof x.corr !== 'string' || x.corr.length < 1 || x.corr.length > 256)) {
    return 'corr must be a string of 1 to 256 characters';
  }
  if (!isPlainObject(x.data)) return 'data must be an object';
  return null;
}

export function isEnvelope(x: unknown): x is Envelope {
  return validateEnvelope(x) === null;
}

/** Size of the serialized envelope in UTF-8 bytes. */
export function envelopeBytes(env: Envelope<object>): number {
  return new TextEncoder().encode(JSON.stringify(env)).length;
}
