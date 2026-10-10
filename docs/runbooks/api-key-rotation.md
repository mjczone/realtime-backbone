# API key rotation

Centrifugo v6 accepts one key per API (`http_api.key` and `grpc_api.key`), so there is no overlap period. Rotation is a short, planned window in which some publishes fail and are logged.

## Before

- Generate the new keys: `openssl rand -hex 32` (one for HTTP, one for gRPC).
- List every publisher that holds the key. Each publisher's audit log names it by `component`.
- Pick a quiet time. Publishes that fail during the window are not retried after the SDK's 30-second retry budget, so agent runs that are streaming at that moment may lose events.

## Steps

1. Put the new keys in the vault.
2. Update the backbone's secret (`realtime-backbone-secrets` in Kubernetes, `.env` in Compose, the service variables on Railway).
3. Restart the backbone: `kubectl -n rtb rollout restart deploy/realtime-backbone`, `docker compose up -d`, or redeploy on Railway.
4. Right away, update and restart every publisher with the new key.
5. Watch the publisher audit logs for `outcome: failed` with `401` or `Unauthenticated`, and the `BackboneApiErrors` alert. They should stop once every publisher has the new key.

## If the key leaked

Do the same steps immediately, without waiting for a quiet time. Anyone holding the old key could publish to any tenant until step 3 finishes. Check the Centrifugo logs and `centrifugo_api_command_errors_total` for unknown callers afterwards.

## Later

Scoped publisher keys (v1) put an edge in front of the API with one key per component, so a rotation touches one publisher at a time.
