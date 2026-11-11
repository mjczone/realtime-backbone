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
	guardRunIDKey   = "realtime-doctor:run_id"
	guardMaxFails   = 3
	apiInternalCode = 100
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
		prefix: c.String("engine.redis.prefix"),
		apiKey: c.String("http_api.key"),
		http:   &http.Client{Timeout: 3 * time.Second},
		log:    func(s string) { fmt.Fprintln(os.Stderr, "realtime-doctor guard:", s) },
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
		g.apiURL = apiURL(c)
		g.channel = probeChannel(c)
	}
	return g, nil
}

func apiURL(c *Config) string {
	port := c.Int("http_server.internal_port")
	if port == 0 {
		port = c.Int("http_server.port")
	}
	if port == 0 {
		port = 8000
	}
	prefix := c.String("http_api.handler_prefix")
	if prefix == "" {
		prefix = "/api"
	}
	return "http://127.0.0.1:" + strconv.Itoa(port) + prefix + "/publish"
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

// checkValkey connects afresh, so the endpoint's name is looked up again. It reports whether every
// target is a primary. With newEpochs, it also deletes history when a target is a new server with old data.
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
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()

	info := func(section string) map[string]string {
		s, err := client.Do(ctx, client.B().Info().Section(section).Build()).ToString()
		if err != nil {
			return nil
		}
		return parseInfo(s)
	}
	if info("replication")["role"] != "master" {
		return false
	}
	if !newEpochs {
		return true
	}
	runID := info("server")["run_id"]
	if runID == "" {
		return true
	}
	old, err := client.Do(ctx, client.B().Set().Key(guardRunIDKey).Value(runID).Get().Build()).ToString()
	if err != nil && !rueidis.IsRedisNil(err) {
		return false
	}
	if old != "" && old != runID {
		n, err := g.deleteHistory(ctx, client)
		if err != nil {
			g.log(fmt.Sprintf("%s: new server with old data, deleting history failed after %d keys: %v", t.Label, n, err))
			client.Do(ctx, client.B().Set().Key(guardRunIDKey).Value(old).Build())
			return true
		}
		g.log(fmt.Sprintf("%s: new server with old data (run_id %s, was %s): deleted %d history keys, clients reload", t.Label, runID, old, n))
	}
	return true
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
	probeUnreachable
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
		return probeUnreachable, err.Error()
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

// stuck is true when Centrifugo cannot publish while a fresh connection finds a primary.
func (g *Guard) stuck(ctx context.Context, newEpochs bool) bool {
	primary := g.checkValkey(ctx, newEpochs)
	if g.channel == "" {
		return false
	}
	r, detail := g.probe(ctx)
	if r == probeOtherError && detail != g.lastErr {
		g.log("probe on " + g.channel + ": " + detail)
	}
	if r == probeOtherError {
		g.lastErr = detail
	} else {
		g.lastErr = ""
	}
	return r == probeInternalError && primary
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
		if g.stuck(ctx, true) {
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

// Live is a liveness check: false when Centrifugo does not answer, or is stuck.
func (g *Guard) Live(ctx context.Context) (bool, string) {
	if g.channel == "" {
		return true, "not covered"
	}
	primary := g.checkValkey(ctx, false)
	r, detail := g.probe(ctx)
	switch {
	case r == probeUnreachable:
		return false, "Centrifugo does not answer: " + detail
	case r == probeInternalError && primary:
		return false, "Centrifugo's publishes fail while Valkey takes writes: " + detail
	}
	return true, "ok"
}

func runGuard(path string, restartParent bool) int {
	cfg, err := LoadConfig(path, os.LookupEnv)
	if err != nil {
		fmt.Fprintln(os.Stderr, "realtime-doctor guard:", err)
		return 2
	}
	if t := cfg.String("engine.type"); t != "redis" {
		return 0
	}
	g, err := NewGuard(cfg)
	if err != nil {
		fmt.Fprintln(os.Stderr, "realtime-doctor guard:", err)
		return 2
	}
	ctx := context.Background()
	if !restartParent {
		g.Run(ctx, nil)
		return 0
	}
	parent := os.Getppid()
	ctx, cancel := context.WithCancel(ctx)
	go func() {
		for range time.Tick(time.Second) {
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
