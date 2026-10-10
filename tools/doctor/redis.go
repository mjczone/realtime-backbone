package main

import (
	"crypto/tls"
	"errors"
	"fmt"
	"net"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/redis/rueidis"
)

// Target is one Redis or Valkey endpoint the backbone will use.
type Target struct {
	Label    string
	Option   rueidis.ClientOption
	Sentinel bool
	Cluster  bool
}

// Targets builds one Target per configured engine address, following Centrifugo's address rules.
func Targets(c *Config) ([]Target, error) {
	base := rueidis.ClientOption{
		Username:         c.String("engine.redis.user"),
		Password:         c.String("engine.redis.password"),
		DisableCache:     true,
		ConnWriteTimeout: 3 * time.Second,
		Dialer:           net.Dialer{Timeout: 3 * time.Second},
		DisableRetry:     true,
	}
	if c.Bool("engine.redis.tls.enabled") {
		base.TLSConfig = &tls.Config{MinVersion: tls.VersionTLS12}
	}

	if sentinels := c.Strings("engine.redis.sentinel_address"); len(sentinels) > 0 {
		o := base
		o.InitAddress = sentinels
		o.Sentinel = rueidis.SentinelOption{
			MasterSet: c.String("engine.redis.sentinel_master_name"),
			Username:  c.String("engine.redis.sentinel_user"),
			Password:  c.String("engine.redis.sentinel_password"),
		}
		if o.Sentinel.MasterSet == "" {
			return nil, errors.New("engine.redis.sentinel_master_name is required with sentinel_address")
		}
		return []Target{{Label: "sentinel " + strings.Join(sentinels, ","), Option: o, Sentinel: true}}, nil
	}
	if cluster := c.Strings("engine.redis.cluster_address"); len(cluster) > 0 {
		o := base
		o.InitAddress = cluster
		return []Target{{Label: "cluster " + strings.Join(cluster, ","), Option: o, Cluster: true}}, nil
	}

	addrs := c.Strings("engine.redis.address")
	if len(addrs) == 0 {
		addrs = []string{"redis://127.0.0.1:6379"}
	}
	var out []Target
	for _, a := range addrs {
		t, err := parseAddress(a, base)
		if err != nil {
			return nil, fmt.Errorf("engine.redis.address %q: %w", redact(a), err)
		}
		out = append(out, t)
	}
	return out, nil
}

func parseAddress(address string, o rueidis.ClientOption) (Target, error) {
	t := Target{Label: redact(address)}
	if !strings.Contains(address, "://") {
		if _, _, err := net.SplitHostPort(address); err != nil {
			return t, errors.New("must be a Redis URL or host:port")
		}
		o.InitAddress = []string{address}
		t.Option = o
		return t, nil
	}
	u, err := url.Parse(address)
	if err != nil {
		return t, errors.New("not a valid URL")
	}
	q := u.Query()
	switch u.Scheme {
	case "redis", "tcp", "rediss", "redis+sentinel", "rediss+sentinel", "redis+cluster":
	default:
		return t, fmt.Errorf("unsupported scheme %q", u.Scheme)
	}
	o.InitAddress = append([]string{u.Host}, q["addr"]...)
	if p := strings.TrimPrefix(u.Path, "/"); p != "" {
		db, err := strconv.Atoi(p)
		if err != nil {
			return t, fmt.Errorf("bad DB number %q", p)
		}
		o.SelectDB = db
	}
	if u.User != nil {
		if u.User.Username() != "" {
			o.Username = u.User.Username()
		}
		if p, ok := u.User.Password(); ok {
			o.Password = p
		}
	}
	tlsOn := strings.HasPrefix(u.Scheme, "rediss") || q.Get("tls_enabled") == "true"
	if tlsOn && o.TLSConfig == nil {
		o.TLSConfig = &tls.Config{MinVersion: tls.VersionTLS12}
	}
	t.Sentinel = strings.Contains(u.Scheme, "sentinel") || q.Has("sentinel_master_name")
	t.Cluster = u.Scheme == "redis+cluster"
	if t.Sentinel {
		o.Sentinel = rueidis.SentinelOption{
			MasterSet: q.Get("sentinel_master_name"),
			Username:  q.Get("sentinel_user"),
			Password:  q.Get("sentinel_password"),
		}
		if o.Sentinel.MasterSet == "" {
			return t, errors.New("sentinel_master_name is required for Sentinel")
		}
		if tlsOn || q.Get("sentinel_tls_enabled") == "true" {
			o.Sentinel.TLSConfig = &tls.Config{MinVersion: tls.VersionTLS12}
		}
	}
	t.Option = o
	return t, nil
}

func redact(address string) string {
	u, err := url.Parse(address)
	if err != nil || u.User == nil {
		return address
	}
	if _, ok := u.User.Password(); ok {
		u.User = url.UserPassword(u.User.Username(), "xxxxx")
	}
	return u.String()
}
