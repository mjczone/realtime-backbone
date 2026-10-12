// realtime-gateway puts the backbone behind plain HTTP, so apps and agents need no SDK:
//
//   - servers publish with their own scoped key and ask for realtime tokens,
//   - browsers get realtime tokens with the app's own access token,
//   - agent runs go through the gateway to the agent's existing AG-UI endpoint, and the gateway publishes the stream.
package main

import (
	"context"
	"crypto"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"log/slog"
	"net/http"
	"os"
	"slices"
	"strings"
	"time"

	"github.com/mjczone/realtime-backbone/gateway/contract"
)

const jwkSHA256 = crypto.SHA256

func b64url(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

type Gateway struct {
	cfg    *Config
	pub    *Publisher
	signer *Signer
	users  *Users
	runner *Runner
	bundle []byte
}

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))
	path := flag.String("config", envOr("RTB_GATEWAY_CONFIG", "/etc/realtime-gateway/gateway.json"), "gateway config file")
	flag.Parse()
	cfg, err := LoadConfig(*path)
	if err != nil {
		slog.Error("config", "error", err)
		os.Exit(2)
	}
	g, err := NewGateway(context.Background(), cfg)
	if err != nil {
		slog.Error("startup", "error", err)
		os.Exit(2)
	}
	slog.Info("realtime-gateway listening", "address", cfg.Listen, "agents", len(cfg.Agents), "clients", len(cfg.Clients))
	srv := &http.Server{Addr: cfg.Listen, Handler: g.Routes(), ReadHeaderTimeout: 10 * time.Second}
	if err := srv.ListenAndServe(); err != nil {
		slog.Error("server", "error", err)
		os.Exit(1)
	}
}

func NewGateway(ctx context.Context, cfg *Config) (*Gateway, error) {
	signer, err := NewSigner(cfg)
	if err != nil {
		return nil, err
	}
	users, err := NewUsers(ctx, cfg.Users)
	if err != nil {
		return nil, err
	}
	var owners OwnerStore = newMemoryOwners()
	if cfg.Valkey != "" {
		if owners, err = newValkeyOwners(cfg.Valkey); err != nil {
			return nil, err
		}
	}
	pub := NewPublisher(strings.TrimSuffix(cfg.Centrifugo.APIURL, "/"), cfg.Centrifugo.APIKey)
	g := &Gateway{cfg: cfg, pub: pub, signer: signer, users: users, runner: NewRunner(cfg, pub, signer, owners)}
	if cfg.ClientBundle != "" {
		if g.bundle, err = os.ReadFile(cfg.ClientBundle); err != nil {
			slog.Warn("client bundle not loaded", "error", err)
		}
	}
	return g, nil
}

func (g *Gateway) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("ok")) })
	mux.HandleFunc("GET /.well-known/rtb-jwks.json", g.jwks)
	mux.HandleFunc("GET /v1/config", g.publicConfig)
	mux.HandleFunc("GET /v1/client.js", g.clientJS)
	// Servers, with a client key.
	mux.HandleFunc("POST /v1/publish", g.publish)
	mux.HandleFunc("POST /v1/tokens/connection", g.serverConnectionToken)
	mux.HandleFunc("POST /v1/tokens/subscription", g.serverSubscriptionToken)
	// Browsers, with the app's access token.
	mux.HandleFunc("POST /v1/me/tokens/connection", g.userConnectionToken)
	mux.HandleFunc("POST /v1/me/tokens/subscription", g.userSubscriptionToken)
	mux.HandleFunc("POST /v1/agents/{agent}/runs", g.startRun)
	mux.HandleFunc("POST /v1/runs/{runId}/cancel", g.cancelRun)
	return g.cors(mux)
}

func (g *Gateway) cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if origin := r.Header.Get("Origin"); origin != "" && slices.Contains(g.cfg.CORS, origin) {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST")
			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func fail(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func readJSON(r *http.Request, v any) error {
	return json.NewDecoder(http.MaxBytesReader(nil, r.Body, 4<<20)).Decode(v)
}

func (g *Gateway) jwks(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "public, max-age=300")
	_, _ = w.Write(g.signer.jwks)
}

func (g *Gateway) publicConfig(w http.ResponseWriter, _ *http.Request) {
	agents := make([]string, 0, len(g.cfg.Agents))
	for name := range g.cfg.Agents {
		agents = append(agents, name)
	}
	slices.Sort(agents)
	writeJSON(w, http.StatusOK, map[string]any{"backboneUrl": g.cfg.PublicBackboneURL, "agents": agents})
}

func (g *Gateway) clientJS(w http.ResponseWriter, _ *http.Request) {
	if g.bundle == nil {
		fail(w, http.StatusNotFound, "no client bundle")
		return
	}
	w.Header().Set("Content-Type", "text/javascript")
	w.Header().Set("Cache-Control", "public, max-age=300")
	_, _ = w.Write(g.bundle)
}

// client finds the server-side caller by its key.
func (g *Gateway) client(r *http.Request) *ClientConfig {
	key, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	if !ok {
		return nil
	}
	for i := range g.cfg.Clients {
		if subtle.ConstantTimeCompare([]byte(g.cfg.Clients[i].Key), []byte(key)) == 1 {
			return &g.cfg.Clients[i]
		}
	}
	return nil
}

func (g *Gateway) publish(w http.ResponseWriter, r *http.Request) {
	cl := g.client(r)
	if cl == nil {
		fail(w, http.StatusUnauthorized, "unknown client key")
		return
	}
	var body struct {
		Channel string          `json:"channel"`
		Type    string          `json:"type"`
		Data    json.RawMessage `json:"data"`
		Corr    string          `json:"corr"`
	}
	if err := readJSON(r, &body); err != nil {
		fail(w, http.StatusBadRequest, "body must be JSON with channel, type and data")
		return
	}
	c, ok := contract.ParseChannel(body.Channel)
	base := map[string]any{"component": cl.ID, "channel": body.Channel, "type": body.Type}
	if !ok {
		audit(slog.LevelWarn, merge(base, map[string]any{"outcome": "denied", "reason": contract.InvalidChannel}))
		fail(w, http.StatusBadRequest, contract.InvalidChannel)
		return
	}
	if !c.IsGlobal() && !cl.allows(c.Tenant) {
		audit(slog.LevelWarn, merge(base, map[string]any{"outcome": "denied", "reason": contract.TenantMismatch, "tenant": c.Tenant}))
		fail(w, http.StatusForbidden, contract.TenantMismatch)
		return
	}
	if reason := contract.CheckTenant(contract.TenantContext{Tenant: c.Tenant, AllowGlobal: cl.AllowGlobal}, body.Channel, c.Tenant); reason != "" {
		audit(slog.LevelWarn, merge(base, map[string]any{"outcome": "denied", "reason": reason, "tenant": c.Tenant}))
		fail(w, http.StatusForbidden, reason)
		return
	}
	env, err := contract.NewEnvelope(body.Type, c.Tenant, cl.ID, body.Data, body.Corr)
	if err != nil {
		fail(w, http.StatusBadRequest, err.Error())
		return
	}
	if raw, _ := json.Marshal(env); len(raw) > contract.MaxEnvelopeBytes {
		audit(slog.LevelWarn, merge(base, map[string]any{"outcome": "too_large", "tenant": c.Tenant, "id": env.ID}))
		fail(w, http.StatusRequestEntityTooLarge, "envelope over 64 KB")
		return
	}
	res := g.pub.Publish(body.Channel, env, map[string]any{"component": cl.ID})
	if res.Err != nil {
		fail(w, http.StatusBadGateway, res.Err.Error())
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func merge(a, b map[string]any) map[string]any {
	out := map[string]any{}
	for k, v := range a {
		out[k] = v
	}
	for k, v := range b {
		out[k] = v
	}
	return out
}

func (g *Gateway) serverConnectionToken(w http.ResponseWriter, r *http.Request) {
	cl := g.client(r)
	if cl == nil || !cl.Tokens {
		fail(w, http.StatusUnauthorized, "this client key can't mint tokens")
		return
	}
	var body struct {
		UserID string         `json:"userId"`
		Info   map[string]any `json:"info"`
	}
	if err := readJSON(r, &body); err != nil || !contract.ValidUserID(body.UserID) {
		fail(w, http.StatusBadRequest, "userId is required")
		return
	}
	token, err := g.signer.Connection(body.UserID, body.Info)
	if err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"token": token})
}

func (g *Gateway) serverSubscriptionToken(w http.ResponseWriter, r *http.Request) {
	cl := g.client(r)
	if cl == nil || !cl.Tokens {
		fail(w, http.StatusUnauthorized, "this client key can't mint tokens")
		return
	}
	var body struct {
		UserID  string `json:"userId"`
		Channel string `json:"channel"`
	}
	if err := readJSON(r, &body); err != nil || !contract.ValidUserID(body.UserID) {
		fail(w, http.StatusBadRequest, "userId and channel are required")
		return
	}
	c, ok := contract.ParseChannel(body.Channel)
	switch {
	case !ok:
		fail(w, http.StatusBadRequest, "invalid channel")
	case c.UserID != "":
		fail(w, http.StatusBadRequest, "user channels use the connection token")
	case !c.IsGlobal() && !cl.allows(c.Tenant):
		fail(w, http.StatusForbidden, "this client key can't mint tokens for that tenant")
	default:
		g.mintSubscription(w, body.UserID, body.Channel)
	}
}

func (g *Gateway) mintSubscription(w http.ResponseWriter, userID, channel string) {
	token, err := g.signer.Subscription(userID, channel)
	if err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"token": token})
}

func (g *Gateway) user(w http.ResponseWriter, r *http.Request) *User {
	u, err := g.users.FromRequest(r)
	if err != nil {
		slog.Info("user token rejected", "path", r.URL.Path, "reason", err.Error())
		fail(w, http.StatusUnauthorized, "unauthenticated")
		return nil
	}
	return u
}

func (g *Gateway) userConnectionToken(w http.ResponseWriter, r *http.Request) {
	u := g.user(w, r)
	if u == nil {
		return
	}
	var info map[string]any
	if u.Name != "" {
		info = map[string]any{"name": u.Name}
	}
	token, err := g.signer.Connection(u.ID, info)
	if err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"token": token})
}

// userSubscriptionToken allows run channels the user owns and channels matching the config's subscribe rules.
func (g *Gateway) userSubscriptionToken(w http.ResponseWriter, r *http.Request) {
	u := g.user(w, r)
	if u == nil {
		return
	}
	var body struct {
		Channel string `json:"channel"`
	}
	if err := readJSON(r, &body); err != nil {
		fail(w, http.StatusBadRequest, "body must be JSON with a channel")
		return
	}
	c, ok := contract.ParseChannel(body.Channel)
	if !ok {
		fail(w, http.StatusBadRequest, "invalid channel")
		return
	}
	if c.UserID != "" {
		fail(w, http.StatusBadRequest, "user channels use the connection token")
		return
	}
	if c.Topic == "run" && u.HasTenant(c.Tenant) {
		owner, found, err := g.runner.owners.Get(r.Context(), c.ID)
		if err != nil {
			fail(w, http.StatusServiceUnavailable, err.Error())
			return
		}
		if found && owner.UserID == u.ID && owner.Tenant == c.Tenant {
			g.mintSubscription(w, u.ID, body.Channel)
			return
		}
		fail(w, http.StatusForbidden, "forbidden")
		return
	}
	for _, t := range u.Tenants {
		for _, p := range g.cfg.Subscribe {
			if subscribeRule(p, t, u.ID).MatchString(body.Channel) {
				g.mintSubscription(w, u.ID, body.Channel)
				return
			}
		}
	}
	fail(w, http.StatusForbidden, "forbidden")
}

func (g *Gateway) startRun(w http.ResponseWriter, r *http.Request) {
	u := g.user(w, r)
	if u == nil {
		return
	}
	name := r.PathValue("agent")
	agent, ok := g.cfg.Agents[name]
	if !ok {
		fail(w, http.StatusNotFound, "no such agent")
		return
	}
	var input Event
	if err := readJSON(r, &input); err != nil || input == nil {
		fail(w, http.StatusBadRequest, "body must be RunAgentInput JSON")
		return
	}
	tenant := r.URL.Query().Get("tenant")
	switch {
	case tenant == "" && len(u.Tenants) == 1:
		tenant = u.Tenants[0]
	case tenant == "":
		fail(w, http.StatusBadRequest, "the user has several tenants: name one with ?tenant=")
		return
	case !u.HasTenant(tenant):
		fail(w, http.StatusForbidden, "forbidden")
		return
	}
	ref, err := g.runner.Start(r.Context(), name, agent, u, tenant, input)
	var se *startError
	switch {
	case errors.As(err, &se):
		fail(w, se.status, se.msg)
	case err != nil:
		fail(w, http.StatusInternalServerError, err.Error())
	default:
		writeJSON(w, http.StatusAccepted, ref)
	}
}

func (g *Gateway) cancelRun(w http.ResponseWriter, r *http.Request) {
	u := g.user(w, r)
	if u == nil {
		return
	}
	err := g.runner.Cancel(r.Context(), r.PathValue("runId"), u)
	switch {
	case errors.Is(err, errNoRun):
		fail(w, http.StatusNotFound, "no such run")
	case err != nil:
		fail(w, http.StatusServiceUnavailable, err.Error())
	default:
		writeJSON(w, http.StatusOK, map[string]bool{"cancelled": true})
	}
}

func envOr(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}
