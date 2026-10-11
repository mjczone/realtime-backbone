package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math/rand/v2"
	"net/http"
	"sync"
	"time"

	"github.com/mjczone/realtime-backbone/gateway/contract"
)

// Centrifugo codes worth retrying: internal (100), not available (108), too many requests (111).
var transientCodes = map[int]bool{100: true, 108: true, 111: true}

type PublishResult struct {
	ID     string `json:"id"`
	Offset uint64 `json:"offset,omitempty"`
	Epoch  string `json:"epoch,omitempty"`
	Err    error  `json:"-"`
}

type publishError struct {
	msg       string
	transient bool
}

func (e *publishError) Error() string { return e.msg }

type job struct {
	channel string
	env     contract.Envelope
	audit   map[string]any
	done    chan PublishResult
}

// Publisher sends envelopes to Centrifugo. Publishes to one channel go one at a time, in the order they were queued,
// so retries never reorder messages. Different channels publish concurrently.
type Publisher struct {
	apiURL, apiKey string
	http           *http.Client
	mu             sync.Mutex
	queues         map[string]chan *job
	attempts       int
	baseDelay      time.Duration
	maxDelay       time.Duration
	total          time.Duration
	send           func(ctx context.Context, channel string, body []byte, key string) (uint64, string, error)
}

func NewPublisher(apiURL, apiKey string) *Publisher {
	p := &Publisher{
		apiURL: apiURL, apiKey: apiKey,
		http:     &http.Client{Timeout: 10 * time.Second},
		queues:   map[string]chan *job{},
		attempts: 8, baseDelay: 100 * time.Millisecond, maxDelay: 5 * time.Second, total: 30 * time.Second,
	}
	p.send = p.sendHTTP
	return p
}

// Enqueue queues an envelope and returns a channel that gets the result. It never blocks on the network.
func (p *Publisher) Enqueue(channel string, env contract.Envelope, audit map[string]any) <-chan PublishResult {
	j := &job{channel: channel, env: env, audit: audit, done: make(chan PublishResult, 1)}
	p.mu.Lock()
	q, ok := p.queues[channel]
	if !ok {
		q = make(chan *job, 4096)
		p.queues[channel] = q
		go p.worker(channel, q)
	}
	q <- j
	p.mu.Unlock()
	return j.done
}

// Publish queues an envelope and waits for the result.
func (p *Publisher) Publish(channel string, env contract.Envelope, audit map[string]any) PublishResult {
	return <-p.Enqueue(channel, env, audit)
}

func (p *Publisher) worker(channel string, q chan *job) {
	for {
		select {
		case j := <-q:
			j.done <- p.run(j)
		case <-time.After(30 * time.Second):
			p.mu.Lock()
			if len(q) == 0 {
				delete(p.queues, channel)
				p.mu.Unlock()
				return
			}
			p.mu.Unlock()
		}
	}
}

func (p *Publisher) run(j *job) PublishResult {
	body, _ := json.Marshal(j.env)
	attempts := 0
	started := time.Now()
	var offset uint64
	var epoch string
	var err error
	for i := 0; ; i++ {
		attempts++
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		offset, epoch, err = p.send(ctx, j.channel, body, j.env.ID)
		cancel()
		if err == nil {
			break
		}
		var pe *publishError
		transient := !errors.As(err, &pe) || pe.transient
		delay := time.Duration(rand.Float64() * float64(min(p.maxDelay, p.baseDelay<<i)))
		if !transient || i+1 >= p.attempts || time.Since(started)+delay > p.total {
			break
		}
		time.Sleep(delay)
	}
	entry := map[string]any{"msg": "rtb.audit", "channel": j.channel, "type": j.env.Type, "tenant": j.env.Tenant, "id": j.env.ID, "attempts": attempts}
	for k, v := range j.audit {
		entry[k] = v
	}
	if err != nil {
		entry["outcome"], entry["reason"] = "failed", err.Error()
		audit(slog.LevelWarn, entry)
		return PublishResult{ID: j.env.ID, Err: err}
	}
	entry["outcome"] = "ok"
	audit(slog.LevelInfo, entry)
	return PublishResult{ID: j.env.ID, Offset: offset, Epoch: epoch}
}

func audit(level slog.Level, entry map[string]any) {
	args := make([]any, 0, len(entry)*2)
	for k, v := range entry {
		if k != "msg" {
			args = append(args, k, v)
		}
	}
	slog.Log(context.Background(), level, "rtb.audit", args...)
}

func (p *Publisher) sendHTTP(ctx context.Context, channel string, envelope []byte, key string) (uint64, string, error) {
	body, _ := json.Marshal(map[string]any{"channel": channel, "data": json.RawMessage(envelope), "idempotency_key": key})
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, p.apiURL+"/publish", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-API-Key", p.apiKey)
	res, err := p.http.Do(req)
	if err != nil {
		return 0, "", err
	}
	defer res.Body.Close()
	if res.StatusCode >= 400 {
		return 0, "", &publishError{fmt.Sprintf("HTTP %d from Centrifugo API", res.StatusCode), res.StatusCode >= 500 || res.StatusCode == 429}
	}
	var out struct {
		Result struct {
			Offset uint64 `json:"offset"`
			Epoch  string `json:"epoch"`
		} `json:"result"`
		Error *struct {
			Code    int    `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		return 0, "", err
	}
	if out.Error != nil {
		return 0, "", &publishError{fmt.Sprintf("Centrifugo error %d: %s", out.Error.Code, out.Error.Message), transientCodes[out.Error.Code]}
	}
	return out.Result.Offset, out.Result.Epoch, nil
}
