package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/redis/rueidis"
)

const (
	guardInterval   = 5 * time.Second
	guardMaxFails   = 3
	apiInternalCode = 100
	resetTimeout    = 60 * time.Second
	resetLockTTL    = 300
)

// Guard covers two Valkey failover cases Centrifugo does not handle itself:
//   - A new server holds old data (a promoted replica, or a restart from AOF) and may have lost the last
//     writes. The epoch survives, offsets go back, and clients drop new publications as duplicates.
//     The guard deletes the history keys so every channel gets a new epoch and clients get recovered: false.
//   - Centrifugo stays connected to a primary that became a replica, and every write fails with READONLY.
//     The guard sees Centrifugo's publishes fail while Valkey takes writes, and asks for a restart.
type Guard struct {
	targets []Target
	prefix  string
	baseURL string
	apiURL  string
	apiKey  string
	channel string
	http    *http.Client
	log     func(string)
	lastErr string
}

func NewGuard(c *Config) (*Guard, error) {
	targets, err := Targets(c)
	if err != nil {
		return nil, err
	}
	g := &Guard{
		prefix:  c.String("engine.redis.prefix"),
		apiKey:  c.String("http_api.key"),
		baseURL: baseURL(c),
		http:    &http.Client{Timeout: 3 * time.Second},
		log:     func(s string) { fmt.Fprintln(os.Stderr, "realtime-doctor guard:", s) },
	}
	if g.prefix == "" {
		g.prefix = "centrifugo"
	}
	for _, t := range targets {
		if !t.Cluster {
			g.targets = append(g.targets, t)
		}
	}
	if len(g.targets) < len(targets) {
		g.log("cluster mode is not covered")
	}
	if !c.Bool("http_api.disabled") {
		prefix := c.String("http_api.handler_prefix")
		if prefix == "" {
			prefix = "/api"
		}
		g.apiURL = g.baseURL + prefix + "/publish"
		g.channel = probeChannel(c)
	}
	return g, nil
}

func baseURL(c *Config) string {
	port := c.Int("http_server.internal_port")
	if port == 0 {
		port = c.Int("http_server.port")
	}
	if port == 0 {
		port = 8000
	}
	return "http://127.0.0.1:" + strconv.Itoa(port)
}

// probeChannel is a channel with history, so a probe publish is a write that a replica refuses.
func probeChannel(c *Config) string {
	namespaces, _ := c.Namespaces()
	for _, ns := range namespaces {
		if ns.HistorySize > 0 {
			return ns.Name + ":global.realtime-guard"
		}
	}
	return ""
}

func (g *Guard) runIDKey() string { return "realtime-doctor:run_id:" + g.prefix }

// checkValkey connects afresh, so the endpoint's name is looked up again. It reports whether every
// target takes a write. With newEpochs, it also deletes history when a target is a new server with old data.
func (g *Guard) checkValkey(ctx context.Context, newEpochs bool) bool {
	ok := len(g.targets) > 0
	for _, t := range g.targets {
		if !g.checkTarget(ctx, t, newEpochs) {
			ok = false
		}
	}
	return ok
}

func (g *Guard) checkTarget(ctx context.Context, t Target, newEpochs bool) bool {
	opt := t.Option
	opt.ForceSingleClient = !t.Sentinel
	client, err := rueidis.NewClient(opt)
	if err != nil {
		return false
	}
	defer client.Close()
	cctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()

	if err := client.Do(cctx, client.B().Set().Key("realtime-doctor:writable").Value("1").ExSeconds(30).Build()).Error(); err != nil {
		return false
	}
	if !newEpochs {
		return true
	}
	s, err := client.Do(cctx, client.B().Info().Section("server").Build()).ToString()
	if err != nil {
		return true
	}
	runID := parseInfo(s)["run_id"]
	old, err := client.Do(cctx, client.B().Get().Key(g.runIDKey()).Build()).ToString()
	if runID == "" || old == runID || (err != nil && !rueidis.IsRedisNil(err)) {
		return true
	}
	if old == "" {
		client.Do(cctx, client.B().Set().Key(g.runIDKey()).Value(runID).Build())
		return true
	}
	g.newEpochs(ctx, client, t.Label, runID, old)
	return true
}

// newEpochs deletes the history once per new server: a lock lets one node do it, and the new run_id is
// stored only after the delete, so a failed or interrupted delete is tried again.
func (g *Guard) newEpochs(ctx context.Context, client rueidis.Client, label, runID, old string) {
	ctx, cancel := context.WithTimeout(ctx, resetTimeout)
	defer cancel()
	lock := "realtime-doctor:reset:" + g.prefix + ":" + runID
	err := client.Do(ctx, client.B().Set().Key(lock).Value("1").Nx().ExSeconds(resetLockTTL).Build()).Error()
	if err != nil {
		return
	}
	n, err := g.deleteHistory(ctx, client)
	if err != nil {
		g.log(fmt.Sprintf("%s: new server with old data, deleting history failed after %d keys, trying again: %v", label, n, err))
		client.Do(context.Background(), client.B().Del().Key(lock).Build())
		return
	}
	client.Do(ctx, client.B().Set().Key(g.runIDKey()).Value(runID).Build())
	g.log(fmt.Sprintf("%s: new server with old data (run_id %s, was %s): deleted %d history keys, clients reload", label, runID, old, n))
}

func (g *Guard) deleteHistory(ctx context.Context, client rueidis.Client) (int, error) {
	n := 0
	cursor := uint64(0)
	for {
		e, err := client.Do(ctx, client.B().Scan().Cursor(cursor).Match(g.prefix+".stream.*").Count(1000).Build()).AsScanEntry()
		if err != nil {
			return n, err
		}
		if len(e.Elements) > 0 {
			if err := client.Do(ctx, client.B().Unlink().Key(e.Elements...).Build()).Error(); err != nil {
				return n, err
			}
			n += len(e.Elements)
		}
		if e.Cursor == 0 {
			return n, nil
		}
		cursor = e.Cursor
	}
}

type probeResult int

const (
	probeOK probeResult = iota
	probeNoAnswer
	probeInternalError
	probeOtherError
)

// probe publishes through Centrifugo's server API, so it uses Centrifugo's own Valkey connection.
func (g *Guard) probe(ctx context.Context) (probeResult, string) {
	body, _ := json.Marshal(map[string]any{"channel": g.channel, "data": map[string]any{"probe": true}})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, g.apiURL, bytes.NewReader(body))
	if err != nil {
		return probeOtherError, err.Error()
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-API-Key", g.apiKey)
	res, err := g.http.Do(req)
	if err != nil {
		return probeNoAnswer, err.Error()
	}
	defer res.Body.Close()
	var out struct {
		Error *struct {
			Code    int    `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if res.StatusCode != http.StatusOK {
		return probeOtherError, res.Status
	}
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		return probeOtherError, err.Error()
	}
	if out.Error == nil {
		return probeOK, ""
	}
	if out.Error.Code == apiInternalCode {
		return probeInternalError, out.Error.Message
	}
	return probeOtherError, fmt.Sprintf("code %d: %s", out.Error.Code, out.Error.Message)
}

// stuck is true when Centrifugo's publish fails while a fresh connection to Valkey takes a write.
// Centrifugo spreads commands over several connections and only some may be stuck, so it probes up to 3 times.
func (g *Guard) stuck(ctx context.Context) bool {
	if g.channel == "" {
		return false
	}
	for i := 0; i < 3; i++ {
		r, detail := g.probe(ctx)
		if r == probeOtherError && detail != g.lastErr {
			g.log("probe on " + g.channel + ": " + detail)
		}
		if r == probeOtherError {
			g.lastErr = detail
		} else {
			g.lastErr = ""
		}
		if r == probeInternalError {
			return g.checkValkey(ctx, false)
		}
		if r != probeOK {
			return false
		}
	}
	return false
}

// Run checks every few seconds until ctx ends. After guardMaxFails stuck checks in a row it calls restart
// and returns; with no restart it logs and goes on.
func (g *Guard) Run(ctx context.Context, restart func()) {
	if g.channel == "" {
		g.log("no namespace with history or the HTTP API is off: READONLY is not covered")
	}
	fails := 0
	t := time.NewTicker(guardInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		g.checkValkey(ctx, true)
		if g.stuck(ctx) {
			fails++
		} else {
			fails = 0
		}
		if fails == guardMaxFails {
			if restart == nil {
				g.log("Centrifugo's publishes fail while Valkey takes writes (READONLY after a failover?): restart it")
				continue
			}
			g.log("Centrifugo's publishes fail while Valkey takes writes (READONLY after a failover?): restarting it")
			restart()
			return
		}
	}
}

// Live is a liveness check: false when Centrifugo does not answer, or is stuck. A slow or failing
// Valkey is not a reason to restart.
func (g *Guard) Live(ctx context.Context) (bool, string) {
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, g.baseURL+"/health", nil)
	res, err := g.http.Do(req)
	if err != nil {
		return false, "Centrifugo does not answer: " + err.Error()
	}
	res.Body.Close()
	if g.stuck(ctx) {
		return false, "Centrifugo's publishes fail while Valkey takes writes"
	}
	return true, "ok"
}

// runGuard runs until stopped. With a parent PID, it stops that process when Centrifugo is stuck, and
// exits when the parent is gone.
func runGuard(path string, parent int) int {
	cfg, err := LoadConfig(path, os.LookupEnv)
	if err != nil {
		fmt.Fprintln(os.Stderr, "realtime-doctor guard:", err)
		return 2
	}
	if t := cfg.String("engine.type"); t != "redis" {
		if parent == 0 {
			select {}
		}
		return 0
	}
	g, err := NewGuard(cfg)
	if err != nil {
		fmt.Fprintln(os.Stderr, "realtime-doctor guard:", err)
		return 2
	}
	ctx := context.Background()
	if parent == 0 {
		g.Run(ctx, nil)
		return 0
	}
	ctx, cancel := context.WithCancel(ctx)
	go func() {
		for ; ; time.Sleep(time.Second) {
			if os.Getppid() != parent {
				cancel()
				return
			}
		}
	}()
	g.Run(ctx, func() { _ = syscall.Kill(parent, syscall.SIGTERM) })
	return 0
}

func runLive(path string) int {
	cfg, err := LoadConfig(path, os.LookupEnv)
	if err != nil {
		fmt.Fprintln(os.Stderr, "realtime-doctor live:", err)
		return 1
	}
	if t := cfg.String("engine.type"); t != "redis" {
		return 0
	}
	g, err := NewGuard(cfg)
	if err != nil {
		fmt.Fprintln(os.Stderr, "realtime-doctor live:", err)
		return 1
	}
	ok, detail := g.Live(context.Background())
	if !ok {
		fmt.Fprintln(os.Stderr, "realtime-doctor live:", detail)
		return 1
	}
	return 0
}

func guardEnabled() bool {
	return !strings.EqualFold(os.Getenv("RTB_GUARD"), "off")
}
