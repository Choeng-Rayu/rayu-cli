// Package secretbox opens the AES-256-GCM envelopes the backend writes for
// provider API keys.
//
// This is the read half of rayu-backend/src/common/secretBox.ts: the backend
// seals a key when an admin saves it, and the gateway — the only component that
// actually calls an upstream — opens it. The master key lives ONLY in
// RAYU_PROVIDER_SECRET and must be the SAME value in both processes; it is never
// stored beside the ciphertext.
//
// Envelope: "v1:" + base64( iv(12) ‖ authTag(16) ‖ ciphertext )
//
// GCM is authenticated, so a tampered or truncated row fails to open rather than
// decrypting to attacker-chosen bytes. A failure here must mark the key unusable —
// never fall back to another value, which would send the wrong credential
// upstream.
package secretbox

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
)

const (
	version  = "v1"
	ivBytes  = 12
	tagBytes = 16
	// minSecretLen mirrors the backend: a short master key is refused rather than
	// stretched, so a weak secret can't hide behind a hash.
	minSecretLen = 32
)

// SecretEnv is the environment variable holding the master key.
const SecretEnv = "RAYU_PROVIDER_SECRET"

// ErrNoMasterKey is returned when RAYU_PROVIDER_SECRET is missing or too short.
var ErrNoMasterKey = errors.New(SecretEnv + " is not set (or is shorter than 32 chars)")

// Opener decrypts envelopes with a fixed master key. Deriving the AES key once
// (rather than per envelope) keeps a config refresh that opens many keys cheap.
type Opener struct{ key []byte }

// NewOpener derives the AES key from the master secret. A missing/short secret is
// reported so the caller can log an actionable startup error instead of failing
// mysteriously on the first request.
func NewOpener(secret string) (*Opener, error) {
	s := strings.TrimSpace(secret)
	if len(s) < minSecretLen {
		return nil, fmt.Errorf(
			"%w — generate one with `openssl rand -base64 48` and set the SAME value "+
				"on rayu-backend and rayu-gateway", ErrNoMasterKey)
	}
	sum := sha256.Sum256([]byte(s))
	return &Opener{key: sum[:]}, nil
}

// Open decrypts one envelope. The error is deliberately vague about content: it
// must never echo ciphertext or key material into a log.
func (o *Opener) Open(envelope string) (string, error) {
	raw := strings.TrimSpace(envelope)
	sep := strings.Index(raw, ":")
	if sep < 0 {
		return "", errors.New("malformed secret envelope (missing version)")
	}
	if v := raw[:sep]; v != version {
		return "", fmt.Errorf("unsupported secret envelope version %q", v)
	}
	bytes, err := base64.StdEncoding.DecodeString(raw[sep+1:])
	if err != nil {
		return "", errors.New("malformed secret envelope (bad base64)")
	}
	if len(bytes) <= ivBytes+tagBytes {
		return "", errors.New("malformed secret envelope (too short)")
	}
	iv := bytes[:ivBytes]
	tag := bytes[ivBytes : ivBytes+tagBytes]
	ciphertext := bytes[ivBytes+tagBytes:]

	block, err := aes.NewCipher(o.key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCMWithNonceSize(block, ivBytes)
	if err != nil {
		return "", err
	}
	// Go's GCM expects the tag appended to the ciphertext; the envelope stores it
	// separately (matching Node's getAuthTag API), so re-join them here.
	plaintext, err := gcm.Open(nil, iv, append(ciphertext, tag...), nil)
	if err != nil {
		return "", errors.New(
			"could not decrypt provider key (wrong " + SecretEnv + ", or the stored value was tampered with)")
	}
	return string(plaintext), nil
}

// Mask renders a key for logs/health output without revealing it. Kept in the
// same shape the backend stores in maskedKey so operators see one format.
func Mask(k string) string {
	switch {
	case k == "":
		return "<unset>"
	case len(k) <= 12:
		return fmt.Sprintf("***(%d)", len(k))
	default:
		return fmt.Sprintf("%s…%s(%d)", k[:6], k[len(k)-4:], len(k))
	}
}
