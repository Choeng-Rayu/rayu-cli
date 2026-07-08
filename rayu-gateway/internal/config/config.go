// Package config loads the gateway configuration from environment variables.
// The gateway shares the backend's DATABASE_URL (prisma-style) and JWT secret,
// and holds the upstream provider API keys (which never leave the gateway env).
package config

import (
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
)

// Config holds all runtime configuration for the gateway.
type Config struct {
	Port          string
	JWTSecret     string
	DatabaseURL   string // raw prisma-style URL (may be empty in tests)
	DatabaseDSN   string // go-sql-driver/mysql DSN derived from DatabaseURL
	RedisURL      string
	DeepSeekKey   string
	ProviderKeys  map[string]string // provider name -> api key (env-sourced)
	ConfigRefresh int               // seconds between in-memory config refreshes
	UserCacheTTL  int               // seconds to cache per-user entitlements
	CorsOrigins   []string          // allowed browser origins for the dashboard
}

func getenv(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

// Load reads configuration from the environment. RAYU_JWT_SECRET is required;
// everything else has a sensible default so the binary boots in dev.
func Load() (*Config, error) {
	c := &Config{
		Port:        getenv("PORT", "8080"),
		JWTSecret:   os.Getenv("RAYU_JWT_SECRET"),
		DatabaseURL: os.Getenv("DATABASE_URL"),
		RedisURL:    getenv("REDIS_URL", "redis://localhost:6379"),
		DeepSeekKey: os.Getenv("DEEPSEEK_API_KEY"),
	}
	if c.JWTSecret == "" {
		return nil, fmt.Errorf("RAYU_JWT_SECRET is required")
	}
	c.ConfigRefresh, _ = strconv.Atoi(getenv("CONFIG_REFRESH_SECONDS", "30"))
	c.UserCacheTTL, _ = strconv.Atoi(getenv("USER_CACHE_TTL_SECONDS", "10"))

	// Allowed browser origins for the dashboard's /v1/credits calls. Default "*"
	// is safe because every /v1 route still requires a valid Rayu JWT.
	for _, o := range strings.Split(getenv("GATEWAY_CORS_ORIGINS", "*"), ",") {
		if t := strings.TrimSpace(o); t != "" {
			c.CorsOrigins = append(c.CorsOrigins, t)
		}
	}

	// Upstream provider keys live ONLY here. Map by provider name; callers can
	// also fall back to <PROVIDER>_API_KEY via KeyForProvider.
	c.ProviderKeys = map[string]string{}
	if c.DeepSeekKey != "" {
		c.ProviderKeys["deepseek"] = c.DeepSeekKey
	}
	if k := os.Getenv("DEEPINFRA_API_KEY"); k != "" {
		c.ProviderKeys["deepinfra"] = k
	}
	if k := os.Getenv("LONGCAT_API_KEY"); k != "" {
		c.ProviderKeys["longcat"] = k
	}
	// Ollama Cloud (provider 'rayu-ollama'): resold hosted models via
	// Rayu's own ollama.com key. KeyForProvider can't derive it from the provider
	// name (it has dashes), so map it explicitly here.
	if k := os.Getenv("OLLAMA_API_KEY"); k != "" {
		c.ProviderKeys["rayu-ollama"] = k
	}

	if c.DatabaseURL != "" {
		dsn, err := MySQLDSN(c.DatabaseURL)
		if err != nil {
			return nil, fmt.Errorf("parse DATABASE_URL: %w", err)
		}
		c.DatabaseDSN = dsn
	}
	return c, nil
}

// KeyForProvider returns the upstream API key for a provider name, falling back
// to the <PROVIDER>_API_KEY env var (upper-cased) when not pre-mapped.
func (c *Config) KeyForProvider(provider string) string {
	if k, ok := c.ProviderKeys[provider]; ok && k != "" {
		return k
	}
	return os.Getenv(strings.ToUpper(provider) + "_API_KEY")
}

// ProviderKeySummary returns a masked, log-safe summary of the loaded upstream
// keys (e.g. "deepseek=sk-e2…71c8(35) deepinfra=<unset>") so key mix-ups are
// obvious at boot without ever logging the secret.
func (c *Config) ProviderKeySummary() string {
	mask := func(k string) string {
		switch {
		case k == "":
			return "<unset>"
		case len(k) <= 10:
			return fmt.Sprintf("***(%d)", len(k))
		default:
			return fmt.Sprintf("%s…%s(%d)", k[:6], k[len(k)-4:], len(k))
		}
	}
	return fmt.Sprintf("deepseek=%s deepinfra=%s longcat=%s rayu-ollama=%s",
		mask(c.ProviderKeys["deepseek"]), mask(c.ProviderKeys["deepinfra"]), mask(c.ProviderKeys["longcat"]), mask(c.ProviderKeys["rayu-ollama"]))
}

// MySQLDSN converts a prisma-style "mysql://user:pass@host:port/db?params" URL
// into a go-sql-driver/mysql DSN "user:pass@tcp(host:port)/db?parseTime=true".
func MySQLDSN(raw string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return "", err
	}
	if u.Scheme != "mysql" {
		return "", fmt.Errorf("unsupported scheme %q (want mysql)", u.Scheme)
	}
	user := u.User.Username()
	pass, _ := u.User.Password()
	host := u.Host
	if host == "" {
		host = "127.0.0.1:3306"
	}
	dbName := strings.TrimPrefix(u.Path, "/")
	q := u.Query()
	q.Set("parseTime", "true")
	q.Set("loc", "UTC")

	cred := user
	if pass != "" {
		cred = user + ":" + pass
	}
	return fmt.Sprintf("%s@tcp(%s)/%s?%s", cred, host, dbName, q.Encode()), nil
}
