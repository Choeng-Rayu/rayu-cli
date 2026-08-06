package config

import (
	"strings"
	"testing"
)

// validEnv is a complete, well-formed set of every required key plus a couple
// of optional ones, used as the baseline each test mutates.
func validEnv() map[string]string {
	return map[string]string{
		"PORT":                     "9090",
		"BASE_DOMAIN":              "apps.example.com",
		"SERVICE_AUTH_SECRET":      "super-secret",
		"BUILD_MODEL":              "claude-sonnet",
		"SANDBOX_IMAGE":            "rayu/sandbox:pinned",
		"MAX_CONCURRENT_BUILDS":    "4",
		"PER_USER_CONCURRENCY":     "2",
		"PER_USER_DAILY":           "10",
		"SANDBOX_CPU":              "1.5",
		"SANDBOX_MEM":              "512m",
		"SANDBOX_PIDS":             "256",
		"BUILD_TIMEOUT":            "20m",
		"HEALTHCHECK_DEADLINE":     "60s",
		"APP_TTL":                  "24h",
		"APP_IDLE_TTL":             "30m",
		"DEPLOY_COALESCE_INTERVAL": "2s",
		"STORE_DSN":                "memory://",
		"RATE_LIMIT_RPS":           "25",
		"SECRET_PATTERNS":          "sk-[a-z0-9]+,ghp_[A-Za-z0-9]+",
	}
}

// loadFrom runs Load against an explicit env map instead of the process env, so
// tests are hermetic and parallel-safe.
func loadFrom(env map[string]string) (*Config, error) {
	saved := newLoader
	defer func() { newLoader = saved }()
	newLoader = func() *loader {
		return &loader{getenv: func(k string) string { return env[k] }}
	}
	return Load()
}

func TestLoadValid(t *testing.T) {
	cfg, err := loadFrom(validEnv())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.BaseDomain != "apps.example.com" {
		t.Errorf("BaseDomain = %q", cfg.BaseDomain)
	}
	if cfg.MaxConcurrentBuilds != 4 || cfg.PerUserConcurrency != 2 || cfg.PerUserDaily != 10 {
		t.Errorf("quota fields wrong: %+v", cfg)
	}
	if cfg.SandboxNanoCPUs != 1_500_000_000 {
		t.Errorf("SandboxNanoCPUs = %d, want 1.5e9", cfg.SandboxNanoCPUs)
	}
	if cfg.SandboxMemBytes != 512*1024*1024 {
		t.Errorf("SandboxMemBytes = %d, want 512MiB", cfg.SandboxMemBytes)
	}
	if cfg.SandboxPids != 256 {
		t.Errorf("SandboxPids = %d", cfg.SandboxPids)
	}
	if cfg.BuildTimeout.Minutes() != 20 {
		t.Errorf("BuildTimeout = %v", cfg.BuildTimeout)
	}
	if cfg.HealthCheckDeadline.Seconds() != 60 {
		t.Errorf("HealthCheckDeadline = %v", cfg.HealthCheckDeadline)
	}
	if len(cfg.SecretPatterns) != 2 {
		t.Errorf("SecretPatterns = %v", cfg.SecretPatterns)
	}
	if cfg.RateLimitRPS != 25 {
		t.Errorf("RateLimitRPS = %v", cfg.RateLimitRPS)
	}
}

func TestLoadDefaultsForOptionalKeys(t *testing.T) {
	env := validEnv()
	delete(env, "STORE_DSN")
	delete(env, "RATE_LIMIT_RPS")
	delete(env, "DEPLOY_COALESCE_INTERVAL")
	delete(env, "PORT")
	cfg, err := loadFrom(env)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.StoreDSN != "memory://" {
		t.Errorf("StoreDSN default = %q", cfg.StoreDSN)
	}
	if cfg.RateLimitRPS != 20 {
		t.Errorf("RateLimitRPS default = %v", cfg.RateLimitRPS)
	}
	if cfg.DeployCoalesceInterval.Seconds() != 2 {
		t.Errorf("DeployCoalesceInterval default = %v", cfg.DeployCoalesceInterval)
	}
	if cfg.Port != "9090" {
		t.Errorf("Port default = %q", cfg.Port)
	}
	if cfg.BuildsDir != "/srv/builds" || cfg.ProxyNetwork != "proxy" || cfg.EgressNetwork != "egress" {
		t.Errorf("network/dir defaults wrong: %+v", cfg)
	}
}

// Req 3.1, 14.4, 17.1, 17.3 — a missing required key must fail fast with an
// error that names the offending key.
func TestLoadRequiredKeyMissing(t *testing.T) {
	for _, key := range []string{
		"BASE_DOMAIN", "SERVICE_AUTH_SECRET", "BUILD_MODEL", "SANDBOX_IMAGE",
		"MAX_CONCURRENT_BUILDS", "PER_USER_CONCURRENCY", "PER_USER_DAILY",
		"SANDBOX_CPU", "SANDBOX_MEM", "SANDBOX_PIDS",
		"BUILD_TIMEOUT", "HEALTHCHECK_DEADLINE", "APP_TTL", "APP_IDLE_TTL",
	} {
		env := validEnv()
		delete(env, key)
		_, err := loadFrom(env)
		if err == nil {
			t.Errorf("missing %s: expected error, got nil", key)
			continue
		}
		if !strings.Contains(err.Error(), key) {
			t.Errorf("missing %s: error %q does not name the key", key, err)
		}
	}
}

// Req 7.5, 13.1, 19.2 — malformed durations fail with a key-named error.
func TestLoadBadDuration(t *testing.T) {
	for _, key := range []string{"BUILD_TIMEOUT", "HEALTHCHECK_DEADLINE", "APP_TTL", "APP_IDLE_TTL"} {
		env := validEnv()
		env[key] = "not-a-duration"
		_, err := loadFrom(env)
		if err == nil {
			t.Errorf("bad %s: expected error, got nil", key)
			continue
		}
		if !strings.Contains(err.Error(), key) {
			t.Errorf("bad %s: error %q does not name the key", key, err)
		}
	}
}

// Req 3.1, 17.1, 17.3 — non-numeric or non-positive quota counts are rejected.
func TestLoadBadIntegers(t *testing.T) {
	for _, key := range []string{"MAX_CONCURRENT_BUILDS", "PER_USER_CONCURRENCY", "PER_USER_DAILY", "SANDBOX_PIDS"} {
		for _, bad := range []string{"abc", "0", "-1"} {
			env := validEnv()
			env[key] = bad
			_, err := loadFrom(env)
			if err == nil {
				t.Errorf("%s=%q: expected error, got nil", key, bad)
				continue
			}
			if !strings.Contains(err.Error(), key) {
				t.Errorf("%s=%q: error %q does not name the key", key, bad, err)
			}
		}
	}
}

func TestLoadBadResourceLimits(t *testing.T) {
	cases := map[string]string{"SANDBOX_CPU": "fast", "SANDBOX_MEM": "lots"}
	for key, bad := range cases {
		env := validEnv()
		env[key] = bad
		if _, err := loadFrom(env); err == nil {
			t.Errorf("%s=%q: expected error, got nil", key, bad)
		}
	}
}

func TestLoadBadSecretPattern(t *testing.T) {
	env := validEnv()
	env["SECRET_PATTERNS"] = "valid,([unclosed"
	if _, err := loadFrom(env); err == nil {
		t.Fatal("expected error for invalid regex pattern, got nil")
	}
}

// Multiple problems are reported together rather than one-at-a-time.
func TestLoadAccumulatesErrors(t *testing.T) {
	env := validEnv()
	delete(env, "BASE_DOMAIN")
	env["BUILD_TIMEOUT"] = "nope"
	_, err := loadFrom(env)
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if !strings.Contains(err.Error(), "BASE_DOMAIN") || !strings.Contains(err.Error(), "BUILD_TIMEOUT") {
		t.Errorf("expected both keys in error, got %q", err)
	}
}

func TestParseMemBytes(t *testing.T) {
	cases := map[string]int64{
		"1024": 1024,
		"512b": 512,
		"1k":   1024,
		"2K":   2048,
		"512m": 512 * 1024 * 1024,
		"1g":   1024 * 1024 * 1024,
		"3G":   3 * 1024 * 1024 * 1024,
	}
	for in, want := range cases {
		got, err := parseMemBytes(in)
		if err != nil {
			t.Errorf("parseMemBytes(%q) error: %v", in, err)
			continue
		}
		if got != want {
			t.Errorf("parseMemBytes(%q) = %d, want %d", in, got, want)
		}
	}
	for _, bad := range []string{"", "abc", "10x", "-5m", "1.5g"} {
		if _, err := parseMemBytes(bad); err == nil {
			t.Errorf("parseMemBytes(%q): expected error", bad)
		}
	}
}
