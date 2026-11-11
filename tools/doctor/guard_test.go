package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/redis/rueidis"
)

func TestGuardSettings(t *testing.T) {
	c := testConfig(t, `{"http_server":{"port":8000,"internal_port":9000},"engine":{"type":"redis"},
		"channel":{"namespaces":[{"name":"live"},{"name":"replay","history_size":10}]}}`, nil)
	if got := apiURL(c); got != "http://127.0.0.1:9000/api/publish" {
		t.Fatalf("apiURL = %q", got)
	}
	if got := probeChannel(c); got != "replay:global.realtime-guard" {
		t.Fatalf("probeChannel = %q", got)
	}
	c = testConfig(t, `{"channel":{"namespaces":[{"name":"live"}]}}`, map[string]string{"CENTRIFUGO_HTTP_SERVER_PORT": "8001"})
	if got := apiURL(c); got != "http://127.0.0.1:8001/api/publish" {
		t.Fatalf("apiURL = %q", got)
	}
	if got := probeChannel(c); got != "" {
		t.Fatalf("probeChannel = %q", got)
	}
}

func testGuard(t *testing.T, apiURL string) (*Guard, rueidis.Client) {
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
	g.apiURL = apiURL
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
	stream, meta, other := "rtbtest.stream.replay:a", "rtbtest.stream.meta.replay:a", "rtbtest.presence.x"
	defer client.Do(ctx, client.B().Del().Key(stream, meta, other).Build())

	do(client.B().Set().Key(guardRunIDKey).Value("an-earlier-server").Build())
	do(client.B().Set().Key(stream).Value("1").Build())
	do(client.B().Set().Key(meta).Value("1").Build())
	do(client.B().Set().Key(other).Value("1").Build())
	if !g.checkValkey(ctx, true) {
		t.Fatal("expected a primary")
	}
	if exists(stream) || exists(meta) || !exists(other) {
		t.Fatal("expected only the history keys deleted")
	}

	do(client.B().Set().Key(stream).Value("1").Build())
	g.checkValkey(ctx, true)
	if !exists(stream) {
		t.Fatal("same server: history must stay")
	}
}

func TestGuardStuck(t *testing.T) {
	body := `{"error":{"code":100,"message":"internal server error"}}`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-API-Key") != "" {
			t.Error("no key was configured")
		}
		_, _ = w.Write([]byte(body))
	}))
	defer srv.Close()
	g, _ := testGuard(t, srv.URL)
	ctx := context.Background()

	if !g.stuck(ctx, false) {
		t.Fatal("internal error with a primary: expected stuck")
	}
	if ok, _ := g.Live(ctx); ok {
		t.Fatal("live: expected a failure")
	}
	body = `{"error":{"code":102,"message":"unknown channel"}}`
	if g.stuck(ctx, false) {
		t.Fatal("other errors are not stuck")
	}
	body = `{"result":{}}`
	if ok, _ := g.Live(ctx); !ok {
		t.Fatal("live: expected ok")
	}
	g.apiURL = "http://127.0.0.1:1/api/publish"
	if ok, _ := g.Live(ctx); ok {
		t.Fatal("live: Centrifugo not answering must fail")
	}
}
