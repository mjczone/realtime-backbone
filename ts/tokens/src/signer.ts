import { SignJWT, calculateJwkThumbprint, exportJWK, generateKeyPair, importJWK, importPKCS8, type JWK, type CryptoKey } from 'jose';

export interface SignerOptions {
  /** ES256 private key as a JWK object, a JWK JSON string, or a PKCS8 PEM string. */
  privateKey: JWK | string;
  audience: string;
  issuer: string;
  /** Key ID. Defaults to the JWK's kid, or its RFC 7638 thumbprint. */
  kid?: string;
  /** Extra public keys to publish in the JWKS, for example the old key during a rotation. */
  additionalPublicKeys?: JWK[];
}

export interface ConnectionTokenInput {
  /** Global user ID. */
  sub: string;
  /** Lifetime in seconds. Default 600. */
  ttl?: number;
  /** Shown to other subscribers of presence channels. Put a display name here and nothing more. */
  info?: Record<string, unknown>;
}

export interface SubscriptionTokenInput {
  sub: string;
  channel: string;
  /** Lifetime in seconds. Default 600. */
  ttl?: number;
}

export interface TokenSigner {
  readonly kid: string;
  mintConnectionToken(input: ConnectionTokenInput): Promise<string>;
  mintSubscriptionToken(input: SubscriptionTokenInput): Promise<string>;
  jwks(): { keys: JWK[] };
}

async function loadPrivateKey(key: JWK | string): Promise<{ key: CryptoKey; jwk: JWK }> {
  if (typeof key === 'string' && key.trimStart().startsWith('-----BEGIN')) {
    const k = await importPKCS8(key, 'ES256', { extractable: true });
    return { key: k, jwk: await exportJWK(k) };
  }
  const jwk: JWK = typeof key === 'string' ? JSON.parse(key) : key;
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.d) throw new Error('privateKey must be an EC P-256 private key');
  return { key: (await importJWK(jwk, 'ES256')) as CryptoKey, jwk };
}

function publicPart(jwk: JWK, kid: string): JWK {
  return { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, kid, alg: 'ES256', use: 'sig' };
}

export async function createTokenSigner(options: SignerOptions): Promise<TokenSigner> {
  const { key, jwk } = await loadPrivateKey(options.privateKey);
  const kid = options.kid ?? jwk.kid ?? (await calculateJwkThumbprint(publicPart(jwk, '')));
  const keys = [publicPart(jwk, kid), ...(options.additionalPublicKeys ?? []).map((k) => publicPart(k, k.kid ?? ''))];
  if (keys.some((k) => !k.kid)) throw new Error('every additional public key needs a kid');

  const sign = (claims: Record<string, unknown>, sub: string, ttl: number) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'ES256', kid, typ: 'JWT' })
      .setSubject(sub)
      .setAudience(options.audience)
      .setIssuer(options.issuer)
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + ttl)
      .sign(key);

  return {
    kid,
    mintConnectionToken: ({ sub, ttl = 600, info }) => sign(info ? { info } : {}, sub, ttl),
    mintSubscriptionToken: ({ sub, channel, ttl = 600 }) => sign({ channel }, sub, ttl),
    jwks: () => ({ keys }),
  };
}

/** Generates a new ES256 signing key as a JWK with a thumbprint kid. For dev and for rotation scripts. */
export async function generateSigningKey(): Promise<JWK> {
  const { privateKey } = await generateKeyPair('ES256', { extractable: true });
  const jwk = await exportJWK(privateKey);
  jwk.kid = await calculateJwkThumbprint(publicPart(jwk, ''));
  jwk.alg = 'ES256';
  return jwk;
}
