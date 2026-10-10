# Channel names (v1)

Every channel is `<tier>:<scope>.<topic>[.<id>]`, or `<tier>:t-<tenant>.user#<userId>` for a single user. The SDKs build and parse names with these rules. Both the TypeScript and .NET contract packages run the vectors in `vectors/channels.*.json`.

## Pieces

| Piece | Rule |
| --- | --- |
| `tier` | `live`, `replay` or `presence` |
| `scope` | `global`, or `t-<tenant>` |
| `tenant` | `[A-Za-z0-9_-]{1,64}`, case-sensitive, never `global` |
| `topic` | `[A-Za-z0-9_-]+` |
| `id` | `[A-Za-z0-9_-]+` |
| `userId` | `[A-Za-z0-9_-]{1,128}` |
| Whole name | ASCII, 255 characters at most |

`Acme` and `acme` are different tenants. Apps that want case-insensitive tenants lowercase the tenant before minting tokens or publishing.

## Forms

| Form | Name | Tiers |
| --- | --- | --- |
| Global | `global.<topic>` or `global.<topic>.<id>` | `live`, `replay` |
| Tenant-wide | `t-<tenant>.all` | `live`, `replay` |
| Topic or record | `t-<tenant>.<topic>` or `t-<tenant>.<topic>.<id>` | all |
| Group | `t-<tenant>.grp.<group>` | all |
| Single user | `t-<tenant>.user#<userId>` | `live`, `replay` |
| Agent run | `t-<tenant>.run.<runId>` | all (use `replay`) |

Rules:

- `all`, `grp`, `user` and `run` are reserved topic words. They only appear in the forms above, never as an ordinary topic, and never under `global`.
- `all` takes no id. `grp` and `run` need one. `user` is only used with `#`.
- Nesting stops at `topic.id`. `t-acme.a.b.c` is invalid.
- `presence` never has `global`, `all` or `#` channels: a presence call returns every subscriber, so presence stays per record or room.

## Parse result

`parse(name)` returns:

| Field | Value |
| --- | --- |
| `tier` | `live`, `replay` or `presence` |
| `tenant` | The tenant ID, or the literal `global` for global channels |
| `topic` | The topic, including the reserved words `all`, `grp`, `user`, `run` |
| `id` | The id, or absent |
| `userId` | The user ID for `user#` channels, or absent |

Using `global` as the tenant value for global channels means the channel's tenant always equals the envelope's `tenant` field.

## Builders

| Builder | Result |
| --- | --- |
| `global(topic, id?, tier = live)` | `live:global.<topic>[.<id>]` |
| `tenantAll(tenant, tier = live)` | `live:t-<tenant>.all` |
| `record(tenant, topic, id?, tier = live)` | `live:t-<tenant>.<topic>[.<id>]` |
| `group(tenant, group, tier = live)` | `live:t-<tenant>.grp.<group>` |
| `user(tenant, userId, tier = live)` | `live:t-<tenant>.user#<userId>` |
| `run(tenant, runId)` | `replay:t-<tenant>.run.<runId>` |
| `presence(tenant, topic, id?)` | `presence:t-<tenant>.<topic>[.<id>]` |

Builders throw on any input that would not parse back to the same parts. For example `record("ac.me", "jobs")` builds `live:t-ac.me.jobs`, which parses as tenant `ac`, so it throws.

## Encoding keys as IDs

Use opaque IDs (ULIDs, UUIDs, database keys) where you can. When an ID has to come from a key with other characters (a ticker like `BRK.B`, a file path, a name), encode it. Every SDK has the same pair of functions, and they pass `vectors/ids.json`:

| Function | Does |
| --- | --- |
| `encodeId(key)` | Each UTF-8 byte of `key` that is `A-Z`, `a-z`, `0-9` or `-` passes through. Every other byte, including `_`, becomes `_` plus two uppercase hex digits |
| `decodeId(id)` | The reverse |

- `BRK.B` → `BRK_2EB`, `ES=F` → `ES_3DF`, `a_b` → `a_5Fb`, `café` → `caf_C3_A9`. Keys made of plain characters come out unchanged.
- Each key has exactly one encoding, so two different keys never share an ID. `decodeId` rejects anything `encodeId` would not produce: lowercase hex, an escaped plain character such as `_41`, truncated escapes, and bytes that are not valid UTF-8.
- `encodeId` rejects an empty key, a key that is not valid Unicode text (such as a lone surrogate), and any result longer than 128 characters, so an encoded ID also fits as a user ID. For longer keys, use your own short ID or a hash.
- The result fits any `topic`, `id`, group or user ID segment. The tenant ID is not encoded; tenants follow their own rule above.
- Encoded IDs show up in channel names, which appear in logs. Never encode personal data or secrets into them.

## Edge check in Centrifugo

Each namespace sets `channel_regex`, so Centrifugo rejects malformed names before checking tokens. It matches the part after `<tier>:`, uses Go's regexp (no lookahead), and only checks client subscriptions, not server publishes. So it checks the shape, not the reserved words. The SDKs check everything.

`live` and `replay`:

```
^(global\.[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)?|t-[A-Za-z0-9_-]{1,64}\.([A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)?|user#[A-Za-z0-9_-]{1,128}))$
```

`presence`:

```
^t-[A-Za-z0-9_-]{1,64}\.[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)?$
```

## Tenant guard

`check(context, channel, envelope)`, where `context` is `{ tenant?, allowGlobal? }`. Checks run in this order, and the first failure is the result:

| Reason | Fails when |
| --- | --- |
| `invalid_channel` | The channel does not parse |
| `global_not_allowed` | The channel is global and `allowGlobal` is not true |
| `no_tenant_context` | The channel is a tenant channel and the context has no tenant |
| `tenant_mismatch` | The channel is a tenant channel and its tenant differs from the context tenant |
| `envelope_tenant_mismatch` | `envelope.tenant` differs from the channel's tenant (`global` for global channels) |

For a global channel the context tenant is not compared. `allowGlobal` is set per publisher, or with `RTB_ALLOW_GLOBAL=true`, and is off by default. The guard runs in the SDK only; Centrifugo doesn't know about tenants, and a raw `curl` with the API key can still publish anywhere.

Vectors: `vectors/guard.json`.
