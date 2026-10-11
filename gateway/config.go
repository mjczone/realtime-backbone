package main

import (
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"strings"
	"time"
)

// Config is gateway.json. Any "${NAME}" in it is replaced by the environment variable NAME.
type Config struct {
	Listen     string `json:"listen"`
	Source     string `json:"source"`
	Centrifugo struct {
		APIURL string `json:"apiUrl"`
		APIKey string `json:"apiKey"`
	} `json:"centrifugo"`
	PublicBackboneURL string `json:"publicBackboneUrl"`
	// Valkey keeps run ownership so several gateway copies can share it. Empty keeps it in memory (one copy only).
	Valkey  string `json:"valkey"`
	Signing struct {
		PrivateKey      string   `json:"privateKey"`
		PrivateKeyFile  string   `json:"privateKeyFile"`
		Audience        string   `json:"audience"`
		Issuer          string   `json:"issuer"`
		ConnectionTTL   Duration `json:"connectionTtl"`
		SubscriptionTTL Duration `json:"subscriptionTtl"`
	} `json:"signing"`
	Clients []ClientConfig `json:"clients"`
	Users   UsersConfig    `json:"users"`
	// Channels a signed-in browser user may subscribe to without asking the app. {tenant} and {userId} are the
	// user's; * matches one segment. Run channels are allowed for their owner automatically.
	Subscribe []string               `json:"subscribe"`
	CORS      []string               `json:"cors"`
	Agents    map[string]AgentConfig `json:"agents"`
	Webhooks  struct {
		RunCreated  string            `json:"runCreated"`
		RunFinished string            `json:"runFinished"`
		Headers     map[string]string `json:"headers"`
	} `json:"webhooks"`
	ClientBundle string `json:"clientBundle"`
}

// ClientConfig is a server-side caller (an app, a worker) with its own key and scope.
type ClientConfig struct {
	ID          string   `json:"id"`
	Key         string   `json:"key"`
	Tenants     []string `json:"tenants"`
	AllowGlobal bool     `json:"allowGlobal"`
	Tokens      bool     `json:"tokens"`
}

// UsersConfig says how to recognize a signed-in browser user from their access token.
type UsersConfig struct {
	JWKSURL     string `json:"jwksUrl"`
	Audience    string `json:"audience"`
	Issuer      string `json:"issuer"`
	TenantClaim string `json:"tenantClaim"`
	Tenant      string `json:"tenant"`
	NameClaim   string `json:"nameClaim"`
}

// AgentConfig is an agent's existing AG-UI endpoint (RunAgentInput in, server-sent events out).
type AgentConfig struct {
	URL                  string            `json:"url"`
	Headers              map[string]string `json:"headers"`
	ForwardAuthorization bool              `json:"forwardAuthorization"`
	SkipTypes            []string          `json:"skipTypes"`
	NotifyUser           bool              `json:"notifyUser"`
	Timeout              Duration          `json:"timeout"`
	BatchInterval        Duration          `json:"batchInterval"`
}

type Duration struct{ time.Duration }

func (d *Duration) UnmarshalJSON(b []byte) error {
	var s string
	if err := json.Unmarshal(b, &s); err != nil {
		return err
	}
	v, err := time.ParseDuration(s)
	d.Duration = v
	return err
}

var envRef = regexp.MustCompile(`\$\{([A-Za-z_][A-Za-z0-9_]*)\}`)

func LoadConfig(path string) (*Config, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	expanded := envRef.ReplaceAllStringFunc(string(raw), func(m string) string {
		v, _ := json.Marshal(os.Getenv(m[2 : len(m)-1]))
		return strings.Trim(string(v), `"`)
	})
	c := &Config{Listen: ":8090", Source: "rtb-gateway"}
	if err := json.Unmarshal([]byte(expanded), c); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	if c.Signing.ConnectionTTL.Duration == 0 {
		c.Signing.ConnectionTTL.Duration = 10 * time.Minute
	}
	if c.Signing.SubscriptionTTL.Duration == 0 {
		c.Signing.SubscriptionTTL.Duration = 10 * time.Minute
	}
	for name, a := range c.Agents {
		if a.Timeout.Duration == 0 {
			a.Timeout.Duration = 15 * time.Minute
		}
		if a.BatchInterval.Duration == 0 {
			a.BatchInterval.Duration = 75 * time.Millisecond
		}
		for _, t := range a.SkipTypes {
			if requiredEventTypes[t] {
				return nil, fmt.Errorf("agent %s: event type %s can't be skipped", name, t)
			}
		}
		c.Agents[name] = a
	}
	for _, cl := range c.Clients {
		if cl.ID == "" || cl.Key == "" {
			return nil, fmt.Errorf("every client needs an id and a key")
		}
	}
	return c, c.validate()
}

func (c *Config) validate() error {
	switch {
	case c.Centrifugo.APIURL == "" || c.Centrifugo.APIKey == "":
		return fmt.Errorf("centrifugo.apiUrl and centrifugo.apiKey are required")
	case c.Signing.PrivateKey == "" && c.Signing.PrivateKeyFile == "":
		return fmt.Errorf("signing.privateKey or signing.privateKeyFile is required")
	case c.Signing.Audience == "" || c.Signing.Issuer == "":
		return fmt.Errorf("signing.audience and signing.issuer are required")
	case len(c.Agents) > 0 && c.Users.JWKSURL == "":
		return fmt.Errorf("users.jwksUrl is required when agents are configured")
	}
	return nil
}

// allows reports whether the client may publish to or mint tokens for a tenant.
func (cl ClientConfig) allows(tenant string) bool {
	for _, t := range cl.Tenants {
		if t == "*" || t == tenant {
			return true
		}
	}
	return false
}

// subscribeRule turns "live:t-{tenant}.jobs.*" into a matcher for one user.
func subscribeRule(pattern, tenant, userID string) *regexp.Regexp {
	var b strings.Builder
	b.WriteString("^")
	for i := 0; i < len(pattern); {
		switch {
		case strings.HasPrefix(pattern[i:], "{tenant}"):
			b.WriteString(regexp.QuoteMeta(tenant))
			i += len("{tenant}")
		case strings.HasPrefix(pattern[i:], "{userId}"):
			b.WriteString(regexp.QuoteMeta(userID))
			i += len("{userId}")
		case pattern[i] == '*':
			b.WriteString(`[A-Za-z0-9_-]+`)
			i++
		default:
			b.WriteString(regexp.QuoteMeta(pattern[i : i+1]))
			i++
		}
	}
	b.WriteString("$")
	return regexp.MustCompile(b.String())
}
