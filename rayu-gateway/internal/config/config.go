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

// ProviderMeta is the wire config for an upstream provider on the Anthropic
// Messages path: how to authenticate and how to build the URL. Populated from
// built-in defaults + the RAYU_PROVIDERS env registry, so a NEW provider is added
// entirely via .env with ZERO gateway code.
//   - Auth:     "bearer" (Authorization: Bearer) | "x-api-key" (Anthropic-standard)
//   - Endpoint: "anthropic" ({origin}/anthropic/v1/messages, e.g. DeepSeek/LongCat)
//               | "messages"  ({origin}/v1/messages, e.g. Ollama Cloud)
type ProviderMeta struct {
	Auth     string
	Endpoint string
}

// Config holds all runtime configuration for the gateway.
type Config struct {
	Port          string
	JWTSecret     string
	DatabaseURL   string // raw prisma-style URL (may be empty in tests)
	DatabaseDSN   string // go-sql-driver/mysql DSN derived from DatabaseURL
	RedisURL      string
	DeepSeekKey   string
	ProviderKeys  map[string]string // provider name -> api key (env-sourced)
	OllamaProvider string           // Ollama Cloud hosted-model provider name (OLLAMA_PROVIDER_NAME; default 'rayu-ollama')
	ProviderMeta  map[string]ProviderMeta // per-provider auth + endpoint (built-ins + RAYU_PROVIDERS registry)
	DisabledProviders map[string]bool     // providers turned OFF via RAYU_DISABLED_PROVIDERS (zero-code enable/disable)
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
	// Ollama Cloud's hosted-model provider name is configurable via
	// OLLAMA_PROVIDER_NAME (default 'rayu-ollama') so it can be renamed without a
	// code change — the backend seed reads the SAME env for hosted_models.provider,
	// and the gateway keys its Ollama routing (Bearer + {host}/v1/messages) off it.
	// OLLAMA_API_KEY is mapped onto that name (it has dashes, so KeyForProvider's
	// <PROVIDER>_API_KEY fallback can't derive it).
	c.OllamaProvider = strings.TrimSpace(os.Getenv("OLLAMA_PROVIDER_NAME"))
	if k := os.Getenv("OLLAMA_API_KEY"); k != "" {
		c.ProviderKeys[c.OllamaProviderName()] = k
	}

	// RAYU_PROVIDERS is a zero-code registry for ADDITIONAL upstream providers:
	// add an entry + set its key env var and the gateway can route a new provider
	// with NO code change (the backend just seeds models with that provider name).
	// Format: 'name:keyEnv:auth:endpoint' entries separated by ';'
	//   auth     default 'x-api-key'  (or 'bearer')
	//   endpoint default 'anthropic'  (or 'messages' for {host}/v1/messages)
	// e.g. RAYU_PROVIDERS=openrouter:OPENROUTER_API_KEY:bearer:anthropic
	c.ProviderMeta = parseProviderRegistry(os.Getenv("RAYU_PROVIDERS"), c.ProviderKeys)

	// RAYU_DISABLED_PROVIDERS turns providers OFF with zero code: a comma-separated
	// list of provider names (built-in or registry) whose models the gateway
	// refuses to route (and the backend hides from users). Add a name to disable
	// that whole provider; remove it to re-enable. e.g. RAYU_DISABLED_PROVIDERS=longcat,deepinfra
	c.DisabledProviders = map[string]bool{}
	for _, p := range strings.Split(os.Getenv("RAYU_DISABLED_PROVIDERS"), ",") {
		if name := strings.TrimSpace(p); name != "" {
			c.DisabledProviders[name] = true
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

// KeyForProvider returns the upstream API key for a provider name, falling back
// to the <PROVIDER>_API_KEY env var (upper-cased) when not pre-mapped.
func (c *Config) KeyForProvider(provider string) string {
	if k, ok := c.ProviderKeys[provider]; ok && k != "" {
		return k
	}
	return os.Getenv(strings.ToUpper(provider) + "_API_KEY")
}

// KeysForProvider returns the upstream API keys for a provider, split from the
// (comma-separated) key string so a provider can rotate across MANY keys — e.g.
// OLLAMA_API_KEY="key1,key2,key3". Whitespace is trimmed and empty entries are
// dropped; a single key (no comma) yields a one-element slice unchanged, so
// single-key providers (deepseek/longcat) are entirely unaffected.
func (c *Config) KeysForProvider(provider string) []string {
	parts := strings.Split(c.KeyForProvider(provider), ",")
	keys := make([]string, 0, len(parts))
	for _, p := range parts {
		if k := strings.TrimSpace(p); k != "" {
			keys = append(keys, k)
		}
	}
	return keys
}

// defaultOllamaProvider is the fallback Ollama Cloud provider name when
// OLLAMA_PROVIDER_NAME is unset. It is only a default — the env var overrides it.
const defaultOllamaProvider = "rayu-ollama"

// OllamaProviderName returns the hosted-model provider name for Ollama Cloud,
// from OLLAMA_PROVIDER_NAME (default 'rayu-ollama'). It drives the gateway's
// Ollama routing (Bearer auth + {host}/v1/messages) + key lookup, and MUST match
// the hosted_models.provider value the backend seeds (which reads the same env),
// so the two stay in sync when the name changes.
func (c *Config) OllamaProviderName() string {
	if c.OllamaProvider != "" {
		return c.OllamaProvider
	}
	return defaultOllamaProvider
}

// parseProviderRegistry parses RAYU_PROVIDERS ('name:keyEnv:auth:endpoint'
// entries, ';'-separated) into per-provider metadata, and pulls each entry's key
// from its keyEnv into providerKeys (comma-separated key lists are supported by
// KeysForProvider). Missing auth/endpoint default to x-api-key/anthropic. This is
// the zero-code path for adding a new upstream provider via .env.
func parseProviderRegistry(raw string, providerKeys map[string]string) map[string]ProviderMeta {
	meta := map[string]ProviderMeta{}
	for _, entry := range strings.Split(raw, ";") {
		fields := strings.Split(strings.TrimSpace(entry), ":")
		name := strings.TrimSpace(fields[0])
		if name == "" {
			continue
		}
		m := ProviderMeta{Auth: "x-api-key", Endpoint: "anthropic"}
		if len(fields) > 2 {
			if a := strings.TrimSpace(fields[2]); a != "" {
				m.Auth = a
			}
		}
		if len(fields) > 3 {
			if e := strings.TrimSpace(fields[3]); e != "" {
				m.Endpoint = e
			}
		}
		meta[name] = m
		if len(fields) > 1 {
			if keyEnv := strings.TrimSpace(fields[1]); keyEnv != "" {
				if k := os.Getenv(keyEnv); k != "" && providerKeys != nil {
					providerKeys[name] = k
				}
			}
		}
	}
	return meta
}

// knownProviderDefaults returns the built-in auth/endpoint for the shipped
// providers, used when a provider isn't declared in the RAYU_PROVIDERS registry.
// New providers should be added via the registry (zero code); these are just the
// batteries-included defaults for deepseek/longcat/ollama.
func knownProviderDefaults(name, ollamaName string) ProviderMeta {
	switch {
	case name == "longcat":
		return ProviderMeta{Auth: "bearer", Endpoint: "anthropic"}
	case name != "" && name == ollamaName:
		return ProviderMeta{Auth: "bearer", Endpoint: "messages"}
	default: // deepseek, deepinfra, first-party anthropic, or unknown
		return ProviderMeta{Auth: "x-api-key", Endpoint: "anthropic"}
	}
}

// providerMeta resolves a provider's wire config: an explicit RAYU_PROVIDERS
// registry entry wins; otherwise the built-in defaults apply.
func (c *Config) providerMeta(name string) ProviderMeta {
	if m, ok := c.ProviderMeta[name]; ok {
		return m
	}
	return knownProviderDefaults(name, c.OllamaProviderName())
}

// ProviderUsesBearer reports whether the provider authenticates with
// `Authorization: Bearer` (vs the Anthropic-standard `x-api-key`).
func (c *Config) ProviderUsesBearer(name string) bool {
	return c.providerMeta(name).Auth == "bearer"
}

// ProviderEndpointStyle returns how to build the provider's Anthropic Messages
// URL: "messages" ({host}/v1/messages, Ollama) or "anthropic"
// ({host}/anthropic/v1/messages, DeepSeek/LongCat/first-party).
func (c *Config) ProviderEndpointStyle(name string) string {
	return c.providerMeta(name).Endpoint
}

// ProviderDisabled reports whether a provider was turned OFF via
// RAYU_DISABLED_PROVIDERS. Disabled providers' models are refused by the gateway
// (before any credit charge) and hidden from users by the backend.
func (c *Config) ProviderDisabled(name string) bool {
	return c.DisabledProviders[name]
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
	return fmt.Sprintf("deepseek=%s deepinfra=%s longcat=%s %s=%d key(s)",
		mask(c.ProviderKeys["deepseek"]), mask(c.ProviderKeys["deepinfra"]), mask(c.ProviderKeys["longcat"]),
		c.OllamaProviderName(), len(c.KeysForProvider(c.OllamaProviderName())))
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
