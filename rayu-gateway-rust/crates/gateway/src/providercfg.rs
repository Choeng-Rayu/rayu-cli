//! Turns an admin-managed provider row into a validated, ready-to-use upstream
//! route.
//!
//! Port of the Go gateway's `internal/providercfg`.
//!
//! The provider registry in MySQL is the single source of truth for hosted
//! routing. API keys live in `provider_api_keys`, encrypted at rest, and are
//! decrypted once per config refresh into [`crate::providerkeys`] -- this module
//! never sees a secret.
//!
//! `base_url` is admin-supplied and is fetched server-side WITH a provider key
//! attached, so it is validated HERE as well as in the backend: unrestricted it is
//! both an SSRF pivot (cloud metadata, internal admin panels) and a key
//! exfiltration channel, so it must be https to a non-private host.
//!
//! Validating in both places is intentional defence in depth: the backend stops
//! bad input at the API, and this module stops bad ROWS -- including ones written
//! directly to the database, bypassing the API entirely.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

use percent_encoding::{utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};

/// Wire formats a provider can speak.
///
/// The gateway's canonical internal format is Anthropic Messages (what the CLI
/// speaks); the others are translated by an adapter. Values match the backend's
/// `PROVIDER_FORMATS`.
pub const FORMAT_ANTHROPIC_MESSAGES: &str = "anthropic_messages";
pub const FORMAT_OPENAI_CHAT: &str = "openai_chat";
pub const FORMAT_OPENAI_RESPONSES: &str = "openai_responses";
pub const FORMAT_GENAI: &str = "genai";
/// AWS Bedrock's Anthropic surface.
///
/// It speaks Anthropic Messages, but three things make it its own format rather
/// than a variant: the model id lives in the URL PATH (`/model/{model}/invoke`),
/// the body must carry `anthropic_version` and must NOT carry `model` or `stream`,
/// and streaming responses are AWS event-stream frames instead of SSE.
pub const FORMAT_BEDROCK_ANTHROPIC: &str = "bedrock_anthropic";

/// The token an endpoint path may use to say "the upstream model id goes here"
/// (Bedrock's per-model invoke URL). Substituted at request time, path-escaped.
pub const MODEL_PLACEHOLDER: &str = "{model}";

/// Auth schemes, matching the backend's `PROVIDER_AUTH_SCHEMES`.
pub const AUTH_BEARER: &str = "bearer";
pub const AUTH_X_API_KEY: &str = "x_api_key";
pub const AUTH_X_GOOG_API_KEY: &str = "x_goog_api_key";

/// The characters Go's `url.PathEscape` leaves unescaped.
///
/// Go escapes everything except alphanumerics, `-_.~`, and the reserved
/// characters a path SEGMENT is allowed to carry (`$&+:=@`); `/;,?` stay escaped
/// because they would otherwise create a new segment or query. Reproduced exactly
/// so a Bedrock model id (which contains `.`, `-` and `:`) is passed through
/// untouched while an admin typo containing `/` cannot inject a path segment.
const GO_PATH_SEGMENT: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'~')
    .remove(b'$')
    .remove(b'&')
    .remove(b'+')
    .remove(b':')
    .remove(b'=')
    .remove(b'@');

/// Mirrors the backend's `FORMAT_DEFAULTS` so a provider row with no explicit path
/// still routes.
///
/// `genai` has no fixed path: its URL embeds the model id and streaming mode, so
/// its adapter builds it.
pub fn default_endpoint_path(format: &str) -> &'static str {
    match format {
        FORMAT_ANTHROPIC_MESSAGES => "/anthropic/v1/messages",
        FORMAT_OPENAI_CHAT => "/v1/chat/completions",
        FORMAT_OPENAI_RESPONSES => "/v1/responses",
        // Bedrock's non-streaming invoke path. The adapter swaps the suffix for
        // invoke-with-response-stream when the client asked to stream.
        FORMAT_BEDROCK_ANTHROPIC => "/model/{model}/invoke",
        _ => "",
    }
}

/// Whether the gateway understands a provider's format.
pub fn known_format(format: &str) -> bool {
    matches!(
        format,
        FORMAT_ANTHROPIC_MESSAGES
            | FORMAT_OPENAI_CHAT
            | FORMAT_OPENAI_RESPONSES
            | FORMAT_GENAI
            | FORMAT_BEDROCK_ANTHROPIC
    )
}

/// A validated upstream provider, ready to route a request: where to go, how to
/// authenticate, and how many keys are available.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Route {
    pub name: String,
    pub format: String,
    pub base_url: String,
    pub endpoint_path: String,
    pub auth_scheme: String,
    /// How many API keys this provider has. The secrets are held by
    /// [`crate::providerkeys`], which also owns per-key health and rotation.
    pub key_count: usize,
    /// The admin kill switch.
    pub enabled: bool,
}

impl Route {
    /// Whether the key travels as `Authorization: Bearer`.
    pub fn bearer(&self) -> bool {
        self.auth_scheme == AUTH_BEARER
    }

    /// Whether the provider has at least one API key configured.
    pub fn has_key(&self) -> bool {
        self.key_count > 0
    }

    /// Joins the provider's base URL with a path, preserving any path prefix on
    /// the base (e.g. `https://host/openai` + `/v1/responses`).
    pub fn url(&self, path: &str) -> String {
        let base = self.base_url.trim_end_matches('/');
        if path.is_empty() {
            return base.to_string();
        }
        if path.starts_with('/') {
            format!("{base}{path}")
        } else {
            format!("{base}/{path}")
        }
    }

    /// The provider's configured endpoint, falling back to the format default when
    /// the admin left the override blank.
    pub fn endpoint(&self) -> String {
        let path = if self.endpoint_path.is_empty() {
            default_endpoint_path(&self.format)
        } else {
            &self.endpoint_path
        };
        self.url(path)
    }

    /// [`Route::endpoint`] with the `{model}` placeholder resolved, for formats
    /// whose URL carries the model id (Bedrock).
    ///
    /// A path without the placeholder is returned unchanged, so every other format
    /// is unaffected.
    pub fn endpoint_for(&self, upstream_model_id: &str) -> String {
        let path = if self.endpoint_path.is_empty() {
            default_endpoint_path(&self.format).to_string()
        } else {
            self.endpoint_path.clone()
        };
        if path.contains(MODEL_PLACEHOLDER) {
            let escaped = utf8_percent_encode(upstream_model_id, GO_PATH_SEGMENT).to_string();
            return self.url(&path.replace(MODEL_PLACEHOLDER, &escaped));
        }
        self.url(&path)
    }
}

/// Controls how a row is turned into a [`Route`].
#[derive(Debug, Clone, Copy, Default)]
pub struct Options {
    /// Permits http/private base URLs (local development only).
    pub allow_insecure: bool,
}

/// The subset of a provider row this module needs.
///
/// Declared here (rather than importing the store) so validation has no database
/// dependency.
#[derive(Debug, Clone, Default)]
pub struct Row {
    pub name: String,
    pub format: String,
    pub base_url: String,
    pub endpoint_path: String,
    pub auth_scheme: String,
    pub enabled: bool,
    /// How many API keys the provider has configured. The keys themselves live in
    /// [`crate::providerkeys`]; the route only needs to know whether there is
    /// anything to authenticate with.
    pub key_count: usize,
}

/// Why a provider row must not be routed. The messages are surfaced verbatim to
/// admins (provider health + provider test), so they name the bad field.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ConfigError {
    #[error("unknown format {0:?}")]
    UnknownFormat(String),
    #[error("unknown authScheme {0:?}")]
    UnknownAuthScheme(String),
    #[error("baseUrl is empty")]
    BaseUrlEmpty,
    #[error("baseUrl {0:?} is not a valid URL")]
    BaseUrlInvalid(String),
    #[error("baseUrl {0:?} has no host")]
    BaseUrlNoHost(String),
    #[error("baseUrl must not embed credentials")]
    BaseUrlCredentials,
    #[error("baseUrl must not contain a query string or fragment")]
    BaseUrlQueryOrFragment,
    #[error("baseUrl host {0:?} is private/loopback")]
    BaseUrlPrivateHost(String),
    #[error("baseUrl must use https")]
    BaseUrlNotHttps,
    #[error("baseUrl scheme {0:?} is not allowed")]
    BaseUrlScheme(String),
    #[error("endpointPath {0:?} must start with /")]
    EndpointPathRelative(String),
    #[error("endpointPath {0:?} must not contain ..")]
    EndpointPathTraversal(String),
    #[error("endpointPath {0:?} must be a path only")]
    EndpointPathNotAPath(String),
}

/// Validates a provider row and resolves its route.
///
/// A row that fails validation is returned WITH the error so callers can log the
/// reason and refuse to route it -- never silently "fix" it, which would send
/// traffic (and a key) somewhere the admin did not configure.
///
/// Validation order matches Go: format, base URL, endpoint path, auth scheme.
pub fn build(row: Row, opts: Options) -> (Route, Option<ConfigError>) {
    let route = Route {
        name: row.name,
        format: row.format,
        base_url: row.base_url.trim().trim_end_matches('/').to_string(),
        endpoint_path: row.endpoint_path.trim().to_string(),
        auth_scheme: row.auth_scheme.trim().to_string(),
        key_count: row.key_count,
        enabled: row.enabled,
    };

    if !known_format(&route.format) {
        return (
            route.clone(),
            Some(ConfigError::UnknownFormat(route.format.clone())),
        );
    }
    if let Err(e) = validate_base_url(&route.base_url, opts.allow_insecure) {
        return (route, Some(e));
    }
    if let Err(e) = validate_endpoint_path(&route.endpoint_path) {
        return (route, Some(e));
    }
    if !matches!(
        route.auth_scheme.as_str(),
        AUTH_BEARER | AUTH_X_API_KEY | AUTH_X_GOOG_API_KEY
    ) {
        return (
            route.clone(),
            Some(ConfigError::UnknownAuthScheme(route.auth_scheme.clone())),
        );
    }
    (route, None)
}

/// Hostnames that always mean "this machine / this network".
const LOCAL_HOSTNAMES: &[&str] = &[
    "localhost",
    "localhost.localdomain",
    "ip6-localhost",
    "metadata",
    "metadata.google.internal",
    "instance-data",
];

/// Enforces https to a public host.
///
/// Plain http (or a private host) is only allowed when `allow_insecure` is set,
/// for local development against a self-hosted upstream.
pub fn validate_base_url(raw: &str, allow_insecure: bool) -> Result<(), ConfigError> {
    if raw.is_empty() {
        return Err(ConfigError::BaseUrlEmpty);
    }
    let parsed = match url::Url::parse(raw) {
        Ok(u) => u,
        // Go's url.Parse is lenient: a bare "example.com" parses with an empty
        // Host and is reported as "has no host". Match that classification rather
        // than reporting a syntax error the admin cannot act on.
        Err(url::ParseError::RelativeUrlWithoutBase) => {
            return Err(ConfigError::BaseUrlNoHost(raw.to_string()))
        }
        Err(_) => return Err(ConfigError::BaseUrlInvalid(raw.to_string())),
    };

    let host = match parsed.host_str() {
        Some(h) if !h.is_empty() => h.to_string(),
        _ => return Err(ConfigError::BaseUrlNoHost(raw.to_string())),
    };
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(ConfigError::BaseUrlCredentials);
    }
    if parsed.query().is_some() || parsed.fragment().is_some() {
        return Err(ConfigError::BaseUrlQueryOrFragment);
    }

    let private = is_private_host(&host);
    match parsed.scheme() {
        "https" => {
            if private && !allow_insecure {
                return Err(ConfigError::BaseUrlPrivateHost(host));
            }
        }
        "http" => {
            // The provider key travels over this connection, so plaintext is only
            // ever acceptable to a private host in development.
            if !allow_insecure || !private {
                return Err(ConfigError::BaseUrlNotHttps);
            }
        }
        other => return Err(ConfigError::BaseUrlScheme(other.to_string())),
    }
    Ok(())
}

/// Checks an optional path override.
pub fn validate_endpoint_path(path: &str) -> Result<(), ConfigError> {
    if path.is_empty() {
        return Ok(()); // use the format default
    }
    if !path.starts_with('/') {
        return Err(ConfigError::EndpointPathRelative(path.to_string()));
    }
    if path.contains("..") {
        return Err(ConfigError::EndpointPathTraversal(path.to_string()));
    }
    if path.contains("://") || path.contains('?') || path.contains('#') {
        return Err(ConfigError::EndpointPathNotAPath(path.to_string()));
    }
    Ok(())
}

/// Whether a `host` or `host:port` is loopback, private, link-local (including the
/// 169.254.169.254 metadata address), or otherwise not routable on the public
/// internet.
///
/// Hostnames that are not IP literals are only matched against a small local-name
/// list -- name RESOLUTION is deliberately not done here (it would add a DNS
/// round-trip to the config refresh); egress restrictions are the right control
/// for DNS rebinding.
pub fn is_private_host(host: &str) -> bool {
    let mut h = host.trim();
    // Strip an optional port, tolerating a bracketed IPv6 literal.
    if h.starts_with('[') {
        if let Some(end) = h.find(']') {
            h = &h[1..end];
        }
    } else if let Some(idx) = h.rfind(':') {
        // Only treat the tail as a port when it is numeric; a bare IPv6 literal
        // contains colons too.
        if h[idx + 1..].chars().all(|c| c.is_ascii_digit()) && !h[..idx].contains(':') {
            h = &h[..idx];
        }
    }
    let lower = h
        .trim_matches(|c| c == '[' || c == ']')
        .to_ascii_lowercase();

    if LOCAL_HOSTNAMES.contains(&lower.as_str()) || lower.ends_with(".local") {
        return true;
    }
    match lower.parse::<IpAddr>() {
        Ok(ip) => is_private_ip(ip),
        Err(_) => false,
    }
}

/// Whether an IP is loopback, private, link-local, CGNAT, unspecified, or
/// multicast.
///
/// Implemented explicitly rather than with std's helpers because the IPv6
/// equivalents (`is_unique_local`, `is_unicast_link_local`) are still unstable,
/// and because the CGNAT range Go adds by hand has no std predicate at all.
pub fn is_private_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_private_ipv4(v4),
        IpAddr::V6(v6) => {
            // An IPv4-mapped address is really an IPv4 address; Go's ip.To4()
            // makes the same reduction.
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_private_ipv4(v4);
            }
            is_private_ipv6(v6)
        }
    }
}

fn is_private_ipv4(ip: Ipv4Addr) -> bool {
    let o = ip.octets();
    ip.is_loopback()          // 127.0.0.0/8
        || ip.is_private()    // 10/8, 172.16/12, 192.168/16
        || ip.is_link_local() // 169.254.0.0/16 (includes cloud metadata)
        || ip.is_unspecified()// 0.0.0.0
        || ip.is_multicast()  // 224.0.0.0/4
        || ip.is_broadcast()  // 255.255.255.255
        // 100.64.0.0/10 -- carrier-grade NAT, not covered by is_private().
        || (o[0] == 100 && (64..=127).contains(&o[1]))
}

fn is_private_ipv6(ip: Ipv6Addr) -> bool {
    let s = ip.segments();
    ip.is_loopback()            // ::1
        || ip.is_unspecified()  // ::
        || ip.is_multicast()    // ff00::/8 (covers link-local multicast)
        || (s[0] & 0xfe00) == 0xfc00  // fc00::/7 unique-local
        || (s[0] & 0xffc0) == 0xfe80 // fe80::/10 link-local unicast
}

/// Renders a key for logs/health output without ever revealing it:
/// `sk-e2…71c8(35)`. Empty keys are reported as unset.
///
/// The threshold differs from `secretbox::mask` (10 vs 12) -- both are reproduced
/// as-is because both strings appear in operator-facing output.
pub fn mask_key(k: &str) -> String {
    let b = k.as_bytes();
    match b.len() {
        0 => "<unset>".to_string(),
        n if n <= 10 => format!("***({n})"),
        n => format!(
            "{}…{}({})",
            String::from_utf8_lossy(&b[..6]),
            String::from_utf8_lossy(&b[n - 4..]),
            n
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_row() -> Row {
        Row {
            name: "openrouter".into(),
            format: FORMAT_OPENAI_CHAT.into(),
            base_url: "https://openrouter.ai/api".into(),
            endpoint_path: "/v1/chat/completions".into(),
            auth_scheme: AUTH_BEARER.into(),
            enabled: true,
            key_count: 1,
        }
    }

    #[test]
    fn build_resolves_endpoint_and_key_presence() {
        let (r, err) = build(valid_row(), Options::default());
        assert!(err.is_none(), "{err:?}");
        assert_eq!(
            r.endpoint(),
            "https://openrouter.ai/api/v1/chat/completions"
        );
        assert_eq!(r.key_count, 1);
        assert!(r.bearer());
        assert!(r.has_key());
    }

    #[test]
    fn build_falls_back_to_format_default_path() {
        let cases = [
            (
                FORMAT_ANTHROPIC_MESSAGES,
                "https://api.deepseek.com/anthropic/v1/messages",
            ),
            (
                FORMAT_OPENAI_CHAT,
                "https://api.deepseek.com/v1/chat/completions",
            ),
            (
                FORMAT_OPENAI_RESPONSES,
                "https://api.deepseek.com/v1/responses",
            ),
            // genai has no fixed path -- its adapter builds a model-specific URL.
            (FORMAT_GENAI, "https://api.deepseek.com"),
        ];
        for (format, want) in cases {
            let row = Row {
                format: format.into(),
                endpoint_path: String::new(),
                auth_scheme: AUTH_X_API_KEY.into(),
                base_url: "https://api.deepseek.com".into(),
                ..valid_row()
            };
            let (r, err) = build(row, Options::default());
            assert!(err.is_none(), "build({format}): {err:?}");
            assert_eq!(r.endpoint(), want, "format {format}");
        }
    }

    /// A provider whose base URL carries a path prefix must keep it.
    #[test]
    fn url_preserves_base_path_prefix() {
        let r = Route {
            base_url: "https://gw.example/openai/".into(),
            endpoint_path: "/v1/responses".into(),
            format: FORMAT_OPENAI_RESPONSES.into(),
            ..Default::default()
        };
        assert_eq!(r.endpoint(), "https://gw.example/openai/v1/responses");
    }

    /// One entry of the unsafe-row table: a label plus the mutation that makes the
    /// row invalid. Aliased so the table literal stays readable.
    type RowMutation = (&'static str, Box<dyn Fn(&mut Row)>);

    /// A bad row must be REFUSED, not silently repaired -- the gateway would
    /// otherwise send a provider key somewhere the admin never configured.
    #[test]
    fn build_rejects_unsafe_rows() {
        let cases: Vec<RowMutation> = vec![
            (
                "http upstream",
                Box::new(|r: &mut Row| r.base_url = "http://openrouter.ai".into()),
            ),
            (
                "loopback",
                Box::new(|r: &mut Row| r.base_url = "https://127.0.0.1:8080".into()),
            ),
            (
                "localhost name",
                Box::new(|r: &mut Row| r.base_url = "https://localhost".into()),
            ),
            (
                "cloud metadata ip",
                Box::new(|r: &mut Row| r.base_url = "https://169.254.169.254".into()),
            ),
            (
                "metadata name",
                Box::new(|r: &mut Row| r.base_url = "https://metadata.google.internal".into()),
            ),
            (
                "private class A",
                Box::new(|r: &mut Row| r.base_url = "https://10.0.0.5".into()),
            ),
            (
                "private class B",
                Box::new(|r: &mut Row| r.base_url = "https://172.16.9.9".into()),
            ),
            (
                "private class C",
                Box::new(|r: &mut Row| r.base_url = "https://192.168.1.10".into()),
            ),
            (
                "cgnat",
                Box::new(|r: &mut Row| r.base_url = "https://100.100.1.1".into()),
            ),
            (
                "ipv6 loopback",
                Box::new(|r: &mut Row| r.base_url = "https://[::1]:443".into()),
            ),
            (
                "ipv6 ula",
                Box::new(|r: &mut Row| r.base_url = "https://[fd00::1]".into()),
            ),
            (
                "embedded creds",
                Box::new(|r: &mut Row| r.base_url = "https://u:p@openrouter.ai".into()),
            ),
            (
                "query string",
                Box::new(|r: &mut Row| r.base_url = "https://openrouter.ai?x=1".into()),
            ),
            (
                "non-http scheme",
                Box::new(|r: &mut Row| r.base_url = "ftp://openrouter.ai".into()),
            ),
            (
                "unknown format",
                Box::new(|r: &mut Row| r.format = "grpc_magic".into()),
            ),
            (
                "unknown auth",
                Box::new(|r: &mut Row| r.auth_scheme = "hmac".into()),
            ),
            (
                "relative path",
                Box::new(|r: &mut Row| r.endpoint_path = "v1/messages".into()),
            ),
            (
                "path traversal",
                Box::new(|r: &mut Row| r.endpoint_path = "/../secrets".into()),
            ),
            (
                "absolute path url",
                Box::new(|r: &mut Row| r.endpoint_path = "https://evil.example/v1".into()),
            ),
        ];
        for (name, mutate) in cases {
            let mut row = valid_row();
            mutate(&mut row);
            let (_, err) = build(row, Options::default());
            assert!(
                err.is_some(),
                "build with {name} was accepted, want refusal"
            );
        }
    }

    #[test]
    fn build_allows_private_http_only_when_explicitly_enabled() {
        let mut row = valid_row();
        row.base_url = "http://127.0.0.1:11434".into();
        assert!(
            build(row.clone(), Options::default()).1.is_some(),
            "private http accepted without allow_insecure"
        );
        assert!(
            build(
                row.clone(),
                Options {
                    allow_insecure: true
                }
            )
            .1
            .is_none(),
            "private http refused with allow_insecure"
        );

        // Even with the dev flag, a PUBLIC http host stays refused: that would send
        // the key over plaintext to the internet.
        row.base_url = "http://openrouter.ai".into();
        assert!(
            build(
                row,
                Options {
                    allow_insecure: true
                }
            )
            .1
            .is_some(),
            "public http accepted with allow_insecure"
        );
    }

    #[test]
    fn build_succeeds_without_any_key() {
        // A valid row with zero keys must still build (so health output can report
        // keyPresent=false); the request path is what refuses to route it.
        let row = Row {
            key_count: 0,
            ..valid_row()
        };
        let (r, err) = build(row, Options::default());
        assert!(err.is_none(), "{err:?}");
        assert!(!r.has_key());
    }

    #[test]
    fn mask_key_never_reveals_the_secret() {
        const SECRET: &str = "sk-abcdef0123456789abcdef";
        let masked = mask_key(SECRET);
        assert_ne!(masked, SECRET);
        assert_eq!(mask_key(""), "<unset>");
        assert_eq!(mask_key("short"), "***(5)");
        // The threshold is 10 here (secretbox::mask uses 12).
        assert_eq!(mask_key("0123456789"), "***(10)");
        assert_eq!(mask_key("01234567890"), "012345…7890(11)");
        assert_eq!(masked, "sk-abc…cdef(25)");
    }

    #[test]
    fn bedrock_endpoint_substitutes_and_escapes_the_model() {
        let r = Route {
            base_url: "https://bedrock-runtime.us-east-1.amazonaws.com".into(),
            endpoint_path: String::new(),
            format: FORMAT_BEDROCK_ANTHROPIC.into(),
            ..Default::default()
        };
        // A real Bedrock id contains dots, dashes and a colon -- all legal in a
        // path segment, so Go leaves them untouched and so must this.
        assert_eq!(
            r.endpoint_for("anthropic.claude-sonnet-4-20250514-v1:0"),
            "https://bedrock-runtime.us-east-1.amazonaws.com/model/\
             anthropic.claude-sonnet-4-20250514-v1:0/invoke"
        );
        // A slash would create an extra path segment, so it MUST be escaped.
        assert_eq!(
            r.endpoint_for("evil/../../admin"),
            "https://bedrock-runtime.us-east-1.amazonaws.com/model/\
             evil%2F..%2F..%2Fadmin/invoke"
        );
        // A space escapes as %20, like Go's PathEscape.
        assert_eq!(
            r.endpoint_for("has space"),
            "https://bedrock-runtime.us-east-1.amazonaws.com/model/has%20space/invoke"
        );
    }

    #[test]
    fn endpoint_for_leaves_placeholderless_paths_alone() {
        let r = Route {
            base_url: "https://api.deepseek.com".into(),
            endpoint_path: "/anthropic/v1/messages".into(),
            format: FORMAT_ANTHROPIC_MESSAGES.into(),
            ..Default::default()
        };
        assert_eq!(
            r.endpoint_for("deepseek-chat"),
            "https://api.deepseek.com/anthropic/v1/messages"
        );
    }

    /// The expected values on the right were produced by running Go's
    /// `net/url.PathEscape` on the same inputs. The escape set is subtle -- `$&+:=@`
    /// stay literal while `/;,?` and `()*!'` are escaped -- and getting it wrong
    /// would either break real Bedrock model ids or let one inject a path segment.
    #[test]
    fn path_escaping_matches_go_url_pathescape() {
        let cases = [
            (
                "anthropic.claude-sonnet-4-20250514-v1:0",
                "anthropic.claude-sonnet-4-20250514-v1:0",
            ),
            ("evil/../../admin", "evil%2F..%2F..%2Fadmin"),
            ("has space", "has%20space"),
            ("a+b&c=d@e$f", "a+b&c=d@e$f"),
            ("semi;colon,comma?q", "semi%3Bcolon%2Ccomma%3Fq"),
            ("tilde~dash-under_dot.", "tilde~dash-under_dot."),
            (
                "paren()star*bang!quote'",
                "paren%28%29star%2Abang%21quote%27",
            ),
        ];
        for (input, want) in cases {
            let got = utf8_percent_encode(input, GO_PATH_SEGMENT).to_string();
            assert_eq!(got, want, "PathEscape({input:?})");
        }
    }

    #[test]
    fn private_host_classification() {
        for host in [
            "localhost",
            "LOCALHOST",
            "localhost.localdomain",
            "ip6-localhost",
            "metadata",
            "metadata.google.internal",
            "instance-data",
            "printer.local",
            "127.0.0.1",
            "127.0.0.1:8080",
            "10.1.2.3",
            "172.31.255.255",
            "192.168.0.1",
            "169.254.169.254",
            "100.64.0.1",
            "100.127.255.255",
            "0.0.0.0",
            "224.0.0.1",
            "255.255.255.255",
            "[::1]",
            "[::1]:443",
            "[fd00::1]",
            "[fe80::1]",
            "[ff02::1]",
            "::ffff:10.0.0.1",
        ] {
            assert!(is_private_host(host), "{host} should be private");
        }

        for host in [
            "openrouter.ai",
            "api.deepseek.com",
            "api.deepseek.com:443",
            "8.8.8.8",
            "1.1.1.1",
            "99.99.99.99",
            "100.63.255.255", // just below the CGNAT range
            "100.128.0.1",    // just above it
            "[2606:4700::1]",
            "localhost.example.com",
        ] {
            assert!(!is_private_host(host), "{host} should be public");
        }
    }

    #[test]
    fn validate_endpoint_path_cases() {
        assert!(validate_endpoint_path("").is_ok());
        assert!(validate_endpoint_path("/v1/messages").is_ok());
        assert!(validate_endpoint_path("/model/{model}/invoke").is_ok());
        assert_eq!(
            validate_endpoint_path("v1/messages").unwrap_err(),
            ConfigError::EndpointPathRelative("v1/messages".into())
        );
        assert_eq!(
            validate_endpoint_path("/../secrets").unwrap_err(),
            ConfigError::EndpointPathTraversal("/../secrets".into())
        );
        assert_eq!(
            validate_endpoint_path("/v1?x=1").unwrap_err(),
            ConfigError::EndpointPathNotAPath("/v1?x=1".into())
        );
        assert_eq!(
            validate_endpoint_path("/v1#frag").unwrap_err(),
            ConfigError::EndpointPathNotAPath("/v1#frag".into())
        );
    }

    /// The exact strings admins see in provider health and the provider test.
    #[test]
    fn error_messages_match_go() {
        assert_eq!(
            ConfigError::UnknownFormat("grpc_magic".into()).to_string(),
            "unknown format \"grpc_magic\""
        );
        assert_eq!(
            ConfigError::UnknownAuthScheme("hmac".into()).to_string(),
            "unknown authScheme \"hmac\""
        );
        assert_eq!(
            ConfigError::BaseUrlPrivateHost("127.0.0.1".into()).to_string(),
            "baseUrl host \"127.0.0.1\" is private/loopback"
        );
        assert_eq!(
            ConfigError::BaseUrlNotHttps.to_string(),
            "baseUrl must use https"
        );
        assert_eq!(ConfigError::BaseUrlEmpty.to_string(), "baseUrl is empty");
        assert_eq!(
            ConfigError::BaseUrlCredentials.to_string(),
            "baseUrl must not embed credentials"
        );
        assert_eq!(
            ConfigError::BaseUrlQueryOrFragment.to_string(),
            "baseUrl must not contain a query string or fragment"
        );
    }

    #[test]
    fn known_format_covers_all_five() {
        for f in [
            FORMAT_ANTHROPIC_MESSAGES,
            FORMAT_OPENAI_CHAT,
            FORMAT_OPENAI_RESPONSES,
            FORMAT_GENAI,
            FORMAT_BEDROCK_ANTHROPIC,
        ] {
            assert!(known_format(f), "{f}");
        }
        for f in ["", "grpc_magic", "anthropic", "openai"] {
            assert!(!known_format(f), "{f}");
        }
    }

    #[test]
    fn build_trims_and_normalises() {
        let row = Row {
            base_url: "  https://api.deepseek.com/  ".into(),
            endpoint_path: "  /v1/chat/completions  ".into(),
            auth_scheme: "  bearer  ".into(),
            ..valid_row()
        };
        let (r, err) = build(row, Options::default());
        assert!(err.is_none(), "{err:?}");
        assert_eq!(r.base_url, "https://api.deepseek.com");
        assert_eq!(r.endpoint_path, "/v1/chat/completions");
        assert_eq!(r.auth_scheme, "bearer");
        assert_eq!(r.endpoint(), "https://api.deepseek.com/v1/chat/completions");
    }
}
