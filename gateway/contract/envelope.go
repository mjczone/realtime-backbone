package contract

import (
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sync"
	"time"
)

const MaxEnvelopeBytes = 65536

var (
	ulidRe   = regexp.MustCompile(`^[0-9A-HJKMNP-TV-Z]{26}$`)
	typeRe   = regexp.MustCompile(`^[a-z][a-z0-9]*\.[A-Za-z0-9_.]+$`)
	sourceRe = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,128}$`)
	tsRe     = regexp.MustCompile(`^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?Z$`)
)

// Envelope is the JSON every publication carries.
type Envelope struct {
	V      int             `json:"v"`
	ID     string          `json:"id"`
	Type   string          `json:"type"`
	Tenant string          `json:"tenant"`
	Source string          `json:"source"`
	TS     string          `json:"ts"`
	Corr   string          `json:"corr,omitempty"`
	Data   json.RawMessage `json:"data"`
}

// NewEnvelope builds and validates an envelope. data must be a JSON object.
func NewEnvelope(typ, tenant, source string, data json.RawMessage, corr string) (Envelope, error) {
	env := Envelope{V: 1, ID: NewID(), Type: typ, Tenant: tenant, Source: source,
		TS: time.Now().UTC().Format("2006-01-02T15:04:05.000Z"), Corr: corr, Data: data}
	b, err := json.Marshal(env)
	if err != nil {
		return Envelope{}, err
	}
	var m any
	if err := json.Unmarshal(b, &m); err != nil {
		return Envelope{}, err
	}
	if problem := ValidateEnvelope(m); problem != "" {
		return Envelope{}, errors.New("invalid envelope: " + problem)
	}
	return env, nil
}

// ValidateEnvelope returns why the decoded JSON is not a valid envelope, or "" when it is. Unknown fields are ignored.
func ValidateEnvelope(x any) string {
	o, ok := x.(map[string]any)
	if !ok {
		return "not an object"
	}
	if v, ok := o["v"].(float64); !ok || v != 1 {
		return "v must be 1"
	}
	str := func(k string, re *regexp.Regexp) bool { s, ok := o[k].(string); return ok && re.MatchString(s) }
	if !str("id", ulidRe) {
		return "id must be a ULID"
	}
	if s, _ := o["type"].(string); !str("type", typeRe) || len(s) > 128 {
		return "type must be <family>.<name>"
	}
	if !str("tenant", tenantRe) {
		return "tenant is invalid"
	}
	if !str("source", sourceRe) {
		return "source is invalid"
	}
	if !str("ts", tsRe) {
		return "ts must be RFC 3339 UTC"
	}
	if c, present := o["corr"]; present {
		if s, ok := c.(string); !ok || len(s) < 1 || len(s) > 256 {
			return "corr must be a string of 1 to 256 characters"
		}
	}
	if _, ok := o["data"].(map[string]any); !ok {
		return "data must be an object"
	}
	return ""
}

const crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

var (
	ulidMu       sync.Mutex
	ulidLastTime uint64
	ulidLastRand [10]byte
)

// NewID returns a monotonic ULID: 48-bit millisecond time plus 80 random bits.
func NewID() string {
	ulidMu.Lock()
	now := uint64(time.Now().UnixMilli())
	if now <= ulidLastTime {
		now = ulidLastTime
		for i := 9; i >= 0; i-- {
			ulidLastRand[i]++
			if ulidLastRand[i] != 0 {
				break
			}
		}
	} else {
		ulidLastTime = now
		if _, err := rand.Read(ulidLastRand[:]); err != nil {
			panic(fmt.Sprintf("ulid: %v", err))
		}
	}
	var b [16]byte
	for i := 5; i >= 0; i-- {
		b[i] = byte(now)
		now >>= 8
	}
	copy(b[6:], ulidLastRand[:])
	ulidMu.Unlock()

	// 128 bits as 26 base32 characters, most significant first.
	var out [26]byte
	var acc uint64
	bits := 0
	idx := 25
	for i := 15; i >= 0; i-- {
		acc |= uint64(b[i]) << bits
		bits += 8
		for bits >= 5 && idx >= 0 {
			out[idx] = crockford[acc&31]
			acc >>= 5
			bits -= 5
			idx--
		}
	}
	if idx >= 0 {
		out[idx] = crockford[acc&31]
	}
	return string(out[:])
}
