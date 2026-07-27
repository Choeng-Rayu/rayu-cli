// Package providercfg turns an admin-managed provider row into a validated,
// ready-to-use upstream route.
//
// The provider registry in MySQL is the single source of truth for hosted
// routing (it replaced the RAYU_PROVIDERS / RAYU_DISABLED_PROVIDERS /
// OLLAMA_PROVIDER_NAME env registry). API keys live in provider_api_keys,
// encrypted at rest, and are decrypted once per config refresh into
// internal/providerkeys — this package never sees a secret.
//
// BaseURL is admin-supplied and is fetched server-side WITH a provider key
// attached, so it is validated HERE as well as in the backend: unrestricted it is
// both an SSRF pivot (cloud metadata, internal admin panels) and a key
// exfiltration channel, so it must be https to a non-private host.
//
// Validating in both places is intentional defence in depth: the backend stops
// bad input at the API, and this package stops bad ROWS — including ones written
// directly to the database, bypassing the API entirely.
package providercfg

import (
	"fmt"
	"net"
	"net/url"
	"strings"
)

// Wire formats a provider can speak. The gateway's canonical internal format is
// Anthropic Messages (what the CLI speaks); the others are translated by an
// adapter in internal/translate. Values match the backend's PROVIDER_FORMATS.
const (
	FormatAnthropicMessages = "anthropic_messages"
	FormatOpenAIChat        = "openai_chat"
	FormatOpenAIResponses   = "openai_responses"
	FormatGenAI             = "genai"
)

// Auth schemes, matching the backend's PROVIDER_AUTH_SCHEMES.
const (
	AuthBearer      = "bearer"
	AuthXAPIKey     = "x_api_key"
	AuthXGoogAPIKey = "x_goog_api_key"
)

// DefaultEndpointPath mirrors the backend's FORMAT_DEFAULTS so a provider row
// with no explicit path still routes. genai has no fixed path: its URL embeds
// the model id and streaming mode, so its adapter builds it.
func DefaultEndpointPath(format string) string {
	switch format {
	case FormatAnthropicMessages:
		return "/anthropic/v1/messages"
	case FormatOpenAIChat:
		return "/v1/chat/completions"
	case FormatOpenAIResponses:
		return "/v1/responses"
	default:
		return ""
	}
}

// KnownFormat reports whether the gateway understands a provider's format.
func KnownFormat(format string) bool {
	switch format {
	case FormatAnthropicMessages, FormatOpenAIChat, FormatOpenAIResponses, FormatGenAI:
		return true
	}
	return false
}

// Route is a validated upstream provider, ready to route a request: where to go,
// how to authenticate, and which keys to try (in order, with failover).
type Route struct {
	Name         string
	Format       string
	BaseURL      string
	EndpointPath string
	AuthScheme   string
	// KeyCount is how many API keys this provider has. The secrets are held by
	// internal/providerkeys, which also owns per-key health and rotation.
	KeyCount int
	// Enabled is the admin kill switch.
	Enabled bool
}

// Bearer reports whether the key travels as `Authorization: Bearer`.
func (r Route) Bearer() bool { return r.AuthScheme == AuthBearer }

// HasKey reports whether the provider has at least one API key configured.
func (r Route) HasKey() bool { return r.KeyCount > 0 }

// URL joins the provider's base URL with a path, preserving any path prefix on
// the base (e.g. https://host/openai + /v1/responses).
func (r Route) URL(path string) string {
	base := strings.TrimRight(r.BaseURL, "/")
	if path == "" {
		return base
	}
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	return base + path
}

// Endpoint is the provider's configured endpoint, falling back to the format
// default when the admin left the override blank.
func (r Route) Endpoint() string {
	path := r.EndpointPath
	if path == "" {
		path = DefaultEndpointPath(r.Format)
	}
	return r.URL(path)
}

// Options controls how a row is turned into a Route.
type Options struct {
	// AllowInsecure permits http/private base URLs (local development only).
	AllowInsecure bool
}

// Row is the subset of a provider row this package needs. It is declared here
// (rather than importing the store) so validation has no database dependency.
type Row struct {
	Name         string
	Format       string
	BaseURL      string
	EndpointPath string
	AuthScheme   string
	Enabled      bool
	// KeyCount is how many API keys the provider has configured. The keys
	// themselves live in internal/providerkeys (decrypted, in memory); the route
	// only needs to know whether there is anything to authenticate with.
	KeyCount int
}

// Build validates a provider row and resolves its keys. A row that fails
// validation is returned WITH the error so callers can log the reason and refuse
// to route it — never silently "fix" it, which would send traffic (and a key)
// somewhere the admin did not configure.
func Build(row Row, opts Options) (Route, error) {
	r := Route{
		Name:         row.Name,
		Format:       row.Format,
		BaseURL:      strings.TrimRight(strings.TrimSpace(row.BaseURL), "/"),
		EndpointPath: strings.TrimSpace(row.EndpointPath),
		AuthScheme:   strings.TrimSpace(row.AuthScheme),
		KeyCount:     row.KeyCount,
		Enabled:      row.Enabled,
	}
	if !KnownFormat(r.Format) {
		return r, fmt.Errorf("unknown format %q", r.Format)
	}
	if err := ValidateBaseURL(r.BaseURL, opts.AllowInsecure); err != nil {
		return r, err
	}
	if err := ValidateEndpointPath(r.EndpointPath); err != nil {
		return r, err
	}
	switch r.AuthScheme {
	case AuthBearer, AuthXAPIKey, AuthXGoogAPIKey:
	default:
		return r, fmt.Errorf("unknown authScheme %q", r.AuthScheme)
	}
	return r, nil
}

// localHostnames always mean "this machine / this network".
var localHostnames = map[string]bool{
	"localhost":                true,
	"localhost.localdomain":    true,
	"ip6-localhost":            true,
	"metadata":                 true,
	"metadata.google.internal": true,
	"instance-data":            true,
}

// ValidateBaseURL enforces https to a public host. Plain http (or a private
// host) is only allowed when allowInsecure is set, for local development against
// a self-hosted upstream.
func ValidateBaseURL(raw string, allowInsecure bool) error {
	if raw == "" {
		return fmt.Errorf("baseUrl is empty")
	}
	u, err := url.Parse(raw)
	if err != nil {
		return fmt.Errorf("baseUrl %q is not a valid URL", raw)
	}
	if u.Host == "" {
		return fmt.Errorf("baseUrl %q has no host", raw)
	}
	if u.User != nil {
		return fmt.Errorf("baseUrl must not embed credentials")
	}
	if u.RawQuery != "" || u.Fragment != "" {
		return fmt.Errorf("baseUrl must not contain a query string or fragment")
	}
	private := IsPrivateHost(u.Host)
	switch u.Scheme {
	case "https":
		if private && !allowInsecure {
			return fmt.Errorf("baseUrl host %q is private/loopback", u.Hostname())
		}
	case "http":
		// The provider key travels over this connection.
		if !allowInsecure || !private {
			return fmt.Errorf("baseUrl must use https")
		}
	default:
		return fmt.Errorf("baseUrl scheme %q is not allowed", u.Scheme)
	}
	return nil
}

// ValidateEndpointPath checks an optional path override.
func ValidateEndpointPath(path string) error {
	if path == "" {
		return nil // use the format default
	}
	if !strings.HasPrefix(path, "/") {
		return fmt.Errorf("endpointPath %q must start with /", path)
	}
	if strings.Contains(path, "..") {
		return fmt.Errorf("endpointPath %q must not contain ..", path)
	}
	if strings.Contains(path, "://") || strings.Contains(path, "?") || strings.Contains(path, "#") {
		return fmt.Errorf("endpointPath %q must be a path only", path)
	}
	return nil
}

// IsPrivateHost reports whether a host[:port] is loopback, private, link-local
// (including the 169.254.169.254 metadata address), or otherwise not routable on
// the public internet. Hostnames that are not IP literals are only matched
// against a small local-name list — name RESOLUTION is deliberately not done
// here (it would add a DNS round-trip to the request path); egress restrictions
// are the right control for DNS rebinding.
func IsPrivateHost(host string) bool {
	h := host
	if hostOnly, _, err := net.SplitHostPort(host); err == nil {
		h = hostOnly
	}
	h = strings.ToLower(strings.Trim(h, "[]"))
	if localHostnames[h] || strings.HasSuffix(h, ".local") {
		return true
	}
	if ip := net.ParseIP(h); ip != nil {
		return IsPrivateIP(ip)
	}
	return false
}

// IsPrivateIP reports whether an IP is loopback, private, link-local, CGNAT,
// unspecified, or multicast.
func IsPrivateIP(ip net.IP) bool {
	if ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() ||
		ip.IsLinkLocalMulticast() || ip.IsUnspecified() || ip.IsMulticast() {
		return true
	}
	// 100.64.0.0/10 — carrier-grade NAT, not covered by IsPrivate.
	if v4 := ip.To4(); v4 != nil && v4[0] == 100 && v4[1] >= 64 && v4[1] <= 127 {
		return true
	}
	return false
}

// MaskKey renders a key for logs/health output without ever revealing it:
// "sk-e2…71c8(35)". Empty keys are reported as unset.
func MaskKey(k string) string {
	switch {
	case k == "":
		return "<unset>"
	case len(k) <= 10:
		return fmt.Sprintf("***(%d)", len(k))
	default:
		return fmt.Sprintf("%s…%s(%d)", k[:6], k[len(k)-4:], len(k))
	}
}
