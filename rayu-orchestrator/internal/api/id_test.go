package api

import (
	"regexp"
	"strings"
	"testing"
)

// dnsLabelRe matches a syntactically valid DNS label (RFC 1123): 1–63
// characters, lowercase alphanumerics and hyphens, starting and ending with an
// alphanumeric. A generated Build_Id must satisfy this because it becomes the
// subdomain label in <id>.<base-domain>.
var dnsLabelRe = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`)

// TestGenerateBuildID_ValidUniqueDNSLabel asserts every generated id is a
// lowercase, URL-safe, valid DNS label with the bld- prefix, and that ids do not
// collide across many draws.
func TestGenerateBuildID_ValidUniqueDNSLabel(t *testing.T) {
	const n = 2000
	seen := make(map[string]struct{}, n)
	for i := 0; i < n; i++ {
		id, err := GenerateBuildID()
		if err != nil {
			t.Fatalf("GenerateBuildID: %v", err)
		}
		if !strings.HasPrefix(id, buildIDPrefix) {
			t.Fatalf("id %q missing %q prefix", id, buildIDPrefix)
		}
		if len(id) > 63 {
			t.Fatalf("id %q exceeds the 63-char DNS label limit", id)
		}
		if id != strings.ToLower(id) {
			t.Fatalf("id %q is not lowercase", id)
		}
		if !dnsLabelRe.MatchString(id) {
			t.Fatalf("id %q is not a valid DNS label", id)
		}
		if _, dup := seen[id]; dup {
			t.Fatalf("duplicate id generated: %q", id)
		}
		seen[id] = struct{}{}
	}
}
