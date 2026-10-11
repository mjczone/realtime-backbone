package main

import (
	"context"
	"encoding/json"
	"sync"
	"time"

	"github.com/redis/rueidis"
)

// Owner is who started a run, so only they can watch or cancel it.
type Owner struct {
	UserID string `json:"userId"`
	Tenant string `json:"tenant"`
}

// OwnerStore keeps run owners, and relays cancels between gateway copies.
type OwnerStore interface {
	Set(ctx context.Context, runID string, o Owner) error
	Get(ctx context.Context, runID string) (Owner, bool, error)
	PublishCancel(ctx context.Context, runID string) error
	OnCancel(func(runID string) bool)
}

const ownerTTL = time.Hour

// memoryOwners is for a single gateway copy.
type memoryOwners struct {
	mu     sync.Mutex
	owners map[string]memoryOwner
}

type memoryOwner struct {
	owner   Owner
	expires time.Time
}

func newMemoryOwners() *memoryOwners { return &memoryOwners{owners: map[string]memoryOwner{}} }

func (m *memoryOwners) Set(_ context.Context, runID string, o Owner) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	now := time.Now()
	for id, v := range m.owners {
		if v.expires.Before(now) {
			delete(m.owners, id)
		}
	}
	m.owners[runID] = memoryOwner{o, now.Add(ownerTTL)}
	return nil
}

func (m *memoryOwners) Get(_ context.Context, runID string) (Owner, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	v, ok := m.owners[runID]
	if !ok || v.expires.Before(time.Now()) {
		return Owner{}, false, nil
	}
	return v.owner, true, nil
}

func (m *memoryOwners) PublishCancel(context.Context, string) error { return nil }
func (m *memoryOwners) OnCancel(func(string) bool)                  {}

// valkeyOwners shares owners and cancels between gateway copies through Valkey.
type valkeyOwners struct {
	client rueidis.Client
}

const cancelChannel = "realtime-gateway:cancel"

func newValkeyOwners(address string) (*valkeyOwners, error) {
	opt, err := rueidis.ParseURL(address)
	if err != nil {
		return nil, err
	}
	opt.DisableCache = true
	client, err := rueidis.NewClient(opt)
	if err != nil {
		return nil, err
	}
	return &valkeyOwners{client: client}, nil
}

func (v *valkeyOwners) Set(ctx context.Context, runID string, o Owner) error {
	b, _ := json.Marshal(o)
	return v.client.Do(ctx, v.client.B().Set().Key("realtime-gateway:run:"+runID).Value(string(b)).Ex(ownerTTL).Build()).Error()
}

func (v *valkeyOwners) Get(ctx context.Context, runID string) (Owner, bool, error) {
	s, err := v.client.Do(ctx, v.client.B().Get().Key("realtime-gateway:run:"+runID).Build()).ToString()
	if rueidis.IsRedisNil(err) {
		return Owner{}, false, nil
	}
	if err != nil {
		return Owner{}, false, err
	}
	var o Owner
	return o, json.Unmarshal([]byte(s), &o) == nil, nil
}

func (v *valkeyOwners) PublishCancel(ctx context.Context, runID string) error {
	return v.client.Do(ctx, v.client.B().Publish().Channel(cancelChannel).Message(runID).Build()).Error()
}

func (v *valkeyOwners) OnCancel(fn func(string) bool) {
	go func() {
		for {
			_ = v.client.Receive(context.Background(), v.client.B().Subscribe().Channel(cancelChannel).Build(),
				func(m rueidis.PubSubMessage) { fn(m.Message) })
			time.Sleep(time.Second)
		}
	}()
}
