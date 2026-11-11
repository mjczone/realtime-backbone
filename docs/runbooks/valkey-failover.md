# Valkey down or failed over

## What happens

- Centrifugo nodes lose cross-node pub/sub, history and presence while Valkey is unreachable. Publishes fail; the publisher SDKs retry for up to 30 seconds, then report `failed` in the audit log.
- Clients stay connected to their node but receive nothing published through other nodes.
- When Valkey is back (or Sentinel or the provider promotes a replica), Centrifugo reconnects on its own. It looks up the endpoint's name again, so a managed endpoint that moves to the new primary works.
- `replay` subscriptions recover the messages they missed, as long as they are still in history (`history_ttl` is 600 seconds).
- If Valkey restarted without AOF, the history is gone and each channel gets a new epoch. Clients then get `recovered: false` and load state from the app's API. Agent run clients see `RUN_ERROR` with code `rtb.history_lost`.

Centrifugo does not handle two cases on its own. The guard (below) handles both.

- **The new primary lost writes, and clients are not told.** Replication is asynchronous, so a promoted replica can miss the last publications; a restart from AOF can miss the last second. The epoch survives and only the offsets go back. New publications then reuse offsets that clients already saw, and clients drop them as duplicates.
- **Centrifugo stays connected to the old primary after it became a replica, and does not reconnect.** Every publish fails with `READONLY You can't write against a read only replica` until Centrifugo restarts.

Checked on Centrifugo v6.9.7 with Valkey 7.2 and 8.1.

## The guard

`realtime-doctor guard` runs next to Centrifugo and checks Valkey every 5 seconds over a fresh connection:

- **A new server with old data.** It keeps the primary's `run_id` in the key `realtime-doctor:run_id`. When the `run_id` changes and the key is still there (a promoted replica, or a restart from AOF), it deletes Centrifugo's history keys (`<prefix>.stream.*`). Every channel gets a new epoch, and clients get `recovered: false` on the next publication, or within about a minute on a quiet channel. The log says `new server with old data`. It can't tell whether writes were really lost, so it does this after every failover: one reload per `replay` client. A fresh or emptied Valkey changes nothing.
- **Stuck on a replica.** It publishes a probe to `<history namespace>:global.realtime-guard` through Centrifugo's server API. When that fails 3 times in a row while Valkey takes writes, Centrifugo is stuck. Through the image's entrypoint, the guard stops Centrifugo, so the container exits and the platform starts it again. The log says `restarting it`.

Where it runs:

- **The image's entrypoint (Compose, ECS, Railway, `docker run`):** the guard starts with Centrifugo. `RTB_GUARD=off` turns it off. The platform must restart a container that exits.
- **Helm:** the chart runs the guard as the `realtime-guard` sidecar, and `realtime-doctor live` as Centrifugo's liveness probe, which restarts a stuck Centrifugo.
- **Not covered:** cluster mode, and a config with no history namespace or with the HTTP API off. Then use steps 4 and 5 by hand.

## Steps

1. Confirm: `realtime-doctor` on a backbone pod (`kubectl -n rtb exec deploy/realtime-backbone -- realtime-doctor`), and the provider's console.
2. If a managed service is failing over, wait. Check that the endpoint resolves to the new primary.
3. If a self-managed primary died, check that Sentinel promoted a replica (`SENTINEL get-master-addr-by-name mymaster`).
4. Check that the guard reset the history: `new server with old data` in the backbone log. Without the guard, run `FLUSHALL` on the new primary after any failover.
5. If publishes keep failing with `READONLY` in the backbone log, restart the backbone (`kubectl -n rtb rollout restart deploy/realtime-backbone`, or replace the task). With the guard, this happens within about 20 seconds.
6. If Valkey is out of memory with `noeviction`, publishes fail with an OOM error. Raise `maxmemory` or the plan, or lower `history_size` and `history_ttl`. Do not switch to an `allkeys-*` policy: it would silently evict replay history.
7. After recovery, run `realtime-doctor` again and watch `BackbonePubSubLagHigh` and `BackboneApiErrors` clear.

Restarting Centrifugo nodes does not help while Valkey is down. With `RTB_DOCTOR=strict`, restarted pods wait for Valkey before starting.
