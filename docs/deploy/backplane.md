# Choosing a Valkey backplane

Centrifugo keeps history, presence and cross-node pub/sub in Valkey (or Redis). This page says which Valkey to use where.

One rule decides the setup: Valkey only needs to be as available as Centrifugo. On a single host, bundled Valkey is the right choice, because a highly available Valkey can't outlive the host that Centrifugo runs on.

## Setups

| Setup | What it is | When |
| --- | --- | --- |
| Bundled | The Compose `valkey` profile: one Valkey next to Centrifugo, with AOF and data in `DATA_DIR` | A single VM or Droplet, dev and staging, small installs |
| Platform-managed | The provider runs Valkey with automatic failover behind one endpoint, usually `rediss://`. Centrifugo needs only the address; Sentinel isn't involved | Anything with more than one Centrifugo node, when the platform offers it |
| Self-managed HA | 3 VMs running a primary, a replica and Sentinels. Centrifugo is given the Sentinel address | Bare VMs with no managed option and a real need for availability across hosts |

## By host

| Host | Recommended | Notes |
| --- | --- | --- |
| Railway | A Valkey service in the same project and environment, reached at `<service>.railway.internal` (the template in `deploy/railway`) | Single instance with a volume, no failover. Private networking doesn't cross projects |
| DigitalOcean | Managed Caching for Valkey in the same VPC, with a standby node for failover. Backbone on App Platform or a Droplet | TLS required. A single Droplet with bundled Valkey is fine for small installs |
| Vultr | Managed Databases for Valkey in the same VPC, with at least 1 replica for automatic failover | Or a VM with bundled Valkey for small installs |
| OVHcloud | Public Cloud Databases for Valkey, on the private network | Or a VM with bundled Valkey |
| Hetzner and other VM-only hosts | Bundled Valkey on one VM, or self-managed Sentinel across 3 VMs | No first-party managed Valkey; see the provider-neutral options below |
| AWS | ElastiCache for Valkey, **node-based** | Avoid ElastiCache Serverless, which bills by request units (the same problem as pay-per-request Redis) |
| Google Cloud | Memorystore for Valkey, **cluster mode disabled** | The mode is fixed at creation. Cluster mode needs Centrifugo's cluster configuration and is a "Large profile" decision |
| Azure | Azure Managed Redis | Azure Cache for Redis is being retired. Confirm the clustering policy gives Centrifugo a single endpoint, or configure Centrifugo for cluster mode |
| Any cloud, provider-neutral | Aiven for Valkey (runs on AWS, GCP, Azure, DigitalOcean and others), or Redis Cloud on a fixed-size plan | For adopters who want one vendor across clouds |

## What every backplane must support

`rtb-doctor` checks all of these:

- PUB/SUB, Lua scripting (`EVALSHA`) and Streams.
- Eviction policy `noeviction`, so a full Valkey fails publishes visibly instead of silently evicting history.
- AOF or the provider's equivalent persistence, if replay must survive a Valkey restart.
- Private network access, and TLS where offered.
- **Fixed-capacity pricing, not per-request.** Centrifugo holds pub/sub connections open and pings constantly, which makes per-request billing expensive. This applies to Upstash pay-as-you-go and to ElastiCache Serverless. Fixed-price plans from those vendors may be fine, but run the load test against them first.


## Connecting

| Setup | `CENTRIFUGO_ENGINE_REDIS_ADDRESS` |
| --- | --- |
| Bundled (Compose) | `redis://valkey:6379` plus `CENTRIFUGO_ENGINE_REDIS_PASSWORD` |
| Managed, TLS | `rediss://default:PASSWORD@host:port` |
| Sentinel | `redis+sentinel://:PASSWORD@sentinel1:26379?sentinel_master_name=mymaster&addr=sentinel2:26379&addr=sentinel3:26379` |
| Cluster | `redis+cluster://:PASSWORD@node1:6379?addr=node2:6379` (a "Large profile" decision) |

Centrifugo needs Redis 6.2 or later. Valkey reports a compatible `redis_version` (7.2.4). Upstream says Valkey "should work" but is not tested by Centrifugal Labs; this repo's integration tests run against Valkey 8.1.

## Results from managed services

Run `rtb-doctor` against a managed Valkey before relying on it, and record the result here.

| Provider | Plan | Date | Result |
| --- | --- | --- | --- |
| (none recorded yet) | | | |
