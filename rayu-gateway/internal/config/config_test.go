package config

import (
	"strings"
	"testing"
)

func TestMySQLDSN(t *testing.T) {
	dsn, err := MySQLDSN("mysql://rayu:rayu_app_local@127.0.0.1:3306/rayu")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.HasPrefix(dsn, "rayu:rayu_app_local@tcp(127.0.0.1:3306)/rayu?") {
		t.Fatalf("unexpected dsn prefix: %s", dsn)
	}
	if !strings.Contains(dsn, "parseTime=true") {
		t.Fatalf("dsn missing parseTime: %s", dsn)
	}
}

func TestMySQLDSNRejectsNonMySQL(t *testing.T) {
	if _, err := MySQLDSN("postgres://x/y"); err == nil {
		t.Fatal("expected error for non-mysql scheme")
	}
}

func TestKeyForProvider(t *testing.T) {
	c := &Config{ProviderKeys: map[string]string{"deepseek": "sk-test"}}
	if got := c.KeyForProvider("deepseek"); got != "sk-test" {
		t.Fatalf("KeyForProvider(deepseek)=%q", got)
	}
	t.Setenv("FOO_API_KEY", "envkey")
	if got := c.KeyForProvider("foo"); got != "envkey" {
		t.Fatalf("KeyForProvider(foo) fallback=%q", got)
	}
}

func TestKeysForProvider(t *testing.T) {
	c := &Config{ProviderKeys: map[string]string{
		"deepseek":    "sk-single",
		"rayu-ollama": " key1 , key2 ,, key3 ", // comma-separated, messy spacing + empties
	}}
	// Single key (no comma) → one-element slice, unchanged.
	if got := c.KeysForProvider("deepseek"); len(got) != 1 || got[0] != "sk-single" {
		t.Fatalf("KeysForProvider(deepseek)=%v, want [sk-single]", got)
	}
	// Comma-separated → trimmed, empties dropped, order preserved.
	got := c.KeysForProvider("rayu-ollama")
	if len(got) != 3 || got[0] != "key1" || got[1] != "key2" || got[2] != "key3" {
		t.Fatalf("KeysForProvider(rayu-ollama)=%v, want [key1 key2 key3]", got)
	}
	// Unset provider → empty slice.
	if got := c.KeysForProvider("nope"); len(got) != 0 {
		t.Fatalf("KeysForProvider(nope)=%v, want []", got)
	}
}

func TestOllamaProviderName(t *testing.T) {
	// Default when unset.
	if got := (&Config{}).OllamaProviderName(); got != "rayu-ollama" {
		t.Fatalf("default OllamaProviderName=%q, want rayu-ollama", got)
	}
	// Configured value wins.
	if got := (&Config{OllamaProvider: "rayu-ollama-v2"}).OllamaProviderName(); got != "rayu-ollama-v2" {
		t.Fatalf("OllamaProviderName=%q, want rayu-ollama-v2", got)
	}
}

func TestLoadReadsOllamaProviderName(t *testing.T) {
	t.Setenv("RAYU_JWT_SECRET", "s")
	t.Setenv("OLLAMA_PROVIDER_NAME", "rayu-ollama-x")
	t.Setenv("OLLAMA_API_KEY", "k1,k2")
	c, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if c.OllamaProviderName() != "rayu-ollama-x" {
		t.Fatalf("OllamaProviderName=%q, want rayu-ollama-x", c.OllamaProviderName())
	}
	// OLLAMA_API_KEY is mapped onto the CONFIGURED name (multi-key), not a
	// hardcoded 'rayu-ollama'.
	if keys := c.KeysForProvider("rayu-ollama-x"); len(keys) != 2 || keys[0] != "k1" || keys[1] != "k2" {
		t.Fatalf("keys under configured name=%v, want [k1 k2]", keys)
	}
	if keys := c.KeysForProvider("rayu-ollama"); len(keys) != 0 {
		t.Fatalf("keys must NOT be under the default name when renamed, got %v", keys)
	}
}

func TestProviderAuthAndEndpointDefaults(t *testing.T) {
	c := &Config{} // no registry → built-in defaults
	if c.ProviderUsesBearer("deepseek") || c.ProviderEndpointStyle("deepseek") != "anthropic" {
		t.Errorf("deepseek: bearer=%v endpoint=%q, want false/anthropic",
			c.ProviderUsesBearer("deepseek"), c.ProviderEndpointStyle("deepseek"))
	}
	if !c.ProviderUsesBearer("longcat") || c.ProviderEndpointStyle("longcat") != "anthropic" {
		t.Errorf("longcat: bearer=%v endpoint=%q, want true/anthropic",
			c.ProviderUsesBearer("longcat"), c.ProviderEndpointStyle("longcat"))
	}
	// The Ollama provider (its configurable name) → Bearer + {host}/v1/messages.
	if !c.ProviderUsesBearer("rayu-ollama") || c.ProviderEndpointStyle("rayu-ollama") != "messages" {
		t.Errorf("rayu-ollama: bearer=%v endpoint=%q, want true/messages",
			c.ProviderUsesBearer("rayu-ollama"), c.ProviderEndpointStyle("rayu-ollama"))
	}
	// Unknown provider → safe Anthropic-standard default.
	if c.ProviderUsesBearer("mystery") || c.ProviderEndpointStyle("mystery") != "anthropic" {
		t.Errorf("unknown provider default: bearer=%v endpoint=%q, want false/anthropic",
			c.ProviderUsesBearer("mystery"), c.ProviderEndpointStyle("mystery"))
	}
}

func TestLoadReadsProviderRegistry(t *testing.T) {
	t.Setenv("RAYU_JWT_SECRET", "s")
	// Add TWO brand-new providers purely via env — zero gateway code.
	t.Setenv("RAYU_PROVIDERS", "openrouter:OPENROUTER_API_KEY:bearer:anthropic;myprov:MYPROV_KEY::messages")
	t.Setenv("OPENROUTER_API_KEY", "or-1,or-2")
	t.Setenv("MYPROV_KEY", "mp-1")
	c, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	// openrouter: fully usable — auth + endpoint + (multi-)keys, no code.
	if !c.ProviderUsesBearer("openrouter") || c.ProviderEndpointStyle("openrouter") != "anthropic" {
		t.Errorf("openrouter: bearer=%v endpoint=%q", c.ProviderUsesBearer("openrouter"), c.ProviderEndpointStyle("openrouter"))
	}
	if keys := c.KeysForProvider("openrouter"); len(keys) != 2 || keys[0] != "or-1" || keys[1] != "or-2" {
		t.Errorf("openrouter keys=%v, want [or-1 or-2]", keys)
	}
	// myprov: omitted auth field defaults to x-api-key; endpoint 'messages' honored.
	if c.ProviderUsesBearer("myprov") || c.ProviderEndpointStyle("myprov") != "messages" {
		t.Errorf("myprov: bearer=%v endpoint=%q, want false/messages", c.ProviderUsesBearer("myprov"), c.ProviderEndpointStyle("myprov"))
	}
	if keys := c.KeysForProvider("myprov"); len(keys) != 1 || keys[0] != "mp-1" {
		t.Errorf("myprov keys=%v, want [mp-1]", keys)
	}
}

func TestDisabledProviders(t *testing.T) {
	c := &Config{DisabledProviders: map[string]bool{"longcat": true}}
	if !c.ProviderDisabled("longcat") {
		t.Error("longcat should be disabled")
	}
	if c.ProviderDisabled("rayu-ollama") {
		t.Error("rayu-ollama should be enabled (not in the set)")
	}
	if (&Config{}).ProviderDisabled("anything") {
		t.Error("no providers disabled by default")
	}
}

func TestLoadReadsDisabledProviders(t *testing.T) {
	t.Setenv("RAYU_JWT_SECRET", "s")
	t.Setenv("RAYU_DISABLED_PROVIDERS", "longcat, deepinfra ,") // messy spacing + trailing comma
	c, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if !c.ProviderDisabled("longcat") || !c.ProviderDisabled("deepinfra") {
		t.Errorf("longcat + deepinfra should be disabled, got %v", c.DisabledProviders)
	}
	if c.ProviderDisabled("rayu-ollama") {
		t.Error("rayu-ollama must NOT be disabled")
	}
}
