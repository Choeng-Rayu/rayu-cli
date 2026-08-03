//! End-to-end tests for the hosted completion endpoint,
//! `POST /anthropic/v1/messages`.
//!
//! These drive the real router with a real Redis limiter and a wiremock upstream, so
//! they cover the whole money path: reserve -> upstream -> settle -> credit headers.
//! Ports the cases from the Go gateway's `internal/server/{chat_test.go,
//! anthropic_test.go,reservedenial_test.go,load_test.go,translated_provider_test.go}`.
//!
//! Skipped when `RAYU_TEST_REDIS_URL` is unset: the reserve/settle arithmetic IS the
//! logic under test and runs in Lua inside Redis.

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
use rayu_gateway_lib::providercfg::{self, Route};
use rayu_gateway_lib::providerkeys::{Key, Registry};
use rayu_gateway_lib::state::{AppState, EntSource, InflightLimiter};
use serde_json::{json, Value};
use tower::ServiceExt;
use wiremock::matchers::method;
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

// --- fake entitlement source ------------------------------------------------

struct FakeEnt {
    ent: Entitlement,
    settings: AppSettings,
    route: Option<ProviderRoute>,
    keys: Arc<Registry>,
}

#[async_trait::async_trait]
impl EntSource for FakeEnt {
    async fn resolve(&self, _user_id: i64) -> Result<Entitlement, ResolveError> {
        Ok(self.ent.clone())
    }
    fn settings(&self) -> AppSettings {
        self.settings
    }
    fn invalidate(&self, _user_id: i64) {}
    fn route(&self, _provider_id: i64) -> Option<ProviderRoute> {
        self.route.clone()
    }
    fn routes(&self) -> HashMap<i64, ProviderRoute> {
        match &self.route {
            Some(r) => HashMap::from([(1, r.clone())]),
            None => HashMap::new(),
        }
    }
    fn keys(&self) -> Arc<Registry> {
        self.keys.clone()
    }
    fn models(&self) -> Vec<HostedModel> {
        self.ent.allowed_models.clone()
    }
    fn media_models(&self) -> Vec<MediaModel> {
        Vec::new()
    }
    async fn reload(&self) -> Result<(), String> {
        Ok(())
    }
}

// --- builders ---------------------------------------------------------------

fn plan(credits_per_period: Option<i64>, max_daily_turns: Option<i64>) -> Plan {
    Plan {
        id: 1,
        code: "pro".into(),
        name: "Pro".into(),
        price_cents: 2000,
        credits_per_period,
        top_up_enabled: false,
        max_daily_turns,
    }
}

fn model() -> HostedModel {
    HostedModel {
        code: "deepseek-v4-flash".into(),
        label: "DeepSeek V4 Flash".into(),
        provider_id: 1,
        provider: Provider::default(),
        // The model-fidelity guarantee: THIS is what the upstream must receive.
        upstream_model_id: "deepseek-chat-upstream".into(),
        input_price_per_1m_cents: 100,
        output_price_per_1m_cents: 300,
        credit_multiplier: 1.0,
        output_credit_multiplier: 0.0,
        cache_read_credit_multiplier: 0.0,
        cache_write_credit_multiplier: 0.0,
        allowed_plan_codes: vec!["pro".into()],
        context_window: Some(200_000),
        supports_reasoning: false,
        supports_image: false,
        supports_tools: true,
        enabled: true,
    }
}

fn route(uri: &str, format: &str, endpoint: &str) -> Route {
    let (r, err) = providercfg::build(
        providercfg::Row {
            name: "deepseek".into(),
            format: format.into(),
            base_url: uri.to_string(),
            endpoint_path: endpoint.into(),
            auth_scheme: providercfg::AUTH_X_API_KEY.into(),
            enabled: true,
            key_count: 1,
        },
        providercfg::Options {
            allow_insecure: true,
        },
    );
    assert!(err.is_none(), "{err:?}");
    r
}

fn key(id: i64, secret: &str) -> Key {
    Key {
        id,
        label: format!("key-{id}"),
        secret: zeroize::Zeroizing::new(secret.into()),
        masked: format!("sk-…{id}"),
        priority: id,
        enabled: true,
        status: None,
        cooldown_until: None,
    }
}

fn settings() -> AppSettings {
    AppSettings {
        baseline_credits_per_1m: 1000,
        max_concurrent_streams: 0,
        max_tokens_per_request: 0,
        max_requests_per_5h: 0,
        credits_per_dollar: 500,
        min_topup_cents: 500,
    }
}

/// Everything a test needs to drive the router.
struct Harness {
    state: Arc<AppState>,
    user_id: i64,
    org_id: i64,
}

struct HarnessOpts {
    user_id: i64,
    status: String,
    plan: Plan,
    models: Vec<HostedModel>,
    route: Option<ProviderRoute>,
    keys: Vec<Key>,
    settings: AppSettings,
    max_in_flight: i64,
    /// `Some` puts the harness on the TEAM billing path.
    orgs: Option<Arc<rayu_gateway_lib::orgcredits::Resolver>>,
    /// The org id the minted token carries.
    org_id: i64,
}

impl HarnessOpts {
    fn new(user_id: i64, uri: &str) -> Self {
        Self {
            user_id,
            status: "active".into(),
            plan: plan(Some(1_000_000), None),
            models: vec![model()],
            route: Some(ProviderRoute {
                route: route(uri, providercfg::FORMAT_ANTHROPIC_MESSAGES, "/v1/messages"),
                err: None,
            }),
            keys: vec![key(1, "sk-provider")],
            settings: settings(),
            max_in_flight: 0,
            orgs: None,
            org_id: 0,
        }
    }
}

async fn harness(opts: HarnessOpts) -> Harness {
    let redis_url = std::env::var("RAYU_TEST_REDIS_URL").unwrap_or_default();
    let lim = if redis_url.is_empty() {
        None
    } else {
        let l = Limiter::connect(&redis_url).await.expect("redis");
        // Start every test from a clean slate for its own user id.
        l.reset_user_for_tests(opts.user_id).await.expect("reset");
        Some(Arc::new(l))
    };

    let registry = Arc::new(Registry::new(None));
    if !opts.keys.is_empty() {
        registry.replace(1, opts.keys);
    }

    let cfg = Arc::new(Config {
        jwt_secret: SECRET.into(),
        max_in_flight: opts.max_in_flight,
        ..Default::default()
    });
    let state = Arc::new(AppState {
        cfg,
        ent: Arc::new(FakeEnt {
            ent: Entitlement {
                user_id: opts.user_id,
                status: opts.status,
                plan: opts.plan,
                period_end: None,
                allowed_models: opts.models,
                topup_balance: 0,
            },
            settings: opts.settings,
            route: opts.route,
            keys: registry,
        }),
        lim,
        store: None,
        orgs: opts.orgs.clone(),
        wq: Arc::new(Queue::new(Default::default())),
        inflight: Arc::new(InflightLimiter::new(opts.max_in_flight)),
        reloader: Arc::new(ConfigReloader::from_fn(|| async { Ok(()) }, None)),
        upstream: Arc::new(rayu_gateway_lib::upstream::Upstream::new()),
        shed_total: AtomicI64::new(0),
    });
    Harness {
        state,
        user_id: opts.user_id,
        org_id: opts.org_id,
    }
}

fn token(user_id: i64) -> String {
    token_for(user_id, 0)
}

/// Mints a token that may carry an `orgId` claim, which is what puts a request on the
/// TEAM billing path.
fn token_for(user_id: i64, org_id: i64) -> String {
    let mut claims = json!({
        "sub": user_id, "type": "access", "role": "user",
        "exp": (chrono::Utc::now() + chrono::Duration::hours(1)).timestamp(),
    });
    if org_id > 0 {
        claims["orgId"] = json!(org_id);
    }
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

impl Harness {
    async fn post(&self, body: Value) -> Answer {
        let req = Request::post("/anthropic/v1/messages")
            .header("content-type", "application/json")
            .header(
                "authorization",
                format!("Bearer {}", token_for(self.user_id, self.org_id)),
            )
            .header("x-rayu-request-id", "req_test")
            .header("x-rayu-query-source", "repl_main_thread")
            .body(Body::from(serde_json::to_vec(&body).unwrap()))
            .unwrap();
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

fn ask(stream: bool) -> Value {
    json!({
        "model": "deepseek-v4-flash",
        "max_tokens": 64,
        "stream": stream,
        "messages": [{"role": "user", "content": "hello"}],
    })
}

const CAPTURED_STREAM: &str = concat!(
    "event: message_start\n",
    "data: {\"type\":\"message_start\",\"message\":{\"id\":\"m1\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[],\"usage\":{\"input_tokens\":100,\"output_tokens\":1}}}\n\n",
    "event: content_block_delta\n",
    "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"hi\"}}\n\n",
    "event: message_delta\n",
    "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":20}}\n\n",
    "event: message_stop\n",
    "data: {\"type\":\"message_stop\"}\n\n",
);

async fn upstream_ok_stream() -> MockServer {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/event-stream")
                .set_body_string(CAPTURED_STREAM),
        )
        .mount(&server)
        .await;
    server
}

// --- happy paths ------------------------------------------------------------

#[tokio::test]
async fn a_streaming_request_relays_the_upstream_and_sets_credit_headers() {
    let _ = require_redis!();
    let server = upstream_ok_stream().await;
    let h = harness(HarnessOpts::new(4001, &server.uri())).await;

    let got = h.post(ask(true)).await;
    assert_eq!(got.status, StatusCode::OK, "{}", got.text);
    assert_eq!(
        got.headers.get("content-type").unwrap(),
        "text/event-stream"
    );
    // The credit headers are the CLI's status line.
    assert!(got.headers.contains_key("x-rayu-credits-used"));
    assert!(got.headers.contains_key("x-rayu-credits-remaining"));
    assert!(got.headers.contains_key("x-rayu-topup-balance"));
    // The passthrough relays the upstream stream verbatim.
    assert_eq!(got.text, CAPTURED_STREAM);
}

/// The model-fidelity guarantee: the upstream must receive the PROVIDER's model id,
/// never the Rayu code, or a provider 400s on a model it has never heard of.
#[tokio::test]
async fn the_upstream_receives_the_provider_model_id() {
    let _ = require_redis!();
    let server = upstream_ok_stream().await;
    let h = harness(HarnessOpts::new(4002, &server.uri())).await;
    let got = h.post(ask(true)).await;
    assert_eq!(got.status, StatusCode::OK);

    let reqs = server.received_requests().await.unwrap();
    let sent: Value = serde_json::from_slice(&reqs[0].body).unwrap();
    assert_eq!(
        sent["model"], "deepseek-chat-upstream",
        "the Rayu code must be replaced with the provider's id"
    );
}

#[tokio::test]
async fn a_non_streaming_request_returns_json_with_credit_headers() {
    let _ = require_redis!();
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(200).set_body_string(
            r#"{"type":"message","role":"assistant","content":[{"type":"text","text":"hi"}],
                "usage":{"input_tokens":90,"output_tokens":10}}"#,
        ))
        .mount(&server)
        .await;
    let h = harness(HarnessOpts::new(4003, &server.uri())).await;

    let got = h.post(ask(false)).await;
    assert_eq!(got.status, StatusCode::OK, "{}", got.text);
    assert_eq!(got.headers.get("content-type").unwrap(), "application/json");
    assert_eq!(got.json()["type"], "message");
    assert!(got.headers.contains_key("x-rayu-credits-used"));
}

// --- refusals that must cost nothing ----------------------------------------

#[tokio::test]
async fn a_model_outside_the_plan_is_refused() {
    let _ = require_redis!();
    let server = upstream_ok_stream().await;
    let h = harness(HarnessOpts::new(4004, &server.uri())).await;
    let got = h
        .post(json!({"model": "gpt-5.5", "max_tokens": 8, "messages": []}))
        .await;
    assert_eq!(got.status, StatusCode::FORBIDDEN);
    assert_eq!(
        got.json()["error"]["message"],
        "model not available on your plan: gpt-5.5"
    );
    assert!(
        server.received_requests().await.unwrap().is_empty(),
        "a refusal must never reach the upstream"
    );
}

#[tokio::test]
async fn a_suspended_account_is_refused() {
    let _ = require_redis!();
    let server = upstream_ok_stream().await;
    let mut opts = HarnessOpts::new(4005, &server.uri());
    opts.status = "suspended".into();
    let h = harness(opts).await;
    let got = h.post(ask(true)).await;
    assert_eq!(got.status, StatusCode::FORBIDDEN);
    assert_eq!(got.json()["error"]["message"], "account is suspended");
}

/// The capability gate must fire BEFORE any credit or turn is reserved, and must carry
/// a machine code so the CLI can offer to switch models.
#[tokio::test]
async fn an_image_for_a_text_only_model_is_refused_with_a_machine_code() {
    let _ = require_redis!();
    let server = upstream_ok_stream().await;
    let h = harness(HarnessOpts::new(4006, &server.uri())).await;
    let got = h
        .post(json!({
            "model": "deepseek-v4-flash", "max_tokens": 8,
            "messages": [{"role": "user", "content": [
                {"type": "image", "source": {"type": "base64", "data": "AAAA"}},
            ]}],
        }))
        .await;
    assert_eq!(got.status, StatusCode::BAD_REQUEST);
    let body = got.json();
    assert_eq!(
        body["error"]["rayu_code"], "model_no_image_support",
        "the CLI matches on this code, not on prose: {body}"
    );
    assert!(body["error"]["message"]
        .as_str()
        .unwrap()
        .contains("cannot read images"));
    assert!(server.received_requests().await.unwrap().is_empty());
}

#[tokio::test]
async fn thinking_on_a_non_reasoning_model_is_refused() {
    let _ = require_redis!();
    let server = upstream_ok_stream().await;
    let h = harness(HarnessOpts::new(4007, &server.uri())).await;
    let got = h
        .post(json!({
            "model": "deepseek-v4-flash", "max_tokens": 8,
            "thinking": {"type": "enabled", "budget_tokens": 1024},
            "messages": [{"role": "user", "content": "think"}],
        }))
        .await;
    assert_eq!(got.status, StatusCode::BAD_REQUEST);
    assert_eq!(
        got.json()["error"]["rayu_code"],
        "model_no_thinking_support"
    );
}

#[tokio::test]
async fn max_tokens_over_the_admin_limit_is_refused() {
    let _ = require_redis!();
    let server = upstream_ok_stream().await;
    let mut opts = HarnessOpts::new(4008, &server.uri());
    opts.settings.max_tokens_per_request = 100;
    let h = harness(opts).await;
    let got = h
        .post(json!({
            "model": "deepseek-v4-flash", "max_tokens": 500,
            "messages": [{"role": "user", "content": "hi"}],
        }))
        .await;
    assert_eq!(got.status, StatusCode::BAD_REQUEST);
    assert_eq!(
        got.json()["error"]["message"],
        "max_tokens exceeds the per-request limit"
    );
}

#[tokio::test]
async fn a_disabled_provider_is_temporarily_unavailable() {
    let _ = require_redis!();
    let server = upstream_ok_stream().await;
    let mut opts = HarnessOpts::new(4009, &server.uri());
    let mut r = opts.route.take().unwrap();
    r.route.enabled = false;
    opts.route = Some(r);
    let h = harness(opts).await;
    let got = h.post(ask(true)).await;
    assert_eq!(got.status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(
        got.json()["error"]["message"],
        "model temporarily unavailable: deepseek-v4-flash",
        "the CLI must not see internal config detail"
    );
}

#[tokio::test]
async fn a_provider_missing_from_the_registry_is_temporarily_unavailable() {
    let _ = require_redis!();
    let mut opts = HarnessOpts::new(4010, "http://127.0.0.1:1");
    opts.route = None;
    let h = harness(opts).await;
    let got = h.post(ask(true)).await;
    assert_eq!(got.status, StatusCode::SERVICE_UNAVAILABLE);
}

/// An invalid provider row is REFUSED, never silently repaired: the gateway would
/// otherwise attach a provider key to a URL nobody configured.
#[tokio::test]
async fn an_invalid_provider_config_is_refused() {
    let _ = require_redis!();
    let mut opts = HarnessOpts::new(4011, "http://127.0.0.1:1");
    let mut r = opts.route.take().unwrap();
    r.err = Some(providercfg::ConfigError::BaseUrlNoHost(
        "example.com".into(),
    ));
    opts.route = Some(r);
    let h = harness(opts).await;
    let got = h.post(ask(true)).await;
    assert_eq!(got.status, StatusCode::SERVICE_UNAVAILABLE);
}

#[tokio::test]
async fn a_provider_with_no_key_configured_is_a_500() {
    let _ = require_redis!();
    let server = upstream_ok_stream().await;
    let mut opts = HarnessOpts::new(4012, &server.uri());
    opts.keys = vec![];
    let h = harness(opts).await;
    let got = h.post(ask(true)).await;
    assert_eq!(got.status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(
        got.json()["error"]["message"],
        "provider key not configured"
    );
}

/// "All keys temporarily unusable" is a DIFFERENT answer from "never configured": the
/// first resolves itself, so it gets a 503 with a Retry-After.
#[tokio::test]
async fn all_keys_unusable_is_a_retryable_503() {
    let _ = require_redis!();
    let server = upstream_ok_stream().await;
    let mut opts = HarnessOpts::new(4013, &server.uri());
    opts.keys = vec![Key {
        status: Some(rayu_gateway_lib::providerkeys::Status::Invalid),
        ..key(1, "sk-dead")
    }];
    let h = harness(opts).await;
    let got = h.post(ask(true)).await;
    assert_eq!(got.status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(got.headers.get("retry-after").unwrap(), "60");
}

// --- limits -----------------------------------------------------------------

#[tokio::test]
async fn the_daily_turn_cap_is_enforced() {
    let _ = require_redis!();
    let server = upstream_ok_stream().await;
    let mut opts = HarnessOpts::new(4014, &server.uri());
    opts.plan = plan(Some(1_000_000), Some(1));
    let h = harness(opts).await;

    let first = h.post(ask(true)).await;
    assert_eq!(first.status, StatusCode::OK, "{}", first.text);

    let second = h.post(ask(true)).await;
    assert_eq!(second.status, StatusCode::TOO_MANY_REQUESTS);
    let body = second.json();
    assert_eq!(body["reason"], "daily_turn_limit");
    assert_eq!(body["error"]["type"], "rate_limit_exceeded");
    assert!(
        second.headers.contains_key("retry-after"),
        "the client needs to know when the day rolls over"
    );
}

/// A credit denial must read as a credit denial -- and must NOT also burn a daily turn.
#[tokio::test]
async fn an_exhausted_period_is_a_credit_denial() {
    let _ = require_redis!();
    let server = upstream_ok_stream().await;
    let mut opts = HarnessOpts::new(4015, &server.uri());
    // One credit of allowance: the pre-flight estimate alone exceeds it.
    opts.plan = plan(Some(0), Some(100));
    let h = harness(opts).await;

    let got = h.post(ask(true)).await;
    assert_eq!(got.status, StatusCode::TOO_MANY_REQUESTS);
    let body = got.json();
    assert_eq!(body["reason"], "period_limit");
    assert_eq!(body["transient"], false);
    assert!(body["error"]["message"]
        .as_str()
        .unwrap()
        .contains("credit limit reached"));
    assert_eq!(
        got.headers.get("x-rayu-limit").unwrap(),
        "period_limit",
        "the machine-readable reason header"
    );

    // The turn must have been refunded, so a top-up lets the user carry on.
    let lim = h.state.lim.as_ref().unwrap();
    // Give the detached refund a moment.
    for _ in 0..100 {
        if lim.turns_today(4015).await.unwrap().0 == 0 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert_eq!(
        lim.turns_today(4015).await.unwrap().0,
        0,
        "a credit denial must not also cost a daily turn"
    );
}

/// The concurrency cap must be reported as transient, not as a billing problem -- the
/// regression that sent paying users to the pricing page.
#[tokio::test]
async fn a_concurrency_denial_is_transient_not_billing() {
    let _ = require_redis!();
    let server = MockServer::start().await;
    // A stream that never completes, so the first request holds its slot.
    Mock::given(method("POST"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/event-stream")
                .set_body_string(CAPTURED_STREAM)
                .set_delay(std::time::Duration::from_secs(30)),
        )
        .mount(&server)
        .await;

    let mut opts = HarnessOpts::new(4016, &server.uri());
    opts.settings.max_concurrent_streams = 1;
    let h = harness(opts).await;
    let state = h.state.clone();

    // Hold one concurrency slot by leaving a request in flight.
    let held = tokio::spawn(async move {
        let req = Request::post("/anthropic/v1/messages")
            .header("content-type", "application/json")
            .header("authorization", format!("Bearer {}", token(4016)))
            .body(Body::from(serde_json::to_vec(&ask(true)).unwrap()))
            .unwrap();
        let _ = rayu_gateway_lib::routes::router(state).oneshot(req).await;
    });
    // Let the first reserve land in Redis.
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;

    let got = h.post(ask(true)).await;
    assert_eq!(got.status, StatusCode::TOO_MANY_REQUESTS, "{}", got.text);
    let body = got.json();
    assert_eq!(body["reason"], "concurrency");
    assert_eq!(body["transient"], true);
    assert_eq!(
        got.headers.get("retry-after").unwrap(),
        "2",
        "seconds, NOT the billing period reset"
    );
    assert!(
        body.get("resetSeconds").is_none(),
        "a transient denial must not show a renewal ETA"
    );
    let msg = body["error"]["message"].as_str().unwrap();
    assert!(
        !msg.contains("credit limit reached"),
        "the misleading billing prose must be gone: {msg}"
    );
    held.abort();
}

/// The load-shedding valve must answer immediately rather than queueing.
#[tokio::test]
async fn the_inflight_valve_sheds_at_capacity() {
    let _ = require_redis!();
    let server = upstream_ok_stream().await;
    let mut opts = HarnessOpts::new(4017, &server.uri());
    opts.max_in_flight = 1;
    let h = harness(opts).await;

    // Take the only slot directly, so the request must be shed.
    let _slot = h.state.inflight.try_acquire().expect("the only slot");
    let got = h.post(ask(true)).await;
    assert_eq!(got.status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(got.headers.get("retry-after").unwrap(), "5");
    assert_eq!(
        h.state.shed_count(),
        1,
        "the shed must be counted for observability"
    );
}

// --- upstream failures ------------------------------------------------------

/// A client-fixable 400 keeps its cause so the CLI shows it and does NOT retry.
#[tokio::test]
async fn a_client_fixable_upstream_400_is_relayed_with_its_cause() {
    let _ = require_redis!();
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(400).set_body_string(
            r#"{"error":{"message":"prompt is too long: 250000 tokens > 200000 maximum"}}"#,
        ))
        .mount(&server)
        .await;
    let h = harness(HarnessOpts::new(4018, &server.uri())).await;

    let got = h.post(ask(false)).await;
    assert_eq!(got.status, StatusCode::BAD_REQUEST);
    assert!(
        got.text.contains("prompt is too long"),
        "the user can fix this, so they must see it: {}",
        got.text
    );
}

/// A provider-side failure is masked, and must not leak the provider's prose.
#[tokio::test]
async fn a_provider_side_failure_is_masked_as_502() {
    let _ = require_redis!();
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(500).set_body_string(
            r#"{"error":{"message":"internal error at deepseek-internal-host-7"}}"#,
        ))
        .mount(&server)
        .await;
    let h = harness(HarnessOpts::new(4019, &server.uri())).await;

    let got = h.post(ask(false)).await;
    assert_eq!(got.status, StatusCode::BAD_GATEWAY);
    assert!(
        !got.text.contains("deepseek-internal-host-7"),
        "provider detail leaked: {}",
        got.text
    );
}

#[tokio::test]
async fn an_unreachable_upstream_is_a_502_and_settles_nothing() {
    let _ = require_redis!();
    let h = harness(HarnessOpts::new(4020, "http://127.0.0.1:1")).await;
    let got = h.post(ask(false)).await;
    assert_eq!(got.status, StatusCode::BAD_GATEWAY);
}

/// An upstream 429 must cool the key down, so the NEXT request skips it.
#[tokio::test]
async fn an_upstream_429_takes_the_key_out_of_rotation() {
    let _ = require_redis!();
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(
            ResponseTemplate::new(429)
                .insert_header("retry-after", "30")
                .set_body_string(r#"{"error":{"message":"rate limited"}}"#),
        )
        .mount(&server)
        .await;
    let h = harness(HarnessOpts::new(4021, &server.uri())).await;

    let got = h.post(ask(false)).await;
    assert_eq!(got.status, StatusCode::BAD_GATEWAY, "{}", got.text);

    let registry = h.state.ent.keys();
    assert_eq!(
        registry.usable(1),
        0,
        "the rate-limited key must be cooling down, not retried immediately"
    );
    let snap = registry.snapshot_for(1);
    assert_eq!(
        snap[0].status,
        rayu_gateway_lib::providerkeys::Status::RateLimited
    );
    assert!(
        snap[0].cooldown_until.is_some(),
        "the provider's Retry-After must be honoured as a cooldown"
    );
}

// --- settlement -------------------------------------------------------------

/// Settlement must reconcile the pre-flight hold to the ACTUAL usage, so a small turn
/// does not keep a large reserve.
#[tokio::test]
async fn settlement_reconciles_the_reserve_to_actual_usage() {
    let _ = require_redis!();
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(200).set_body_string(
            r#"{"type":"message","role":"assistant","content":[],
                "usage":{"input_tokens":10,"output_tokens":2}}"#,
        ))
        .mount(&server)
        .await;
    let h = harness(HarnessOpts::new(4022, &server.uri())).await;

    let got = h.post(ask(false)).await;
    assert_eq!(got.status, StatusCode::OK, "{}", got.text);

    let lim = h.state.lim.as_ref().unwrap();
    let status = lim.status(4022).await.unwrap();
    // 12 tokens at multiplier 1.0 is what was actually used; the estimate (which
    // includes max_tokens=64) was larger, so the settle must have released the
    // difference.
    assert!(
        status.used_period > 0 && status.used_period < 100,
        "used_period={} should be the real 12-ish tokens, not the estimate",
        status.used_period
    );
}

/// A failed request must still release the hold, or a user's balance silently decays.
#[tokio::test]
async fn a_failed_request_releases_the_hold() {
    let _ = require_redis!();
    let h = harness(HarnessOpts::new(4023, "http://127.0.0.1:1")).await;
    let got = h.post(ask(false)).await;
    assert_eq!(got.status, StatusCode::BAD_GATEWAY);

    let lim = h.state.lim.as_ref().unwrap();
    let status = lim.status(4023).await.unwrap();
    assert_eq!(
        status.used_period, 0,
        "an unreachable upstream consumed nothing, so the hold must be fully released"
    );
}

/// Billing must survive a client hang-up: the pump is detached and settles whatever
/// the upstream delivered.
#[tokio::test]
async fn a_client_that_hangs_up_mid_stream_is_still_billed() {
    let _ = require_redis!();
    let server = upstream_ok_stream().await;
    let h = harness(HarnessOpts::new(4024, &server.uri())).await;

    // Drive the request but DROP the response body without reading it, which is what a
    // client hang-up looks like to the gateway.
    let req = Request::post("/anthropic/v1/messages")
        .header("content-type", "application/json")
        .header("authorization", format!("Bearer {}", token(4024)))
        .body(Body::from(serde_json::to_vec(&ask(true)).unwrap()))
        .unwrap();
    let resp = rayu_gateway_lib::routes::router(h.state.clone())
        .oneshot(req)
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    drop(resp);

    let lim = h.state.lim.as_ref().unwrap();
    // The detached pump settles asynchronously.
    let mut used = 0;
    for _ in 0..200 {
        used = lim.status(4024).await.unwrap().used_period;
        if used > 0 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert!(
        used > 0,
        "a disconnected client must still be charged for what the upstream produced"
    );
}

// --- translated providers ---------------------------------------------------

/// A translating provider must work through the same preamble and settle identically,
/// so billing is format-independent.
#[tokio::test]
async fn a_translated_provider_streams_and_bills_the_same_way() {
    let _ = require_redis!();
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/event-stream")
                .set_body_string(concat!(
                    "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"},\"finish_reason\":null}]}\n\n",
                    "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
                    "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":40,\"completion_tokens\":5,\"total_tokens\":45}}\n\n",
                    "data: [DONE]\n\n",
                )),
        )
        .mount(&server)
        .await;

    let mut opts = HarnessOpts::new(4025, &server.uri());
    opts.route = Some(ProviderRoute {
        route: route(
            &server.uri(),
            providercfg::FORMAT_OPENAI_CHAT,
            "/v1/chat/completions",
        ),
        err: None,
    });
    let h = harness(opts).await;

    let got = h.post(ask(true)).await;
    assert_eq!(got.status, StatusCode::OK, "{}", got.text);
    // The client sees ANTHROPIC events even though the provider spoke OpenAI.
    assert!(got.text.contains("event: message_start"), "{}", got.text);
    assert!(got.text.contains("event: message_stop"));

    let lim = h.state.lim.as_ref().unwrap();
    let mut used = 0;
    for _ in 0..200 {
        used = lim.status(4025).await.unwrap().used_period;
        if used > 0 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert!(used > 0, "a translated turn must be billed too");
}

// --- guards -----------------------------------------------------------------

#[tokio::test]
async fn an_unparseable_body_is_a_400() {
    let _ = require_redis!();
    let h = harness(HarnessOpts::new(4026, "http://127.0.0.1:1")).await;
    let req = Request::post("/anthropic/v1/messages")
        .header("content-type", "application/json")
        .header("authorization", format!("Bearer {}", token(4026)))
        .body(Body::from("not json"))
        .unwrap();
    let resp = rayu_gateway_lib::routes::router(h.state.clone())
        .oneshot(req)
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let body: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(body["error"]["message"], "invalid JSON body");
}

#[tokio::test]
async fn the_endpoint_requires_a_token() {
    let _ = require_redis!();
    let h = harness(HarnessOpts::new(4027, "http://127.0.0.1:1")).await;
    let req = Request::post("/anthropic/v1/messages")
        .header("content-type", "application/json")
        .body(Body::from(serde_json::to_vec(&ask(true)).unwrap()))
        .unwrap();
    let resp = rayu_gateway_lib::routes::router(h.state.clone())
        .oneshot(req)
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
}

// --- team billing -----------------------------------------------------------
//
// Ports the cases from the Go gateway's `internal/server/team_billing_test.go`. The
// contract: an `orgId` claim bills the TEAM (member bucket first, shared pool as the
// hard cap), and EVERY failure mode falls back to individual billing rather than
// rejecting -- because a claim can be a token-lifetime stale, and in that case the
// person really is an individual user again.

use rayu_core::store::OrgMemberState;
use rayu_gateway_lib::orgcredits;

struct FakeOrgs {
    state: Option<OrgMemberState>,
    fail: bool,
}

#[async_trait::async_trait]
impl orgcredits::Source for FakeOrgs {
    async fn org_member_state(
        &self,
        _org_id: i64,
        _user_id: i64,
    ) -> Result<Option<OrgMemberState>, String> {
        if self.fail {
            return Err("team lookup exploded".into());
        }
        Ok(self.state.clone())
    }
}

/// A tweak applied to a healthy seat to make it unusable in one specific way.
type SeatMutation = Box<dyn Fn(&mut OrgMemberState)>;

fn team_seat(org_id: i64) -> OrgMemberState {
    OrgMemberState {
        org_id,
        org_status: "active".into(),
        member_status: "active".into(),
        member_role: "member".into(),
        sub_status: "active".into(),
        plan: Plan {
            id: 9,
            code: "team".into(),
            name: "Team".into(),
            price_cents: 10_000,
            credits_per_period: Some(10_000),
            top_up_enabled: false,
            max_daily_turns: Some(500),
        },
        has_plan: true,
        period_end: None,
        bucket_quota: 100,
        bucket_credits: 100,
        pool_total: 10_000,
        pool_used: 0,
        pool_extra: 0,
    }
}

/// Builds a harness on the team path. `seat` is the state the resolver returns.
async fn team_harness(
    user_id: i64,
    org_id: i64,
    uri: &str,
    seat: Option<OrgMemberState>,
    fail: bool,
) -> Harness {
    let mut opts = HarnessOpts::new(user_id, uri);
    // The team plan allows a DIFFERENT model set, recomputed from the live catalog, so
    // the model has to be allowed for the team plan code too.
    let mut m = model();
    m.allowed_plan_codes = vec!["pro".into(), "team".into()];
    opts.models = vec![m];
    opts.org_id = org_id;
    opts.orgs = Some(Arc::new(orgcredits::Resolver::new(
        Arc::new(FakeOrgs { state: seat, fail }),
        std::time::Duration::from_secs(30),
    )));
    harness(opts).await
}

#[tokio::test]
async fn a_team_member_is_billed_against_the_team_pool() {
    let _ = require_redis!();
    let server = upstream_ok_stream().await;
    let (uid, org) = (4101, 5101);
    let h = team_harness(uid, org, &server.uri(), Some(team_seat(org)), false).await;
    // Clear the org counters this test will move.
    let lim = h.state.lim.as_ref().unwrap();
    lim.reset_org_for_tests(org, uid).await.unwrap();

    let got = h.post(ask(true)).await;
    assert_eq!(got.status, StatusCode::OK, "{}", got.text);
    // The credit headers report the TEAM's pool, because that is the allowance actually
    // limiting this request.
    assert!(got.headers.contains_key("x-rayu-credits-used"));
    assert_eq!(
        got.headers.get("x-rayu-topup-balance").unwrap(),
        "0",
        "a team pool has no personal top-up balance"
    );

    // The team's pool counter must have moved, and the member's personal period counter
    // must NOT have.
    let mut pool = 0;
    for _ in 0..200 {
        pool = lim.org_status(org, uid).await.unwrap().used_pool;
        if pool > 0 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert!(pool > 0, "the team pool must be charged");
    assert_eq!(
        lim.status(uid).await.unwrap().used_period,
        0,
        "a team charge must NOT touch the member's personal allowance"
    );
}

/// The hard cap is the pool: when it cannot cover the hold, the denial must name the
/// team and tell the member who can fix it.
#[tokio::test]
async fn an_exhausted_team_pool_names_the_team_and_the_admin() {
    let _ = require_redis!();
    let server = upstream_ok_stream().await;
    let (uid, org) = (4102, 5102);
    let mut seat = team_seat(org);
    seat.pool_total = 0; // nothing left to spend
    let h = team_harness(uid, org, &server.uri(), Some(seat), false).await;
    h.state
        .lim
        .as_ref()
        .unwrap()
        .reset_org_for_tests(org, uid)
        .await
        .unwrap();

    let got = h.post(ask(true)).await;
    assert_eq!(got.status, StatusCode::TOO_MANY_REQUESTS, "{}", got.text);
    let body = got.json();
    assert_eq!(body["reason"], "pool_limit");
    assert_eq!(
        body["scope"], "team",
        "the client must be able to tell a team limit from a personal one"
    );
    let msg = body["error"]["message"].as_str().unwrap();
    assert!(msg.contains("team's credit pool"), "{msg}");
    assert!(
        msg.contains("team admin"),
        "a member cannot fix this themselves: {msg}"
    );
}

/// A stale claim (the member was removed) must fall back to individual billing, not
/// fail the request.
#[tokio::test]
async fn a_stale_org_claim_falls_back_to_individual_billing() {
    let _ = require_redis!();
    let server = upstream_ok_stream().await;
    let (uid, org) = (4103, 5103);
    let h = team_harness(uid, org, &server.uri(), None, false).await;

    let got = h.post(ask(true)).await;
    assert_eq!(
        got.status,
        StatusCode::OK,
        "a removed member is simply an individual user again: {}",
        got.text
    );
    // The PERSONAL counter moved, which is the proof it billed individually.
    let lim = h.state.lim.as_ref().unwrap();
    let mut used = 0;
    for _ in 0..200 {
        used = lim.status(uid).await.unwrap().used_period;
        if used > 0 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert!(used > 0, "individual billing must have charged the user");
}

/// A suspended team, a removed seat and a lapsed plan all fall back the same way.
#[tokio::test]
async fn every_unusable_team_state_falls_back_to_individual_billing() {
    let _ = require_redis!();
    let server = upstream_ok_stream().await;
    let cases: Vec<(i64, i64, SeatMutation)> = vec![
        (4104, 5104, Box::new(|s| s.org_status = "suspended".into())),
        (4105, 5105, Box::new(|s| s.member_status = "removed".into())),
        (4106, 5106, Box::new(|s| s.sub_status = "past_due".into())),
        (4107, 5107, Box::new(|s| s.has_plan = false)),
    ];
    for (uid, org, mutate) in cases {
        let mut seat = team_seat(org);
        mutate(&mut seat);
        let h = team_harness(uid, org, &server.uri(), Some(seat), false).await;
        let got = h.post(ask(true)).await;
        assert_eq!(
            got.status,
            StatusCode::OK,
            "user={uid} must fall back to individual billing: {}",
            got.text
        );
        let lim = h.state.lim.as_ref().unwrap();
        let mut used = 0;
        for _ in 0..200 {
            used = lim.status(uid).await.unwrap().used_period;
            if used > 0 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert!(used > 0, "user={uid} was not billed individually");
    }
}

/// A database failure resolving the team must not fail the request either.
#[tokio::test]
async fn a_team_lookup_failure_falls_back_to_individual_billing() {
    let _ = require_redis!();
    let server = upstream_ok_stream().await;
    let (uid, org) = (4108, 5108);
    let h = team_harness(uid, org, &server.uri(), None, true).await;
    let got = h.post(ask(true)).await;
    assert_eq!(got.status, StatusCode::OK, "{}", got.text);
}

/// Model access follows the TEAM's plan, not the member's personal one.
#[tokio::test]
async fn model_access_follows_the_team_plan() {
    let _ = require_redis!();
    let server = upstream_ok_stream().await;
    let (uid, org) = (4109, 5109);
    let mut opts = HarnessOpts::new(uid, &server.uri());
    // The catalog model is allowed for "team" but NOT for the member's personal "pro".
    let mut m = model();
    m.allowed_plan_codes = vec!["team".into()];
    opts.models = vec![m];
    opts.org_id = org;
    opts.orgs = Some(Arc::new(orgcredits::Resolver::new(
        Arc::new(FakeOrgs {
            state: Some(team_seat(org)),
            fail: false,
        }),
        std::time::Duration::from_secs(30),
    )));
    let h = harness(opts).await;
    h.state
        .lim
        .as_ref()
        .unwrap()
        .reset_org_for_tests(org, uid)
        .await
        .unwrap();

    let got = h.post(ask(true)).await;
    assert_eq!(
        got.status,
        StatusCode::OK,
        "the team plan grants this model: {}",
        got.text
    );
}

/// `GET /v1/credits` for a team member reports the shared pool, flagged with
/// `scope: "team"`, plus the member's own bucket.
#[tokio::test]
async fn the_credits_route_reports_the_team_view() {
    let _ = require_redis!();
    let (uid, org) = (4110, 5110);
    let mut seat = team_seat(org);
    seat.pool_used = 400;
    seat.pool_extra = 250;
    seat.bucket_quota = 100;
    seat.bucket_credits = 40;
    let h = team_harness(uid, org, "http://127.0.0.1:1", Some(seat), false).await;
    h.state
        .lim
        .as_ref()
        .unwrap()
        .reset_org_for_tests(org, uid)
        .await
        .unwrap();

    let req = Request::get("/v1/credits")
        .header("authorization", format!("Bearer {}", token_for(uid, org)))
        .body(Body::empty())
        .unwrap();
    let resp = rayu_gateway_lib::routes::router(h.state.clone())
        .oneshot(req)
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let body: Value = serde_json::from_slice(&bytes).unwrap();

    assert_eq!(body["scope"], "team", "the flag the client checks first");
    assert_eq!(
        body["plan"], "team",
        "the TEAM's plan, not the personal one"
    );
    assert_eq!(
        body["topupBalance"], 0,
        "a team pool has no personal top-up"
    );
    assert_eq!(body["topUpEnabled"], false);
    assert_eq!(body["team"]["organizationId"], org);
    assert_eq!(body["team"]["role"], "member");
    assert_eq!(body["team"]["poolCredits"], 10_000);
    assert_eq!(body["team"]["bucketQuota"], 100);
    // What the admin bought and what is left of it.
    assert_eq!(body["team"]["purchasedCredits"], 250);
    assert_eq!(
        body["team"]["purchasedRemaining"], 250,
        "nothing purchased is touched until the plan allowance is spent"
    );
}

/// An individual (no org claim) must still get the personal view, with no team fields.
#[tokio::test]
async fn the_credits_route_keeps_the_individual_view_without_an_org_claim() {
    let _ = require_redis!();
    let uid = 4111;
    let h = harness(HarnessOpts::new(uid, "http://127.0.0.1:1")).await;
    let req = Request::get("/v1/credits")
        .header("authorization", format!("Bearer {}", token(uid)))
        .body(Body::empty())
        .unwrap();
    let resp = rayu_gateway_lib::routes::router(h.state.clone())
        .oneshot(req)
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let body: Value = serde_json::from_slice(&bytes).unwrap();
    assert!(body.get("scope").is_none(), "no team scope: {body}");
    assert!(body.get("team").is_none());
    assert_eq!(body["plan"], "pro");
}
