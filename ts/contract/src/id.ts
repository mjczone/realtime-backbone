export const MAX_ENCODED_ID_LENGTH = 128;

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

function isPlain(byte: number): boolean {
  return (
    (byte >= 0x30 && byte <= 0x39) || // 0-9
    (byte >= 0x41 && byte <= 0x5a) || // A-Z
    (byte >= 0x61 && byte <= 0x7a) || // a-z
    byte === 0x2d // -
  );
}

/** Encodes any key as a channel ID: A-Z, a-z, 0-9 and - pass through; every other UTF-8 byte becomes _XX. */
export function encodeId(key: string): string {
  if (typeof key !== 'string' || key === '') throw new Error('encodeId: key must be a non-empty string');
  if (!key.isWellFormed()) throw new Error('encodeId: key is not valid Unicode text');
  let out = '';
  for (const b of encoder.encode(key)) {
    out += isPlain(b) ? String.fromCharCode(b) : `_${b.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  if (out.length > MAX_ENCODED_ID_LENGTH) {
    throw new Error(`encodeId: encoded ID is ${out.length} characters, over ${MAX_ENCODED_ID_LENGTH}`);
  }
  return out;
}

/** The reverse of encodeId. Throws on anything encodeId would not produce. */
export function decodeId(id: string): string {
  if (typeof id !== 'string' || id === '' || id.length > MAX_ENCODED_ID_LENGTH) {
    throw new Error('decodeId: not an encoded ID');
  }
  const bytes: number[] = [];
  for (let i = 0; i < id.length; i++) {
    const c = id.charCodeAt(i);
    if (c === 0x5f) {
      const hex = id.slice(i + 1, i + 3);
      if (!/^[0-9A-F]{2}$/.test(hex)) throw new Error(`decodeId: bad escape at ${i}`);
      const b = parseInt(hex, 16);
      if (isPlain(b)) throw new Error(`decodeId: escaped plain character at ${i}`);
      bytes.push(b);
      i += 2;
    } else if (isPlain(c)) {
      bytes.push(c);
    } else {
      throw new Error(`decodeId: unexpected character at ${i}`);
    }
  }
  try {
    return decoder.decode(new Uint8Array(bytes));
  } catch {
    throw new Error('decodeId: not valid UTF-8');
  }
}
