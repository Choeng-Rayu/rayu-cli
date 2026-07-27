package store

import (
	"context"
	"os"
	"testing"
	"time"
)

// These tests exercise the REAL SQL against a live MySQL, because that is the
// only thing that can prove the hosted_models ⋈ providers join matches the
// backend's Prisma schema (column names, nullability, the provider_id FK). They
// are skipped unless RAYU_TEST_DATABASE_URL points at a migrated database, e.g.
//
//	RAYU_TEST_DATABASE_URL='mysql://rayu:rayu_app_local@127.0.0.1:3306/rayu_test' go test ./internal/store/
func testStore(t *testing.T) *Store {
	t.Helper()
	raw := os.Getenv("RAYU_TEST_DATABASE_URL")
	if raw == "" {
		t.Skip("RAYU_TEST_DATABASE_URL not set — skipping live MySQL store tests")
	}
	dsn, err := mysqlDSNForTest(raw)
	if err != nil {
		t.Fatalf("dsn: %v", err)
	}
	st, err := Open(dsn)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	return st
}

func TestLoadModelsJoinsProviderRegistry(t *testing.T) {
	st := testStore(t)
	models, err := st.LoadModels(context.Background())
	if err != nil {
		t.Fatalf("LoadModels: %v", err)
	}
	if len(models) == 0 {
		t.Fatal("no hosted models loaded — is the database seeded?")
	}
	for _, m := range models {
		// Every model must arrive with a usable provider attached: the gateway
		// cannot route without the provider's format/URL/auth scheme.
		if m.ProviderID == 0 {
			t.Errorf("model %q has no provider_id", m.Code)
		}
		if m.Provider.ID != m.ProviderID {
			t.Errorf("model %q: provider.ID=%d != providerID=%d", m.Code, m.Provider.ID, m.ProviderID)
		}
		if m.Provider.Name == "" || m.Provider.Format == "" || m.Provider.BaseURL == "" {
			t.Errorf("model %q: incomplete provider row %+v", m.Code, m.Provider)
		}
		if m.Provider.AuthScheme == "" {
			t.Errorf("model %q: provider %q has no authScheme", m.Code, m.Provider.Name)
		}
		if m.UpstreamModelID == "" {
			t.Errorf("model %q has no upstreamModelId", m.Code)
		}
		// The context window is optional (nil = client default), but when set it
		// must be a sane positive token count — a client budgets against it.
		if m.ContextWindow != nil && *m.ContextWindow < 1000 {
			t.Errorf("model %q has an implausible contextWindow %d", m.Code, *m.ContextWindow)
		}
		if m.ProviderName() != m.Provider.Name {
			t.Errorf("model %q: ProviderName()=%q want %q", m.Code, m.ProviderName(), m.Provider.Name)
		}
	}
}

func TestLoadProvidersReturnsRegistry(t *testing.T) {
	st := testStore(t)
	providers, err := st.LoadProviders(context.Background())
	if err != nil {
		t.Fatalf("LoadProviders: %v", err)
	}
	if len(providers) == 0 {
		t.Fatal("no providers loaded — is the database seeded?")
	}
	seen := map[string]bool{}
	for _, p := range providers {
		if p.ID == 0 || p.Name == "" {
			t.Errorf("invalid provider row: %+v", p)
		}
		if seen[p.Name] {
			t.Errorf("duplicate provider name %q", p.Name)
		}
		seen[p.Name] = true
	}
	// The seeded registry that replaced the env registry.
	for _, want := range []string{"deepseek", "longcat", "rayu-ollama"} {
		if !seen[want] {
			t.Errorf("expected seeded provider %q in registry, got %v", want, seen)
		}
	}
}

// LoadProviderKeys + UpdateProviderKeyState are the two halves of per-key
// rotation that touch MySQL, so they are asserted against the REAL schema: the
// column names, the ordering the registry relies on (priority, then id), and the
// nullable cooldown/lastError columns. Anything else is a runtime surprise the
// moment a key is rate limited in production.
func TestProviderKeyLoadAndStateWriteBack(t *testing.T) {
	st := testStore(t)
	ctx := context.Background()

	providers, err := st.LoadProviders(ctx)
	if err != nil || len(providers) == 0 {
		t.Skipf("no providers to attach keys to (err=%v)", err)
	}
	pid := providers[0].ID

	// Two keys with priorities inserted OUT of order, to prove the query — not
	// the insertion order — establishes the try order.
	var ids []int64
	for _, k := range []struct {
		priority int
		label    string
	}{{5, "secondary"}, {1, "primary"}} {
		res, err := st.db.ExecContext(ctx,
			`INSERT INTO provider_api_keys
			   (provider_id, label, encryptedKey, keyHash, maskedKey, priority, enabled, status, createdAt, updatedAt)
			 VALUES (?, ?, ?, ?, ?, ?, 1, 'active', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
			pid, k.label, "v1:"+k.label+"-envelope", "hash-"+k.label+"-storetest", "sk-…"+k.label, k.priority)
		if err != nil {
			t.Fatalf("insert %s: %v", k.label, err)
		}
		id, _ := res.LastInsertId()
		ids = append(ids, id)
	}
	t.Cleanup(func() {
		for _, id := range ids {
			_, _ = st.db.ExecContext(context.Background(), `DELETE FROM provider_api_keys WHERE id = ?`, id)
		}
	})

	keys, err := st.LoadProviderKeys(ctx)
	if err != nil {
		t.Fatalf("LoadProviderKeys: %v", err)
	}
	var mine []ProviderKey
	for _, k := range keys {
		for _, id := range ids {
			if k.ID == id {
				mine = append(mine, k)
			}
		}
	}
	if len(mine) != 2 {
		t.Fatalf("loaded %d of 2 inserted keys", len(mine))
	}
	if mine[0].Label != "primary" {
		t.Errorf("first key is %q, want the lowest-priority-number key (primary)", mine[0].Label)
	}
	if mine[0].EncryptedKey == "" || mine[0].MaskedKey == "" || mine[0].ProviderID != pid {
		t.Errorf("key row incomplete: %+v", mine[0])
	}
	if mine[0].CooldownUntil != nil {
		t.Errorf("fresh key has a cooldown: %v", mine[0].CooldownUntil)
	}

	// Write back a rate limit exactly as the async sink does, then re-read it:
	// this is what makes a cooldown survive a gateway restart.
	until := time.Now().Add(90 * time.Second).UTC().Truncate(time.Second)
	used := time.Now().UTC().Truncate(time.Second)
	if err := st.UpdateProviderKeyState(ctx, mine[0].ID, "rate_limited", &until, "HTTP 429", used); err != nil {
		t.Fatalf("UpdateProviderKeyState: %v", err)
	}
	keys, err = st.LoadProviderKeys(ctx)
	if err != nil {
		t.Fatalf("LoadProviderKeys after write: %v", err)
	}
	for _, k := range keys {
		if k.ID != mine[0].ID {
			continue
		}
		if k.Status != "rate_limited" {
			t.Errorf("status=%q, want rate_limited", k.Status)
		}
		if k.CooldownUntil == nil || k.CooldownUntil.UTC().Sub(until).Abs() > time.Second {
			t.Errorf("cooldownUntil=%v, want ≈%v", k.CooldownUntil, until)
		}
		return
	}
	t.Fatal("key vanished after the state write-back")
}
