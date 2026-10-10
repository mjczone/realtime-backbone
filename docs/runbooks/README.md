# Runbooks

| Runbook | When |
| --- | --- |
| [API key rotation](api-key-rotation.md) | Scheduled rotation, or the key leaked |
| [Signing key rotation](signing-key-rotation.md) | Scheduled rotation of the token signing key, or it leaked |
| [Certificate revocation](certificate-revocation.md) | Cut one gRPC publisher off |
| [Valkey failover](valkey-failover.md) | Valkey is down or failed over |
| [Rolling upgrade](rolling-upgrade.md) | New backbone or Centrifugo version |
| [Reconnect storm](reconnect-storm.md) | Many clients reconnect at once, the token endpoint is overloaded |
| [Incident checklist](incident-checklist.md) | Anything else |
