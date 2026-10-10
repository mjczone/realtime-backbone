# Publishing from any language

Any language can publish with one HTTP POST to Centrifugo's server API.  To build a full SDK for another language, follow [sdk-spec.md](sdk-spec.md). In production, use an SDK where you can: the tenant guard and the audit log that the v0 SOC 2 case relies on live there. If you publish without an SDK, do what it does yourself.

```sh
curl -s http://backbone:9000/api/publish \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "channel": "live:t-acme.jobs.01JB7Q",
    "idempotency_key": "01JB7S4K2M9QZX3V5W7Y8A0BCD",
    "data": {
      "v": 1,
      "id": "01JB7S4K2M9QZX3V5W7Y8A0BCD",
      "type": "job.progress",
      "tenant": "acme",
      "source": "billing-worker",
      "ts": "2026-10-10T14:03:22.418Z",
      "data": { "jobId": "01JB7Q", "pct": 40 }
    }
  }'
```

The response is `{"result":{}}` for `live` channels, and `{"result":{"offset":12,"epoch":"XVAeWVni"}}` for `replay` channels. Errors come back with HTTP 200 and an `error` field, for example `{"error":{"code":107,"message":"bad request"}}` when `data` is not a JSON object.

## Do what the SDKs do

1. **Channel name.** Build it by the grammar in `spec/channels.md`. The tenant is the second segment.
2. **Tenant guard.** Only publish to your own tenant's channels, and set the envelope's `tenant` to the channel's tenant. Publish to `global` channels only if this component is meant to.
3. **Envelope.** Every field in `spec/events.md`. `id` is a new ULID per message. Keep it under 64 KB.
4. **Idempotency.** Send the envelope `id` as `idempotency_key`, and reuse the same envelope when you retry. Centrifugo drops duplicates for 5 minutes.
5. **Order.** Send one request at a time per channel, and wait for the response before the next. Parallel requests to one channel can arrive out of order.
6. **Retry** on network errors, HTTP 5xx and error codes 100, 108 and 111, with backoff and jitter, for at most about 30 seconds. Don't retry other errors.
7. **Audit log.** Log one line per publish: component, tenant, channel, type, envelope id, time and outcome. Never the payload.

## gRPC

The same API is on port 10000 as gRPC, defined by `proto/centrifugo/api.proto`. Send the key as `authorization: apikey <key>` metadata. Generate a client from the proto in your language.
