package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/mjczone/realtime-backbone/gateway/contract"
)

type Event = map[string]any

// Events a run can't work without; agents may not skip them (the same list as the SDKs).
var requiredEventTypes = map[string]bool{
	"RUN_FINISHED": true, "RUN_ERROR": true,
	"TEXT_MESSAGE_START": true, "TEXT_MESSAGE_CONTENT": true, "TEXT_MESSAGE_END": true, "TEXT_MESSAGE_CHUNK": true,
	"TOOL_CALL_START": true, "TOOL_CALL_ARGS": true, "TOOL_CALL_END": true, "TOOL_CALL_RESULT": true, "TOOL_CALL_CHUNK": true,
}

const envelopeOverhead = 1024

// RunRef is what the run endpoint returns with 202.
type RunRef struct {
	RunID    string `json:"runId"`
	ThreadID string `json:"threadId"`
	Channel  string `json:"channel"`
	Offset   uint64 `json:"offset"`
	Epoch    string `json:"epoch"`
	Token    string `json:"token,omitempty"`
}

type Runner struct {
	cfg       *Config
	pub       *Publisher
	signer    *Signer
	owners    OwnerStore
	http      *http.Client
	mu        sync.Mutex
	active    map[string]context.CancelFunc
	webhookTo *http.Client
}

func NewRunner(cfg *Config, pub *Publisher, signer *Signer, owners OwnerStore) *Runner {
	r := &Runner{cfg: cfg, pub: pub, signer: signer, owners: owners, http: &http.Client{},
		active: map[string]context.CancelFunc{}, webhookTo: &http.Client{Timeout: 10 * time.Second}}
	owners.OnCancel(r.cancelLocal)
	return r
}

type startError struct {
	status int
	msg    string
}

func (e *startError) Error() string { return e.msg }

// Start begins a run: it records the owner, publishes RUN_STARTED, and drives the agent in the background.
func (r *Runner) Start(ctx context.Context, agentName string, agent AgentConfig, user *User, input Event) (*RunRef, error) {
	if msgs, ok := input["messages"]; ok {
		if _, isList := msgs.([]any); !isList {
			return nil, &startError{http.StatusBadRequest, "messages must be a list"}
		}
	}
	runID := contract.NewID()
	threadID, _ := input["threadId"].(string)
	if threadID == "" {
		threadID = contract.NewID()
	}
	channel, ok := contract.RunChannel(user.Tenant, runID)
	if !ok {
		return nil, &startError{http.StatusBadRequest, "invalid tenant"}
	}
	full := Event{"messages": []any{}, "tools": []any{}, "context": []any{}, "state": map[string]any{}, "forwardedProps": map[string]any{}}
	for k, v := range input {
		full[k] = v
	}
	full["threadId"], full["runId"] = threadID, runID

	if r.cfg.Webhooks.RunCreated != "" {
		status, err := r.webhook(ctx, r.cfg.Webhooks.RunCreated, runID, map[string]any{
			"runId": runID, "threadId": threadID, "userId": user.ID, "tenant": user.Tenant, "agent": agentName, "messages": full["messages"],
		})
		if err != nil {
			return nil, &startError{http.StatusBadGateway, "runCreated webhook: " + err.Error()}
		}
		if status >= 300 {
			return nil, &startError{http.StatusForbidden, fmt.Sprintf("the app refused the run (HTTP %d)", status)}
		}
	}
	if err := r.owners.Set(ctx, runID, Owner{UserID: user.ID, Tenant: user.Tenant}); err != nil {
		return nil, &startError{http.StatusServiceUnavailable, "storing the run owner: " + err.Error()}
	}
	auditFields := map[string]any{"component": "gateway:" + agentName}
	started := r.publish(channel, user.Tenant, runID, Event{"type": "RUN_STARTED", "threadId": threadID, "runId": runID}, auditFields)
	res := <-started
	if res.Err != nil {
		return nil, &startError{http.StatusBadGateway, "publishing RUN_STARTED: " + res.Err.Error()}
	}
	ref := &RunRef{RunID: runID, ThreadID: threadID, Channel: channel, Offset: res.Offset, Epoch: res.Epoch}
	if agent.NotifyUser {
		if userCh, ok := contract.UserChannel("live", user.Tenant, user.ID); ok {
			data, _ := json.Marshal(ref)
			if env, err := contract.NewEnvelope("notice.run_started", user.Tenant, r.cfg.Source, data, ""); err == nil {
				r.pub.Enqueue(userCh, env, auditFields)
			}
		}
	}

	runCtx, cancel := context.WithTimeout(context.Background(), agent.Timeout.Duration)
	r.mu.Lock()
	r.active[runID] = cancel
	r.mu.Unlock()
	go func() {
		defer func() {
			r.mu.Lock()
			delete(r.active, runID)
			r.mu.Unlock()
			cancel()
		}()
		published := r.drive(runCtx, agent, user, channel, runID, full, auditFields)
		if r.cfg.Webhooks.RunFinished != "" {
			_, err := r.webhook(context.Background(), r.cfg.Webhooks.RunFinished, runID, map[string]any{
				"runId": runID, "threadId": threadID, "userId": user.ID, "tenant": user.Tenant, "agent": agentName,
				"events": published, "messages": messagesFromEvents(published),
			})
			if err != nil {
				slog.Warn("runFinished webhook failed", "runId", runID, "error", err)
			}
		}
	}()

	token, err := r.signer.Subscription(user.ID, channel)
	if err != nil {
		return nil, err
	}
	ref.Token = token
	return ref, nil
}

// Cancel stops a run the user owns, on whichever gateway copy is driving it.
func (r *Runner) Cancel(ctx context.Context, runID string, user *User) error {
	owner, ok, err := r.owners.Get(ctx, runID)
	if err != nil {
		return err
	}
	if !ok || owner.UserID != user.ID || owner.Tenant != user.Tenant {
		return errNoRun
	}
	if r.cancelLocal(runID) {
		return nil
	}
	return r.owners.PublishCancel(ctx, runID)
}

var errNoRun = errors.New("no such run")

func (r *Runner) cancelLocal(runID string) bool {
	r.mu.Lock()
	cancel, ok := r.active[runID]
	r.mu.Unlock()
	if ok {
		cancel()
	}
	return ok
}

func (r *Runner) publish(channel, tenant, runID string, e Event, audit map[string]any) <-chan PublishResult {
	data, _ := json.Marshal(e)
	typ, _ := e["type"].(string)
	env, err := contract.NewEnvelope("agui."+typ, tenant, r.cfg.Source, data, runID)
	if err != nil {
		ch := make(chan PublishResult, 1)
		ch <- PublishResult{Err: err}
		return ch
	}
	return r.pub.Enqueue(channel, env, audit)
}

// drive streams the agent's AG-UI events to the run channel and returns what was published.
func (r *Runner) drive(ctx context.Context, agent AgentConfig, user *User, channel, runID string, input Event, audit map[string]any) []Event {
	var (
		mu        sync.Mutex
		published []Event
		pending   []<-chan PublishResult
		ended     bool
	)
	skip := map[string]bool{}
	for _, t := range agent.SkipTypes {
		skip[t] = true
	}
	send := func(e Event) {
		raw, _ := json.Marshal(e)
		if len(raw)+envelopeOverhead > contract.MaxEnvelopeBytes {
			e = Event{"type": "CUSTOM", "name": "rtb.oversize", "value": map[string]any{"type": e["type"], "bytes": len(raw)}}
		}
		if t := e["type"]; t == "RUN_FINISHED" || t == "RUN_ERROR" {
			ended = true
		}
		published = append(published, e)
		pending = append(pending, r.publish(channel, user.Tenant, runID, e, audit))
	}
	batcher := newBatcher(agent.BatchInterval.Duration, &mu, send)
	chunks := &chunkNormalizer{}

	err := r.stream(ctx, agent, user, input, func(e Event) {
		if e["type"] == "RUN_STARTED" {
			return
		}
		for _, out := range chunks.feed(e) {
			if t, _ := out["type"].(string); !skip[t] {
				batcher.push(out)
			}
		}
	})
	for _, out := range chunks.close() {
		batcher.push(out)
	}
	batcher.flush()

	mu.Lock()
	switch {
	case ended:
	case errors.Is(ctx.Err(), context.Canceled):
		send(Event{"type": "RUN_ERROR", "message": "Run cancelled", "code": "rtb.cancelled"})
	case err != nil:
		send(Event{"type": "RUN_ERROR", "message": err.Error(), "code": "rtb.agent_error"})
	default:
		send(Event{"type": "RUN_ERROR", "message": "the agent's stream ended without RUN_FINISHED", "code": "rtb.agent_error"})
	}
	waits := pending
	out := published
	mu.Unlock()
	for _, w := range waits {
		<-w
	}
	return out
}

// stream POSTs the input to the agent's AG-UI endpoint and calls onEvent for each server-sent event.
func (r *Runner) stream(ctx context.Context, agent AgentConfig, user *User, input Event, onEvent func(Event)) error {
	body, _ := json.Marshal(input)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, agent.URL, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "text/event-stream")
	for k, v := range agent.Headers {
		req.Header.Set(k, v)
	}
	if agent.ForwardAuthorization {
		req.Header.Set("Authorization", "Bearer "+user.Token)
	}
	res, err := r.http.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode >= 300 {
		msg, _ := io.ReadAll(io.LimitReader(res.Body, 512))
		return fmt.Errorf("agent returned HTTP %d: %s", res.StatusCode, strings.TrimSpace(string(msg)))
	}
	return readSSE(res.Body, func(data []byte) error {
		var e Event
		if err := json.Unmarshal(data, &e); err != nil {
			return fmt.Errorf("agent sent an event that is not JSON: %w", err)
		}
		if _, ok := e["type"].(string); ok {
			onEvent(e)
		}
		return nil
	})
}

// readSSE calls onData with each event's data (data lines joined by newlines).
func readSSE(body io.Reader, onData func([]byte) error) error {
	sc := bufio.NewScanner(body)
	sc.Buffer(make([]byte, 64*1024), 16*1024*1024)
	var data [][]byte
	dispatch := func() error {
		if len(data) == 0 {
			return nil
		}
		joined := bytes.Join(data, []byte("\n"))
		data = nil
		return onData(joined)
	}
	for sc.Scan() {
		line := sc.Bytes()
		switch {
		case len(line) == 0:
			if err := dispatch(); err != nil {
				return err
			}
		case bytes.HasPrefix(line, []byte("data:")):
			v := bytes.TrimPrefix(line, []byte("data:"))
			v = bytes.TrimPrefix(v, []byte(" "))
			data = append(data, append([]byte(nil), v...))
		}
	}
	if err := sc.Err(); err != nil {
		return err
	}
	return dispatch()
}

func (r *Runner) webhook(ctx context.Context, url, runID string, payload any) (int, error) {
	body, _ := json.Marshal(payload)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.ReplaceAll(url, "{runId}", runID), bytes.NewReader(body))
	if err != nil {
		return 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	for k, v := range r.cfg.Webhooks.Headers {
		req.Header.Set(k, v)
	}
	res, err := r.webhookTo.Do(req)
	if err != nil {
		return 0, err
	}
	res.Body.Close()
	return res.StatusCode, nil
}

// chunkNormalizer turns TEXT_MESSAGE_CHUNK events into TEXT_MESSAGE_START, TEXT_MESSAGE_CONTENT and TEXT_MESSAGE_END.
type chunkNormalizer struct{ open string }

func (c *chunkNormalizer) feed(e Event) []Event {
	if e["type"] != "TEXT_MESSAGE_CHUNK" {
		return append(c.close(), e)
	}
	id, _ := e["messageId"].(string)
	if id == "" {
		id = c.open
	}
	var out []Event
	if id != c.open {
		out = append(out, c.close()...)
		role, _ := e["role"].(string)
		if role == "" {
			role = "assistant"
		}
		out = append(out, Event{"type": "TEXT_MESSAGE_START", "messageId": id, "role": role})
		c.open = id
	}
	if d, _ := e["delta"].(string); d != "" {
		out = append(out, Event{"type": "TEXT_MESSAGE_CONTENT", "messageId": id, "delta": d})
	}
	return out
}

func (c *chunkNormalizer) close() []Event {
	if c.open == "" {
		return nil
	}
	e := Event{"type": "TEXT_MESSAGE_END", "messageId": c.open}
	c.open = ""
	return []Event{e}
}

// batcher joins consecutive TEXT_MESSAGE_CONTENT deltas for one message, and TOOL_CALL_ARGS deltas for one tool call.
// Any other event flushes first, so order is kept. emit runs under mu, in order.
type batcher struct {
	interval time.Duration
	mu       *sync.Mutex
	emit     func(Event)
	key      string
	first    Event
	parts    []string
	bytes    int
	timer    *time.Timer
}

func newBatcher(interval time.Duration, mu *sync.Mutex, emit func(Event)) *batcher {
	return &batcher{interval: interval, mu: mu, emit: emit}
}

func batchKey(e Event) string {
	switch e["type"] {
	case "TEXT_MESSAGE_CONTENT":
		if id, _ := e["messageId"].(string); id != "" {
			return "text:" + id
		}
	case "TOOL_CALL_ARGS":
		if id, _ := e["toolCallId"].(string); id != "" {
			return "args:" + id
		}
	}
	return ""
}

func (b *batcher) push(e Event) {
	b.mu.Lock()
	defer b.mu.Unlock()
	key := batchKey(e)
	if key == "" {
		b.flushLocked()
		b.emit(e)
		return
	}
	if b.key != "" && b.key != key {
		b.flushLocked()
	}
	delta, _ := e["delta"].(string)
	if b.key == "" {
		b.key, b.first = key, e
		b.timer = time.AfterFunc(b.interval, b.flush)
	}
	b.parts = append(b.parts, delta)
	b.bytes += len(delta)
	if b.bytes >= 32768 {
		b.flushLocked()
	}
}

func (b *batcher) flush() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.flushLocked()
}

func (b *batcher) flushLocked() {
	if b.timer != nil {
		b.timer.Stop()
		b.timer = nil
	}
	if b.key == "" {
		return
	}
	e := Event{}
	for k, v := range b.first {
		e[k] = v
	}
	e["delta"] = strings.Join(b.parts, "")
	b.key, b.first, b.parts, b.bytes = "", nil, nil, 0
	b.emit(e)
}

// messagesFromEvents turns a run's AG-UI events into AG-UI messages, for the runFinished webhook.
func messagesFromEvents(events []Event) []Event {
	var out []Event
	byID := map[string]Event{}
	calls := map[string]Event{}
	for _, e := range events {
		switch e["type"] {
		case "TEXT_MESSAGE_START":
			id, _ := e["messageId"].(string)
			m := Event{"id": id, "role": "assistant", "content": ""}
			byID[id] = m
			out = append(out, m)
		case "TEXT_MESSAGE_CONTENT":
			if m, ok := byID[str(e["messageId"])]; ok {
				m["content"] = str(m["content"]) + str(e["delta"])
			}
		case "TOOL_CALL_START":
			parentID := str(e["parentMessageId"])
			if parentID == "" {
				parentID = str(e["toolCallId"])
			}
			parent, ok := byID[parentID]
			if !ok {
				parent = Event{"id": parentID, "role": "assistant"}
				byID[parentID] = parent
				out = append(out, parent)
			}
			call := Event{"id": e["toolCallId"], "type": "function", "function": Event{"name": e["toolCallName"], "arguments": ""}}
			list, _ := parent["toolCalls"].([]any)
			parent["toolCalls"] = append(list, call)
			calls[str(e["toolCallId"])] = call
		case "TOOL_CALL_ARGS":
			if call, ok := calls[str(e["toolCallId"])]; ok {
				fn := call["function"].(Event)
				fn["arguments"] = str(fn["arguments"]) + str(e["delta"])
			}
		case "TOOL_CALL_RESULT":
			out = append(out, Event{"id": e["messageId"], "role": "tool", "toolCallId": e["toolCallId"], "content": e["content"]})
		}
	}
	return out
}

func str(v any) string { s, _ := v.(string); return s }
