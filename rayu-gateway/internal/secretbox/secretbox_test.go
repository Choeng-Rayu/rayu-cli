package secretbox

import (
	"strings"
	"testing"
)

// The master key used to produce the fixtures below.
const fixtureSecret = "cross-language-master-secret-0123456789abcdef"

// These envelopes were produced by the BACKEND (rayu-backend
// src/common/secretBox.ts encryptSecret) with fixtureSecret. They are the whole
// point of this package: the gateway must be able to open what the backend
// sealed. If the two implementations ever drift, these fail — which is far better
// than discovering it when a provider key silently stops working in production.
var nodeFixtures = []struct{ plain, sealed string }{
	{
		"sk-proj-abcdefghijklmnopqrstuvwxyz0123456789",
		"v1:Kl1MyTDp5jqyuKhrb/3B2L+OGOutakNlCGhZ3YBWCgxYaviBtxjobVq/0+jY73HwwAxUm56JaAsIEzlq5fI0spQaVMM8uLo4",
	},
	{
		"short-but-ok-key",
		"v1:4tXBqQZ4hocNfKK18Koz//3JLD6/7twRZbki0et/7uDl2qOW1Izc8BIdYUo=",
	},
	{
		"sk-ant-api03-XYZ_123-abc",
		"v1:2u4FADWFfKTU8AEUIrKXde8C+7N+GI75mQn+y0hvkC1wp3CgYt9ENII8xGizOfmbdiAq3w==",
	},
}

func TestOpensEnvelopesSealedByTheBackend(t *testing.T) {
	o, err := NewOpener(fixtureSecret)
	if err != nil {
		t.Fatalf("NewOpener: %v", err)
	}
	for _, f := range nodeFixtures {
		got, err := o.Open(f.sealed)
		if err != nil {
			t.Errorf("Open(%q…) failed: %v", f.sealed[:16], err)
			continue
		}
		if got != f.plain {
			t.Errorf("Open → %q, want %q", got, f.plain)
		}
	}
}

func TestWrongMasterKeyFailsAndLeaksNothing(t *testing.T) {
	o, err := NewOpener("a-different-master-secret-0123456789abcdef")
	if err != nil {
		t.Fatal(err)
	}
	_, err = o.Open(nodeFixtures[0].sealed)
	if err == nil {
		t.Fatal("expected a decrypt failure with the wrong master key")
	}
	// The message must be actionable but must not echo ciphertext or plaintext.
	if !strings.Contains(err.Error(), SecretEnv) {
		t.Errorf("error should name %s: %v", SecretEnv, err)
	}
	if strings.Contains(err.Error(), nodeFixtures[0].plain) ||
		strings.Contains(err.Error(), nodeFixtures[0].sealed) {
		t.Errorf("error leaked key material: %v", err)
	}
}

func TestTamperedEnvelopeIsRejected(t *testing.T) {
	o, _ := NewOpener(fixtureSecret)
	sealed := nodeFixtures[0].sealed
	// Flip a character inside the base64 body.
	body := []byte(sealed[3:])
	if body[len(body)-2] == 'A' {
		body[len(body)-2] = 'B'
	} else {
		body[len(body)-2] = 'A'
	}
	if _, err := o.Open("v1:" + string(body)); err == nil {
		t.Fatal("tampered ciphertext must not open (GCM auth tag)")
	}
}

func TestMalformedEnvelopes(t *testing.T) {
	o, _ := NewOpener(fixtureSecret)
	for _, bad := range []string{
		"",
		"no-separator",
		"v1:",
		"v1:AAAA",             // shorter than iv+tag
		"v2:AAAABBBBCCCCDDDD", // unknown version
		"v1:!!!not-base64!!!", // undecodable
	} {
		if _, err := o.Open(bad); err == nil {
			t.Errorf("Open(%q) should fail", bad)
		}
	}
}

func TestNewOpenerRefusesAWeakSecret(t *testing.T) {
	for _, secret := range []string{"", "   ", "too-short-secret"} {
		if _, err := NewOpener(secret); err == nil {
			t.Errorf("NewOpener(%q) should fail — a short master key must not be stretched", secret)
		}
	}
	// The error tells the operator exactly what to do.
	_, err := NewOpener("short")
	if err == nil || !strings.Contains(err.Error(), "openssl rand") {
		t.Errorf("error should include the generation command: %v", err)
	}
}

func TestMaskNeverRevealsTheKey(t *testing.T) {
	const key = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789"
	masked := Mask(key)
	if masked == key || strings.Contains(masked, "ghijklmnopqrst") {
		t.Fatalf("Mask leaked the key: %s", masked)
	}
	if Mask("") != "<unset>" {
		t.Errorf("Mask(\"\") = %q", Mask(""))
	}
	if got := Mask("short"); got != "***(5)" {
		t.Errorf("Mask(short) = %q", got)
	}
}
