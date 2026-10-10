# Reconnect storm

Every client that reconnects asks the app's token endpoint for a connection token, and one subscription token per non-user channel. After a deploy, a node loss or a network blip, that can be every client at once.

## Signs

- Token endpoint latency or error rate jumps. This is the app's metric, not the backbone's.
- `centrifugo_client_connections_inflight` and connection accept rates spike.
- Clients show "connecting" for longer than usual.

## Steps

1. Scale the token endpoint out. It only signs JWTs, so it scales well.
2. Check the authorize callback: it should not hit a slow database for every call. The SDK helpers cache "allowed" answers for 30 seconds by default (`cacheTtlMs` / `AuthorizeCacheTtl`); raise it during an incident if your checks allow.
3. centrifuge-js backs off between reconnect attempts with jitter, so the load spreads out on its own. Do not shorten its delays.
4. If a rolling upgrade caused it, let it finish; don't roll back mid-way, which causes a second storm.

## Prevent

- Roll nodes one at a time (the Helm chart does).
- Size the token endpoint for all connected users reconnecting within about a minute.
- Keep connection token lifetimes around 10 minutes. Shorter means more refresh traffic all the time.
