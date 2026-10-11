package contract

import (
	"strings"
	"unicode/utf8"
)

const (
	InvalidChannel         = "invalid_channel"
	GlobalNotAllowed       = "global_not_allowed"
	NoTenantContext        = "no_tenant_context"
	TenantMismatch         = "tenant_mismatch"
	EnvelopeTenantMismatch = "envelope_tenant_mismatch"
)

// TenantContext is who is publishing.
type TenantContext struct {
	Tenant      string
	AllowGlobal bool
}

// CheckTenant returns "" when the publish is allowed, or the reason it is not. The order matches spec/channels.md.
func CheckTenant(ctx TenantContext, channel, envelopeTenant string) string {
	c, ok := ParseChannel(channel)
	if !ok {
		return InvalidChannel
	}
	if c.IsGlobal() {
		if !ctx.AllowGlobal {
			return GlobalNotAllowed
		}
	} else {
		if ctx.Tenant == "" {
			return NoTenantContext
		}
		if ctx.Tenant != c.Tenant {
			return TenantMismatch
		}
	}
	if envelopeTenant != c.Tenant {
		return EnvelopeTenantMismatch
	}
	return ""
}

const MaxEncodedIDLength = 128

func plain(b byte) bool {
	return b >= '0' && b <= '9' || b >= 'A' && b <= 'Z' || b >= 'a' && b <= 'z' || b == '-'
}

// EncodeID encodes any key as a channel ID, the same as every SDK (spec/channels.md).
func EncodeID(key string) (string, bool) {
	if key == "" || !utf8.ValidString(key) {
		return "", false
	}
	var sb strings.Builder
	for i := 0; i < len(key); i++ {
		b := key[i]
		if plain(b) {
			sb.WriteByte(b)
		} else {
			sb.WriteByte('_')
			sb.WriteString(strings.ToUpper(hex2(b)))
		}
	}
	if sb.Len() > MaxEncodedIDLength {
		return "", false
	}
	return sb.String(), true
}

// DecodeID is the reverse of EncodeID. It rejects anything EncodeID would not produce.
func DecodeID(id string) (string, bool) {
	if id == "" || len(id) > MaxEncodedIDLength {
		return "", false
	}
	out := make([]byte, 0, len(id))
	for i := 0; i < len(id); i++ {
		c := id[i]
		switch {
		case c == '_':
			if i+3 > len(id) {
				return "", false
			}
			h := id[i+1 : i+3]
			b, ok := unhex(h)
			if !ok || plain(b) {
				return "", false
			}
			out = append(out, b)
			i += 2
		case plain(c):
			out = append(out, c)
		default:
			return "", false
		}
	}
	if !utf8.ValidString(string(out)) {
		return "", false
	}
	return string(out), true
}

func hex2(b byte) string {
	const digits = "0123456789ABCDEF"
	return string([]byte{digits[b>>4], digits[b&15]})
}

func unhex(h string) (byte, bool) {
	var v byte
	for i := 0; i < 2; i++ {
		c := h[i]
		switch {
		case c >= '0' && c <= '9':
			v = v<<4 | (c - '0')
		case c >= 'A' && c <= 'F':
			v = v<<4 | (c - 'A' + 10)
		default:
			return 0, false
		}
	}
	return v, true
}
