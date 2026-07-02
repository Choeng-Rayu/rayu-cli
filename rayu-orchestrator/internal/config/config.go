// Package config loads and validates the rayu-orchestrator configuration from
// environment variables.
//
// Policy: keys that gate capacity, security, or the sandbox/deploy runtime are
// REQUIRED and have no default — Load fails fast with a descriptive, key-named
// error when any of them is missing or malformed. Operational keys with a safe
// default are optional (their format is still validated when present). All
// validation problems are accumulated and returned together so a misconfigured
// deployment surfaces every issue at once rather than one boot at a time.
package config

import (
	"fmt"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Config holds all runtime configuration for the orchestrator. Numeric runtime
// limits are pre-converted into the units the Docker SDK expects (NanoCPUs,
// bytes) so downstream packages never re-parse raw env strings.
type Config struct {
	// HTTP server.
	Port string

	// Routing / proxy (Req 14).
	BaseDomain   string // wildcard app domain (prod) or sslip.io base (dev)
	PlatformHost string // existing platform host for the edge proxy's static routers
	DNSProvider  string // DNS-01 provider id for wildcard TLS (optional at boot)

	// Container runtime + networks (Req 5, 12, 14).
	DockerHost    string // Docker Engine API endpoint; empty = SDK default/socket
	BuildsDir     string // bind-mounted workspaces root
	ProxyNetwork  string // network shared between the proxy and App_Containers
	EgressNetwork string // egress-restricted build network

	// Admission control + quotas (Req 3, 17).
	MaxConcurrentBuilds int
	PerUserConcurrency  int
	PerUserDaily        int

	// Sandbox image + resource limits (Req 4, 5.6).
	SandboxImage    string
	SandboxNanoCPUs int64 // derived from SANDBOX_CPU (cpu count * 1e9)
	SandboxMemBytes int64 // derived from SANDBOX_MEM
	SandboxPids     int64

	// Swarm invocation (Req 6.2).
	BuildModel string

	// Timeouts / tuning (Req 7.5, 12.5, 13.1, 19.2).
	BuildTimeout           time.Duration
	HealthCheckDeadline    time.Duration
	DeployCoalesceInterval time.Duration
	AppTTL                 time.Duration
	AppIdleTTL             time.Duration

	// Persistence (Req 9, 16).
	StoreDSN string // "memory://" or a MySQL DSN (MySQLStore wired in a later task)

	// Service auth + rate limiting (Req 15).
	ServiceAuthSecret string
	RateLimitRPS      float64

	// Redaction (Req 18.3, 21.4). Raw patterns, validated to compile here and
	// consumed by the central redactor in a later task.
	SecretPatterns []string
}

// Load reads and validates configuration from the process environment.
func Load() (*Config, error) {
	l := newLoader()
	c := &Config{
		// HTTP server (optional).
		Port: l.optStr("PORT", "9090"),

		// Required: routing, sandbox image, model, capacity (Req 14.4, 4, 6.2, 3.1, 17).
		BaseDomain:          l.reqStr("BASE_DOMAIN"),
		ServiceAuthSecret:   l.reqStr("SERVICE_AUTH_SECRET"),
		BuildModel:          l.reqStr("BUILD_MODEL"),
		SandboxImage:        l.reqStr("SANDBOX_IMAGE"),
		MaxConcurrentBuilds: l.reqPosInt("MAX_CONCURRENT_BUILDS"),
		PerUserConcurrency:  l.reqPosInt("PER_USER_CONCURRENCY"),
		PerUserDaily:        l.reqPosInt("PER_USER_DAILY"),

		// Required: sandbox resource limits (Req 5.6).
		SandboxNanoCPUs: l.reqCPUNanos("SANDBOX_CPU"),
		SandboxMemBytes: l.reqMemBytes("SANDBOX_MEM"),
		SandboxPids:     l.reqPosInt64("SANDBOX_PIDS"),

		// Required: timeouts/deadlines (Req 7.5, 13.1, 19.2).
		BuildTimeout:        l.reqDuration("BUILD_TIMEOUT"),
		HealthCheckDeadline: l.reqDuration("HEALTHCHECK_DEADLINE"),
		AppTTL:              l.reqDuration("APP_TTL"),
		AppIdleTTL:          l.reqDuration("APP_IDLE_TTL"),

		// Optional operational knobs with safe defaults.
		PlatformHost:           l.optStr("PLATFORM_HOST", ""),
		DNSProvider:            l.optStr("DNS_PROVIDER", ""),
		DockerHost:             l.optStr("DOCKER_HOST", ""),
		BuildsDir:              l.optStr("BUILDS_DIR", "/srv/builds"),
		ProxyNetwork:           l.optStr("PROXY_NETWORK", "proxy"),
		EgressNetwork:          l.optStr("EGRESS_NETWORK", "egress"),
		StoreDSN:               l.optStr("STORE_DSN", "memory://"),
		DeployCoalesceInterval: l.optDuration("DEPLOY_COALESCE_INTERVAL", 2*time.Second),
		RateLimitRPS:           l.optPosFloat("RATE_LIMIT_RPS", 20),
		SecretPatterns:         l.patterns("SECRET_PATTERNS"),
	}
	if err := l.err(); err != nil {
		return nil, err
	}
	return c, nil
}

// loader accumulates validation problems while reading env keys so Load can
// report all of them in a single error.
type loader struct {
	getenv func(string) string // injectable for tests; defaults to os.Getenv
	errs   []string
}

// newLoader builds the loader Load uses. It is a package var so tests can inject
// a hermetic env source instead of mutating the process environment.
var newLoader = func() *loader { return &loader{} }

func (l *loader) env(key string) string {
	if l.getenv != nil {
		return strings.TrimSpace(l.getenv(key))
	}
	return strings.TrimSpace(os.Getenv(key))
}

func (l *loader) addf(format string, args ...any) {
	l.errs = append(l.errs, fmt.Sprintf(format, args...))
}

func (l *loader) err() error {
	if len(l.errs) == 0 {
		return nil
	}
	return fmt.Errorf("invalid orchestrator configuration: %s", strings.Join(l.errs, "; "))
}

func (l *loader) reqStr(key string) string {
	v := l.env(key)
	if v == "" {
		l.addf("%s is required", key)
	}
	return v
}

func (l *loader) optStr(key, def string) string {
	if v := l.env(key); v != "" {
		return v
	}
	return def
}

func (l *loader) reqPosInt(key string) int {
	v := l.env(key)
	if v == "" {
		l.addf("%s is required", key)
		return 0
	}
	n, err := strconv.Atoi(v)
	if err != nil || n <= 0 {
		l.addf("%s must be a positive integer (got %q)", key, v)
		return 0
	}
	return n
}

func (l *loader) reqPosInt64(key string) int64 {
	v := l.env(key)
	if v == "" {
		l.addf("%s is required", key)
		return 0
	}
	n, err := strconv.ParseInt(v, 10, 64)
	if err != nil || n <= 0 {
		l.addf("%s must be a positive integer (got %q)", key, v)
		return 0
	}
	return n
}

func (l *loader) optPosFloat(key string, def float64) float64 {
	v := l.env(key)
	if v == "" {
		return def
	}
	f, err := strconv.ParseFloat(v, 64)
	if err != nil || f <= 0 {
		l.addf("%s must be a positive number (got %q)", key, v)
		return def
	}
	return f
}

func (l *loader) reqDuration(key string) time.Duration {
	v := l.env(key)
	if v == "" {
		l.addf("%s is required", key)
		return 0
	}
	d, err := time.ParseDuration(v)
	if err != nil || d <= 0 {
		l.addf("%s must be a positive Go duration such as 30s or 5m (got %q)", key, v)
		return 0
	}
	return d
}

func (l *loader) optDuration(key string, def time.Duration) time.Duration {
	v := l.env(key)
	if v == "" {
		return def
	}
	d, err := time.ParseDuration(v)
	if err != nil || d <= 0 {
		l.addf("%s must be a positive Go duration such as 30s or 5m (got %q)", key, v)
		return def
	}
	return d
}

// reqCPUNanos parses a CPU-count string ("1", "1.5", "0.5") into NanoCPUs for
// the Docker SDK (cpu count * 1e9).
func (l *loader) reqCPUNanos(key string) int64 {
	v := l.env(key)
	if v == "" {
		l.addf("%s is required", key)
		return 0
	}
	cpus, err := strconv.ParseFloat(v, 64)
	if err != nil || cpus <= 0 {
		l.addf("%s must be a positive CPU count such as 1 or 1.5 (got %q)", key, v)
		return 0
	}
	return int64(cpus * 1e9)
}

// reqMemBytes parses a memory string with an optional b/k/m/g suffix
// (1024-based, case-insensitive) into bytes, e.g. "512m" -> 536870912.
func (l *loader) reqMemBytes(key string) int64 {
	v := l.env(key)
	if v == "" {
		l.addf("%s is required", key)
		return 0
	}
	bytes, err := parseMemBytes(v)
	if err != nil {
		l.addf("%s must be a memory size such as 512m or 2g (got %q)", key, v)
		return 0
	}
	return bytes
}

// patterns reads a comma-separated list of secret regex patterns, validating
// that each compiles. Empty/whitespace entries are skipped.
func (l *loader) patterns(key string) []string {
	raw := l.env(key)
	if raw == "" {
		return nil
	}
	var out []string
	for _, p := range strings.Split(raw, ",") {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		if _, err := regexp.Compile(p); err != nil {
			l.addf("%s contains an invalid regular expression %q: %v", key, p, err)
			continue
		}
		out = append(out, p)
	}
	return out
}

var memRe = regexp.MustCompile(`^([0-9]+)([bkmgBKMG]?)$`)

func parseMemBytes(s string) (int64, error) {
	m := memRe.FindStringSubmatch(strings.TrimSpace(s))
	if m == nil {
		return 0, fmt.Errorf("invalid memory size %q", s)
	}
	n, err := strconv.ParseInt(m[1], 10, 64)
	if err != nil || n <= 0 {
		return 0, fmt.Errorf("invalid memory size %q", s)
	}
	var mult int64 = 1
	switch strings.ToLower(m[2]) {
	case "", "b":
		mult = 1
	case "k":
		mult = 1024
	case "m":
		mult = 1024 * 1024
	case "g":
		mult = 1024 * 1024 * 1024
	}
	return n * mult, nil
}
