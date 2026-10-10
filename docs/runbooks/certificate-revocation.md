# Cutting off a gRPC publisher

Centrifugo checks that a gRPC client certificate is signed by the CA in `grpc_api.tls.client_ca_pem`. It does not check CRLs or OCSP, and it does not log which certificate connected. So revocation works through short certificate lifetimes, and attribution comes from the publisher SDK's audit log.

## Cut one component off

1. Stop the component's certificate from renewing. With the Helm chart's cert-manager option, remove the component from `certificates.clients` and run `helm upgrade` (this deletes its Certificate), and delete its Secret.
2. Its current certificate stays valid until it expires (24 hours by default). If that is too long, restart the backbone nodes as well. That only drops current connections; a component that still holds a valid certificate can connect again until it expires.
3. If the component also holds the shared API key, rotate the key: see [API key rotation](api-key-rotation.md).

## Cut everything off fast

Replace the CA: issue a new CA, reissue the server and every client certificate from it, and set the new CA in `client_ca_pem`. Every certificate from the old CA stops working once the backbone restarts.

## Find out what a component published

Search the publisher audit logs (`rtb.audit`) by `component`. Each entry has the tenant, channel, event type, envelope ID, time and outcome, never the payload.
