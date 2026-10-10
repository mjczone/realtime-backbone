# Rolling upgrade

The backbone image tracks this repo's version. A Centrifugo patch bump is a backbone patch release.

## Kubernetes

```sh
helm upgrade rtb deploy/helm/realtime-backbone -n rtb -f my-values.yaml --set centrifugo.image.tag=X.Y.Z
kubectl -n rtb rollout status deploy/realtime-backbone
helm test rtb -n rtb
```

The chart replaces one pod at a time (`maxUnavailable: 1`) and the PodDisruptionBudget keeps at least two running. Each pod waits 5 seconds before it stops, then clients on it reconnect to another node, and `replay` subscriptions recover what they missed.

## Compose

```sh
# set BACKBONE_IMAGE to the new tag in .env
docker compose pull && docker compose up -d
```

One node, so clients disconnect for a few seconds, then reconnect and recover.

## Before a Centrifugo major version

Read the Centrifugo migration notes, run the integration tests against the new image, and try it in staging. Config keys change between majors.

## Watch

- Token endpoint latency: every reconnect fetches a connection token. See [Reconnect storm](reconnect-storm.md).
- `BackboneNodeMissing` while pods roll is expected; it should clear.
