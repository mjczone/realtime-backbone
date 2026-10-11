package contract

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"testing"
)

func load(t *testing.T, name string, v any) {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "..", "spec", "vectors", name))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(b, v); err != nil {
		t.Fatal(err)
	}
}

func TestChannelVectors(t *testing.T) {
	var valid []struct {
		Name   string  `json:"name"`
		Parsed Channel `json:"parsed"`
	}
	load(t, "channels.valid.json", &valid)
	for _, v := range valid {
		c, ok := ParseChannel(v.Name)
		if !ok || c != v.Parsed {
			t.Errorf("%s: got %+v %v, want %+v", v.Name, c, ok, v.Parsed)
		}
	}
	var invalid []struct{ Name, Why string }
	load(t, "channels.invalid.json", &invalid)
	for _, v := range invalid {
		if _, ok := ParseChannel(v.Name); ok {
			t.Errorf("%s (%s): parsed", v.Name, v.Why)
		}
	}
}

func TestEnvelopeVectors(t *testing.T) {
	var valid, invalid []struct {
		Why      string `json:"why"`
		Envelope any    `json:"envelope"`
	}
	load(t, "envelopes.valid.json", &valid)
	load(t, "envelopes.invalid.json", &invalid)
	for _, v := range valid {
		if p := ValidateEnvelope(v.Envelope); p != "" {
			t.Errorf("%s: %s", v.Why, p)
		}
	}
	for _, v := range invalid {
		if ValidateEnvelope(v.Envelope) == "" {
			t.Errorf("%s: accepted", v.Why)
		}
	}
}

func TestGuardVectors(t *testing.T) {
	var vs []struct {
		Why     string `json:"why"`
		Context struct {
			Tenant      string `json:"tenant"`
			AllowGlobal bool   `json:"allowGlobal"`
		} `json:"context"`
		Channel        string `json:"channel"`
		EnvelopeTenant string `json:"envelopeTenant"`
		Allow          bool   `json:"allow"`
		Reason         string `json:"reason"`
	}
	load(t, "guard.json", &vs)
	for _, v := range vs {
		got := CheckTenant(TenantContext{v.Context.Tenant, v.Context.AllowGlobal}, v.Channel, v.EnvelopeTenant)
		if (got == "") != v.Allow || got != v.Reason {
			t.Errorf("%s: got %q", v.Why, got)
		}
	}
}

func TestIDVectors(t *testing.T) {
	var vs struct {
		Roundtrip    []struct{ Key, ID, Why string } `json:"roundtrip"`
		EncodeErrors []struct{ Key, Why string }     `json:"encodeErrors"`
		DecodeErrors []struct{ ID, Why string }      `json:"decodeErrors"`
	}
	load(t, "ids.json", &vs)
	for _, v := range vs.Roundtrip {
		if id, ok := EncodeID(v.Key); !ok || id != v.ID {
			t.Errorf("encode %s: got %q", v.Why, id)
		}
		if key, ok := DecodeID(v.ID); !ok || key != v.Key {
			t.Errorf("decode %s: got %q", v.Why, key)
		}
	}
	for _, v := range vs.EncodeErrors {
		if _, ok := EncodeID(v.Key); ok {
			t.Errorf("encode %s: accepted", v.Why)
		}
	}
	for _, v := range vs.DecodeErrors {
		if _, ok := DecodeID(v.ID); ok {
			t.Errorf("decode %s: accepted", v.Why)
		}
	}
}

func TestNewIDIsMonotonic(t *testing.T) {
	ids := make([]string, 5000)
	for i := range ids {
		ids[i] = NewID()
		if !ulidRe.MatchString(ids[i]) {
			t.Fatalf("bad ULID %q", ids[i])
		}
	}
	if !sort.StringsAreSorted(ids) {
		t.Fatal("not sorted")
	}
}

func TestNewEnvelope(t *testing.T) {
	e, err := NewEnvelope("job.progress", "acme", "w", json.RawMessage(`{"pct":1}`), "c1")
	if err != nil || e.Corr != "c1" || e.V != 1 {
		t.Fatalf("%+v %v", e, err)
	}
	if _, err := NewEnvelope("job.progress", "acme", "w", json.RawMessage(`[1]`), ""); err == nil {
		t.Fatal("array data accepted")
	}
}
