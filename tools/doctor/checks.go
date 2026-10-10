package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/redis/rueidis"
)

type Status string

const (
	Pass Status = "pass"
	Warn Status = "warn"
	Fail Status = "fail"
	Skip Status = "skip"
)

type Result struct {
	Check  string `json:"check"`
	Target string `json:"target,omitempty"`
	Status Status `json:"status"`
	Detail string `json:"detail"`
}

func ExitCode(results []Result) int {
	code := 0
	for _, r := range results {
		if r.Status == Fail {
			return 2
		}
		if r.Status == Warn {
			code = 1
		}
	}
	return code
}

func RunAll(ctx context.Context, c *Config) []Result {
	results := ConfigChecks(c)
	if t := c.String("engine.type"); t != "redis" {
		return append(results, Result{Check: "engine", Status: Warn,
			Detail: fmt.Sprintf("engine.type is %q: no backplane, single node only, history lost on restart", t)})
	}
	targets, err := Targets(c)
	if err != nil {
		return append(results, Result{Check: "connect", Status: Fail, Detail: err.Error()})
	}
	for _, t := range targets {
		results = append(results, BackplaneChecks(ctx, t)...)
	}
	return results
}

func ConfigChecks(c *Config) []Result {
	var out []Result
	add := func(s Status, detail string) {
		out = append(out, Result{Check: "config", Status: s, Detail: detail})
	}

	if c.Bool("client.insecure") {
		add(Fail, "client.insecure is on: anyone can connect and subscribe without a token")
	}
	if c.Bool("http_api.insecure") {
		add(Fail, "http_api.insecure is on: the server API needs no key")
	} else if !c.Bool("http_api.disabled") && c.String("http_api.key") == "" {
		add(Fail, "http_api.key is not set")
	}
	if c.Bool("http_api.external") {
		add(Warn, "http_api.external is on: the server API is on the public client port")
	}
	if c.Bool("grpc_api.enabled") && c.String("grpc_api.key") == "" && c.String("grpc_api.tls.client_ca_pem") == "" {
		add(Fail, "grpc_api is enabled with no key and no client CA")
	}

	out = append(out, tokenChecks(c, "client.token")...)
	if c.Bool("client.subscription_token.enabled") {
		out = append(out, tokenChecks(c, "client.subscription_token")...)
	}

	origins := c.Strings("client.allowed_origins")
	switch {
	case slices.Contains(origins, "*"):
		add(Warn, "client.allowed_origins is *: fine for dev, set exact origins in production")
	case len(origins) == 0:
		add(Warn, "client.allowed_origins is empty: browsers on other origins can't connect")
	}

	if len(out) == 0 {
		add(Pass, "API key, token verification, audience and issuer are set")
	}
	return out
}

func tokenChecks(c *Config, prefix string) []Result {
	var out []Result
	add := func(s Status, detail string) {
		out = append(out, Result{Check: "config", Status: s, Detail: detail})
	}
	if c.String(prefix+".jwks_public_endpoint") == "" {
		if c.String(prefix+".hmac_secret_key") != "" || c.String(prefix+".rsa_public_key") != "" || c.String(prefix+".ecdsa_public_key") != "" {
			add(Warn, prefix+" uses a static key: the backbone design verifies through jwks_public_endpoint")
		} else {
			add(Fail, prefix+".jwks_public_endpoint is not set")
		}
	}
	if c.String(prefix+".audience") == "" && c.String(prefix+".audience_regex") == "" {
		add(Fail, prefix+".audience is not set")
	}
	if c.String(prefix+".issuer") == "" && c.String(prefix+".issuer_regex") == "" {
		add(Fail, prefix+".issuer is not set")
	}
	return out
}

func BackplaneChecks(ctx context.Context, t Target) []Result {
	var out []Result
	add := func(check string, s Status, detail string) {
		out = append(out, Result{Check: check, Target: t.Label, Status: s, Detail: detail})
	}

	opt := t.Option
	opt.ForceSingleClient = !t.Cluster && !t.Sentinel
	client, err := rueidis.NewClient(opt)
	if err != nil {
		add("connect", Fail, err.Error())
		return out
	}
	defer client.Close()
	cctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	if err := client.Do(cctx, client.B().Ping().Build()).Error(); err != nil {
		add("connect", Fail, err.Error())
		return out
	}
	add("connect", Pass, "connected")

	info := func(section string) map[string]string {
		s, err := client.Do(cctx, client.B().Info().Section(section).Build()).ToString()
		if err != nil {
			return nil
		}
		return parseInfo(s)
	}

	srv := info("server")
	out = append(out, versionCheck(t.Label, srv))
	out = append(out, topologyCheck(t, info("replication"), info("cluster")))
	out = append(out, evictionCheck(t.Label, info("memory")))
	out = append(out, persistenceCheck(t.Label, info("persistence")))
	out = append(out, pubsubCheck(ctx, t, client))
	out = append(out, luaCheck(cctx, t.Label, client))
	out = append(out, streamsCheck(cctx, t.Label, client))
	out = append(out, latencyCheck(cctx, t.Label, client))
	return out
}

func parseInfo(s string) map[string]string {
	m := map[string]string{}
	for _, line := range strings.Split(s, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if k, v, ok := strings.Cut(line, ":"); ok {
			m[k] = v
		}
	}
	return m
}

func versionCheck(label string, srv map[string]string) Result {
	r := Result{Check: "server", Target: label}
	v := srv["redis_version"]
	if v == "" {
		r.Status, r.Detail = Warn, "INFO server did not report a version"
		return r
	}
	name := "Redis " + v
	if vv := srv["valkey_version"]; vv != "" {
		name = "Valkey " + vv + " (redis_version " + v + ")"
	}
	if versionLess(v, "6.2.0") {
		r.Status, r.Detail = Fail, name+": Centrifugo needs Redis 6.2 or later"
		return r
	}
	r.Status, r.Detail = Pass, name
	return r
}

func versionLess(a, b string) bool {
	pa, pb := strings.Split(a, "."), strings.Split(b, ".")
	for i := 0; i < 3; i++ {
		var x, y int
		if i < len(pa) {
			x, _ = strconv.Atoi(pa[i])
		}
		if i < len(pb) {
			y, _ = strconv.Atoi(pb[i])
		}
		if x != y {
			return x < y
		}
	}
	return false
}

func topologyCheck(t Target, repl, cluster map[string]string) Result {
	r := Result{Check: "topology", Target: t.Label}
	clusterOn := cluster["cluster_enabled"] == "1"
	role := repl["role"]
	switch {
	case clusterOn && !t.Cluster:
		r.Status, r.Detail = Fail, "server is in cluster mode but the config is not (use redis+cluster:// or cluster_address)"
	case !clusterOn && t.Cluster:
		r.Status, r.Detail = Fail, "config expects cluster mode but the server is not a cluster"
	case role == "slave" || role == "replica":
		r.Status, r.Detail = Fail, "connected to a replica: writes will fail"
	default:
		mode := "standalone"
		if t.Cluster {
			mode = "cluster"
		} else if t.Sentinel {
			mode = "sentinel"
		}
		r.Status, r.Detail = Pass, fmt.Sprintf("%s, role %s, %s connected replicas", mode, orUnknown(role), orUnknown(repl["connected_slaves"]))
	}
	return r
}

func evictionCheck(label string, mem map[string]string) Result {
	r := Result{Check: "eviction", Target: label}
	policy, max := mem["maxmemory_policy"], mem["maxmemory"]
	switch {
	case policy == "":
		r.Status, r.Detail = Warn, "INFO memory did not report maxmemory_policy; check that it is noeviction"
	case strings.HasPrefix(policy, "allkeys-"):
		r.Status, r.Detail = Fail, "maxmemory_policy is "+policy+": replay history can be evicted, use noeviction"
	case policy != "noeviction":
		r.Status, r.Detail = Warn, "maxmemory_policy is "+policy+": use noeviction"
	case max == "0":
		r.Status, r.Detail = Warn, "maxmemory is 0: a full Valkey is OOM-killed instead of failing publishes"
	default:
		r.Status, r.Detail = Pass, "noeviction, maxmemory "+orUnknown(max)
	}
	return r
}

func persistenceCheck(label string, p map[string]string) Result {
	r := Result{Check: "persistence", Target: label}
	if p["aof_enabled"] == "1" {
		r.Status, r.Detail = Pass, "AOF on"
	} else {
		r.Status, r.Detail = Warn, "AOF off: replay history and stream positions are lost if Valkey restarts (managed services may persist differently)"
	}
	return r
}

func randomKey(kind string) string {
	b := make([]byte, 6)
	_, _ = rand.Read(b)
	return "rtb-doctor:" + kind + ":" + hex.EncodeToString(b)
}

func pubsubCheck(ctx context.Context, t Target, client rueidis.Client) Result {
	r := Result{Check: "pubsub", Target: t.Label}
	ch := randomKey("pubsub")
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()

	got := make(chan error, 1)
	dc, release := client.Dedicate()
	defer release()
	wait := dc.SetPubSubHooks(rueidis.PubSubHooks{
		OnMessage: func(m rueidis.PubSubMessage) {
			select {
			case got <- nil:
			default:
			}
		},
	})
	if err := dc.Do(ctx, dc.B().Subscribe().Channel(ch).Build()).Error(); err != nil {
		r.Status, r.Detail = Fail, "SUBSCRIBE: "+err.Error()
		return r
	}
	start := time.Now()
	if err := client.Do(ctx, client.B().Publish().Channel(ch).Message("ping").Build()).Error(); err != nil {
		r.Status, r.Detail = Fail, "PUBLISH: "+err.Error()
		return r
	}
	select {
	case <-got:
		r.Status, r.Detail = Pass, fmt.Sprintf("round trip %s", time.Since(start).Round(time.Microsecond))
	case err := <-wait:
		r.Status, r.Detail = Fail, fmt.Sprintf("subscription closed: %v", err)
	case <-ctx.Done():
		r.Status, r.Detail = Fail, "no message within 2s"
	}
	return r
}

func luaCheck(ctx context.Context, label string, client rueidis.Client) Result {
	r := Result{Check: "lua", Target: label}
	sha, err := client.Do(ctx, client.B().ScriptLoad().Script("return 1").Build()).ToString()
	if err != nil {
		r.Status, r.Detail = Fail, "SCRIPT LOAD: "+err.Error()
		return r
	}
	n, err := client.Do(ctx, client.B().Evalsha().Sha1(sha).Numkeys(0).Build()).AsInt64()
	if err != nil || n != 1 {
		r.Status, r.Detail = Fail, fmt.Sprintf("EVALSHA: %v", err)
		return r
	}
	r.Status, r.Detail = Pass, "SCRIPT LOAD and EVALSHA work"
	return r
}

func streamsCheck(ctx context.Context, label string, client rueidis.Client) Result {
	r := Result{Check: "streams", Target: label}
	key := randomKey("stream")
	defer client.Do(context.Background(), client.B().Del().Key(key).Build())
	if err := client.Do(ctx, client.B().Xadd().Key(key).Id("*").FieldValue().FieldValue("k", "v").Build()).Error(); err != nil {
		r.Status, r.Detail = Fail, "XADD: "+err.Error()
		return r
	}
	client.Do(ctx, client.B().Expire().Key(key).Seconds(30).Build())
	entries, err := client.Do(ctx, client.B().Xrange().Key(key).Start("-").End("+").Build()).AsXRange()
	if err != nil || len(entries) != 1 {
		r.Status, r.Detail = Fail, fmt.Sprintf("XRANGE: %v", err)
		return r
	}
	r.Status, r.Detail = Pass, "XADD, XRANGE and DEL work"
	return r
}

func latencyCheck(ctx context.Context, label string, client rueidis.Client) Result {
	r := Result{Check: "latency", Target: label}
	var ds []time.Duration
	for i := 0; i < 50; i++ {
		start := time.Now()
		if err := client.Do(ctx, client.B().Ping().Build()).Error(); err != nil {
			r.Status, r.Detail = Fail, "PING: "+err.Error()
			return r
		}
		ds = append(ds, time.Since(start))
	}
	slices.Sort(ds)
	median, max := ds[len(ds)/2], ds[len(ds)-1]
	r.Detail = fmt.Sprintf("50 PINGs: median %s, max %s", median.Round(time.Microsecond), max.Round(time.Microsecond))
	r.Status = Pass
	if max > 5*time.Millisecond {
		r.Status = Warn
		r.Detail += ": over 5ms usually means Valkey is not on the same private network"
	}
	return r
}

func orUnknown(s string) string {
	if s == "" {
		return "unknown"
	}
	return s
}
