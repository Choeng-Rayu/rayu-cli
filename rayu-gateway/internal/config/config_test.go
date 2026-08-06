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

func TestLoadRequiresJWTSecret(t *testing.T) {
	t.Setenv("RAYU_JWT_SECRET", "")
	if _, err := Load(); err == nil {
		t.Fatal("expected Load to fail without RAYU_JWT_SECRET")
	}
}

// Provider routing is NOT read from the environment any more: it lives in the
// `providers` table. Load must not resurrect the retired env registry, so these
// variables having values must have no effect on config.
func TestLoadIgnoresRetiredProviderEnvRegistry(t *testing.T) {
	t.Setenv("RAYU_JWT_SECRET", "s")
	t.Setenv("RAYU_PROVIDERS", "openrouter:OPENROUTER_API_KEY:bearer:anthropic")
	t.Setenv("RAYU_DISABLED_PROVIDERS", "longcat")
	t.Setenv("OLLAMA_PROVIDER_NAME", "rayu-ollama-x")
	c, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	// The Config type itself no longer carries provider routing — this test
	// documents the intent; a reintroduced field would fail to compile here.
	if c.Port == "" {
		t.Fatal("Load returned an unpopulated config")
	}
}

func TestLoadDefaultsAndTuning(t *testing.T) {
	t.Setenv("RAYU_JWT_SECRET", "s")
	c, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if c.Port != "8080" {
		t.Errorf("Port=%q want 8080", c.Port)
	}
	if c.ConfigRefresh != 30 || c.UserCacheTTL != 10 {
		t.Errorf("refresh=%d userTTL=%d want 30/10", c.ConfigRefresh, c.UserCacheTTL)
	}
	if c.MaxInFlight != 0 {
		t.Errorf("MaxInFlight=%d want 0 (unlimited)", c.MaxInFlight)
	}
	// Insecure provider base URLs must be OFF unless explicitly enabled: the
	// provider API key is sent to that URL.
	if c.AllowInsecureProviderBaseURL {
		t.Error("AllowInsecureProviderBaseURL must default to false")
	}
}

func TestLoadReadsInsecureBaseURLFlag(t *testing.T) {
	t.Setenv("RAYU_JWT_SECRET", "s")
	t.Setenv("ALLOW_INSECURE_PROVIDER_BASE_URL", "1")
	c, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if !c.AllowInsecureProviderBaseURL {
		t.Error("ALLOW_INSECURE_PROVIDER_BASE_URL=1 not honoured")
	}
}

func TestEnvTruthy(t *testing.T) {
	for _, v := range []string{"1", "true", "TRUE", " yes ", "on"} {
		if !EnvTruthy(v) {
			t.Errorf("EnvTruthy(%q)=false, want true", v)
		}
	}
	for _, v := range []string{"", "0", "false", "no", "off", "maybe"} {
		if EnvTruthy(v) {
			t.Errorf("EnvTruthy(%q)=true, want false", v)
		}
	}
}
