# Incident checklist

1. **Scope.** One tenant, one channel, or everything? One node or all? Browsers, publishers, or both?
2. **Backbone health.** `rtb-doctor` on a node; `kubectl -n rtb get pods`; the `/health` endpoint on port 9000.
3. **Valkey.** Provider console, memory, CPU, failovers. See [Valkey failover](valkey-failover.md).
4. **Publishers.** Audit logs (`rtb.audit`): `failed` (backbone or network), `denied` (tenant guard, a bug in the caller), `too_large` (payload over 64 KB).
5. **Clients.** Browser console: token endpoint errors (401/403), subscribe errors (103 permission denied, 107 bad channel name), disconnect codes.
6. **Token endpoint.** Latency and errors. See [Reconnect storm](reconnect-storm.md).
7. **Recent changes.** Deploys of the backbone, the apps, the signing key or the API key.
8. **Security.** If a key or certificate may have leaked: [API key rotation](api-key-rotation.md), [Signing key rotation](signing-key-rotation.md), [Certificate revocation](certificate-revocation.md).
9. **Afterwards.** Write down what happened, the timeline and the fix. Add an alert or a doctor check if one would have caught it.
