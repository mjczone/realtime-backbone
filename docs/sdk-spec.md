# SDK spec

What an SDK for the backbone must do, in any language. The TypeScript (`ts/`), .NET (`dotnet/`) and Python (`python/`) SDKs follow it; use them as reference implementations. A new SDK is done when it passes `spec/vectors/` and does everything marked **must** below.

An SDK has up to four parts. Build only the parts you need:

| Part | Needed for |
| --- | --- |
| Contract | Everything else |
| Publisher | Backends, workers and agents that publish |
| Tokens | App backends that let browsers or apps subscribe |
| Agent sink | Agent services that stream AG-UI events |

Browser and mobile apps use Centrifugo's official client SDKs directly; see "Clients" at the end.

## 1. Contract

The contract has no network code and no dependencies beyond a ULID generator.

### Channels

- **Must** parse names by `spec/channels.md` and return `tier`, `tenant` (the literal `global` for global channels), `topic`, and `id` or `userId` when present.
- **Must** pass `spec/vectors/channels.valid.json` (with the same parse result) and `channels.invalid.json`.
- **Must** offer one builder per audience: `global`, `tenantAll`, `record`, `group`, `user`, `run`, `presence`.
- **Must** make builders check that the name parses back to the same parts. For example, `record("ac.me", "jobs")` builds `live:t-ac.me.jobs`, which parses as tenant `ac`, so it must throw.

### IDs from keys

- **Must** offer `encodeId(key)` and `decodeId(id)` by the rule in `spec/channels.md` ("Encoding keys as IDs"), and pass `spec/vectors/ids.json`.
- **Must** reject keys that are not valid Unicode text (a lone surrogate, for example) instead of replacing them.

### Envelope

- **Must** build envelopes by `spec/events.md`: `v` = 1, `id` = a new ULID, `ts` = now in RFC 3339 UTC with `Z`, and `corr` left out when not given.
- **Should** make IDs monotonic within a process, so IDs created in the same millisecond still sort in order.
- **Must** validate by the same rules and pass `spec/vectors/envelopes.valid.json` and `envelopes.invalid.json`. Validators ignore unknown fields.
- **Must** measure size as the UTF-8 bytes of the serialized envelope. The cap is 65,536 bytes.

### Tenant guard

- **Must** implement `check(context, channel, envelopeTenant)`, where `context` is `{ tenant?, allowGlobal }`. It returns allow, or deny with one of these reason codes, checked in this order: `invalid_channel`, `global_not_allowed`, `no_tenant_context`, `tenant_mismatch`, `envelope_tenant_mismatch`.
- **Must** pass `spec/vectors/guard.json`, reason codes included.

## 2. Publisher

### Configuration

| Setting | Notes |
| --- | --- |
| API address and key | HTTP: `POST {apiUrl}/publish` with header `X-API-Key`. gRPC: `Publish` from `proto/centrifugo/api.proto` with metadata `authorization: apikey <key>` |
| `source` | This component's ID; goes into every envelope and audit entry |
| `tenant` | Optional; a multi-tenant worker leaves it empty and calls `forTenant(t)` |
| `allowGlobal` | Off by default. When not set in code, read `RTB_ALLOW_GLOBAL=true` from the environment |
| Client certificate and CA | gRPC only, optional (mTLS) |

### `publish(channel, type, data, corr?)`

These steps **must** run in this order:

1. **Envelope tenant.** Use `global` for a global channel, otherwise the context tenant.
2. **Guard.** On deny: write an audit entry with outcome `denied` and the reason, then throw. Send nothing.
3. **Build** the envelope (`data` must be a JSON object). If the input is invalid: write an audit entry with outcome `denied`, then throw.
4. **Size.** Over 65,536 bytes: write an audit entry with outcome `too_large`, then throw. Send nothing.
5. **Queue** on the channel's queue (see below).
6. **Send** with `idempotency_key` = the envelope `id`. Retry as described below.
7. **Audit** `ok` or `failed`, with the number of attempts.
8. **Return** the envelope and, for `replay` channels, `{ offset, epoch }` from the response. Return no position for `live` channels: Centrifugo sends an empty result (gRPC: offset 0 and empty epoch).

Steps 1 to 4 **must** happen synchronously, before the publish is queued. Then calls made in order are queued in order, even when the caller doesn't wait for each one.

### Per-channel ordering

This is the most important property. An SDK **must** have a test for it.

- Each channel has a FIFO queue with **at most one request in flight**. The next request starts only after the previous one succeeded or gave up.
- Different channels publish concurrently.
- A failed publish does not block the ones after it.
- Expose `forTenant(t)` as a view that **shares the same queues**.
- Expose `idle()`, which resolves when everything queued so far is done.

The tests **must** show that under random delays and failures, one channel never has two requests in flight and its messages arrive in call order, while different channels do overlap. The integration test runs against a real backbone with requests lost both before and after Centrifugo, and checks the channel's history holds every message once, in order.

### Retries

- Retry the **same envelope** with the **same idempotency key**. Centrifugo drops duplicates for 5 minutes.
- Retry: network errors, timeouts, HTTP 5xx and 429, gRPC `Unavailable`, `DeadlineExceeded`, `ResourceExhausted`, `Internal` and `Aborted`, and Centrifugo error codes 100 (internal), 108 (not available) and 111 (too many requests).
- Don't retry anything else: HTTP 401, gRPC `Unauthenticated`, or code 107 (bad request), for example.
- Backoff is full jitter: wait a random time between 0 and `min(maxDelay, baseDelay × 2^attempt)`.
- Defaults: 8 attempts, 100 ms base delay, 5 s max delay, 30 s total budget, 10 s per request. Never retry past the total budget; it **must** stay well inside the 5-minute idempotency window.

Centrifugo returns API errors inside a successful response (`{"error":{"code":107,"message":"bad request"}}`), so check the body as well as the HTTP or gRPC status.

### Audit log

- **Must** write one structured entry per publish. Fields: `component`, `tenant`, `channel`, `type`, `id` (when built), `ts`, `outcome` (`ok`, `denied`, `too_large` or `failed`), `reason` (when not ok) and `attempts`.
- **Must not** log the payload.
- Use `info` level for `ok` and `warn` for everything else. The default output is the platform's normal logger (TS: JSON lines on stdout; .NET: `ILogger` category `MJCZone.Realtime.Audit`).

### Delta batcher

The batcher is used by agent sinks, and can be used on its own.

- Join consecutive `TEXT_MESSAGE_CONTENT` events for the same `messageId`, and consecutive `TOOL_CALL_ARGS` events for the same `toolCallId`, by concatenating their `delta`. Keep the first event's other fields.
- Flush when the interval elapses (default 75 ms), when the buffered delta reaches the byte limit (default 32,768), when another key arrives, and **before** any other event, which is then emitted right after.
- Emit synchronously and in order, so that queuing order equals event order.

## 3. Tokens

### Signer

- **Must** sign with ES256 only. The key comes as a P-256 JWK (object or JSON string) or a PKCS8 PEM. Reject other key types. Never offer HMAC.
- Header: `alg: ES256`, `typ: JWT`, `kid`.
- `kid` defaults to the JWK's `kid`, or else its RFC 7638 thumbprint: base64url SHA-256 of `{"crv":"P-256","kty":"EC","x":"…","y":"…"}`. Two SDKs given the same key **must** produce the same `kid`; see the fixed-key tests in `dotnet/test/MJCZone.Realtime.Tokens.Tests` and `python/tokens/tests`.
- Connection token: `sub` (global user ID), `aud`, `iss`, `iat`, `exp` (default 600 s), and optionally `info` (a display name for presence, and nothing more).
- Subscription token: the same claims plus `channel`, with `exp` defaulting to 600 s.
- JWKS: the signing key's public JWK (`kty`, `crv`, `x`, `y`, `kid`, `alg: ES256`, `use: sig`) plus any additional public keys (for rotation). Never include `d`.
- **Must** offer a helper that generates a new key as a JWK with a thumbprint `kid`.

### Endpoints

All three take the app's own `authenticate(request) → { userId, tenant, info?, tenants? } | null` and `authorize(user, channel, parsed) → bool` callbacks.

| Endpoint | Behavior |
| --- | --- |
| `POST …/connection` | 401 if `authenticate` returns null; otherwise `{ "token": … }` |
| `POST …/subscription` with `{ "channel" }` | 401 if not authenticated. 400 if the body or channel is invalid. 400 for a user (`#`) channel (those use the connection token). 403 if the channel's tenant is neither `tenant` nor in `tenants` (global channels skip this check). 403 if `authorize` says no. Otherwise `{ "token": … }` |
| `GET /.well-known/rtb-jwks.json` | The JWKS, with `Cache-Control: public, max-age=300` |

- The built-in checks **must** run before `authorize`, so the app's callback never sees a malformed or cross-tenant channel.
- Cache only **allowed** answers, per user, tenant and channel (default 30 s; 0 turns it off). Never cache a denial.
- Errors are JSON: `{ "error": "<message>" }`.
- `tenant` is the user's main tenant, used for runs. `tenants` is optional: more tenants the user may subscribe to.

## 4. Agent sink and run endpoint

### Sink

`publishAgentRun(publisher, channel, runId, events)` takes a stream of AG-UI events from the framework and:

- **must** drop the framework's `RUN_STARTED`, because the run endpoint already published one;
- **must** normalize `TEXT_MESSAGE_CHUNK` into `TEXT_MESSAGE_START`, `TEXT_MESSAGE_CONTENT` and `TEXT_MESSAGE_END`, if the framework emits chunks;
- passes the events through the delta batcher and publishes each as type `agui.<EVENT_TYPE>` with `corr` = the run ID;
- replaces an event whose JSON plus 1,024 bytes of envelope overhead is over the cap with `{ "type": "CUSTOM", "name": "rtb.oversize", "value": { "type": <original type>, "bytes": <size> } }`. This check happens before queuing, so order is kept;
- if the stream fails without having sent `RUN_FINISHED` or `RUN_ERROR`, publishes `RUN_ERROR` with code `rtb.agent_error` and the error message;
- if cancelled, stops reading the stream and publishes `RUN_ERROR` with code `rtb.cancelled`;
- **must** accept a list of event types to skip (`skipTypes`), empty by default, and not publish events of those types. The run helpers pass the option through;
- **must** refuse, before it reads any event, a `skipTypes` that contains an event type a run needs: `RUN_FINISHED`, `RUN_ERROR`, and the text and tool-call events (`TEXT_MESSAGE_*`, `TOOL_CALL_*`). The run helpers check it when they are created. See "Choosing what to publish" in `spec/events.md`;
- never throws, and returns the published events plus the error, if any, once every publish has finished.

### Run flow

`startRun` and the run endpoint follow DESIGN.md's run flow:

1. Create a run ID (ULID). Use the input's thread ID, or create one if it's missing. Set both on the framework input.
2. Call `onRunCreated(info)` so the app records who may watch the run. Token requests for this run channel are authorized from that record.
3. Publish `agui.RUN_STARTED` with `{ type, threadId, runId }` to `replay:t-<tenant>.run.<runId>` and keep its `{ offset, epoch }`.
4. If asked, publish `notice.run_started` (`{ runId, threadId, channel, offset, epoch }`) to `live:t-<tenant>.user#<userId>`, or to `live:t-<inboxTenant>.user#<userId>` when the app sets an inbox tenant.
5. Return `202` with `{ runId, threadId, channel, offset, epoch, token }`, where `token` is a subscription token for the run channel.
6. Drive the agent in the background through the sink, then call `onRunFinished(info, result)`.

Cancel endpoint: only the run's owner, in the same tenant, can cancel. Anyone else gets 404.

The agent service **must** be a long-running process, because step 6 happens after the response. Say so in the SDK's README.

## Clients

Browsers and apps use Centrifugo's official client SDKs (JavaScript, Swift, Kotlin/Java, Dart, Go and others). An app on the backbone **must**:

- subscribe to a run from `{ offset: <RUN_STARTED offset> - 1, epoch }`;
- treat `recovered: false` after a recovery attempt as "history lost" and load state from the app's API;
- allow a subscribe reply to take longer than a few seconds: a reload can replay up to 2,000 publications, a few MB. `ts/client` waits 15 s;
- drop messages whose envelope `id` it has already seen (keep about the last 1,000 per subscription);
- drop payloads that are not valid envelopes;
- skip the subscription token for user (`#`) channels;
- stop retrying when the token endpoint answers 401 or 403. Each SDK has its own way to say so; in centrifuge-js, throw `UnauthorizedError`.

`ts/client` and `ts/agui-client` show all of this for the browser.

## Tests a new SDK needs

| Test | How |
| --- | --- |
| Conformance | Run every file in `spec/vectors/`, including `ids.json` |
| Ordering | Fake transport with random delays and failures; at most one request in flight per channel; call order kept; channels overlap |
| Retries | Transient errors are retried with the same envelope and key; permanent errors are not |
| Guard, size, audit | Denials and oversize send nothing and write the right audit outcome |
| Tokens | Tokens verify against the SDK's own JWKS with a standard JWT library; the fixed key gives the same `kid` as the other SDKs |
| Integration | Against the backbone image and Valkey in containers: publish returns a position; history order holds under injected failures; Centrifugo accepts the SDK's tokens; subscribing from `offset - 1` returns `RUN_STARTED` first |
