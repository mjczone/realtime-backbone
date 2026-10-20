# Railway template

Two services in one Railway project: `valkey` and `backbone`. Railway builds templates in its dashboard, not from a file, so this folder holds what you need to rebuild the template: each service's `railway.json` and the variables below.

## Services

### valkey

- Source image: `valkey/valkey:8.1.10-alpine`
- Volume mounted at `/data`
- Start command: in `valkey/railway.json`. `--bind "* -::*"` listens on IPv6 too, which Railway's private network needs. It runs through `sh -c` so `$VALKEY_PASSWORD` is expanded either way.
- No public domain.

| Variable | Value |
| --- | --- |
| `VALKEY_PASSWORD` | `${{secret(32)}}` |
| `VALKEY_MAXMEMORY` | A bit under the plan's memory, for example `400mb` on 512 MB |

### backbone

- Source image: `ghcr.io/mjczone/realtime-backbone:0.2.1`
- Public domain on port `8000` only. The API ports (9000, 10000) stay on the private network.

| Variable | Value |
| --- | --- |
| `RTB_DOCTOR` | `strict`, so a broken setup fails the deploy instead of running half-configured |
| `CENTRIFUGO_HTTP_API_KEY` | `${{secret(48)}}` |
| `CENTRIFUGO_GRPC_API_KEY` | `${{secret(48)}}` |
| `CENTRIFUGO_ENGINE_REDIS_ADDRESS` | `redis://${{valkey.RAILWAY_PRIVATE_DOMAIN}}:6379` |
| `CENTRIFUGO_ENGINE_REDIS_PASSWORD` | `${{valkey.VALKEY_PASSWORD}}` |
| `CENTRIFUGO_CLIENT_ALLOWED_ORIGINS` | Your app's origin, for example `https://app.up.railway.app` |
| `CENTRIFUGO_CLIENT_TOKEN_JWKS_PUBLIC_ENDPOINT` | Your app's `/.well-known/rtb-jwks.json` |
| `CENTRIFUGO_CLIENT_TOKEN_AUDIENCE` | `realtime-backbone` |
| `CENTRIFUGO_CLIENT_TOKEN_ISSUER` | Your app's issuer |
| `CENTRIFUGO_CLIENT_SUBSCRIPTION_TOKEN_JWKS_PUBLIC_ENDPOINT` | Same as the connection JWKS URL |
| `CENTRIFUGO_CLIENT_SUBSCRIPTION_TOKEN_AUDIENCE` | Same as the connection audience |
| `CENTRIFUGO_CLIENT_SUBSCRIPTION_TOKEN_ISSUER` | Same as the connection issuer |
| `PORT` | `8000` (the port Railway routes the public domain to) |

### gateway (optional)

[`realtime-gateway`](../../gateway/README.md), for publishing, tokens and agent runs over plain HTTP.

- Source image: `ghcr.io/mjczone/realtime-backbone-gateway:0.2.1`
- Public domain on port `8090`, when browsers or publishers in other projects use it.

| Variable | Value |
| --- | --- |
| `RTB_GATEWAY_CONFIG_JSON` | The config from `gateway/README.md`, with `"apiUrl": "http://${{backbone.RAILWAY_PRIVATE_DOMAIN}}:9000/api"`, `"apiKey": "${CENTRIFUGO_HTTP_API_KEY}"`, `"privateKey": "${RTB_SIGNING_KEY}"` and `"valkey": "redis://default:${VALKEY_PASSWORD}@${{valkey.RAILWAY_PRIVATE_DOMAIN}}:6379"` |
| `CENTRIFUGO_HTTP_API_KEY` | `${{backbone.CENTRIFUGO_HTTP_API_KEY}}` |
| `VALKEY_PASSWORD` | `${{valkey.VALKEY_PASSWORD}}` |
| `RTB_SIGNING_KEY` | An EC P-256 private key (JWK or PEM) |

Then set the backbone's two JWKS endpoints to `http://${{gateway.RAILWAY_PRIVATE_DOMAIN}}:8090/.well-known/rtb-jwks.json`. The gateway listens on IPv6 too, which Railway's private network needs.

Publishers in the same project and environment reach `http://${{backbone.RAILWAY_PRIVATE_DOMAIN}}:9000/api` with the API key.

## Rebuild the template

1. Create a project with the two services above, their variables and the volume.
2. Deploy and read the backbone's first log lines: `realtime-doctor` prints its checks before Centrifugo starts.
3. In the project settings, create a template from the project, and add the "Deploy on Railway" button to the main README.

## Limits

- One Valkey with a volume, no failover. Fine for small installs.
- Railway's private network covers one project and environment. Publishers in other projects need a public API endpoint; read "v0 deployment assumption" in `docs/DESIGN.md` first, because v0 has one shared API key.
- Run `realtime-doctor` on demand as a one-off command on the backbone service.
