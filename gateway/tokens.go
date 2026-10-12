package main

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"slices"
	"strings"
	"time"

	"github.com/lestrrat-go/httprc/v3"
	"github.com/lestrrat-go/jwx/v3/jwa"
	"github.com/lestrrat-go/jwx/v3/jwk"
	"github.com/lestrrat-go/jwx/v3/jws"
	"github.com/lestrrat-go/jwx/v3/jwt"
)

// Signer mints Centrifugo connection and subscription tokens (ES256) and serves their JWKS.
type Signer struct {
	key             jwk.Key
	jwks            []byte
	kid             string
	audience        string
	issuer          string
	connectionTTL   time.Duration
	subscriptionTTL time.Duration
}

func NewSigner(c *Config) (*Signer, error) {
	raw := c.Signing.PrivateKey
	if raw == "" {
		b, err := os.ReadFile(c.Signing.PrivateKeyFile)
		if err != nil {
			return nil, err
		}
		raw = string(b)
	}
	var key jwk.Key
	var err error
	if strings.HasPrefix(strings.TrimSpace(raw), "-----BEGIN") {
		key, err = jwk.ParseKey([]byte(raw), jwk.WithPEM(true))
	} else {
		key, err = jwk.ParseKey([]byte(raw))
	}
	if err != nil {
		return nil, fmt.Errorf("signing key: %w", err)
	}
	var priv ecdsa.PrivateKey
	if err := jwk.Export(key, &priv); err != nil || priv.Curve != elliptic.P256() {
		return nil, errors.New("signing key must be an EC P-256 private key")
	}
	pub, err := key.PublicKey()
	if err != nil {
		return nil, err
	}
	kid, ok := key.KeyID()
	if !ok || kid == "" {
		tp, err := pub.Thumbprint(jwkSHA256)
		if err != nil {
			return nil, err
		}
		kid = b64url(tp)
	}
	_ = key.Set(jwk.KeyIDKey, kid)
	_ = pub.Set(jwk.KeyIDKey, kid)
	_ = pub.Set(jwk.AlgorithmKey, jwa.ES256())
	_ = pub.Set(jwk.KeyUsageKey, "sig")
	set := jwk.NewSet()
	_ = set.AddKey(pub)
	jwks, _ := json.Marshal(set)
	return &Signer{key: key, jwks: jwks, kid: kid, audience: c.Signing.Audience, issuer: c.Signing.Issuer,
		connectionTTL: c.Signing.ConnectionTTL.Duration, subscriptionTTL: c.Signing.SubscriptionTTL.Duration}, nil
}

func (s *Signer) sign(sub string, ttl time.Duration, claims map[string]any) (string, error) {
	now := time.Now()
	b := jwt.NewBuilder().Subject(sub).Audience([]string{s.audience}).Issuer(s.issuer).IssuedAt(now).Expiration(now.Add(ttl))
	for k, v := range claims {
		b = b.Claim(k, v)
	}
	tok, err := b.Build()
	if err != nil {
		return "", err
	}
	hdr := jws.NewHeaders()
	_ = hdr.Set(jws.KeyIDKey, s.kid)
	_ = hdr.Set(jws.TypeKey, "JWT")
	signed, err := jwt.Sign(tok, jwt.WithKey(jwa.ES256(), s.key, jws.WithProtectedHeaders(hdr)))
	return string(signed), err
}

func (s *Signer) Connection(sub string, info map[string]any) (string, error) {
	claims := map[string]any{}
	if info != nil {
		claims["info"] = info
	}
	return s.sign(sub, s.connectionTTL, claims)
}

func (s *Signer) Subscription(sub, channel string) (string, error) {
	return s.sign(sub, s.subscriptionTTL, map[string]any{"channel": channel})
}

// User is a signed-in browser user. Tenants are the tenants they may see; most users have one.
type User struct {
	ID      string
	Tenants []string
	Name    string
	Token   string
}

func (u *User) HasTenant(t string) bool { return slices.Contains(u.Tenants, t) }

// Users verifies the app's access tokens against the app's (or its IdP's) JWKS.
type Users struct {
	cfg   UsersConfig
	cache *jwk.Cache
}

func NewUsers(ctx context.Context, cfg UsersConfig) (*Users, error) {
	if cfg.JWKSURL == "" {
		return &Users{cfg: cfg}, nil
	}
	cache, err := jwk.NewCache(ctx, httprc.NewClient())
	if err != nil {
		return nil, err
	}
	// Register without waiting: the app may start after the gateway. The first request fetches the keys.
	if err := cache.Register(ctx, cfg.JWKSURL, jwk.WithWaitReady(false)); err != nil {
		return nil, err
	}
	return &Users{cfg: cfg, cache: cache}, nil
}

func (u *Users) FromRequest(r *http.Request) (*User, error) {
	if u.cache == nil {
		return nil, errors.New("users are not configured")
	}
	raw, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	if !ok || raw == "" {
		return nil, errors.New("missing bearer token")
	}
	set, err := u.cache.Lookup(r.Context(), u.cfg.JWKSURL)
	if err != nil {
		// Not fetched yet (the app may have started after the gateway): fetch now.
		if set, err = u.cache.Refresh(r.Context(), u.cfg.JWKSURL); err != nil {
			return nil, fmt.Errorf("fetching user JWKS: %w", err)
		}
	}
	opts := []jwt.ParseOption{jwt.WithKeySet(set, jws.WithInferAlgorithmFromKey(true)), jwt.WithValidate(true)}
	if u.cfg.Audience != "" {
		opts = append(opts, jwt.WithAudience(u.cfg.Audience))
	}
	if u.cfg.Issuer != "" {
		opts = append(opts, jwt.WithIssuer(u.cfg.Issuer))
	}
	tok, err := jwt.Parse([]byte(raw), opts...)
	if err != nil {
		return nil, err
	}
	sub, _ := tok.Subject()
	var tenants []string
	if u.cfg.Tenant != "" {
		tenants = []string{u.cfg.Tenant}
	}
	if v := claim(tok, u.cfg.TenantClaim); v != nil {
		if tenants, err = tenantList(v); err != nil {
			return nil, err
		}
	}
	name, _ := claim(tok, u.cfg.NameClaim).(string)
	if sub == "" || len(tenants) == 0 {
		return nil, errors.New("token has no user or tenant")
	}
	return &User{ID: sub, Tenants: tenants, Name: name, Token: raw}, nil
}

// tenantList reads a tenant claim: one tenant as a string, or several as a list of strings.
func tenantList(v any) ([]string, error) {
	switch v := v.(type) {
	case string:
		if v == "" {
			return nil, nil
		}
		return []string{v}, nil
	case []any:
		out := make([]string, 0, len(v))
		for _, x := range v {
			s, ok := x.(string)
			if !ok || s == "" {
				return nil, errors.New("tenant claim has an item that is not a tenant")
			}
			out = append(out, s)
		}
		return out, nil
	}
	return nil, errors.New("tenant claim is not a string or a list of strings")
}

// claim reads a claim by dotted path, for example "info.tenant".
func claim(tok jwt.Token, path string) any {
	if path == "" {
		return nil
	}
	parts := strings.Split(path, ".")
	var v any
	if err := tok.Get(parts[0], &v); err != nil {
		return nil
	}
	for _, p := range parts[1:] {
		m, ok := v.(map[string]any)
		if !ok {
			return nil
		}
		v = m[p]
	}
	return v
}
