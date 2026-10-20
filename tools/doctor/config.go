package main

import (
	"encoding/json"
	"fmt"
	"os"
	"strconv"
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

// Int reads a number, or 0 if it is unset or not a number. An empty env var counts as unset.
func (c *Config) Int(path string) int {
	if v, ok := c.env(envName(path)); ok && v != "" {
		n, _ := strconv.Atoi(v)
		return n
	}
	v, _ := c.fromFile(path)
	f, _ := v.(float64)
	return int(f)
}

type Namespace struct {
	Name        string `json:"name"`
	HistorySize int    `json:"history_size"`
}

// Namespaces reads channel.namespaces the way Centrifugo does: CENTRIFUGO_CHANNEL_NAMESPACES replaces the file's
// list when it is a JSON array and adds names when it is space-separated, then
// CENTRIFUGO_CHANNEL_NAMESPACES_<NAME>_HISTORY_SIZE changes one namespace.
func (c *Config) Namespaces() ([]Namespace, error) {
	var out []Namespace
	if v, ok := c.fromFile("channel.namespaces"); ok {
		raw, _ := json.Marshal(v)
		if err := json.Unmarshal(raw, &out); err != nil {
			return nil, fmt.Errorf("channel.namespaces: %w", err)
		}
	}
	if v, ok := c.env("CENTRIFUGO_CHANNEL_NAMESPACES"); ok && v != "" {
		if strings.HasPrefix(v, "[") && strings.HasSuffix(v, "]") {
			out = nil
			if err := json.Unmarshal([]byte(v), &out); err != nil {
				return nil, fmt.Errorf("CENTRIFUGO_CHANNEL_NAMESPACES: %w", err)
			}
		} else {
			for _, name := range strings.Split(v, " ") {
				out = append(out, Namespace{Name: name})
			}
		}
	}
	for i, ns := range out {
		name := strings.ToUpper(strings.NewReplacer(".", "_", "-", "_").Replace(ns.Name))
		if v, ok := c.env("CENTRIFUGO_CHANNEL_NAMESPACES_" + name + "_HISTORY_SIZE"); ok && v != "" {
			n, err := strconv.Atoi(v)
			if err != nil {
				return nil, fmt.Errorf("CENTRIFUGO_CHANNEL_NAMESPACES_%s_HISTORY_SIZE: %w", name, err)
			}
			out[i].HistorySize = n
		}
	}
	return out, nil
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
