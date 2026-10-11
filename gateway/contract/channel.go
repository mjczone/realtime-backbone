// Package contract is the Go port of the channel grammar, envelope and tenant guard in spec/.
// It passes the same vectors as the TypeScript, .NET and Python SDKs.
package contract

import (
	"regexp"
	"strings"
)

const MaxChannelLength = 255

var (
	segmentRe = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)
	tenantRe  = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
	userIDRe  = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)
	reserved  = map[string]bool{"all": true, "grp": true, "user": true, "run": true}
	tiers     = map[string]bool{"live": true, "replay": true, "presence": true}
)

// Channel is a parsed channel name. Tenant is "global" for global channels.
type Channel struct {
	Tier   string `json:"tier"`
	Tenant string `json:"tenant"`
	Topic  string `json:"topic"`
	ID     string `json:"id,omitempty"`
	UserID string `json:"userId,omitempty"`
}

func (c Channel) IsGlobal() bool { return c.Tenant == "global" }

func ValidTenant(t string) bool { return tenantRe.MatchString(t) && t != "global" }

func ValidUserID(u string) bool { return userIDRe.MatchString(u) }

func segments(s string) ([]string, bool) {
	parts := strings.Split(s, ".")
	if len(parts) > 2 {
		return nil, false
	}
	for _, p := range parts {
		if !segmentRe.MatchString(p) {
			return nil, false
		}
	}
	return parts, true
}

// ParseChannel returns the parsed channel and true, or false when the name is not valid.
func ParseChannel(name string) (Channel, bool) {
	if len(name) > MaxChannelLength {
		return Channel{}, false
	}
	tier, rest, ok := strings.Cut(name, ":")
	if !ok || !tiers[tier] {
		return Channel{}, false
	}
	if g, ok := strings.CutPrefix(rest, "global."); ok {
		parts, ok := segments(g)
		if tier == "presence" || !ok || reserved[parts[0]] {
			return Channel{}, false
		}
		c := Channel{Tier: tier, Tenant: "global", Topic: parts[0]}
		if len(parts) == 2 {
			c.ID = parts[1]
		}
		return c, true
	}
	t, ok := strings.CutPrefix(rest, "t-")
	if !ok {
		return Channel{}, false
	}
	tenant, tail, ok := strings.Cut(t, ".")
	if !ok || !ValidTenant(tenant) {
		return Channel{}, false
	}
	if u, ok := strings.CutPrefix(tail, "user#"); ok {
		if tier == "presence" || !ValidUserID(u) {
			return Channel{}, false
		}
		return Channel{Tier: tier, Tenant: tenant, Topic: "user", UserID: u}, true
	}
	parts, ok := segments(tail)
	if !ok {
		return Channel{}, false
	}
	c := Channel{Tier: tier, Tenant: tenant, Topic: parts[0]}
	if len(parts) == 2 {
		c.ID = parts[1]
	}
	switch c.Topic {
	case "all":
		if c.ID != "" || tier == "presence" {
			return Channel{}, false
		}
	case "grp", "run":
		if c.ID == "" {
			return Channel{}, false
		}
	case "user":
		return Channel{}, false
	}
	return c, true
}

// RunChannel builds replay:t-<tenant>.run.<runID>.
func RunChannel(tenant, runID string) (string, bool) {
	name := "replay:t-" + tenant + ".run." + runID
	c, ok := ParseChannel(name)
	return name, ok && c.Tenant == tenant && c.ID == runID
}

// UserChannel builds <tier>:t-<tenant>.user#<userID>.
func UserChannel(tier, tenant, userID string) (string, bool) {
	name := tier + ":t-" + tenant + ".user#" + userID
	c, ok := ParseChannel(name)
	return name, ok && c.Tenant == tenant && c.UserID == userID
}
