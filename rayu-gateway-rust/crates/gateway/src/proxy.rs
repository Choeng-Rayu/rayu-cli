//! The transparent, authenticated reverse proxy for BYO-key providers.
//!
//! Port of `handleProxy` and its helpers from the Go gateway's
//! `internal/server/server.go`, plus `proxy.Forward` from `internal/proxy`.
//!
//! # What it is for
//!
//! When the CLI has `USE_RAYU_OAUTH` on but the user is paying their own provider,
//! the request still comes through Rayu so usage can be tracked and the daily-turn
//! cap enforced -- but the gateway charges NO credits and holds NO provider key. The
//! caller's own `Authorization` / `x-api-key` header is replayed to the upstream
//! verbatim.
//!
//! Because of that the identity comes from `X-Rayu-Token`, NOT `Authorization`: the
//! latter carries the USER'S OWN upstream credential, which must be forwarded
//! untouched.
//!
//! Any gateway-origin failure carries an `X-Rayu-Proxy-Error` header so the CLI can
//! tell it apart from a forwarded upstream response and fail safe to a direct call.

use std::net::{IpAddr, SocketAddr};
use std::sync::OnceLock;

use axum::response::Response;
use http::{HeaderMap, HeaderName, HeaderValue, StatusCode};
use rayu_core::httpx;
use regex::Regex;
use serde_json::Value;

use crate::providercfg::is_private_ip;

/// Marks a gateway-origin error so the CLI can distinguish it from a forwarded
/// upstream response and fall back to a direct provider call.
pub const PROXY_ERROR_HEADER: &str = "x-rayu-proxy-error";

/// Positive marker that a response really was proxied by this gateway.
///
/// The CLI checks it so an older gateway without this route (404), a redirect or an
/// error page can be told apart from a genuine proxy pass-through.
pub const PROXIED_HEADER: &str = "x-rayu-proxied";

/// Names the machine-readable limit when the gateway itself refuses.
pub const LIMIT_HEADER: &str = "x-rayu-limit";

/// Flags a model-fidelity refusal.
pub const MODEL_FIDELITY_HEADER: &str = "x-rayu-model-fidelity";

/// Per-connection headers that must not be forwarded.
const HOP_BY_HOP: &[&str] = &[
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
];

/// Writes a gateway-origin error tagged with [`PROXY_ERROR_HEADER`].
pub fn proxy_error(status: StatusCode, msg: &str) -> Response {
    let mut resp = httpx::write_error(status, msg);
    if let Ok(v) = HeaderValue::from_str(msg) {
        resp.headers_mut().insert(PROXY_ERROR_HEADER, v);
    }
    resp
}

/// Reads a header, falling back to `def` when absent or blank.
pub fn header_or(h: &HeaderMap, key: &str, def: &str) -> String {
    match h.get(key).and_then(|v| v.to_str().ok()).map(str::trim) {
        Some(v) if !v.is_empty() => v.to_string(),
        _ => def.to_string(),
    }
}

/// The headers to replay to the upstream.
///
/// Everything except the gateway's own control headers (`X-Rayu-*`), `Host` and
/// `Content-Length` (set from the new request and body), and hop-by-hop headers. The
/// provider's auth header (`Authorization` / `x-api-key`) is PRESERVED so the upstream
/// authenticates the caller.
pub fn forwardable_headers(h: &HeaderMap) -> HeaderMap {
    let mut out = HeaderMap::new();
    for (name, value) in h.iter() {
        let n = name.as_str();
        if n.starts_with("x-rayu-")
            || n == "host"
            || n == "content-length"
            || HOP_BY_HOP.contains(&n)
        {
            continue;
        }
        out.append(name.clone(), value.clone());
    }
    out
}

/// Why an upstream URL was refused.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum UpstreamUrlError {
    #[error("invalid upstream url")]
    Invalid,
    #[error("upstream must be https")]
    NotHttps,
    #[error("upstream host required")]
    NoHost,
    #[error("upstream host not allowed")]
    NotAllowed,
}

/// Enforces https and blocks SSRF to private/loopback/link-local hosts, so the
/// authenticated proxy cannot be used to reach internal services or the cloud
/// metadata endpoint.
///
/// `allow_insecure` relaxes both guards so a test can reach a loopback upstream (Go
/// achieves the same by making `validateUpstreamURL` a package var).
pub fn validate_upstream_url(raw: &str, allow_insecure: bool) -> Result<(), UpstreamUrlError> {
    let u = url::Url::parse(raw).map_err(|_| UpstreamUrlError::Invalid)?;
    if !allow_insecure && u.scheme() != "https" {
        return Err(UpstreamUrlError::NotHttps);
    }
    let host = u.host_str().unwrap_or("");
    if host.is_empty() {
        return Err(UpstreamUrlError::NoHost);
    }
    if !allow_insecure && crate::providercfg::is_private_host(host) {
        return Err(UpstreamUrlError::NotAllowed);
    }
    Ok(())
}

/// Matches the model id in a Bedrock invoke URL.
///
/// The AnthropicBedrock SDK moves the model OUT of the JSON body and INTO the path
/// (`/model/{id}/invoke`, `/model/{id}/invoke-with-response-stream`), so reading the
/// body returns `""` for Bedrock and the real model must come from the URL -- which is
/// why gateway logs used to show `model=""`.
fn bedrock_model_url_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"/model/([^/]+)/invoke(?:-with-response-stream)?(?:$|\?|#)")
            .expect("valid regex")
    })
}

/// Extracts the model id from a Bedrock invoke URL, or `""` when it is not one.
pub fn model_from_upstream_url(upstream: &str) -> String {
    let Some(caps) = bedrock_model_url_re().captures(upstream) else {
        return String::new();
    };
    let raw = caps.get(1).map(|m| m.as_str()).unwrap_or("");
    if raw.is_empty() {
        return String::new();
    }
    percent_encoding::percent_decode_str(raw)
        .decode_utf8()
        .map(|s| s.to_string())
        .unwrap_or_else(|_| raw.to_string())
}

/// Pulls the `model` field from a JSON request body, for tracking.
pub fn best_effort_model(body: &[u8]) -> String {
    serde_json::from_slice::<Value>(body)
        .ok()
        .and_then(|v| v.get("model").and_then(|m| m.as_str()).map(String::from))
        .unwrap_or_default()
}

/// Classifies a model id/alias into its Claude family by substring, or `"other"` for
/// non-Claude / opaque ids.
///
/// Mirrors the CLI's own `modelFamilyOf` so both ends agree on the fidelity rule.
pub fn model_family_of(model: &str) -> &'static str {
    let m = model.to_ascii_lowercase();
    if m.contains("opus") {
        "opus"
    } else if m.contains("sonnet") {
        "sonnet"
    } else if m.contains("haiku") {
        "haiku"
    } else {
        "other"
    }
}

/// Reports a DEFINITE cross-family mismatch between the intended and the
/// actually-routed model.
///
/// Both must classify to a known (non-`"other"`) family and those families must
/// differ. Unknown/opaque ids never trigger it, so an enterprise deployment id or a
/// custom inference profile is never falsely flagged.
pub fn family_mismatch(intended: &str, actual: &str) -> bool {
    if intended.is_empty() || actual.is_empty() {
        return false;
    }
    let (fi, fa) = (model_family_of(intended), model_family_of(actual));
    if fi == "other" || fa == "other" {
        return false;
    }
    fi != fa
}

/// The allow-list of client identities that may appear in `usage_events.source`.
///
/// An allow-list rather than a passthrough ON PURPOSE: `X-Rayu-Query-Source` is
/// client-controlled, and letting arbitrary strings into an analytics column makes it
/// impossible to `GROUP BY` afterwards (and would need its own length/charset guard
/// against the `VarChar(32)` column).
const USAGE_EVENT_CLIENTS: &[(&str, &str)] = &[("studio", "studio")];

/// Maps the request's `X-Rayu-Query-Source` to the value stored in
/// `usage_events.source` on the BYO-key proxy path.
///
/// The CLI sends no `X-Rayu-Query-Source` at all, and historically every proxied row
/// was written as `"gateway"`. That default is preserved EXACTLY -- only a client that
/// names itself in the allow-list gets its own bucket, so Rayu Studio traffic is
/// separable from CLI traffic without rewriting the meaning of existing rows.
///
/// The source may be a bare client name (`"studio"`) or client-qualified
/// (`"studio:chat"`); only the segment before the first colon is considered.
pub fn usage_event_source(source: &str) -> &'static str {
    let name = source.trim().to_ascii_lowercase();
    let name = name.split(':').next().unwrap_or("");
    for (client, mapped) in USAGE_EVENT_CLIENTS {
        if *client == name {
            return mapped;
        }
    }
    "gateway"
}

/// I3: a DNS resolver that refuses to hand back a private address.
///
/// The Go gateway resolves the host once in `validateUpstreamURL` and then lets the
/// transport resolve it AGAIN when connecting -- a DNS-rebind window in which an
/// attacker-controlled name can answer `1.2.3.4` for the check and `169.254.169.254`
/// for the connect. Checking at RESOLVE time closes it, because the answer that is
/// validated is the same one the connection uses.
///
/// Disabled by `RAYU_PROXY_PIN_DNS=0`, which restores Go's behaviour exactly.
#[derive(Debug, Default)]
pub struct PublicOnlyResolver;

impl reqwest::dns::Resolve for PublicOnlyResolver {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let host = name.as_str().to_string();
        Box::pin(async move {
            let addrs = tokio::net::lookup_host(format!("{host}:0"))
                .await
                .map_err(|e| -> Box<dyn std::error::Error + Send + Sync> { Box::new(e) })?;
            let kept: Vec<SocketAddr> = addrs.filter(|a| !is_private_ip(a.ip())).collect();
            if kept.is_empty() {
                return Err(Box::<dyn std::error::Error + Send + Sync>::from(format!(
                    "upstream host {host} resolves only to disallowed addresses"
                )));
            }
            Ok(Box::new(kept.into_iter()) as reqwest::dns::Addrs)
        })
    }
}

/// Whether an address is one this proxy may connect to.
pub fn is_allowed_upstream_ip(ip: &IpAddr) -> bool {
    !is_private_ip(*ip)
}

/// Copies every upstream response header onto the client response.
///
/// A transparent proxy must not editorialise: the CLI reads `content-type`,
/// `anthropic-*`, rate-limit headers and more straight through.
pub fn copy_upstream_headers(from: &HeaderMap, to: &mut HeaderMap) {
    for (name, value) in from.iter() {
        // Hop-by-hop headers describe the upstream connection, not this one.
        if HOP_BY_HOP.contains(&name.as_str()) {
            continue;
        }
        to.append(name.clone(), value.clone());
    }
}

/// Builds the header name/value pair for a `Retry-After`, when the value is useful.
pub fn retry_after(seconds: i64) -> Option<(HeaderName, HeaderValue)> {
    if seconds <= 0 {
        return None;
    }
    HeaderValue::from_str(&seconds.to_string())
        .ok()
        .map(|v| (http::header::RETRY_AFTER, v))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_https_public_hosts_are_allowed() {
        assert!(validate_upstream_url("https://api.anthropic.com/v1/messages", false).is_ok());

        assert_eq!(
            validate_upstream_url("http://api.anthropic.com", false),
            Err(UpstreamUrlError::NotHttps),
            "plaintext would expose the caller's own provider key"
        );
        assert_eq!(
            validate_upstream_url("not a url", false),
            Err(UpstreamUrlError::Invalid)
        );
        // The SSRF cases that matter: loopback, link-local metadata, and RFC1918.
        for raw in [
            "https://localhost/v1",
            "https://127.0.0.1/v1",
            "https://169.254.169.254/latest/meta-data/",
            "https://10.0.0.5/v1",
            "https://192.168.1.1/v1",
            "https://[::1]/v1",
        ] {
            assert_eq!(
                validate_upstream_url(raw, false),
                Err(UpstreamUrlError::NotAllowed),
                "{raw} must be refused"
            );
        }
    }

    /// The escape hatch exists only so a test can reach a loopback upstream.
    #[test]
    fn allow_insecure_relaxes_both_guards() {
        assert!(validate_upstream_url("http://127.0.0.1:8080/v1", true).is_ok());
        // A URL with no host at all is still refused.
        assert_eq!(
            validate_upstream_url("file:///etc/passwd", true),
            Err(UpstreamUrlError::NoHost)
        );
    }

    #[test]
    fn the_gateways_own_control_headers_are_never_forwarded() {
        let mut h = HeaderMap::new();
        h.insert("authorization", "Bearer user-own-provider-key".parse().unwrap());
        h.insert("x-api-key", "sk-user-own".parse().unwrap());
        h.insert("anthropic-version", "2023-06-01".parse().unwrap());
        h.insert("content-type", "application/json".parse().unwrap());
        h.insert("x-rayu-token", "rayu-jwt".parse().unwrap());
        h.insert("x-rayu-upstream-url", "https://x/y".parse().unwrap());
        h.insert("host", "gateway.rayucode.com".parse().unwrap());
        h.insert("content-length", "123".parse().unwrap());
        h.insert("connection", "keep-alive".parse().unwrap());

        let out = forwardable_headers(&h);
        // The caller's OWN provider credential must survive: it is what authenticates
        // the upstream call.
        assert_eq!(
            out.get("authorization").unwrap(),
            "Bearer user-own-provider-key"
        );
        assert_eq!(out.get("x-api-key").unwrap(), "sk-user-own");
        assert_eq!(out.get("anthropic-version").unwrap(), "2023-06-01");
        assert_eq!(out.get("content-type").unwrap(), "application/json");

        // The Rayu identity must NOT leak to the provider.
        assert!(out.get("x-rayu-token").is_none());
        assert!(out.get("x-rayu-upstream-url").is_none());
        assert!(out.get("host").is_none(), "Host is set from the new URL");
        assert!(out.get("content-length").is_none());
        assert!(out.get("connection").is_none(), "hop-by-hop");
    }

    #[test]
    fn a_bedrock_model_is_read_from_the_url() {
        assert_eq!(
            model_from_upstream_url(
                "https://bedrock-runtime.us-east-1.amazonaws.com/model/us.anthropic.claude-sonnet-4-6/invoke"
            ),
            "us.anthropic.claude-sonnet-4-6"
        );
        assert_eq!(
            model_from_upstream_url(
                "https://x/model/anthropic.claude-3-haiku-20240307-v1:0/invoke-with-response-stream"
            ),
            "anthropic.claude-3-haiku-20240307-v1:0"
        );
        // A percent-encoded id is decoded back to what the user meant.
        assert_eq!(
            model_from_upstream_url("https://x/model/foo%2Fbar/invoke"),
            "foo/bar"
        );
        // A query string or fragment still terminates the match.
        assert_eq!(
            model_from_upstream_url("https://x/model/m1/invoke?x=1"),
            "m1"
        );
        // Not a Bedrock URL.
        assert_eq!(
            model_from_upstream_url("https://api.anthropic.com/v1/messages"),
            ""
        );
        assert_eq!(model_from_upstream_url("https://x/model//invoke"), "");
    }

    #[test]
    fn the_model_falls_back_to_the_body() {
        assert_eq!(
            best_effort_model(br#"{"model":"claude-sonnet-4-6","max_tokens":8}"#),
            "claude-sonnet-4-6"
        );
        assert_eq!(best_effort_model(b"not json"), "");
        assert_eq!(best_effort_model(br#"{"model":123}"#), "");
    }

    #[test]
    fn model_families_are_classified_by_substring() {
        assert_eq!(model_family_of("us.anthropic.claude-opus-4-1"), "opus");
        assert_eq!(model_family_of("claude-sonnet-4-6"), "sonnet");
        assert_eq!(model_family_of("CLAUDE-HAIKU-3-5"), "haiku");
        assert_eq!(model_family_of("gpt-5.5"), "other");
        assert_eq!(model_family_of(""), "other");
    }

    /// Only a DEFINITE cross-family mismatch counts, so an opaque enterprise id is
    /// never falsely flagged.
    #[test]
    fn family_mismatch_only_fires_on_two_known_different_families() {
        assert!(family_mismatch("claude-sonnet-4-6", "claude-opus-4-1"));
        assert!(family_mismatch("claude-haiku-3-5", "claude-sonnet-4-6"));

        assert!(!family_mismatch("claude-sonnet-4-6", "claude-sonnet-4-6"));
        assert!(
            !family_mismatch("claude-sonnet-4-6", "arn:aws:bedrock:profile/abc123"),
            "an opaque inference profile must not be flagged"
        );
        assert!(!family_mismatch("", "claude-opus-4-1"));
        assert!(!family_mismatch("claude-opus-4-1", ""));
        assert!(!family_mismatch("gpt-5.5", "claude-opus-4-1"));
    }

    /// Ports Go's `TestUsageEventSource`: the historic default must not change, and
    /// only an allow-listed client gets its own bucket.
    #[test]
    fn usage_event_source_defaults_to_gateway() {
        // The CLI sends nothing, so this is the overwhelmingly common case.
        assert_eq!(usage_event_source(""), "gateway");
        assert_eq!(usage_event_source("unknown"), "gateway");
        assert_eq!(usage_event_source("repl_main_thread"), "gateway");
        // An arbitrary client-controlled string must NOT reach the analytics column.
        assert_eq!(usage_event_source("'; DROP TABLE users;--"), "gateway");
        assert_eq!(usage_event_source("a".repeat(500).as_str()), "gateway");

        // Allow-listed, bare and client-qualified, case-insensitive, trimmed.
        assert_eq!(usage_event_source("studio"), "studio");
        assert_eq!(usage_event_source("studio:chat"), "studio");
        assert_eq!(usage_event_source("  STUDIO:agent  "), "studio");
        // A near-miss is not the allow-listed client.
        assert_eq!(usage_event_source("studios"), "gateway");
    }

    /// Ports Go's `TestUsageEventSourceFitsColumn`: every value this can return must
    /// fit `usage_events.source VarChar(32)`.
    #[test]
    fn every_usage_event_source_fits_the_column() {
        const MAX: usize = 32;
        let mut all: Vec<&str> = vec!["gateway"];
        all.extend(USAGE_EVENT_CLIENTS.iter().map(|(_, mapped)| *mapped));
        for v in all {
            assert!(
                v.len() <= MAX,
                "{v:?} is {} bytes, over the VarChar(32) column",
                v.len()
            );
            assert!(
                v.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'),
                "{v:?} must be a safe analytics key"
            );
        }
    }

    #[test]
    fn header_or_falls_back_on_blank() {
        let mut h = HeaderMap::new();
        h.insert("x-rayu-provider", "  anthropic ".parse().unwrap());
        h.insert("x-rayu-query-source", "   ".parse().unwrap());
        assert_eq!(header_or(&h, "x-rayu-provider", "unknown"), "anthropic");
        assert_eq!(
            header_or(&h, "x-rayu-query-source", "unknown"),
            "unknown",
            "a blank header is not a value"
        );
        assert_eq!(header_or(&h, "absent", "unknown"), "unknown");
    }

    #[tokio::test]
    async fn a_gateway_error_is_tagged_so_the_cli_can_fail_safe() {
        let resp = proxy_error(StatusCode::BAD_GATEWAY, "upstream unreachable");
        assert_eq!(resp.status(), StatusCode::BAD_GATEWAY);
        assert_eq!(
            resp.headers().get(PROXY_ERROR_HEADER).unwrap(),
            "upstream unreachable",
            "without this header the CLI cannot tell a gateway fault from a provider one"
        );
    }

    #[test]
    fn upstream_headers_are_copied_except_hop_by_hop() {
        let mut from = HeaderMap::new();
        from.insert("content-type", "text/event-stream".parse().unwrap());
        from.insert("anthropic-ratelimit-requests-remaining", "42".parse().unwrap());
        from.insert("transfer-encoding", "chunked".parse().unwrap());
        let mut to = HeaderMap::new();
        copy_upstream_headers(&from, &mut to);
        assert_eq!(to.get("content-type").unwrap(), "text/event-stream");
        assert_eq!(
            to.get("anthropic-ratelimit-requests-remaining").unwrap(),
            "42",
            "a transparent proxy must relay the provider's own rate-limit headers"
        );
        assert!(
            to.get("transfer-encoding").is_none(),
            "hop-by-hop describes the upstream connection, not this one"
        );
    }

    #[test]
    fn private_addresses_are_never_allowed_upstream() {
        for ip in [
            "127.0.0.1",
            "169.254.169.254",
            "10.1.2.3",
            "192.168.0.1",
            "172.16.0.1",
            "::1",
        ] {
            assert!(
                !is_allowed_upstream_ip(&ip.parse().unwrap()),
                "{ip} must be refused"
            );
        }
        for ip in ["1.1.1.1", "104.18.32.1", "2606:4700::1111"] {
            assert!(is_allowed_upstream_ip(&ip.parse().unwrap()), "{ip}");
        }
    }

    #[test]
    fn retry_after_is_omitted_when_useless() {
        assert!(retry_after(0).is_none(), "Retry-After: 0 reads as 'forever'");
        assert!(retry_after(-1).is_none());
        assert_eq!(retry_after(30).unwrap().1, "30");
    }
}
