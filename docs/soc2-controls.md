# SOC 2 controls (v0)

This is the case we make for the v0 backbone, which has one shared publisher key. Auditors decide what is sufficient; this page is not a guarantee. The design behind it is in `docs/DESIGN.md` ("Authentication, authorization and SOC 2 controls").

## Controls

| Concern | Control in v0 | Evidence | Improvement in v1 |
| --- | --- | --- | --- |
| Attribution | Publisher SDK audit log: component, tenant, channel, event type, envelope id, time, outcome | `rtb.audit` log lines from every publisher | Per-component API keys |
| Least privilege | SDK tenant guard; the API listens only on the private network (internal port, NetworkPolicy in Kubernetes) | Guard conformance vectors (`spec/vectors/guard.json`) run in CI for both SDKs; the NetworkPolicy; CI checks the API is not on the client port | Keys scoped to tenants and channel prefixes at an edge |
| Revocation | Short-lived gRPC client certificates (24 hours); stop renewing to cut a component off | cert-manager Certificates; [certificate revocation runbook](runbooks/certificate-revocation.md) | Revoke one key |
| Secret handling | API keys and the token signing key in a vault, injected as env vars; the Helm chart never takes secret values | Secret manifests point at existing Secrets; [rotation runbooks](runbooks/) | Same, per key |
| Tenant isolation | Token endpoints only mint subscription tokens for the caller's tenants and after the app's own authorization; the tenant ID is in every channel name; Centrifugo rejects malformed channel names at the edge | Token endpoint tests; `channel_regex` integration test | Scope check at the edge before Centrifugo |
| Client authentication | Connection and subscription JWTs (ES256, about 10 minutes) verified by Centrifugo through the app's JWKS; Centrifugo holds only public keys | Integration tests that Centrifugo accepts SDK tokens and rejects others | Same |
| Transport | TLS on the client endpoint; mTLS available on gRPC | Ingress or Caddy TLS config; chart mTLS settings | Same |
| Availability | Rolling upgrades one node at a time; replay history recovers missed messages; `realtime-doctor` checks the backplane on every start | PodDisruptionBudget; alerts in the PrometheusRule; load test results in DESIGN.md | Same |

## Known limits

- Centrifugo does not log which client certificate connected and does not check CRLs or OCSP. mTLS proves a caller holds a valid certificate; the SDK audit log says which component sent what.
- HTTP publishers (including the TypeScript SDK) have no certificate identity unless the internal port is put behind mTLS. Their attribution is the audit log alone.
- The tenant guard runs in the SDKs. Anyone holding the shared API key can publish to any tenant with a raw request. That is why the key stays on the private network and why v1 adds scoped keys.
- A removed signing key can stay in Centrifugo's JWKS cache for up to an hour. After a key leak, restart the backbone nodes.
