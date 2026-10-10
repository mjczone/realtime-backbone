# Envelope and built-in events (v1)

## Envelope

Every publication is one JSON object. The schema is `envelope.schema.json`; the vectors are `vectors/envelopes.*.json`.

| Field | Required | Rule |
| --- | --- | --- |
| `v` | yes | The number `1` |
| `id` | yes | ULID, 26 characters, Crockford base32, uppercase. Also sent as the publish `idempotency_key` |
| `type` | yes | `<family>.<name>`: `^[a-z][a-z0-9]*\.[A-Za-z0-9_.]+$`, 128 characters at most |
| `tenant` | yes | The channel's tenant, or `global` for global channels |
| `source` | yes | Publishing component ID, `[A-Za-z0-9_.-]{1,128}` |
| `ts` | yes | Publish time, RFC 3339 in UTC with a `Z`, for example `2026-10-10T14:03:22.418Z` |
| `corr` | no | Correlation ID (run, job or request), 1 to 256 characters |
| `data` | yes | A JSON object |

- The serialized envelope is 64 KB (65,536 bytes of UTF-8) at most. The SDKs check this before publishing.
- Readers ignore fields they don't know. `v` changes only for breaking changes.
- Clients drop duplicates by `id`. Duplicates can happen after recovery or a retried publish.
- Centrifugo's `publication_data_format: json_object` rejects any publication that is not a JSON object. It doesn't check the envelope fields; the SDKs do.

## Families

`agui`, `job`, `entity`, `notice` and `system` are reserved and defined here. Apps may add their own families, such as `inventory.low`.

## Built-in types

| Type | `data` |
| --- | --- |
| `agui.<EVENT_TYPE>` | The AG-UI event exactly as the framework produced it, including its own `type` field. For example `agui.TEXT_MESSAGE_CONTENT` |
| `agui.CUSTOM` with `name: "rtb.oversize"` | `{ "type": "CUSTOM", "name": "rtb.oversize", "value": { "type": "<original AG-UI type>", "bytes": <size> } }`. Sent in place of an AG-UI event that is over the cap. The client refetches state from the app's API |
| `entity.changed` | `{ "entity": "<name>", "id": "<id>", "op": "created" \| "updated" \| "deleted" }` |
| `notice.run_started` | `{ "runId", "threadId", "channel", "offset", "epoch" }`. `offset` and `epoch` are the stream position of the run's `RUN_STARTED` |
| `job.progress` | `{ "jobId", "pct": 0-100, "step"?: "<text>" }` |
| `job.finished` | `{ "jobId", "ok": true \| false, "error"?: "<text>" }` |
| `system.maintenance` | `{ "message": "<text>", "startsAt"?: "<RFC 3339>", "endsAt"?: "<RFC 3339>" }` |

Anything not listed is app-defined.

## Joining a run

The run endpoint returns the stream position (`offset`, `epoch`) of the `RUN_STARTED` it published. The client subscribes with `since: { offset: offset - 1, epoch }`.

Checked against Centrifugo v6.9.7 with Valkey (Phase 0 spike):

- `since` returns publications strictly after `offset`, so `offset - 1` delivers `RUN_STARTED` first, exactly once. This includes `offset - 1 = 0` on a new channel.
- With a wrong or expired epoch the subscription still succeeds, but with `recovered: false` and no publications. The client treats that as "run history lost" and loads state from the app's API.
