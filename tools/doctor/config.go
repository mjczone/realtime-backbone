package main

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
)

// Config is the effective Centrifugo config: the JSON file with CENTRIFUGO_* env vars on top,
// the same way Centrifugo resolves it.
type Config struct {
	raw map[string]any
	env func(string) (string, bool)
}

func LoadConfig(path string, env func(string) (string, bool)) (*Config, error) {
	c := &Config{raw: map[string]any{}, env: env}
	if path == "" {
		return c, nil
	}
	b, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return c, nil
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(b, &c.raw); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	return c, nil
}

func envName(path string) string {
	return "CENTRIFUGO_" + strings.ToUpper(strings.ReplaceAll(path, ".", "_"))
}

func (c *Config) fromFile(path string) (any, bool) {
	var cur any = c.raw
	for _, part := range strings.Split(path, ".") {
		m, ok := cur.(map[string]any)
		if !ok {
			return nil, false
		}
		cur, ok = m[part]
		if !ok {
			return nil, false
		}
	}
	return cur, true
}

func (c *Config) String(path string) string {
	if v, ok := c.env(envName(path)); ok {
		return v
	}
	v, _ := c.fromFile(path)
	s, _ := v.(string)
	return s
}

func (c *Config) Bool(path string) bool {
	if v, ok := c.env(envName(path)); ok {
		return v == "true" || v == "1"
	}
	v, _ := c.fromFile(path)
	b, _ := v.(bool)
	return b
}

// Strings reads a list. Centrifugo splits list env vars on spaces.
func (c *Config) Strings(path string) []string {
	if v, ok := c.env(envName(path)); ok {
		return strings.Fields(v)
	}
	v, _ := c.fromFile(path)
	switch t := v.(type) {
	case []any:
		var out []string
		for _, x := range t {
			if s, ok := x.(string); ok && s != "" {
				out = append(out, s)
			}
		}
		return out
	case string:
		return strings.Fields(t)
	}
	return nil
}
