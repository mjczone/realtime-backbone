package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/redis/rueidis"
)

func TestGuardSettings(t *testing.T) {
	c := testConfig(t, `{"http_server":{"port":8000,"internal_port":9000},"engine":{"type":"redis"},
		"channel":{"namespaces":[{"name":"live"},{"name":"replay","history_size":10}]}}`, nil)
	g, err := NewGuard(c)
	if err != nil {
		t.Fatal(err)
	}
	if g.apiURL != "http://127.0.0.1:9000/api/publish" || g.baseURL != "http://127.0.0.1:9000" {
		t.Fatalf("urls = %q %q", g.baseURL, g.apiURL)
	}
	if g.channel != "replay:global.realtime-guard" {
		t.Fatalf("channel = %q", g.channel)
	}
	if g.serverKey() != "realtime-doctor:server:centrifugo" {
		t.Fatalf("serverKey = %q", g.serverKey())
	}
	c = testConfig(t, `{"channel":{"namespaces":[{"name":"live"}]}}`, map[string]string{"CENTRIFUGO_HTTP_SERVER_PORT": "8001"})
	if got := baseURL(c); got != "http://127.0.0.1:8001" {
		t.Fatalf("baseURL = %q", got)
	}
	if got := probeChannel(c); got != "" {
		t.Fatalf("probeChannel = %q", got)
	}
}

func TestLostWrites(t *testing.T) {
	zero := noReplID
	info := func(run, repl, repl2 string) map[string]string {
		return map[string]string{"run_id": run, "master_replid": repl, "master_replid2": repl2}
	}
	cases := []struct {
		name string
		old  string
		info map[string]string
		want bool
	}{
		{"restart", "r1:a", info("r2", "b", zero), true},
		{"restart, replid kept", "r1:a", info("r2", "a", zero), true},
		{"promotion", "r1:a", info("r1", "b", "a"), true},
		{"failback, guard missed the other primary", "r1:a", info("r1", "c", "b"), true},
		{"new backlog", "r1:a", info("r1", "b", zero), false},
		{"no master_replid2 field", "r1:a", info("r1", "b", ""), false},
		{"same replid after a promotion", "r1:b", info("r1", "b", "a"), false},
	}
	for _, c := range cases {
		if got := lostWrites(c.old, c.info); got != c.want {
			t.Errorf("%s: lostWrites = %v, want %v", c.name, got, c.want)
		}
	}
}

func testGuard(t *testing.T, base string) (*Guard, rueidis.Client) {
	t.Helper()
	addr := os.Getenv("RTB_TEST_REDIS")
	if addr == "" {
		t.Skip("RTB_TEST_REDIS not set")
	}
	c := testConfig(t, `{"channel":{"namespaces":[{"name":"replay","history_size":10}]}}`,
		map[string]string{"CENTRIFUGO_ENGINE_REDIS_ADDRESS": addr, "CENTRIFUGO_ENGINE_REDIS_PREFIX": "rtbtest"})
	g, err := NewGuard(c)
	if err != nil {
		t.Fatal(err)
	}
	g.baseURL, g.apiURL = base, base+"/api/publish"
	g.log = func(s string) { t.Log(s) }
	opt := g.targets[0].Option
	opt.ForceSingleClient = true
	client, err := rueidis.NewClient(opt)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(client.Close)
	return g, client
}

func TestGuardNewEpochs(t *testing.T) {
	g, client := testGuard(t, "")
	ctx := context.Background()
	do := func(cmd rueidis.Completed) {
		if err := client.Do(ctx, cmd).Error(); err != nil {
			t.Fatal(err)
		}
	}
	exists := func(key string) bool {
		n, _ := client.Do(ctx, client.B().Exists().Key(key).Build()).AsInt64()
		return n == 1
	}
	s, _ := client.Do(ctx, client.B().Info().Build()).ToString()
	info := parseInfo(s)
	cur := serverID(info)
	stream, meta, other := "rtbtest.stream.replay:a", "rtbtest.stream.meta.replay:a", "rtbtest.presence.x"
	lock := "realtime-doctor:reset:rtbtest:" + cur
	defer client.Do(ctx, client.B().Del().Key(stream, meta, other, lock, g.serverKey(), g.oldRunIDKey()).Build())
	write := func() {
		do(client.B().Set().Key(stream).Value("1").Build())
		do(client.B().Set().Key(meta).Value("1").Build())
		do(client.B().Set().Key(other).Value("1").Build())
	}
	stored := func() string {
		v, _ := client.Do(ctx, client.B().Get().Key(g.serverKey()).Build()).ToString()
		return v
	}

	do(client.B().Del().Key(g.serverKey()).Build())
	do(client.B().Set().Key(g.oldRunIDKey()).Value(info["run_id"]).Build())
	write()
	g.checkValkey(ctx, true)
	if !exists(stream) || stored() != cur || exists(g.oldRunIDKey()) {
		t.Fatal("first run: history must stay, the server is stored and the old key removed")
	}

	do(client.B().Del().Key(g.serverKey()).Build())
	do(client.B().Set().Key(g.oldRunIDKey()).Value("an-earlier-run-id").Build())
	write()
	g.checkValkey(ctx, true)
	if exists(stream) || stored() != cur || exists(g.oldRunIDKey()) {
		t.Fatal("upgrade after a restart: history must go, the server is stored and the old key removed")
	}
	write()

	if info["master_replid2"] == noReplID {
		do(client.B().Set().Key(g.serverKey()).Value(info["run_id"] + ":an-earlier-backlog").Build())
		g.checkValkey(ctx, true)
		if !exists(stream) || stored() != cur {
			t.Fatal("new backlog on the same server: history must stay")
		}
	}

	do(client.B().Set().Key(g.serverKey()).Value("an-earlier-server:x").Build())
	do(client.B().Set().Key(lock).Value("1").Build())
	g.checkValkey(ctx, true)
	if !exists(stream) {
		t.Fatal("another node holds the lock: history must stay")
	}

	do(client.B().Del().Key(lock).Build())
	if !g.checkValkey(ctx, true) {
		t.Fatal("expected a writable primary")
	}
	if exists(stream) || exists(meta) || !exists(other) {
		t.Fatal("expected only the history keys deleted")
	}
	if v := stored(); v != cur {
		t.Fatalf("server key = %q", v)
	}

	write()
	g.checkValkey(ctx, true)
	if !exists(stream) {
		t.Fatal("same server: history must stay")
	}
}

func TestGuardLive(t *testing.T) {
	body, delay := `{"error":{"code":100,"message":"internal server error"}}`, time.Duration(0)
	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte(`{}`)) })
	mux.HandleFunc("/api/publish", func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(delay)
		_, _ = w.Write([]byte(body))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	g, client := testGuard(t, srv.URL)
	g.http.Timeout = 300 * time.Millisecond
	ctx := context.Background()

	if ok, _ := g.Live(ctx); ok {
		t.Fatal("internal error with a writable primary: expected stuck")
	}

	delay = time.Second
	if ok, _ := g.Live(ctx); !ok {
		t.Fatal("a slow publish is not a reason to restart")
	}
	delay = 0

	if err := client.Do(ctx, client.B().ConfigSet().ParameterValue().ParameterValue("maxmemory", "1").Build()).Error(); err != nil {
		t.Skip("CONFIG SET refused:", err)
	}
	ok, _ := g.Live(ctx)
	client.Do(ctx, client.B().ConfigSet().ParameterValue().ParameterValue("maxmemory", "0").Build())
	if !ok {
		t.Fatal("Valkey out of memory is not a reason to restart")
	}

	body = `{"error":{"code":102,"message":"unknown channel"}}`
	if ok, _ := g.Live(ctx); !ok {
		t.Fatal("other errors are not stuck")
	}
	body = `{"result":{}}`
	if ok, _ := g.Live(ctx); !ok {
		t.Fatal("expected ok")
	}
	g.baseURL = "http://127.0.0.1:1"
	if ok, _ := g.Live(ctx); ok {
		t.Fatal("Centrifugo not answering must fail")
	}
}
