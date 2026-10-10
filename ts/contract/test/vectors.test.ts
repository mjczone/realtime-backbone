import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import { checkTenant, decodeId, encodeId, isValidChannel, tryParseChannel, validateEnvelope } from '../src/index.js';

const spec = (path: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../../../spec/${path}`, import.meta.url)), 'utf8'));
const schema = new Ajv2020().compile(spec('envelope.schema.json'));

describe('channels.valid.json', () => {
  for (const v of spec('vectors/channels.valid.json')) {
    it(v.name.slice(0, 60), () => expect(tryParseChannel(v.name)).toEqual(v.parsed));
  }
});

describe('channels.invalid.json', () => {
  for (const v of spec('vectors/channels.invalid.json')) {
    it(v.why, () => expect(tryParseChannel(v.name)).toBeNull());
  }
});

describe('envelopes.valid.json', () => {
  for (const v of spec('vectors/envelopes.valid.json')) {
    it(v.why, () => {
      expect(validateEnvelope(v.envelope)).toBeNull();
      expect(schema(v.envelope)).toBe(true);
    });
  }
});

describe('envelopes.invalid.json', () => {
  for (const v of spec('vectors/envelopes.invalid.json')) {
    it(v.why, () => {
      expect(validateEnvelope(v.envelope)).not.toBeNull();
      expect(schema(v.envelope)).toBe(false);
    });
  }
});

describe('guard.json', () => {
  for (const v of spec('vectors/guard.json')) {
    it(v.why, () => {
      const r = checkTenant(v.context, v.channel, { tenant: v.envelopeTenant });
      expect(r).toEqual(v.allow ? { allow: true } : { allow: false, reason: v.reason });
    });
  }
});

describe('ids.json', () => {
  const ids = spec('vectors/ids.json');
  for (const v of ids.roundtrip) {
    it(`round trip: ${v.why}`, () => {
      expect(encodeId(v.key)).toBe(v.id);
      expect(decodeId(v.id)).toBe(v.key);
    });
  }
  for (const v of ids.encodeErrors) it(`encode error: ${v.why}`, () => expect(() => encodeId(v.key)).toThrow());
  for (const v of ids.decodeErrors) it(`decode error: ${v.why}`, () => expect(() => decodeId(v.id)).toThrow());
  it('rejects a lone surrogate', () => expect(() => encodeId('a\uD800')).toThrow());
  it('an encoded ID fits a channel', () => {
    expect(isValidChannel(`live:t-acme.quotes.${encodeId('BRK.B')}`)).toBe(true);
    expect(isValidChannel(`live:t-acme.user#${encodeId('auth0|42')}`)).toBe(true);
  });
});
