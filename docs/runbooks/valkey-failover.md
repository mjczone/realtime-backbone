# Valkey down or failed over

## What happens

- Centrifugo nodes lose cross-node pub/sub, history and presence while Valkey is unreachable. Publishes fail; the publisher SDKs retry for up to 30 seconds, then report `failed` in the audit log.
- Clients stay connected to their node but receive nothing published through other nodes.
- When Valkey is back (or Sentinel or the provider promotes a replica), Centrifugo reconnects on its own. It looks up the endpoint's name again, so a managed endpoint that moves to the new primary works.
- `replay` subscriptions recover the messages they missed, as long as they are still in history (`history_ttl` is 600 seconds).
- If Valkey restarted without AOF, the history is gone and each channel gets a new epoch. Clients then get `recovered: false` and load state from the app's API. Agent run clients see `RUN_ERROR` with code `rtb.history_lost`.
- **If the new primary lost writes, clients are not told.** Replication is asynchronous, so a promoted replica can miss the last publications. The epoch is copied to the replica and does not change; only the offsets go back. New publications then reuse offsets that clients already saw, and clients drop them as duplicates. Step 4 fixes this.
- **If Centrifugo stays connected to the old primary after it became a replica, it does not reconnect.** Every publish fails with `READONLY You can't write against a read only replica` until Centrifugo restarts. Step 5 fixes this.

Checked on Centrifugo v6.9.7 with Valkey 7.2 and 8.1.

## Steps

1. Confirm: `realtime-doctor` on a backbone pod (`kubectl -n rtb exec deploy/realtime-backbone -- realtime-doctor`), and the provider's console.
2. If a managed service is failing over, wait. Check that the endpoint resolves to the new primary.
3. If a self-managed primary died, check that Sentinel promoted a replica (`SENTINEL get-master-addr-by-name mymaster`).
4. After any failover, run `FLUSHALL` on the new primary. Every channel gets a new epoch, so clients get `recovered: false` on the next publication and reload state. You can't easily tell whether writes were lost, so do it every time. The cost is one reload per `replay` client; presence rebuilds on its own.
5. If publishes fail with `READONLY` in the backbone logs, restart the backbone (`kubectl -n rtb rollout restart deploy/realtime-backbone`, or replace the task).
6. If Valkey is out of memory with `noeviction`, publishes fail with an OOM error. Raise `maxmemory` or the plan, or lower `history_size` and `history_ttl`. Do not switch to an `allkeys-*` policy: it would silently evict replay history.
7. After recovery, run `realtime-doctor` again and watch `BackbonePubSubLagHigh` and `BackboneApiErrors` clear.

Restarting Centrifugo nodes does not help while Valkey is down. With `RTB_DOCTOR=strict`, restarted pods wait for Valkey before starting.
