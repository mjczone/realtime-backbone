package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/lestrrat-go/jwx/v3/jwa"
	"github.com/lestrrat-go/jwx/v3/jwk"
	"github.com/lestrrat-go/jwx/v3/jwt"
)

func TestReadSSE(t *testing.T) {
	in := "event: x\ndata: {\"a\":1}\n\n: comment\ndata: {\"b\":\ndata: 2}\n\ndata: {\"c\":3}"
	var got []string
	if err := readSSE(strings.NewReader(in), func(b []byte) error { got = append(got, string(b)); return nil }); err != nil {
		t.Fatal(err)
	}
	want := []string{`{"a":1}`, "{\"b\":\n2}", `{"c":3}`}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("got %q", got)
	}
}

func TestChunkNormalizer(t *testing.T) {
	c := &chunkNormalizer{}
	var types []string
	for _, e := range []Event{
		{"type": "TEXT_MESSAGE_CHUNK", "messageId": "m", "delta": "Hel"},
		{"type": "TEXT_MESSAGE_CHUNK", "delta": "lo"},
		{"type": "RUN_FINISHED"},
	} {
		for _, out := range c.feed(e) {
			types = append(types, out["type"].(string))
		}
	}
	if fmt.Sprint(types) != "[TEXT_MESSAGE_START TEXT_MESSAGE_CONTENT TEXT_MESSAGE_CONTENT TEXT_MESSAGE_END RUN_FINISHED]" {
		t.Fatal(types)
	}
}

func TestBatcher(t *testing.T) {
	var mu sync.Mutex
	var out []Event
	b := newBatcher(time.Hour, &mu, func(e Event) { out = append(out, e) })
	b.push(Event{"type": "TEXT_MESSAGE_START", "messageId": "m"})
	b.push(Event{"type": "TEXT_MESSAGE_CONTENT", "messageId": "m", "delta": "Hel"})
	b.push(Event{"type": "TEXT_MESSAGE_CONTENT", "messageId": "m", "delta": "lo"})
	b.push(Event{"type": "TOOL_CALL_ARGS", "toolCallId": "t", "delta": `{"a"`})
	b.push(Event{"type": "TOOL_CALL_ARGS", "toolCallId": "t", "delta": `:1}`})
	b.push(Event{"type": "TEXT_MESSAGE_END", "messageId": "m"})
	if len(out) != 4 || out[1]["delta"] != "Hello" || out[2]["delta"] != `{"a":1}` || out[3]["type"] != "TEXT_MESSAGE_END" {
		t.Fatalf("%v", out)
	}
	b2 := newBatcher(10*time.Millisecond, &mu, func(e Event) { out = append(out, e) })
	b2.push(Event{"type": "TEXT_MESSAGE_CONTENT", "messageId": "m", "delta": "x"})
	time.Sleep(50 * time.Millisecond)
	mu.Lock()
	defer mu.Unlock()
	if out[len(out)-1]["delta"] != "x" {
		t.Fatal("interval flush")
	}
}

func TestSubscribeRule(t *testing.T) {
	r := subscribeRule("live:t-{tenant}.jobs.*", "acme", "u1")
	for ch, want := range map[string]bool{"live:t-acme.jobs.1": true, "live:t-acme.jobs": false, "live:t-globex.jobs.1": false, "live:t-acme.jobs.1.2": false} {
		if r.MatchString(ch) != want {
			t.Errorf("%s: want %v", ch, want)
		}
	}
	if !subscribeRule("presence:t-{tenant}.doc.{userId}", "acme", "u.1").MatchString("presence:t-acme.doc.u.1") {
		t.Error("placeholders are quoted")
	}
}

func TestMessagesFromEvents(t *testing.T) {
	msgs := messagesFromEvents([]Event{
		{"type": "TEXT_MESSAGE_START", "messageId": "a"},
		{"type": "TOOL_CALL_START", "toolCallId": "c", "toolCallName": "f", "parentMessageId": "a"},
		{"type": "TOOL_CALL_ARGS", "toolCallId": "c", "delta": "{}"},
		{"type": "TOOL_CALL_RESULT", "messageId": "r", "toolCallId": "c", "content": "ok"},
		{"type": "TEXT_MESSAGE_START", "messageId": "b"},
		{"type": "TEXT_MESSAGE_CONTENT", "messageId": "b", "delta": "hi"},
	})
	b, _ := json.Marshal(msgs)
	want := `[{"content":"","id":"a","role":"assistant","toolCalls":[{"function":{"arguments":"{}","name":"f"},"id":"c","type":"function"}]},{"content":"ok","id":"r","role":"tool","toolCallId":"c"},{"content":"hi","id":"b","role":"assistant"}]`
	if string(b) != want {
		t.Fatal(string(b))
	}
}

// testKit is a gateway wired to a fake Centrifugo, a fake agent and a user JWKS.
type testKit struct {
	gw        *httptest.Server
	userKey   jwk.Key
	mu        sync.Mutex
	published []map[string]any
	agentBody chan Event
	agentAuth chan string
}

func newKit(t *testing.T, agentHandler http.HandlerFunc, mutate func(*Config)) *testKit {
	t.Helper()
	k := &testKit{agentBody: make(chan Event, 10), agentAuth: make(chan string, 10)}
	offset := 0
	cf := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		k.mu.Lock()
		k.published = append(k.published, body)
		offset++
		o := offset
		k.mu.Unlock()
		fmt.Fprintf(w, `{"result":{"offset":%d,"epoch":"e1"}}`, o)
	}))
	t.Cleanup(cf.Close)
	agent := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var in Event
		_ = json.NewDecoder(r.Body).Decode(&in)
		k.agentBody <- in
		k.agentAuth <- r.Header.Get("Authorization")
		agentHandler(w, r.WithContext(context.WithValue(r.Context(), inputKey{}, in)))
	}))
	t.Cleanup(agent.Close)

	raw, _ := jwk.Import(mustECKey(t))
	_ = raw.Set(jwk.KeyIDKey, "u1")
	k.userKey = raw
	pub, _ := raw.PublicKey()
	set := jwk.NewSet()
	_ = set.AddKey(pub)
	jwks := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _ = json.NewEncoder(w).Encode(set) }))
	t.Cleanup(jwks.Close)

	signing, _ := jwk.Import(mustECKey(t))
	sb, _ := json.Marshal(signing)
	dir := t.TempDir()
	cfg := fmt.Sprintf(`{
	  "centrifugo": {"apiUrl": %q, "apiKey": "k"},
	  "signing": {"privateKey": %q, "audience": "rtb", "issuer": "gw"},
	  "clients": [{"id": "worker", "key": "worker-key", "tenants": ["acme"], "tokens": true}],
	  "users": {"jwksUrl": %q, "audience": "app", "issuer": "app", "tenantClaim": "info.tenant"},
	  "subscribe": ["live:t-{tenant}.tasks"],
	  "agents": {"chat": {"url": %q, "forwardAuthorization": true, "notifyUser": true, "skipTypes": ["STATE_SNAPSHOT"], "batchInterval": "20ms"}}
	}`, cf.URL+"/api", string(sb), jwks.URL, agent.URL)
	path := filepath.Join(dir, "gateway.json")
	_ = os.WriteFile(path, []byte(cfg), 0o600)
	c, err := LoadConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	if mutate != nil {
		mutate(c)
	}
	g, err := NewGateway(context.Background(), c)
	if err != nil {
		t.Fatal(err)
	}
	k.gw = httptest.NewServer(g.Routes())
	t.Cleanup(k.gw.Close)
	return k
}

type inputKey struct{}

func (k *testKit) userToken(t *testing.T, sub, tenant string) string {
	tok, _ := jwt.NewBuilder().Subject(sub).Audience([]string{"app"}).Issuer("app").Expiration(time.Now().Add(time.Hour)).
		Claim("info", map[string]any{"tenant": tenant}).Build()
	signed, err := jwt.Sign(tok, jwt.WithKey(jwa.ES256(), k.userKey))
	if err != nil {
		t.Fatal(err)
	}
	return string(signed)
}

func (k *testKit) post(t *testing.T, path, auth string, body any) (int, map[string]any) {
	b, _ := json.Marshal(body)
	req, _ := http.NewRequest(http.MethodPost, k.gw.URL+path, strings.NewReader(string(b)))
	req.Header.Set("Authorization", "Bearer "+auth)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(res.Body).Decode(&out)
	return res.StatusCode, out
}

func (k *testKit) types(channel string) []string {
	k.mu.Lock()
	defer k.mu.Unlock()
	var out []string
	for _, p := range k.published {
		if p["channel"] == channel {
			out = append(out, p["data"].(map[string]any)["type"].(string))
		}
	}
	return out
}

func sse(w http.ResponseWriter, events ...string) {
	w.Header().Set("Content-Type", "text/event-stream")
	for _, e := range events {
		fmt.Fprintf(w, "data: %s\n\n", e)
		w.(http.Flusher).Flush()
	}
}

func TestPublishScopes(t *testing.T) {
	k := newKit(t, func(http.ResponseWriter, *http.Request) {}, nil)
	status, out := k.post(t, "/v1/publish", "worker-key", map[string]any{"channel": "live:t-acme.jobs.1", "type": "job.progress", "data": map[string]any{"pct": 5}})
	if status != 200 || out["id"] == "" {
		t.Fatal(status, out)
	}
	if s, _ := k.post(t, "/v1/publish", "worker-key", map[string]any{"channel": "live:t-globex.jobs.1", "type": "a.b", "data": map[string]any{}}); s != 403 {
		t.Fatal("other tenant", s)
	}
	if s, _ := k.post(t, "/v1/publish", "worker-key", map[string]any{"channel": "live:global.x", "type": "a.b", "data": map[string]any{}}); s != 403 {
		t.Fatal("global", s)
	}
	if s, _ := k.post(t, "/v1/publish", "nope", map[string]any{}); s != 401 {
		t.Fatal("bad key", s)
	}
	if s, _ := k.post(t, "/v1/publish", "worker-key", map[string]any{"channel": "live:t-acme.x", "type": "a.b", "data": map[string]any{"s": strings.Repeat("x", 70000)}}); s != 413 {
		t.Fatal("too large", s)
	}
}

func TestUserTokens(t *testing.T) {
	k := newKit(t, func(http.ResponseWriter, *http.Request) {}, nil)
	user := k.userToken(t, "ann", "acme")
	if s, out := k.post(t, "/v1/me/tokens/connection", user, nil); s != 200 || out["token"] == "" {
		t.Fatal(s, out)
	}
	if s, _ := k.post(t, "/v1/me/tokens/subscription", user, map[string]string{"channel": "live:t-acme.tasks"}); s != 200 {
		t.Fatal("rule", s)
	}
	if s, _ := k.post(t, "/v1/me/tokens/subscription", user, map[string]string{"channel": "live:t-acme.secret"}); s != 403 {
		t.Fatal("no rule", s)
	}
	if s, _ := k.post(t, "/v1/me/tokens/subscription", user, map[string]string{"channel": "replay:t-acme.run.r1"}); s != 403 {
		t.Fatal("unknown run", s)
	}
	if s, _ := k.post(t, "/v1/me/tokens/connection", "garbage", nil); s != 401 {
		t.Fatal("bad user token", s)
	}
	if s, _ := k.post(t, "/v1/tokens/subscription", "worker-key", map[string]string{"userId": "ann", "channel": "live:t-globex.x"}); s != 403 {
		t.Fatal("server token, other tenant", s)
	}
}

func TestRunThroughTheGateway(t *testing.T) {
	k := newKit(t, func(w http.ResponseWriter, r *http.Request) {
		in := r.Context().Value(inputKey{}).(Event)
		sse(w,
			fmt.Sprintf(`{"type":"RUN_STARTED","threadId":%q,"runId":%q}`, in["threadId"], in["runId"]),
			`{"type":"STATE_SNAPSHOT","snapshot":{}}`,
			`{"type":"TEXT_MESSAGE_START","messageId":"m","role":"assistant"}`,
			`{"type":"TEXT_MESSAGE_CONTENT","messageId":"m","delta":"Hel"}`,
			`{"type":"TEXT_MESSAGE_CONTENT","messageId":"m","delta":"lo"}`,
			`{"type":"TEXT_MESSAGE_END","messageId":"m"}`,
			fmt.Sprintf(`{"type":"RUN_FINISHED","threadId":%q,"runId":%q}`, in["threadId"], in["runId"]),
		)
	}, nil)
	user := k.userToken(t, "ann", "acme")
	status, ref := k.post(t, "/v1/agents/chat/runs", user, map[string]any{"threadId": "th1", "messages": []any{map[string]any{"id": "u1", "role": "user", "content": "hi"}}})
	if status != 202 || ref["offset"].(float64) != 1 || ref["token"] == "" || ref["threadId"] != "th1" {
		t.Fatal(status, ref)
	}
	in := <-k.agentBody
	if in["runId"] != ref["runId"] || in["threadId"] != "th1" {
		t.Fatal("agent input", in)
	}
	if auth := <-k.agentAuth; auth != "Bearer "+user {
		t.Fatal("authorization not forwarded", auth)
	}
	channel := ref["channel"].(string)
	waitFor(t, func() bool { return len(k.types(channel)) == 5 })
	if got := fmt.Sprint(k.types(channel)); got != "[agui.RUN_STARTED agui.TEXT_MESSAGE_START agui.TEXT_MESSAGE_CONTENT agui.TEXT_MESSAGE_END agui.RUN_FINISHED]" {
		t.Fatal(got)
	}
	if got := fmt.Sprint(k.types("live:t-acme.user#ann")); got != "[notice.run_started]" {
		t.Fatal("notice", got)
	}
	if s, _ := k.post(t, "/v1/me/tokens/subscription", user, map[string]string{"channel": channel}); s != 200 {
		t.Fatal("owner token", s)
	}
	if s, _ := k.post(t, "/v1/me/tokens/subscription", k.userToken(t, "bob", "acme"), map[string]string{"channel": channel}); s != 403 {
		t.Fatal("other user token", s)
	}
}

func TestRunErrorsAndCancel(t *testing.T) {
	release := make(chan struct{})
	k := newKit(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.Context().Value(inputKey{}).(Event)["threadId"] {
		case "broken":
			w.WriteHeader(500)
		case "short":
			sse(w, `{"type":"TEXT_MESSAGE_START","messageId":"m"}`)
		case "slow":
			sse(w, `{"type":"TEXT_MESSAGE_START","messageId":"m"}`)
			select {
			case <-r.Context().Done():
			case <-release:
			}
		}
	}, nil)
	defer close(release)
	user := k.userToken(t, "ann", "acme")
	lastError := func(threadID string) map[string]any {
		_, ref := k.post(t, "/v1/agents/chat/runs", user, map[string]any{"threadId": threadID})
		<-k.agentBody
		<-k.agentAuth
		channel := ref["channel"].(string)
		if threadID == "slow" {
			time.Sleep(100 * time.Millisecond)
			if s, _ := k.post(t, "/v1/runs/"+ref["runId"].(string)+"/cancel", k.userToken(t, "bob", "acme"), nil); s != 404 {
				t.Fatal("other user cancel", s)
			}
			if s, _ := k.post(t, "/v1/runs/"+ref["runId"].(string)+"/cancel", user, nil); s != 200 {
				t.Fatal("cancel", s)
			}
		}
		waitFor(t, func() bool { ts := k.types(channel); return len(ts) > 0 && ts[len(ts)-1] == "agui.RUN_ERROR" })
		k.mu.Lock()
		defer k.mu.Unlock()
		for i := len(k.published) - 1; i >= 0; i-- {
			if k.published[i]["channel"] == channel {
				return k.published[i]["data"].(map[string]any)["data"].(map[string]any)
			}
		}
		return nil
	}
	if e := lastError("broken"); e["code"] != "rtb.agent_error" || !strings.Contains(e["message"].(string), "HTTP 500") {
		t.Fatal(e)
	}
	if e := lastError("short"); e["code"] != "rtb.agent_error" {
		t.Fatal(e)
	}
	if e := lastError("slow"); e["code"] != "rtb.cancelled" {
		t.Fatal(e)
	}
}

func TestSkipTypesGuard(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "g.json")
	_ = os.WriteFile(path, []byte(`{"centrifugo":{"apiUrl":"x","apiKey":"k"},"signing":{"privateKey":"x","audience":"a","issuer":"i"},
	  "users":{"jwksUrl":"x"},"agents":{"a":{"url":"x","skipTypes":["RUN_FINISHED"]}}}`), 0o600)
	if _, err := LoadConfig(path); err == nil || !strings.Contains(err.Error(), "can't be skipped") {
		t.Fatal(err)
	}
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatal("timed out")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func mustECKey(t *testing.T) any {
	t.Helper()
	k, err := ecdsaKey()
	if err != nil {
		t.Fatal(err)
	}
	return k
}
