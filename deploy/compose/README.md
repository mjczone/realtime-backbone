# Single-host deployment (Compose)

One Centrifugo node and, optionally, a bundled Valkey on one host, from published images. Good for small installs and staging. For high availability use the Helm chart.

## Start

```sh
cp .env.example .env     # fill in the keys, password, JWKS URL, audience, issuer and origins
docker compose up -d --wait
docker compose logs backbone | head -15   # rtb-doctor's checks
```

- `COMPOSE_PROFILES=valkey` bundles Valkey with AOF on and `noeviction`. Remove it and set `VALKEY_ADDRESS` to use a managed Valkey or Redis.
- Add `tls` to the profiles to put Caddy in front of the client port with automatic HTTPS for `DOMAIN`. Then set `CLIENT_BIND=127.0.0.1` so the plain port is not public.
- Data lives in `DATA_DIR` (default `./data`). Back it up by copying the directory.

## Ports

| Port | What | Default bind |
| --- | --- | --- |
| `CLIENT_PORT` (8000) | WebSocket, SSE and HTTP-stream for browsers | all interfaces |
| `API_PORT` (9000) | HTTP server API, health, metrics | `127.0.0.1` |
| `GRPC_PORT` (10000) | gRPC server API | `127.0.0.1` |

Publishers on the same host join the `rtb` network and call `http://backbone:9000/api` or `backbone:10000` with no published port:

```yaml
networks:
  rtb:
    external: true
```

Publishers on other hosts reach the API through a private interface: set `API_BIND` to that interface's address. Never bind the API to a public address; see "v0 deployment assumption" in `docs/DESIGN.md`.

## Operate

- Check: `docker compose exec backbone rtb-doctor`
- Upgrade: set the new `BACKBONE_IMAGE`, then `docker compose pull && docker compose up -d`
- Logs: `docker compose logs -f backbone`
- Rotate the API key: see `docs/runbooks/api-key-rotation.md`

This is one host and one Centrifugo node. If the host goes down, so does the backbone; clients reconnect and recover from history when it is back, as long as Valkey's data survived.
