import { execFileSync } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { GenericContainer, Network, Wait, type StartedNetwork, type StartedTestContainer } from 'testcontainers';
import { createTokenSigner, generateSigningKey, type TokenSigner } from '@mjczone/realtime-tokens';

export const API_KEY = 'it-api-key';
export const AUDIENCE = 'rtb-it';
export const ISSUER = 'rtb-it-app';

export interface Stack {
  apiUrl: string;
  clientUrl: string;
  signer: TokenSigner;
  backbone: StartedTestContainer;
  stop(): Promise<void>;
}

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

export async function startStack(): Promise<Stack> {
  const signer = await createTokenSigner({ privateKey: await generateSigningKey(), audience: AUDIENCE, issuer: ISSUER });
  const jwks = http.createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(signer.jwks()));
  });
  await new Promise<void>((r) => jwks.listen(0, '0.0.0.0', r));
  const jwksUrl = `http://host.docker.internal:${(jwks.address() as AddressInfo).port}/.well-known/rtb-jwks.json`;

  // The docker CLI honors .dockerignore; building through Testcontainers can trip on dev data in .data/.
  execFileSync('docker', ['build', '-q', '-f', `${repoRoot}images/backbone/Dockerfile`, '-t', 'rtb-backbone:it', repoRoot]);
  const image = new GenericContainer('rtb-backbone:it');
  const network: StartedNetwork = await new Network().start();
  const valkey = await new GenericContainer('valkey/valkey:8.1.10-alpine')
    .withNetwork(network)
    .withNetworkAliases('valkey')
    .withCommand(['valkey-server', '--maxmemory', '128mb', '--maxmemory-policy', 'noeviction', '--appendonly', 'yes'])
    .start();

  const backbone = await image
    .withNetwork(network)
    .withExposedPorts(8000, 9000)
    .withExtraHosts([{ host: 'host.docker.internal', ipAddress: 'host-gateway' }])
    .withEnvironment({
      RTB_DOCTOR: 'strict',
      CENTRIFUGO_HTTP_API_KEY: API_KEY,
      CENTRIFUGO_GRPC_API_KEY: 'it-grpc-key',
      CENTRIFUGO_ENGINE_REDIS_ADDRESS: 'redis://valkey:6379',
      CENTRIFUGO_CLIENT_ALLOWED_ORIGINS: '*',
      CENTRIFUGO_CLIENT_TOKEN_JWKS_PUBLIC_ENDPOINT: jwksUrl,
      CENTRIFUGO_CLIENT_TOKEN_AUDIENCE: AUDIENCE,
      CENTRIFUGO_CLIENT_TOKEN_ISSUER: ISSUER,
      CENTRIFUGO_CLIENT_SUBSCRIPTION_TOKEN_JWKS_PUBLIC_ENDPOINT: jwksUrl,
      CENTRIFUGO_CLIENT_SUBSCRIPTION_TOKEN_AUDIENCE: AUDIENCE,
      CENTRIFUGO_CLIENT_SUBSCRIPTION_TOKEN_ISSUER: ISSUER,
    })
    .withWaitStrategy(Wait.forHttp('/health', 9000))
    .start();

  return {
    apiUrl: `http://${backbone.getHost()}:${backbone.getMappedPort(9000)}/api`,
    clientUrl: `http://${backbone.getHost()}:${backbone.getMappedPort(8000)}`,
    signer,
    backbone,
    async stop() {
      await backbone.stop();
      await valkey.stop();
      await network.stop();
      jwks.close();
    },
  };
}
