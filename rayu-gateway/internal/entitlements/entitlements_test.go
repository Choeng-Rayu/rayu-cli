package entitlements

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"testing"
	"time"

	"github.com/choeng-rayu/rayu-gateway/internal/providercfg"
	"github.com/choeng-rayu/rayu-gateway/internal/providerkeys"
	"github.com/choeng-rayu/rayu-gateway/internal/secretbox"
	"github.com/choeng-rayu/rayu-gateway/internal/store"
)

const testMaster = "entitlements-master-secret-0123456789abcdef"

func testCache(t *testing.T, master string) *Cache {
	t.Helper()
	var opener *secretbox.Opener
	if master != "" {
		var err error
		opener, err = secretbox.NewOpener(master)
		if err != nil {
			t.Fatalf("NewOpener: %v", err)
		}
	}
	return New(nil, time.Minute, time.Minute, providercfg.Options{}, opener, nil)
}

// sealed produces an envelope byte-for-byte the way the BACKEND does
// ("v1:" + base64(iv‖tag‖ciphertext), AES-256-GCM under sha256(master)). The
// gateway itself is decrypt-only on purpose — it never needs to create a key — so
// the sealing half lives here, in the test, and any drift in the shared envelope
// format shows up as a failure to open.
func sealed(t *testing.T, plaintext string) string {
	t.Helper()
	sum := sha256.Sum256([]byte(testMaster))
	block, err := aes.NewCipher(sum[:])
	if err != nil {
		t.Fatalf("aes: %v", err)
	}
	gcm, err := cipher.NewGCMWithNonceSize(block, 12)
	if err != nil {
		t.Fatalf("gcm: %v", err)
	}
	iv := make([]byte, 12)
	if _, err := rand.Read(iv); err != nil {
		t.Fatalf("rand: %v", err)
	}
	sealedBytes := gcm.Seal(nil, iv, []byte(plaintext), nil)
	ct, tag := sealedBytes[:len(sealedBytes)-16], sealedBytes[len(sealedBytes)-16:]
	env := append(append(append([]byte{}, iv...), tag...), ct...)
	return "v1:" + base64.StdEncoding.EncodeToString(env)
}

// A decryptable key must reach the registry with its plaintext and its stored
// admin/health state intact — that plaintext is what makes "no decryption on the
// request path" possible.
func TestOpenKeyDecryptsOncePerRefresh(t *testing.T) {
	c := testCache(t, testMaster)
	cool := time.Now().Add(30 * time.Second)
	got := c.openKey(store.ProviderKey{
		ID: 7, ProviderID: 1, Label: "primary", MaskedKey: "sk-…def",
		EncryptedKey: sealed(t, "sk-live-secret"), Priority: 2, Enabled: true,
		Status: "rate_limited", CooldownUntil: &cool,
	})
	if got.Secret != "sk-live-secret" {
		t.Fatalf("Secret not decrypted (got %q)", secretbox.Mask(got.Secret))
	}
	if got.ID != 7 || got.Label != "primary" || got.Masked != "sk-…def" || got.Priority != 2 || !got.Enabled {
		t.Fatalf("metadata lost: %+v", providerkeys.Key{ID: got.ID, Label: got.Label, Masked: got.Masked, Priority: got.Priority, Enabled: got.Enabled})
	}
	if got.Status != providerkeys.StatusRateLimited || !got.CooldownUntil.Equal(cool) {
		t.Fatalf("persisted health not restored: status=%s cooldown=%v", got.Status, got.CooldownUntil)
	}
}

// A key that cannot be opened must be KEPT and marked invalid, never dropped and
// never usable: an operator has to be able to see "this key can't be decrypted"
// (wrong RAYU_PROVIDER_SECRET) instead of a key silently vanishing.
func TestOpenKeyKeepsUndecryptableKeysAsInvalid(t *testing.T) {
	cases := map[string]*Cache{
		"wrong master key": testCache(t, "a-different-master-secret-0123456789abcdef"),
		"no master key":    testCache(t, ""),
	}
	for name, c := range cases {
		got := c.openKey(store.ProviderKey{
			ID: 3, ProviderID: 1, MaskedKey: "sk-…xyz",
			EncryptedKey: sealed(t, "sk-live-secret"), Enabled: true, Status: "active",
		})
		if got.Status != providerkeys.StatusInvalid {
			t.Errorf("%s: status=%s, want %s", name, got.Status, providerkeys.StatusInvalid)
		}
		if got.Secret != "" {
			t.Errorf("%s: a key that failed to open must carry no secret", name)
		}
		if got.ID != 3 || got.Masked != "sk-…xyz" {
			t.Errorf("%s: key was dropped instead of reported: %+v", name, got)
		}
	}
}

// Route building must reflect how many keys a provider actually has, because
// KeyCount is what makes a keyless provider visibly unroutable at boot.
func TestKeysRegistryDrivesRouteKeyCount(t *testing.T) {
	c := testCache(t, testMaster)
	c.keys.Replace(1, []providerkeys.Key{
		{ID: 1, Secret: "a", Enabled: true, Status: providerkeys.StatusActive},
		{ID: 2, Secret: "b", Enabled: true, Status: providerkeys.StatusActive},
	})
	if got := c.Keys().Usable(1); got != 2 {
		t.Fatalf("usable=%d, want 2", got)
	}
	// Forget is what a deleted provider must trigger: its decrypted keys cannot
	// stay resident in memory.
	c.Keys().Forget(1)
	if got := c.Keys().Usable(1); got != 0 {
		t.Fatalf("usable after Forget=%d, want 0", got)
	}
}

func TestAllowedModels(t *testing.T) {
	models := []store.HostedModel{
		{Code: "deepseek-v4-flash", Enabled: true, AllowedPlanCodes: []string{"pro", "pro_plus", "max"}},
		{Code: "deepseek-v4-pro", Enabled: true, AllowedPlanCodes: []string{"pro", "pro_plus", "max"}},
		{Code: "disabled-model", Enabled: false, AllowedPlanCodes: []string{"pro"}},
		{Code: "ultra-only", Enabled: true, AllowedPlanCodes: []string{"max"}},
	}

	pro := AllowedModels(models, "pro")
	if len(pro) != 2 {
		t.Fatalf("pro should see 2 models, got %d", len(pro))
	}

	free := AllowedModels(models, "free")
	if len(free) != 0 {
		t.Fatalf("free should see 0 models, got %d", len(free))
	}

	max := AllowedModels(models, "max")
	if len(max) != 3 {
		t.Fatalf("max should see 3 models (flash, pro, ultra-only), got %d", len(max))
	}

	// All three paid plan codes (matching MODEL_SEED.allowedPlanCodes) must see
	// the shared hosted models.
	proPlus := AllowedModels(models, "pro_plus")
	if len(proPlus) != 2 {
		t.Fatalf("pro_plus should see 2 models (flash, pro), got %d", len(proPlus))
	}
}
