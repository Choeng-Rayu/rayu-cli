// Package config loads the gateway configuration from environment variables.
// The gateway shares the backend's DATABASE_URL (prisma-style) and JWT secret.
//
// Provider ROUTING is NOT configured here: it comes from the `providers` table
// (the admin-managed registry), which replaced the RAYU_PROVIDERS /
// RAYU_DISABLED_PROVIDERS / OLLAMA_PROVIDER_NAME env variables. Provider API KEYS
// are not here either — they are encrypted rows in provider_api_keys, entered in
// the admin dashboard. The only provider-related secret in the environment is
// RAYU_PROVIDER_SECRET (see internal/secretbox), the master key that opens them,
// which must match the backend's.
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
	ConfigRefresh int      // seconds between in-memory config refreshes
	UserCacheTTL  int      // seconds to cache per-user entitlements
	ConfigChannel string   // Redis pub/sub channel for admin config invalidation (empty = default)
	MaxInFlight   int      // global cap on concurrently-processed hosted streaming requests (RAYU_MAX_INFLIGHT; 0 = unlimited)
	CorsOrigins   []string // allowed browser origins for the dashboard
	// AllowInsecureProviderBaseURL permits http / private-host provider base URLs
	// (ALLOW_INSECURE_PROVIDER_BASE_URL). Development only: a provider's API key
	// is sent to that URL, so plaintext or internal targets are refused by
	// default. The backend honours the same variable when validating admin input.
	AllowInsecureProviderBaseURL bool
	// EnforceModelFidelity hard-rejects a /v1/proxy request whose intended model
	// family (X-Rayu-Intended-Model) differs from the model actually routed
	// (Bedrock URL path / body). Default OFF: mismatches are only logged. Env
	// RAYU_ENFORCE_MODEL_FIDELITY=1 turns on hard rejection (defense-in-depth).
	EnforceModelFidelity bool
	// ProxyBodyReadTimeoutSeconds bounds how long the gateway waits to read a
	// /v1/proxy request body before giving up with 408 (RAYU_PROXY_BODY_READ_TIMEOUT
	// seconds; 0 = no explicit deadline). Deliberately NOT a global server
	// WriteTimeout, which would break long SSE streams.
	ProxyBodyReadTimeoutSeconds int
}

// EnvTruthy reports whether an env value means "on" (1/true/yes/on, any case).
func EnvTruthy(v string) bool {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
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
	}
	if c.JWTSecret == "" {
		return nil, fmt.Errorf("RAYU_JWT_SECRET is required")
	}
	c.ConfigRefresh, _ = strconv.Atoi(getenv("CONFIG_REFRESH_SECONDS", "30"))
	c.UserCacheTTL, _ = strconv.Atoi(getenv("USER_CACHE_TTL_SECONDS", "10"))
	// Redis pub/sub channel used to tell every replica that an admin changed the
	// configuration, so a dashboard save takes effect immediately instead of at the
	// next CONFIG_REFRESH_SECONDS tick. Empty uses configbus.DefaultChannel. Both
	// the publisher and the subscriber are this gateway, so nothing else needs to
	// know the value — it only has to MATCH across replicas sharing a Redis.
	c.ConfigChannel = os.Getenv("RAYU_CONFIG_CHANNEL")
	// Global load-shedding valve: max hosted streaming requests processed at once
	// (0 = unlimited). When exceeded, the gateway sheds with a fast, clean 503 so
	// a burst of concurrent users degrades gracefully instead of exhausting the
	// origin's connections/FDs and collapsing into Cloudflare origin_bad_gateway.
	c.MaxInFlight, _ = strconv.Atoi(getenv("RAYU_MAX_INFLIGHT", "0"))

	// Model-fidelity enforcement + proxy body-read deadline (both default off/0).
	c.EnforceModelFidelity = EnvTruthy(os.Getenv("RAYU_ENFORCE_MODEL_FIDELITY"))
	c.ProxyBodyReadTimeoutSeconds, _ = strconv.Atoi(
		getenv("RAYU_PROXY_BODY_READ_TIMEOUT", "0"),
	)

	c.AllowInsecureProviderBaseURL = EnvTruthy(os.Getenv("ALLOW_INSECURE_PROVIDER_BASE_URL"))

	// Allowed browser origins for the dashboard's /v1/credits calls. Default "*"
	// is safe because every /v1 route still requires a valid Rayu JWT.
	for _, o := range strings.Split(getenv("GATEWAY_CORS_ORIGINS", "*"), ",") {
		if t := strings.TrimSpace(o); t != "" {
			c.CorsOrigins = append(c.CorsOrigins, t)
		}
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
