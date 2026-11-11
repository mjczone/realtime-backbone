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
	if g.runIDKey() != "realtime-doctor:run_id:centrifugo" {
		t.Fatalf("runIDKey = %q", g.runIDKey())
	}
	c = testConfig(t, `{"channel":{"namespaces":[{"name":"live"}]}}`, map[string]string{"CENTRIFUGO_HTTP_SERVER_PORT": "8001"})
	if got := baseURL(c); got != "http://127.0.0.1:8001" {
		t.Fatalf("baseURL = %q", got)
	}
	if got := probeChannel(c); got != "" {
		t.Fatalf("probeChannel = %q", got)
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
	s, _ := client.Do(ctx, client.B().Info().Section("server").Build()).ToString()
	runID := parseInfo(s)["run_id"]
	stream, meta, other := "rtbtest.stream.replay:a", "rtbtest.stream.meta.replay:a", "rtbtest.presence.x"
	lock := "realtime-doctor:reset:rtbtest:" + runID
	defer client.Do(ctx, client.B().Del().Key(stream, meta, other, lock, g.runIDKey()).Build())
	write := func() {
		do(client.B().Set().Key(stream).Value("1").Build())
		do(client.B().Set().Key(meta).Value("1").Build())
		do(client.B().Set().Key(other).Value("1").Build())
	}

	do(client.B().Del().Key(g.runIDKey()).Build())
	write()
	g.checkValkey(ctx, true)
	if !exists(stream) {
		t.Fatal("first run: history must stay")
	}

	do(client.B().Set().Key(g.runIDKey()).Value("an-earlier-server").Build())
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
	if v, _ := client.Do(ctx, client.B().Get().Key(g.runIDKey()).Build()).ToString(); v != runID {
		t.Fatalf("run_id key = %q", v)
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
