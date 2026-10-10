# Valkey down or failed over

## What happens

- Centrifugo nodes lose cross-node pub/sub, history and presence while Valkey is unreachable. Publishes fail; the publisher SDKs retry for up to 30 seconds, then report `failed` in the audit log.
- Clients stay connected to their node but receive nothing published through other nodes.
- When Valkey is back (or Sentinel or the provider promotes a replica), Centrifugo reconnects on its own.
- `replay` subscriptions recover the messages they missed, as long as they are still in history (`history_ttl` is 600 seconds).
- If the new primary lost writes, or Valkey restarted without AOF, the stream's epoch changes. Clients then get `recovered: false` and load state from the app's API. Agent run clients see `RUN_ERROR` with code `rtb.history_lost`.

## Steps

1. Confirm: `rtb-doctor` on a backbone pod (`kubectl -n rtb exec deploy/realtime-backbone -- rtb-doctor`), and the provider's console.
2. If a managed service is failing over, wait. Check that the endpoint resolves to the new primary.
3. If a self-managed primary died, check that Sentinel promoted a replica (`SENTINEL get-master-addr-by-name mymaster`).
4. If Valkey is out of memory with `noeviction`, publishes fail with an OOM error. Raise `maxmemory` or the plan, or lower `history_size` and `history_ttl`. Do not switch to an `allkeys-*` policy: it would silently evict replay history.
5. After recovery, run `rtb-doctor` again and watch `BackbonePubSubLagHigh` and `BackboneApiErrors` clear.

Restarting Centrifugo nodes does not help while Valkey is down. With `RTB_DOCTOR=strict`, restarted pods wait for Valkey before starting.
