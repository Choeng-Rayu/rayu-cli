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
