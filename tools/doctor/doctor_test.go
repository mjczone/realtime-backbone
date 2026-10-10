package main

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func testConfig(t *testing.T, file string, env map[string]string) *Config {
	t.Helper()
	path := ""
	if file != "" {
		path = filepath.Join(t.TempDir(), "config.json")
		if err := os.WriteFile(path, []byte(file), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	c, err := LoadConfig(path, func(k string) (string, bool) { v, ok := env[k]; return v, ok })
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func TestEnvOverridesFile(t *testing.T) {
	c := testConfig(t, `{"http_api":{"key":"file"},"engine":{"redis":{"address":["redis://a:1"]}}}`,
		map[string]string{"CENTRIFUGO_HTTP_API_KEY": "env", "CENTRIFUGO_ENGINE_REDIS_ADDRESS": "redis://b:1 redis://c:1"})
	if got := c.String("http_api.key"); got != "env" {
		t.Fatalf("key = %q", got)
	}
	if got := c.Strings("engine.redis.address"); len(got) != 2 || got[1] != "redis://c:1" {
		t.Fatalf("address = %v", got)
	}
	if got := c.String("missing.key"); got != "" {
		t.Fatalf("missing = %q", got)
	}
}

func TestTargets(t *testing.T) {
	cases := []struct {
		addr     string
		sentinel bool
		tls      bool
		user     string
		pass     string
		label    string
		err      bool
	}{
		{addr: "valkey:6379", label: "valkey:6379"},
		{addr: "redis://:secret@valkey:6379/2", pass: "secret", label: "redis://:xxxxx@valkey:6379/2"},
		{addr: "rediss://default:pw@host:25061", tls: true, user: "default", pass: "pw", label: "rediss://default:xxxxx@host:25061"},
		{addr: "redis+sentinel://s1:26379?sentinel_master_name=mymaster", sentinel: true, label: "redis+sentinel://s1:26379?sentinel_master_name=mymaster"},
		{addr: "redis+sentinel://s1:26379", err: true},
		{addr: "http://x:1", err: true},
		{addr: "no-port", err: true},
	}
	for _, tc := range cases {
		c := testConfig(t, "", map[string]string{"CENTRIFUGO_ENGINE_REDIS_ADDRESS": tc.addr})
		ts, err := Targets(c)
		if tc.err {
			if err == nil {
				t.Errorf("%s: expected error", tc.addr)
			}
			continue
		}
		if err != nil {
			t.Fatalf("%s: %v", tc.addr, err)
		}
		tg := ts[0]
		if tg.Sentinel != tc.sentinel || (tg.Option.TLSConfig != nil) != tc.tls || tg.Option.Username != tc.user || tg.Option.Password != tc.pass || tg.Label != tc.label {
			t.Errorf("%s: got %+v label %q", tc.addr, tg.Option, tg.Label)
		}
	}
}

func TestSentinelAddressField(t *testing.T) {
	c := testConfig(t, `{"engine":{"redis":{"sentinel_address":["s1:26379","s2:26379"],"sentinel_master_name":"m"}}}`, nil)
	ts, err := Targets(c)
	if err != nil || len(ts) != 1 || !ts[0].Sentinel || ts[0].Option.Sentinel.MasterSet != "m" || len(ts[0].Option.InitAddress) != 2 {
		t.Fatalf("got %+v, %v", ts, err)
	}
}

func statuses(rs []Result) map[Status]int {
	m := map[Status]int{}
	for _, r := range rs {
		m[r.Status]++
	}
	return m
}

func TestConfigChecks(t *testing.T) {
	good := `{"http_api":{"key":"k"},"client":{"allowed_origins":["https://app"],
	  "token":{"jwks_public_endpoint":"http://x/jwks","audience":"a","issuer":"i"},
	  "subscription_token":{"enabled":true,"jwks_public_endpoint":"http://x/jwks","audience":"a","issuer":"i"}}}`
	if rs := ConfigChecks(testConfig(t, good, nil)); ExitCode(rs) != 0 {
		t.Fatalf("good config: %+v", rs)
	}
	if rs := ConfigChecks(testConfig(t, good, map[string]string{"CENTRIFUGO_CLIENT_ALLOWED_ORIGINS": "*"})); ExitCode(rs) != 1 {
		t.Fatalf("origins *: %+v", rs)
	}
	rs := ConfigChecks(testConfig(t, good, map[string]string{"CENTRIFUGO_HTTP_API_KEY": "", "CENTRIFUGO_CLIENT_SUBSCRIPTION_TOKEN_ISSUER": ""}))
	if statuses(rs)[Fail] != 2 {
		t.Fatalf("missing key and issuer: %+v", rs)
	}
	rs = ConfigChecks(testConfig(t, `{"grpc_api":{"enabled":true}}`, nil))
	if ExitCode(rs) != 2 {
		t.Fatalf("empty config: %+v", rs)
	}
}

func TestEviction(t *testing.T) {
	cases := map[string]Status{"allkeys-lru": Fail, "volatile-lru": Warn, "": Warn}
	for policy, want := range cases {
		if got := evictionCheck("x", map[string]string{"maxmemory_policy": policy, "maxmemory": "1"}).Status; got != want {
			t.Errorf("%q: got %s", policy, got)
		}
	}
	if got := evictionCheck("x", map[string]string{"maxmemory_policy": "noeviction", "maxmemory": "0"}).Status; got != Warn {
		t.Errorf("maxmemory 0: got %s", got)
	}
	if got := evictionCheck("x", map[string]string{"maxmemory_policy": "noeviction", "maxmemory": "268435456"}).Status; got != Pass {
		t.Errorf("noeviction: got %s", got)
	}
}

func TestVersion(t *testing.T) {
	if !versionLess("6.0.9", "6.2.0") || versionLess("7.2.4", "6.2.0") || versionLess("6.2.0", "6.2.0") {
		t.Fatal("versionLess")
	}
	if r := versionCheck("x", map[string]string{"redis_version": "7.2.4", "valkey_version": "8.1.10"}); r.Status != Pass {
		t.Fatalf("%+v", r)
	}
	if r := versionCheck("x", map[string]string{"redis_version": "6.0.0"}); r.Status != Fail {
		t.Fatalf("%+v", r)
	}
}

func TestConfigFromArgs(t *testing.T) {
	cases := map[string][]string{
		"/c.json":     {"centrifugo", "-c", "/c.json"},
		"/d.json":     {"centrifugo", "--config=/d.json"},
		"config.json": {"centrifugo"},
	}
	for want, args := range cases {
		if got := configFromArgs(args); got != want {
			t.Errorf("%v: got %q", args, got)
		}
	}
}

// TestBackplane runs against a real Valkey when RTB_TEST_REDIS is set, for example redis://localhost:6379.
func TestBackplane(t *testing.T) {
	addr := os.Getenv("RTB_TEST_REDIS")
	if addr == "" {
		t.Skip("RTB_TEST_REDIS not set")
	}
	c := testConfig(t, "", map[string]string{"CENTRIFUGO_ENGINE_REDIS_ADDRESS": addr})
	ts, err := Targets(c)
	if err != nil {
		t.Fatal(err)
	}
	rs := BackplaneChecks(context.Background(), ts[0])
	want := os.Getenv("RTB_TEST_EXPECT")
	for _, r := range rs {
		t.Logf("%s %s: %s", r.Status, r.Check, r.Detail)
	}
	if want == "fail" && ExitCode(rs) != 2 {
		t.Fatal("expected a failure")
	}
	if want == "" {
		for _, r := range rs {
			if r.Check != "eviction" && r.Check != "persistence" && r.Check != "latency" && r.Status != Pass {
				t.Fatalf("%s: %s", r.Check, r.Detail)
			}
		}
	}
}
