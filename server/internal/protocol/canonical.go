package protocol

import (
	"encoding/json"
	"math"
	"sort"
	"strconv"
	"strings"
	"unicode/utf16"
)

// StableStringify serializes a decoded JSON value the way the plugin's
// `stableStringify` does: object keys sorted at every level, JavaScript number
// formatting, and JSON.stringify string escaping.
func StableStringify(value any) string {
	var b strings.Builder
	b.Grow(256)
	writeStable(&b, value)
	return b.String()
}

// CanonicalBytes returns the exact bytes a signer signed: the envelope without
// its `signature` member, canonicalized.
func CanonicalBytes(envelope map[string]any) []byte {
	rest := make(map[string]any, len(envelope))
	for k, v := range envelope {
		if k == "signature" {
			continue
		}
		rest[k] = v
	}
	return []byte(StableStringify(rest))
}

func writeStable(b *strings.Builder, v any) {
	switch x := v.(type) {
	case nil:
		b.WriteString("null")
	case bool:
		if x {
			b.WriteString("true")
		} else {
			b.WriteString("false")
		}
	case string:
		writeJSONString(b, x)
	case json.Number:
		f, err := x.Float64()
		if err != nil {
			b.WriteString("null")
			return
		}
		b.WriteString(FormatJSNumber(f))
	case float64:
		b.WriteString(FormatJSNumber(x))
	case float32:
		b.WriteString(FormatJSNumber(float64(x)))
	case int:
		b.WriteString(strconv.Itoa(x))
	case int32:
		b.WriteString(strconv.FormatInt(int64(x), 10))
	case int64:
		b.WriteString(strconv.FormatInt(x, 10))
	case uint64:
		b.WriteString(strconv.FormatUint(x, 10))
	case []any:
		b.WriteByte('[')
		for i, item := range x {
			if i > 0 {
				b.WriteByte(',')
			}
			writeStable(b, item)
		}
		b.WriteByte(']')
	case []string:
		b.WriteByte('[')
		for i, item := range x {
			if i > 0 {
				b.WriteByte(',')
			}
			writeJSONString(b, item)
		}
		b.WriteByte(']')
	case map[string]any:
		keys := make([]string, 0, len(x))
		for k := range x {
			keys = append(keys, k)
		}
		sort.Slice(keys, func(i, j int) bool { return utf16Less(keys[i], keys[j]) })
		b.WriteByte('{')
		for i, k := range keys {
			if i > 0 {
				b.WriteByte(',')
			}
			writeJSONString(b, k)
			b.WriteByte(':')
			writeStable(b, x[k])
		}
		b.WriteByte('}')
	default:
		raw, err := json.Marshal(v)
		if err != nil {
			b.WriteString("null")
			return
		}
		b.Write(raw)
	}
}

// writeJSONString mirrors JSON.stringify's string quoting: only `"`, `\` and
// control characters are escaped, everything else is emitted as UTF-8.
func writeJSONString(b *strings.Builder, s string) {
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\b':
			b.WriteString(`\b`)
		case '\f':
			b.WriteString(`\f`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		default:
			if r < 0x20 {
				b.WriteString(`\u00`)
				b.WriteByte(hexDigit(byte(r) >> 4))
				b.WriteByte(hexDigit(byte(r) & 0x0f))
				continue
			}
			b.WriteRune(r)
		}
	}
	b.WriteByte('"')
}

func hexDigit(v byte) byte {
	if v < 10 {
		return '0' + v
	}
	return 'a' + (v - 10)
}

// utf16Less compares strings by UTF-16 code units, matching JavaScript's
// default Array.prototype.sort on object keys.
func utf16Less(a, b string) bool {
	ua := utf16.Encode([]rune(a))
	ub := utf16.Encode([]rune(b))
	n := len(ua)
	if len(ub) < n {
		n = len(ub)
	}
	for i := 0; i < n; i++ {
		if ua[i] != ub[i] {
			return ua[i] < ub[i]
		}
	}
	return len(ua) < len(ub)
}

// FormatJSNumber renders a float64 the way ECMAScript's Number::toString does
// for JSON.stringify: shortest round-tripping digits, fixed notation for
// decimal exponents in [-6, 21), exponential notation outside that range.
func FormatJSNumber(f float64) string {
	if math.IsNaN(f) || math.IsInf(f, 0) {
		return "null"
	}
	if f == 0 {
		return "0"
	}
	negative := f < 0
	if negative {
		f = -f
	}

	// Shortest round-trip digits in scientific form, e.g. "1.2345e+02".
	sci := strconv.FormatFloat(f, 'e', -1, 64)
	mantissa, expPart, ok := strings.Cut(sci, "e")
	if !ok {
		// Defensive: should not happen.
		if negative {
			return "-" + sci
		}
		return sci
	}
	exp, err := strconv.Atoi(expPart)
	if err != nil {
		if negative {
			return "-" + sci
		}
		return sci
	}
	digits := strings.Replace(mantissa, ".", "", 1)

	var out string
	if exp >= -6 && exp < 21 {
		out = fixedNotation(digits, exp)
	} else {
		out = exponentialNotation(digits, exp)
	}
	if negative {
		return "-" + out
	}
	return out
}

func fixedNotation(digits string, exp int) string {
	if exp >= len(digits)-1 {
		return digits + strings.Repeat("0", exp-(len(digits)-1))
	}
	if exp >= 0 {
		return digits[:exp+1] + "." + digits[exp+1:]
	}
	return "0." + strings.Repeat("0", -exp-1) + digits
}

func exponentialNotation(digits string, exp int) string {
	var b strings.Builder
	b.WriteByte(digits[0])
	if len(digits) > 1 {
		b.WriteByte('.')
		b.WriteString(digits[1:])
	}
	b.WriteByte('e')
	if exp >= 0 {
		b.WriteByte('+')
	} else {
		b.WriteByte('-')
		exp = -exp
	}
	b.WriteString(strconv.Itoa(exp))
	return b.String()
}
