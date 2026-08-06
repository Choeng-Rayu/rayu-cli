package api

import (
	"crypto/rand"
	"encoding/base32"
)

// buildIDPrefix is prepended to every generated Build_Id. It makes ids
// recognizable in logs and guarantees the id begins with a letter — a DNS label
// must start with an alphanumeric, and a letter is the always-safe choice.
const buildIDPrefix = "bld-"

// buildIDRandomBytes is the amount of cryptographic randomness in a Build_Id.
// 10 bytes = 80 bits encodes to exactly 16 lowercase base32 characters (no
// padding), giving a 20-character id ("bld-" + 16) — well under the 63-char DNS
// label limit — with a collision probability that is negligible at any
// realistic build volume.
const buildIDRandomBytes = 10

// lowerBase32 is the RFC 4648 base32 alphabet, lowercased, without padding. Its
// alphabet (a–z and 2–7) is entirely valid inside a DNS label, so an encoded id
// needs no further sanitization to be used directly as the subdomain label in
// <id>.<base-domain>.
var lowerBase32 = base32.NewEncoding("abcdefghijklmnopqrstuvwxyz234567").WithPadding(base32.NoPadding)

// GenerateBuildID returns a unique, URL-safe, lowercase Build_Id that is a valid
// DNS label and can therefore be used directly as the subdomain that fronts the
// deployed app (Req 1.1, 14). The id is "bld-" followed by 80 bits of
// cryptographic randomness encoded in lowercase base32, e.g.
// "bld-k7q2v9v8r3m4n5p6": it starts with a letter, contains only lowercase
// alphanumerics, ends with an alphanumeric, and is 20 characters long, so it is
// always a syntactically valid label.
//
// It is exported so the build engine can be injected with the id allocator from
// main.go without the build package importing the api package (avoiding an
// import cycle).
func GenerateBuildID() (string, error) {
	b := make([]byte, buildIDRandomBytes)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return buildIDPrefix + lowerBase32.EncodeToString(b), nil
}
