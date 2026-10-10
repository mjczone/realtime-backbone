# realtime-backbone Helm chart

Wraps the upstream [`centrifugal/centrifugo`](https://github.com/centrifugal/helm-charts) chart (pinned to 13.6.1, Centrifugo 6.9.7) and points it at the `realtime-backbone` image. It adds:

- the backbone config (namespaces, channel regexes, transports), copied from `config/centrifugo.json`
- `rtb-doctor` as an init container, and as `helm test`
- separate Services for the client port, the HTTP API and the gRPC API
- a NetworkPolicy: the client port is open, the API ports only accept labeled publisher namespaces and Prometheus
- 3 replicas, a PodDisruptionBudget, and rolling updates one pod at a time
- optional: a PrometheusRule with the backbone alerts, a Grafana dashboard ConfigMap, cert-manager certificates for gRPC mTLS

It does not install Valkey. Point it at a managed Valkey or your own Sentinel setup; see `docs/deploy/backplane.md`.

## Install

1. Create the Secret. The chart never takes secret values.

   ```sh
   kubectl -n rtb create secret generic realtime-backbone-secrets \
     --from-literal=CENTRIFUGO_HTTP_API_KEY=... \
     --from-literal=CENTRIFUGO_GRPC_API_KEY=... \
     --from-literal=CENTRIFUGO_ENGINE_REDIS_ADDRESS='rediss://default:PASSWORD@valkey.example.internal:6379'
   ```

   In production, populate it with External Secrets or the Secrets Store CSI driver from your vault.

2. Set the token settings in your values (`backbone.env`): the JWKS URL your app serves (`/.well-known/rtb-jwks.json`), the audience, the issuer and the allowed origins.

3. Label the namespaces that publish:

   ```sh
   kubectl label namespace my-app realtime-backbone/publisher=true
   ```

4. Install and check:

   ```sh
   helm dependency build deploy/helm/realtime-backbone
   helm install rtb deploy/helm/realtime-backbone -n rtb -f my-values.yaml
   helm test rtb -n rtb
   ```

5. Put an ingress (or Gateway) in front of the `realtime-backbone` Service only, with WebSocket support. Publishers use `realtime-backbone-internal:9000` (HTTP) or `realtime-backbone-grpc-api:10000` (gRPC).

Names are fixed (`realtime-backbone`, `realtime-backbone-secrets`, `realtime-backbone-env`) so the init container can reach the same config, Secret and env. Install one release per namespace, or change `centrifugo.fullnameOverride`, `backbone.secretName` and `backbone.envConfigMapName` together.

## rtb-doctor

The init container runs `rtb-doctor --mode warn`: it logs its checks and the pod starts anyway. Set `--mode strict` in `centrifugo.initContainers` to refuse to start on a failure. With strict, a Valkey outage during a rollout makes new pods wait until Valkey is back, which is the intended fail-fast behavior.

## gRPC mTLS

Set `certificates.enabled: true`, an `issuerRef`, and one entry in `certificates.clients` per publishing component. Then turn on TLS for the gRPC API:

```yaml
centrifugo:
  env:
    CENTRIFUGO_GRPC_API_TLS_ENABLED: "true"
    CENTRIFUGO_GRPC_API_TLS_CERT_PEM: /tls/tls.crt
    CENTRIFUGO_GRPC_API_TLS_KEY_PEM: /tls/tls.key
    CENTRIFUGO_GRPC_API_TLS_CLIENT_CA_PEM: /tls/ca.crt
  volumes:
    - name: grpc-tls
      secret:
        secretName: rtb-grpc-server-tls   # <release>-grpc-server-tls
  volumeMounts:
    - name: grpc-tls
      mountPath: /tls
      readOnly: true
```

Centrifugo checks that the client certificate is signed by the CA, but it does not log which certificate connected and does not check CRLs or OCSP. That is why the certificates are short-lived (24 hours by default): to cut a component off, delete its Certificate and it can't renew. Attribution comes from the publisher SDK's audit log.

## Monitoring

`centrifugo.metrics.serviceMonitor.enabled: true` scrapes `/metrics`. `prometheusRule.enabled: true` adds alerts for pub/sub lag, connections per node, server API errors, dropped Valkey pub/sub messages and missing nodes. Valkey memory and CPU alerts come from your Valkey provider or exporter. `dashboard.enabled: true` adds a small dashboard; the official Centrifugo dashboard is grafana.com dashboard 13039.

## Updating the config

`config/centrifugo.json` is the source. After changing it, run `node scripts/sync-helm-config.mjs`. CI runs it with `--check`.
