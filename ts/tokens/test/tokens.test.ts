import { describe, expect, it } from 'vitest';
import { createLocalJWKSet, decodeProtectedHeader, exportPKCS8, generateKeyPair, jwtVerify } from 'jose';
import { createTokenEndpoints, createTokenSigner, generateSigningKey, type TokenUser } from '../src/index.js';

const opts = { audience: 'rtb', issuer: 'test-app' };

async function verify(token: string, jwks: ReturnType<Awaited<ReturnType<typeof createTokenSigner>>['jwks']>) {
  return jwtVerify(token, createLocalJWKSet(jwks), { ...opts, algorithms: ['ES256'] });
}

describe('signer', () => {
  it('mints tokens that verify against its JWKS', async () => {
    const signer = await createTokenSigner({ privateKey: await generateSigningKey(), ...opts });
    const conn = await signer.mintConnectionToken({ sub: 'u1', info: { name: 'Ann' } });
    const { payload } = await verify(conn, signer.jwks());
    expect(payload).toMatchObject({ sub: 'u1', aud: 'rtb', iss: 'test-app', info: { name: 'Ann' } });
    expect(payload.exp! - payload.iat!).toBe(600);
    expect(decodeProtectedHeader(conn)).toMatchObject({ alg: 'ES256', kid: signer.kid });

    const sub = await signer.mintSubscriptionToken({ sub: 'u1', channel: 'live:t-acme.x', ttl: 60 });
    const v = await verify(sub, signer.jwks());
    expect(v.payload).toMatchObject({ sub: 'u1', channel: 'live:t-acme.x' });
    expect(v.payload.exp! - v.payload.iat!).toBe(60);
  });

  it('JWKS holds only public keys', async () => {
    const signer = await createTokenSigner({ privateKey: JSON.stringify(await generateSigningKey()), ...opts });
    expect(signer.jwks().keys).toHaveLength(1);
    expect(signer.jwks().keys[0]).not.toHaveProperty('d');
  });

  it('accepts a PKCS8 PEM key and derives a kid', async () => {
    const { privateKey } = await generateKeyPair('ES256', { extractable: true });
    const signer = await createTokenSigner({ privateKey: await exportPKCS8(privateKey), ...opts });
    expect(signer.kid).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('publishes the old key during rotation', async () => {
    const oldKey = await generateSigningKey();
    const oldSigner = await createTokenSigner({ privateKey: oldKey, ...opts });
    const oldToken = await oldSigner.mintConnectionToken({ sub: 'u1' });
    const newSigner = await createTokenSigner({ privateKey: await generateSigningKey(), additionalPublicKeys: [oldKey], ...opts });
    expect(newSigner.jwks().keys).toHaveLength(2);
    await expect(verify(oldToken, newSigner.jwks())).resolves.toBeTruthy();
    expect(newSigner.jwks().keys.every((k) => !('d' in k))).toBe(true);
  });

  it('rejects non-P-256 keys', async () => {
    await expect(createTokenSigner({ privateKey: { kty: 'RSA', n: 'x', e: 'AQAB', d: 'x' }, ...opts })).rejects.toThrow();
  });
});

describe('endpoints', () => {
  const user: TokenUser = { userId: 'u1', tenant: 'acme' };
  let authorizeCalls = 0;

  async function make(authUser: TokenUser | null = user) {
    authorizeCalls = 0;
    const signer = await createTokenSigner({ privateKey: await generateSigningKey(), ...opts });
    const endpoints = createTokenEndpoints({
      signer,
      authenticate: () => authUser,
      authorize: (_u, channel) => {
        authorizeCalls++;
        return !channel.includes('secret');
      },
    });
    return { signer, endpoints };
  }

  const post = (channel: unknown) => new Request('http://x/sub', { method: 'POST', body: JSON.stringify({ channel }) });

  it('mints a connection token', async () => {
    const { endpoints, signer } = await make();
    const r = await endpoints.connection(new Request('http://x/conn', { method: 'POST' }));
    const { token } = (await r.json()) as { token: string };
    expect((await verify(token, signer.jwks())).payload.sub).toBe('u1');
  });

  it('401 without a user', async () => {
    const { endpoints } = await make(null);
    expect((await endpoints.connection(new Request('http://x', { method: 'POST' }))).status).toBe(401);
    expect((await endpoints.subscription(post('live:t-acme.x'))).status).toBe(401);
  });

  it('checks the channel before the authorizer', async () => {
    const { endpoints } = await make();
    expect((await endpoints.subscription(post('live:t-acme.x.y.z'))).status).toBe(400);
    expect((await endpoints.subscription(post(42))).status).toBe(400);
    expect((await endpoints.subscription(post('live:t-acme.user#u1'))).status).toBe(400);
    expect((await endpoints.subscription(post('live:t-globex.x'))).status).toBe(403);
    expect(authorizeCalls).toBe(0);
    expect((await endpoints.subscription(post('live:t-acme.secret'))).status).toBe(403);
    expect(authorizeCalls).toBe(1);
  });

  it('mints a subscription token and caches the allow', async () => {
    const { endpoints, signer } = await make();
    for (let i = 0; i < 3; i++) {
      const r = await endpoints.subscription(post('replay:t-acme.run.r1'));
      expect(r.status).toBe(200);
      const { token } = (await r.json()) as { token: string };
      expect((await verify(token, signer.jwks())).payload.channel).toBe('replay:t-acme.run.r1');
    }
    expect(authorizeCalls).toBe(1);
  });

  it('global channels go to the authorizer', async () => {
    const { endpoints } = await make();
    expect((await endpoints.subscription(post('live:global.maintenance'))).status).toBe(200);
    expect(authorizeCalls).toBe(1);
  });

  it('serves the JWKS', async () => {
    const { endpoints, signer } = await make();
    const r = await endpoints.jwks(new Request('http://x/.well-known/rtb-jwks.json'));
    expect(await r.json()).toEqual(signer.jwks());
  });
});
