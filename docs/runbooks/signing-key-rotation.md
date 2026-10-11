# Signing key rotation

Apps sign connection and subscription tokens with an ES256 key and serve the public half at `/.well-known/rtb-jwks.json`. Centrifugo verifies tokens through that JWKS URL. It caches each key by URL and `kid` for one hour, and fetches the JWKS again when it sees a `kid` it doesn't know.

## Scheduled rotation (no downtime)

1. Generate a new key: `generateSigningKey()` in `@mjczone/realtime-tokens`, or `RealtimeTokenSigner.GenerateSigningKey()` in `MJCZone.Realtime.Tokens`. Store it in the vault.
2. Deploy the app with the new key as the signing key, and the old key's public JWK in `additionalPublicKeys` / `AdditionalPublicKeys`. The JWKS now lists both. Centrifugo fetches the new `kid` the first time a token carries it.
3. Wait for the longest token lifetime (10 minutes by default), plus your deploy time.
4. Deploy again without the old key in the additional keys.

## If the key leaked

1. Deploy the app with a new signing key and no additional keys, so the JWKS no longer lists the leaked key.
2. Restart the backbone nodes (`kubectl -n rtb rollout restart deploy/realtime-backbone`). Otherwise Centrifugo may keep the leaked key in its cache for up to an hour.
3. Connections made with forged tokens end when their token expires and the refresh fails (at most 10 minutes plus a 25-second grace period). To end them sooner, use the server API's `disconnect` for the affected users.
