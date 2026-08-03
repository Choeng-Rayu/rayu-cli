//! Router-level tests for the BYO-key proxy, `ANY /v1/proxy`.
//!
//! Ports the cases from the Go gateway's `internal/server/{proxy_cap_test.go,
//! proxy_fidelity_test.go}`.
//!
//! Two contracts dominate here:
//!
//! * a GATEWAY-origin failure must carry `X-Rayu-Proxy-Error` so the CLI fails safe to
//!   a direct provider call, while an INTENTIONAL gateway limit must NOT carry it (or
//!   the CLI would bypass the cap);
//! * the caller's own provider credential is forwarded untouched while every
//!   `X-Rayu-*` control header is stripped.

use std::collections::HashMap;
use std::sync::atomic::AtomicI64;
use std::sync::Arc;

use axum::body::Body;
use http::{Request, StatusCode};
use http_body_util::BodyExt;
use rayu_core::config::Config;
use rayu_core::eventqueue::Queue;
use rayu_core::store::{AppSettings, HostedModel, MediaModel, Plan, Provider};
use rayu_gateway_lib::configreload::ConfigReloader;
use rayu_gateway_lib::entitlements::{Entitlement, ProviderRoute, ResolveError};
use rayu_gateway_lib::limiter::Limiter;
use rayu_gateway_lib::providerkeys::Registry;
use rayu_gateway_lib::state::{AppState, EntSource, InflightLimiter};
use serde_json::{json, Value};
use tower::ServiceExt;
use wiremock::matchers::any as any_request;
use wiremock::{Mock, MockServer, ResponseTemplate};

const SECRET: &str = "test-secret-that-is-long-enough-32b";

macro_rules! require_redis {
    () => {
        match std::env::var("RAYU_TEST_REDIS_URL") {
            Ok(u) if !u.is_empty() => u,
            _ => {
                eprintln!("skipping: RAYU_TEST_REDIS_URL is not set");
                return;
            }
        }
    };
}

struct FakeEnt {
    plan: Plan,
}

#[async_trait::async_trait]
impl EntSource for FakeEnt {
    async fn resolve(&self, user_id: i64) -> Result<Entitlement, ResolveError> {
        Ok(Entitlement {
            user_id,
            status: "active".into(),
            plan: self.plan.clone(),
            period_end: None,
            allowed_models: vec![],
            topup_balance: 0,
        })
    }
    fn settings(&self) -> AppSettings {
        AppSettings::default()
    }
    fn invalidate(&self, _user_id: i64) {}
    fn route(&self, _provider_id: i64) -> Option<ProviderRoute> {
        None
    }
    fn routes(&self) -> HashMap<i64, ProviderRoute> {
        HashMap::new()
    }
    fn keys(&self) -> Arc<Registry> {
        Arc::new(Registry::new(None))
    }
    fn models(&self) -> Vec<HostedModel> {
        vec![]
    }
    fn media_models(&self) -> Vec<MediaModel> {
        vec![]
    }
    async fn reload(&self) -> Result<(), String> {
        Ok(())
    }
}

/// Silences the unused-import warnings for types the fake needs but never builds.
#[allow(dead_code)]
fn _unused(_: Provider) {}

struct Harness {
    state: Arc<AppState>,
    user_id: i64,
}

async fn harness(user_id: i64, max_daily_turns: Option<i64>, enforce_fidelity: bool) -> Harness {
    let redis_url = std::env::var("RAYU_TEST_REDIS_URL").unwrap_or_default();
    let lim = if redis_url.is_empty() {
        None
    } else {
        let l = Limiter::connect(&redis_url).await.expect("redis");
        l.reset_user_for_tests(user_id).await.expect("reset");
        Some(Arc::new(l))
    };
    let cfg = Arc::new(Config {
        jwt_secret: SECRET.into(),
        // The tests reach a loopback wiremock upstream, which the SSRF guard would
        // otherwise refuse. Go relaxes the same guard by overriding a package var.
        allow_insecure_provider_base_url: true,
        enforce_model_fidelity: enforce_fidelity,
        ..Default::default()
    });
    let state = Arc::new(AppState {
        cfg,
        ent: Arc::new(FakeEnt {
            plan: Plan {
                id: 1,
                code: "pro".into(),
                name: "Pro".into(),
                price_cents: 0,
                credits_per_period: Some(1_000_000),
                top_up_enabled: false,
                max_daily_turns,
            },
        }),
        lim,
        store: None,
        orgs: None,
        wq: Arc::new(Queue::new(Default::default())),
        inflight: Arc::new(InflightLimiter::new(0)),
        reloader: Arc::new(ConfigReloader::from_fn(|| async { Ok(()) }, None)),
        upstream: Arc::new(rayu_gateway_lib::upstream::Upstream::new()),
        shed_total: AtomicI64::new(0),
    });
    Harness { state, user_id }
}

/// A harness with the SSRF guard ARMED, for the URL-validation tests.
async fn strict_harness(user_id: i64) -> Harness {
    let mut h = harness(user_id, None, false).await;
    let mut cfg = (*h.state.cfg).clone();
    cfg.allow_insecure_provider_base_url = false;
    // Rebuild the state with the stricter config.
    let old = h.state.clone();
    h.state = Arc::new(AppState {
        cfg: Arc::new(cfg),
        ent: old.ent.clone(),
        lim: old.lim.clone(),
        store: None,
        orgs: None,
        wq: old.wq.clone(),
        inflight: old.inflight.clone(),
        reloader: old.reloader.clone(),
        upstream: old.upstream.clone(),
        shed_total: AtomicI64::new(0),
    });
    h
}

fn token(user_id: i64) -> String {
    let claims = json!({
        "sub": user_id, "type": "access", "role": "user",
        "exp": (chrono::Utc::now() + chrono::Duration::hours(1)).timestamp(),
    });
    jsonwebtoken::encode(
        &jsonwebtoken::Header::default(),
        &claims,
        &jsonwebtoken::EncodingKey::from_secret(SECRET.as_bytes()),
    )
    .unwrap()
}

struct Answer {
    status: StatusCode,
    headers: http::HeaderMap,
    text: String,
}

impl Answer {
    fn json(&self) -> Value {
        serde_json::from_str(&self.text).unwrap_or(Value::String(self.text.clone()))
    }
}

/// Extra headers a test wants on the request.
type Extra<'a> = &'a [(&'a str, &'a str)];

impl Harness {
    async fn call(&self, upstream: &str, extra: Extra<'_>, body: &str) -> Answer {
        let mut req = Request::post("/v1/proxy")
            .header("content-type", "application/json")
            .header("x-rayu-token", token(self.user_id));
        if !upstream.is_empty() {
            req = req.header("x-rayu-upstream-url", upstream);
        }
        for (k, v) in extra {
            req = req.header(*k, *v);
        }
        self.send(req.body(Body::from(body.to_string())).unwrap()).await
    }

    async fn send(&self, req: Request<Body>) -> Answer {
        let resp = rayu_gateway_lib::routes::router(self.state.clone())
            .oneshot(req)
            .await
            .unwrap();
        let status = resp.status();
        let headers = resp.headers().clone();
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        Answer {
            status,
            headers,
            text: String::from_utf8_lossy(&bytes).to_string(),
        }
    }
}

async fn echo_upstream() -> MockServer {
    let server = MockServer::start().await;
    Mock::given(any_request())
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "application/json")
                .insert_header("anthropic-ratelimit-requests-remaining", "77")
                .set_body_string(r#"{"ok":true}"#),
        )
        .mount(&server)
        .await;
    server
}

// --- identity ---------------------------------------------------------------

#[tokio::test]
async fn a_missing_rayu_token_is_a_tagged_401() {
    let h = harness(6001, None, false).await;
    let req = Request::post("/v1/proxy")
        .header("x-rayu-upstream-url", "https://api.anthropic.com/v1/messages")
        .body(Body::empty())
        .unwrap();
    let got = h.send(req).await;
    assert_eq!(got.status, StatusCode::UNAUTHORIZED);
    assert_eq!(
        got.headers.get("x-rayu-proxy-error").unwrap(),
        "missing X-Rayu-Token",
        "the CLI needs this to fail safe to a direct call"
    );
}

#[tokio::test]
async fn an_invalid_rayu_token_is_a_tagged_401() {
    let h = harness(6002, None, false).await;
    let req = Request::post("/v1/proxy")
        .header("x-rayu-token", "not-a-jwt")
        .header("x-rayu-upstream-url", "https://api.anthropic.com/v1/messages")
        .body(Body::empty())
        .unwrap();
    let got = h.send(req).await;
    assert_eq!(got.status, StatusCode::UNAUTHORIZED);
    assert_eq!(
        got.headers.get("x-rayu-proxy-error").unwrap(),
        "invalid X-Rayu-Token"
    );
}

/// Identity must come from X-Rayu-Token, NOT Authorization -- the latter carries the
/// user's own provider key.
#[tokio::test]
async fn an_authorization_header_alone_does_not_authenticate() {
    let h = harness(6003, None, false).await;
    let req = Request::post("/v1/proxy")
        .header("authorization", format!("Bearer {}", token(6003)))
        .header("x-rayu-upstream-url", "https://api.anthropic.com/v1/messages")
        .body(Body::empty())
        .unwrap();
    let got = h.send(req).await;
    assert_eq!(got.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn a_missing_upstream_url_is_a_tagged_400() {
    let h = harness(6004, None, false).await;
    let got = h.call("", &[], "{}").await;
    assert_eq!(got.status, StatusCode::BAD_REQUEST);
    assert_eq!(
        got.headers.get("x-rayu-proxy-error").unwrap(),
        "missing X-Rayu-Upstream-URL"
    );
}

// --- SSRF -------------------------------------------------------------------

#[tokio::test]
async fn the_ssrf_guard_refuses_plaintext_and_internal_hosts() {
    let h = strict_harness(6005).await;
    let cases = [
        ("http://api.anthropic.com/v1", "upstream must be https"),
        ("https://169.254.169.254/latest/meta-data/", "upstream host not allowed"),
        ("https://localhost/v1", "upstream host not allowed"),
        ("https://10.0.0.5/v1", "upstream host not allowed"),
        ("not a url", "invalid upstream url"),
    ];
    for (url, want) in cases {
        let got = h.call(url, &[], "{}").await;
        assert_eq!(got.status, StatusCode::FORBIDDEN, "{url}");
        assert_eq!(
            got.headers.get("x-rayu-proxy-error").unwrap(),
            want,
            "{url}"
        );
    }
}

// --- forwarding -------------------------------------------------------------

#[tokio::test]
async fn a_proxied_request_relays_the_upstream_verbatim() {
    let server = echo_upstream().await;
    let h = harness(6006, None, false).await;
    let got = h
        .call(
            &format!("{}/v1/messages", server.uri()),
            &[("authorization", "Bearer user-own-provider-key")],
            r#"{"model":"claude-sonnet-4-6","max_tokens":8}"#,
        )
        .await;

    assert_eq!(got.status, StatusCode::OK, "{}", got.text);
    assert_eq!(got.json()["ok"], true);
    // The positive marker the CLI checks.
    assert_eq!(got.headers.get("x-rayu-proxied").unwrap(), "1");
    // The upstream's own headers are relayed, including its rate-limit counters.
    assert_eq!(got.headers.get("content-type").unwrap(), "application/json");
    assert_eq!(
        got.headers
            .get("anthropic-ratelimit-requests-remaining")
            .unwrap(),
        "77"
    );
    assert!(
        got.headers.get("x-rayu-proxy-error").is_none(),
        "a successful proxy must not be tagged as a gateway error"
    );

    // The caller's own credential reached the upstream; the Rayu identity did not.
    let reqs = server.received_requests().await.unwrap();
    let sent = &reqs[0];
    assert_eq!(
        sent.headers.get("authorization").unwrap().to_str().unwrap(),
        "Bearer user-own-provider-key"
    );
    assert!(
        sent.headers.get("x-rayu-token").is_none(),
        "the Rayu identity must never leak to the provider"
    );
    assert!(sent.headers.get("x-rayu-upstream-url").is_none());
    // The body is forwarded byte for byte.
    assert_eq!(
        String::from_utf8_lossy(&sent.body),
        r#"{"model":"claude-sonnet-4-6","max_tokens":8}"#
    );
}

#[tokio::test]
async fn an_upstream_non_200_is_relayed_with_its_status() {
    let server = MockServer::start().await;
    Mock::given(any_request())
        .respond_with(
            ResponseTemplate::new(429)
                .insert_header("retry-after", "12")
                .set_body_string(r#"{"error":{"message":"slow down"}}"#),
        )
        .mount(&server)
        .await;
    let h = harness(6007, None, false).await;
    let got = h.call(&format!("{}/v1", server.uri()), &[], "{}").await;

    assert_eq!(
        got.status,
        StatusCode::TOO_MANY_REQUESTS,
        "a transparent proxy passes the provider's own status through"
    );
    assert!(got.text.contains("slow down"));
    assert_eq!(got.headers.get("retry-after").unwrap(), "12");
    assert_eq!(got.headers.get("x-rayu-proxied").unwrap(), "1");
    assert!(
        got.headers.get("x-rayu-proxy-error").is_none(),
        "this is the PROVIDER's refusal, not the gateway's"
    );
}

#[tokio::test]
async fn an_unreachable_upstream_is_a_tagged_502_without_the_proxied_marker() {
    let h = harness(6008, None, false).await;
    let got = h.call("http://127.0.0.1:1/v1", &[], "{}").await;
    assert_eq!(got.status, StatusCode::BAD_GATEWAY);
    assert_eq!(
        got.headers.get("x-rayu-proxy-error").unwrap(),
        "upstream unreachable"
    );
    assert!(
        got.headers.get("x-rayu-proxied").is_none(),
        "the marker must be absent so the CLI falls back to a direct call"
    );
}

// --- daily turn cap ---------------------------------------------------------

/// The cap denial must NOT be tagged as a proxy error, or the CLI would fail safe to a
/// direct provider call and bypass the limit entirely.
#[tokio::test]
async fn the_daily_turn_cap_is_enforced_without_letting_the_cli_bypass_it() {
    let _ = require_redis!();
    let server = echo_upstream().await;
    let h = harness(6009, Some(1), false).await;
    let url = format!("{}/v1", server.uri());

    let first = h
        .call(&url, &[("x-rayu-logical-request-id", "logical-A")], "{}")
        .await;
    assert_eq!(first.status, StatusCode::OK, "{}", first.text);

    let second = h
        .call(&url, &[("x-rayu-logical-request-id", "logical-B")], "{}")
        .await;
    assert_eq!(second.status, StatusCode::TOO_MANY_REQUESTS);
    let body = second.json();
    assert_eq!(body["reason"], "daily_turn_limit");
    assert_eq!(
        second.headers.get("x-rayu-limit").unwrap(),
        "daily_turn_limit"
    );
    assert!(
        second.headers.get("x-rayu-proxy-error").is_none(),
        "tagging this as a proxy error would let the CLI bypass the cap"
    );
}

/// Retries of ONE logical request must burn ONE turn, or a flaky network would eat a
/// user's whole daily allowance.
#[tokio::test]
async fn retries_of_one_logical_request_burn_a_single_turn() {
    let _ = require_redis!();
    let server = echo_upstream().await;
    let h = harness(6010, Some(5), false).await;
    let url = format!("{}/v1", server.uri());

    for _ in 0..3 {
        let got = h
            .call(&url, &[("x-rayu-logical-request-id", "same-logical-id")], "{}")
            .await;
        assert_eq!(got.status, StatusCode::OK, "{}", got.text);
    }

    let lim = h.state.lim.as_ref().unwrap();
    let (used, _) = lim.turns_today(6010).await.unwrap();
    assert_eq!(
        used, 1,
        "three retries of one logical request must cost exactly one turn"
    );
}

/// An upstream rejection refunds the turn, because the CLI will retry and no successful
/// turn happened.
#[tokio::test]
async fn an_upstream_rejection_refunds_the_turn() {
    let _ = require_redis!();
    let server = MockServer::start().await;
    Mock::given(any_request())
        .respond_with(ResponseTemplate::new(400).set_body_string("bad request"))
        .mount(&server)
        .await;
    let h = harness(6011, Some(5), false).await;

    let got = h
        .call(
            &format!("{}/v1", server.uri()),
            &[("x-rayu-logical-request-id", "L1")],
            "{}",
        )
        .await;
    assert_eq!(got.status, StatusCode::BAD_REQUEST);

    let lim = h.state.lim.as_ref().unwrap();
    for _ in 0..100 {
        if lim.turns_today(6011).await.unwrap().0 == 0 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert_eq!(
        lim.turns_today(6011).await.unwrap().0,
        0,
        "a rejected request must not consume the daily cap"
    );
}

/// A gateway with no limiter at all must still proxy: a BYO-key user is never blocked
/// by gateway infrastructure problems.
#[tokio::test]
async fn the_cap_fails_open_when_the_limiter_is_absent() {
    let server = echo_upstream().await;
    let mut h = harness(6012, Some(1), false).await;
    // Drop the limiter, simulating a Redis outage.
    let old = h.state.clone();
    h.state = Arc::new(AppState {
        cfg: old.cfg.clone(),
        ent: old.ent.clone(),
        lim: None,
        store: None,
        orgs: None,
        wq: old.wq.clone(),
        inflight: old.inflight.clone(),
        reloader: old.reloader.clone(),
        upstream: old.upstream.clone(),
        shed_total: AtomicI64::new(0),
    });

    for _ in 0..3 {
        let got = h.call(&format!("{}/v1", server.uri()), &[], "{}").await;
        assert_eq!(
            got.status,
            StatusCode::OK,
            "an infra hiccup must never block BYO-key traffic"
        );
    }
}

// --- model fidelity ---------------------------------------------------------

/// By default a mismatch is only LOGGED, so an enforcement rollout cannot break users
/// before an operator opts in.
#[tokio::test]
async fn a_family_mismatch_is_allowed_by_default() {
    let server = echo_upstream().await;
    let h = harness(6013, None, false).await;
    let got = h
        .call(
            &format!("{}/model/us.anthropic.claude-opus-4-1/invoke", server.uri()),
            &[("x-rayu-intended-model", "claude-sonnet-4-6")],
            "{}",
        )
        .await;
    assert_eq!(got.status, StatusCode::OK, "{}", got.text);
    assert!(got.headers.get("x-rayu-model-fidelity").is_none());
}

/// With enforcement on, the mismatch is refused BEFORE the upstream is called, so the
/// wrong-model request never reaches the provider (and never costs the user).
#[tokio::test]
async fn an_enforced_family_mismatch_is_refused_before_the_upstream_call() {
    let server = echo_upstream().await;
    let h = harness(6014, None, true).await;
    let got = h
        .call(
            &format!("{}/model/us.anthropic.claude-opus-4-1/invoke", server.uri()),
            &[("x-rayu-intended-model", "claude-sonnet-4-6")],
            "{}",
        )
        .await;

    assert_eq!(got.status, StatusCode::CONFLICT);
    assert_eq!(got.headers.get("x-rayu-model-fidelity").unwrap(), "mismatch");
    assert!(got
        .headers
        .get("x-rayu-proxy-error")
        .unwrap()
        .to_str()
        .unwrap()
        .contains("model fidelity mismatch"));
    assert!(
        server.received_requests().await.unwrap().is_empty(),
        "the bad request must never reach the provider"
    );
}

/// An opaque Bedrock inference profile must never be flagged, or every enterprise
/// deployment would be refused.
#[tokio::test]
async fn an_opaque_model_id_is_never_flagged() {
    let server = echo_upstream().await;
    let h = harness(6015, None, true).await;
    let got = h
        .call(
            &format!("{}/model/arn%3Aaws%3Abedrock%3Aprofile%2Fabc/invoke", server.uri()),
            &[("x-rayu-intended-model", "claude-sonnet-4-6")],
            "{}",
        )
        .await;
    assert_eq!(
        got.status,
        StatusCode::OK,
        "an opaque profile id is not a definite mismatch: {}",
        got.text
    );
}

/// The model reported for a Bedrock call comes from the URL, because the SDK moves it
/// out of the body. This is what stopped gateway logs showing `model=""`.
#[tokio::test]
async fn a_bedrock_model_is_taken_from_the_url_not_the_body() {
    let server = echo_upstream().await;
    let h = harness(6016, None, true).await;
    // The body carries NO model at all, exactly like a real Bedrock request.
    let got = h
        .call(
            &format!("{}/model/us.anthropic.claude-sonnet-4-6/invoke", server.uri()),
            &[("x-rayu-intended-model", "claude-sonnet-4-6")],
            r#"{"max_tokens":8,"messages":[]}"#,
        )
        .await;
    assert_eq!(
        got.status,
        StatusCode::OK,
        "the URL model matches the intent, so fidelity passes: {}",
        got.text
    );
}

// --- guards -----------------------------------------------------------------

#[tokio::test]
async fn an_oversized_body_is_refused() {
    let h = harness(6017, None, false).await;
    // 9 MiB, over the 8 MiB cap.
    let big = "x".repeat(9 << 20);
    let got = h.call("https://api.anthropic.com/v1", &[], &big).await;
    assert_eq!(got.status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(
        got.headers.get("x-rayu-proxy-error").unwrap(),
        "request body too large"
    );
}

/// The route accepts any method, because it is a transparent proxy.
#[tokio::test]
async fn the_route_is_method_agnostic() {
    let server = echo_upstream().await;
    let h = harness(6018, None, false).await;
    for method in [http::Method::GET, http::Method::POST, http::Method::DELETE] {
        let req = Request::builder()
            .method(method.clone())
            .uri("/v1/proxy")
            .header("x-rayu-token", token(6018))
            .header("x-rayu-upstream-url", format!("{}/v1", server.uri()))
            .body(Body::empty())
            .unwrap();
        let got = h.send(req).await;
        assert_eq!(got.status, StatusCode::OK, "{method}");
    }
    let reqs = server.received_requests().await.unwrap();
    let methods: Vec<String> = reqs.iter().map(|r| r.method.to_string()).collect();
    assert!(
        methods.contains(&"DELETE".to_string()),
        "the method must be forwarded, not rewritten: {methods:?}"
    );
}
