# Single-host deployment (Compose)

One Centrifugo node and, optionally, a bundled Valkey on one host, from published images. Good for small installs and staging. For high availability use the Helm chart.

## Start

```sh
cp .env.example .env     # fill in the keys, password, JWKS URL, audience, issuer and origins
docker compose up -d --wait
docker compose logs backbone | head -15   # realtime-doctor's checks
```

- `COMPOSE_PROFILES=valkey` bundles Valkey with AOF on and `noeviction`. Remove it and set `VALKEY_ADDRESS` to use a managed Valkey or Redis.
- Add `tls` to the profiles to put Caddy in front of the client port with automatic HTTPS for `DOMAIN`. Then set `CLIENT_BIND=127.0.0.1` so the plain port is not public.
- Data lives in `DATA_DIR` (default `./data`). Back it up by copying the directory.

## realtime-gateway (optional)

Add `gateway` to `COMPOSE_PROFILES` to run [`realtime-gateway`](../../gateway/README.md) on `GATEWAY_PORT` (8090): publishing with scoped keys, realtime tokens and agent runs over plain HTTP.

1. Put the token signing key (EC P-256, JWK or PEM) in `secrets/signing.jwk`.
2. Write `gateway.json` next to this file. Reference secrets as `${NAME}`; the gateway reads them from `.env`. For example `"centrifugo": { "apiUrl": "http://backbone:9000/api", "apiKey": "${API_KEY}" }`, `"valkey": "redis://:${VALKEY_PASSWORD}@valkey:6379"` and `"signing": { "privateKeyFile": "/run/secrets/signing.jwk", ... }`.
3. Set `JWKS_URL=http://gateway:8090/.well-known/rtb-jwks.json` so Centrifugo trusts the gateway's tokens, and use the same audience and issuer in both.

## Ports

| Port | What | Default bind |
| --- | --- | --- |
| `CLIENT_PORT` (8000) | WebSocket, SSE and HTTP-stream for browsers | all interfaces |
| `API_PORT` (9000) | HTTP server API, health, metrics | `127.0.0.1` |
| `GRPC_PORT` (10000) | gRPC server API | `127.0.0.1` |
| `GATEWAY_PORT` (8090) | `realtime-gateway`, with the `gateway` profile | all interfaces |

Publishers on the same host join the `rtb` network and call `http://backbone:9000/api` or `backbone:10000` with no published port:

```yaml
networks:
  rtb:
    external: true
```

Publishers on other hosts reach the API through a private interface: set `API_BIND` to that interface's address. Never bind the API to a public address; see "v0 deployment assumption" in `docs/DESIGN.md`.

## Operate

- Check: `docker compose exec backbone realtime-doctor`
- Upgrade: set the new `BACKBONE_IMAGE`, then `docker compose pull && docker compose up -d`
- Logs: `docker compose logs -f backbone`
- Rotate the API key: see `docs/runbooks/api-key-rotation.md`

This is one host and one Centrifugo node. If the host goes down, so does the backbone; clients reconnect and recover from history when it is back, as long as Valkey's data survived.
