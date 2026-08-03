//! Router-level tests for the free metadata endpoints.
//!
//! These drive the real axum router through `oneshot`, with a fake [`EntSource`], so
//! they assert the whole contract the CLI depends on: status codes, JSON field names,
//! headers, and the auth boundary. Ports the relevant cases from the Go gateway's
//! `internal/server/{server_test.go,counttokens_test.go,mediamodels_test.go,topup_quote_test.go}`.

use std::collections::HashMap;
use std::sync::atomic::AtomicI64;
use std::sync::{Arc, Mutex};

use axum::body::Body;
use http::{Request, StatusCode};
use http_body_util::BodyExt;
use rayu_core::config::{Config, LogFormat};
use rayu_core::eventqueue::Queue;
use rayu_core::store::{AppSettings, HostedModel, MediaModel, Plan, Provider};
use rayu_gateway_lib::configreload::ConfigReloader;
use rayu_gateway_lib::entitlements::{Entitlement, ProviderRoute, ResolveError};
use rayu_gateway_lib::providerkeys::Registry;
use rayu_gateway_lib::state::{AppState, EntSource, InflightLimiter};
use serde_json::Value;
use tower::ServiceExt;

const SECRET: &str = "test-secret-that-is-long-enough-32b";

// --- fakes ------------------------------------------------------------------

struct FakeEnt {
    ent: Mutex<Entitlement>,
    settings: AppSettings,
    media: Vec<MediaModel>,
    fail: Option<ResolveError>,
    keys: Arc<Registry>,
}

#[async_trait::async_trait]
impl EntSource for FakeEnt {
    async fn resolve(&self, _user_id: i64) -> Result<Entitlement, ResolveError> {
        match &self.fail {
            Some(ResolveError::Deadline) => Err(ResolveError::Deadline),
            Some(ResolveError::Store(m)) => Err(ResolveError::Store(m.clone())),
            None => Ok(self.ent.lock().unwrap().clone()),
        }
    }
    fn settings(&self) -> AppSettings {
        self.settings
    }
    fn invalidate(&self, _user_id: i64) {}
    fn route(&self, _provider_id: i64) -> Option<ProviderRoute> {
        None
    }
    fn routes(&self) -> HashMap<i64, ProviderRoute> {
        HashMap::new()
    }
    fn keys(&self) -> Arc<Registry> {
        self.keys.clone()
    }
    fn models(&self) -> Vec<HostedModel> {
        self.ent.lock().unwrap().allowed_models.clone()
    }
    fn media_models(&self) -> Vec<MediaModel> {
        self.media.clone()
    }
    async fn reload(&self) -> Result<(), String> {
        Ok(())
    }
}

fn plan(code: &str) -> Plan {
    Plan {
        id: 1,
        code: code.into(),
        name: format!("{code} plan"),
        price_cents: 0,
        credits_per_period: Some(1000),
        top_up_enabled: true,
        max_daily_turns: Some(50),
    }
}

fn hosted(code: &str) -> HostedModel {
    HostedModel {
        code: code.into(),
        label: format!("{code} label"),
        provider_id: 1,
        provider: Provider::default(),
        upstream_model_id: format!("upstream-{code}"),
        input_price_per_1m_cents: 100,
        output_price_per_1m_cents: 300,
        credit_multiplier: 1.0,
        output_credit_multiplier: 0.0,
        cache_read_credit_multiplier: 0.0,
        cache_write_credit_multiplier: 0.0,
        allowed_plan_codes: vec!["pro".into()],
        context_window: Some(200_000),
        supports_reasoning: true,
        supports_image: false,
        supports_tools: true,
        enabled: true,
    }
}

fn media(code: &str, kind: &str) -> MediaModel {
    MediaModel {
        code: code.into(),
        label: format!("{code} label"),
        media_type: kind.into(),
        capabilities: vec!["generate".into()],
        backend: "nvidia".into(),
        family: "flux".into(),
        nvcf_function_id: String::new(),
        estimated_seconds: Some(12),
        default_params: Some(serde_json::json!({"steps": 30})),
        // Empty = EVERY plan may use it (media generation is gated by feature flags).
        allowed_plan_codes: vec![],
        is_default: true,
        sort_order: 1,
        enabled: true,
    }
}

fn settings() -> AppSettings {
    AppSettings {
        baseline_credits_per_1m: 1000,
        credits_per_dollar: 500,
        min_topup_cents: 500,
        ..Default::default()
    }
}

struct Harness {
    state: Arc<AppState>,
}

impl Harness {
    fn new(fake: FakeEnt) -> Self {
        let cfg = Arc::new(Config {
            port: "0".into(),
            jwt_secret: SECRET.into(),
            cors_origins: vec!["*".into()],
            max_in_flight: 0,
            log_format: LogFormat::Human,
            ..Default::default()
        });
        let state = Arc::new(AppState {
            cfg,
            ent: Arc::new(fake),
            lim: None,
            store: None,
            orgs: None,
            wq: Arc::new(Queue::new(Default::default())),
            inflight: Arc::new(InflightLimiter::new(0)),
            reloader: Arc::new(ConfigReloader::from_fn(|| async { Ok(()) }, None)),
            upstream: Arc::new(rayu_gateway_lib::upstream::Upstream::new()),
            shed_total: AtomicI64::new(0),
        });
        Self { state }
    }

    async fn get(&self, path: &str) -> (StatusCode, http::HeaderMap, Value) {
        self.send(Request::get(path), Body::empty(), true).await
    }

    async fn get_unauthed(&self, path: &str) -> (StatusCode, http::HeaderMap, Value) {
        self.send(Request::get(path), Body::empty(), false).await
    }

    async fn post(&self, path: &str, body: &str) -> (StatusCode, http::HeaderMap, Value) {
        self.send(
            Request::post(path).header("content-type", "application/json"),
            Body::from(body.to_string()),
            true,
        )
        .await
    }

    async fn send(
        &self,
        builder: http::request::Builder,
        body: Body,
        authed: bool,
    ) -> (StatusCode, http::HeaderMap, Value) {
        let builder = if authed {
            builder.header("authorization", format!("Bearer {}", token(7, "user")))
        } else {
            builder
        };
        let req = builder.body(body).unwrap();
        let resp = rayu_gateway_lib::routes::router(self.state.clone())
            .oneshot(req)
            .await
            .unwrap();
        let status = resp.status();
        let headers = resp.headers().clone();
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let json = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes)
                .unwrap_or(Value::String(String::from_utf8_lossy(&bytes).to_string()))
        };
        (status, headers, json)
    }
}

/// Mints an access token the gateway will accept.
fn token(user_id: i64, role: &str) -> String {
    let claims = serde_json::json!({
        "sub": user_id, "type": "access", "role": role,
        "exp": (chrono::Utc::now() + chrono::Duration::hours(1)).timestamp(),
    });
    jsonwebtoken::encode(
        &jsonwebtoken::Header::default(),
        &claims,
        &jsonwebtoken::EncodingKey::from_secret(SECRET.as_bytes()),
    )
    .expect("mint token")
}

fn active_harness() -> Harness {
    Harness::new(FakeEnt {
        ent: Mutex::new(Entitlement {
            user_id: 7,
            status: "active".into(),
            plan: plan("pro"),
            period_end: None,
            allowed_models: vec![hosted("deepseek-v4-flash"), hosted("longcat-2")],
            topup_balance: 250,
        }),
        settings: settings(),
        media: vec![media("flux-2", "image"), media("veo-3", "video")],
        fail: None,
        keys: Arc::new(Registry::new(None)),
    })
}

// --- auth boundary ----------------------------------------------------------

#[tokio::test]
async fn every_v1_route_requires_a_bearer_token() {
    let h = active_harness();
    for path in [
        "/v1/models",
        "/v1/credits",
        "/v1/credits/topup/quote",
        "/v1/_whoami",
        "/v1/_entitlements",
    ] {
        let (status, _, body) = h.get_unauthed(path).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{path} must be protected");
        assert_eq!(
            body["error"]["message"], "missing bearer token",
            "{path}: the CLI matches this message"
        );
    }
}

#[tokio::test]
async fn healthz_stays_public() {
    let h = active_harness();
    let (status, _, body) = h.get_unauthed("/healthz").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["status"], "ok");
}

// --- /v1/models -------------------------------------------------------------

#[tokio::test]
async fn models_returns_the_plan_catalog_in_openai_list_shape() {
    let h = active_harness();
    let (status, _, body) = h.get("/v1/models").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["object"], "list");

    let data = body["data"].as_array().unwrap();
    assert_eq!(data.len(), 2);
    assert_eq!(data[0]["id"], "deepseek-v4-flash");
    assert_eq!(data[0]["object"], "model");
    assert_eq!(data[0]["owned_by"], "rayu");
    // Capabilities let the client warn BEFORE a request instead of surfacing a
    // provider error mid-stream.
    assert_eq!(data[0]["supportsReasoning"], true);
    assert_eq!(data[0]["supportsImage"], false);
    assert_eq!(data[0]["supportsTools"], true);
    assert_eq!(data[0]["contextWindow"], 200_000);
    // The chat catalog must NOT carry media fields.
    assert!(data[0].get("mediaType").is_none());
}

#[tokio::test]
async fn models_media_filters_split_the_catalog() {
    let h = active_harness();

    let (status, _, body) = h.get("/v1/models?media=image").await;
    assert_eq!(status, StatusCode::OK);
    let data = body["data"].as_array().unwrap();
    assert_eq!(data.len(), 1, "only image models");
    assert_eq!(data[0]["id"], "flux-2");
    assert_eq!(data[0]["mediaType"], "image");
    assert_eq!(data[0]["capabilities"], serde_json::json!(["generate"]));
    assert_eq!(data[0]["backend"], "nvidia");
    assert_eq!(data[0]["family"], "flux");
    assert_eq!(
        data[0]["defaultParams"],
        serde_json::json!({"steps": 30}),
        "stored request defaults must reach the client verbatim"
    );
    assert_eq!(
        data[0]["nvcfFunctionId"],
        Value::Null,
        "an unset optional string must be null, not empty"
    );
    assert_eq!(data[0]["estimatedSeconds"], 12);
    assert_eq!(data[0]["default"], true);
    assert_eq!(
        body["media"], "image",
        "the filter is echoed so a client can tell an empty catalog from a typo"
    );

    let (_, _, video) = h.get("/v1/models?media=video").await;
    assert_eq!(video["data"].as_array().unwrap().len(), 1);
    assert_eq!(video["data"][0]["id"], "veo-3");

    let (_, _, all) = h.get("/v1/models?media=all").await;
    assert_eq!(all["data"].as_array().unwrap().len(), 2, "image + video");
    assert_eq!(all["media"], "all");
}

/// The two catalogs must never be mixed: a chat client handed flux/veo would try to
/// route them through this gateway, which cannot serve them.
#[tokio::test]
async fn the_chat_catalog_never_contains_media_models() {
    let h = active_harness();
    let (_, _, body) = h.get("/v1/models").await;
    let ids: Vec<&str> = body["data"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["id"].as_str().unwrap())
        .collect();
    assert!(!ids.contains(&"flux-2"));
    assert!(!ids.contains(&"veo-3"));
}

#[tokio::test]
async fn an_unknown_media_filter_is_a_400_that_names_the_valid_values() {
    let h = active_harness();
    let (status, _, body) = h.get("/v1/models?media=audio").await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let msg = body["error"]["message"].as_str().unwrap();
    assert!(msg.contains("media=image"), "{msg}");
    assert!(msg.contains("media=video"), "{msg}");
    assert!(msg.contains("media=all"), "{msg}");
}

#[tokio::test]
async fn a_suspended_account_cannot_list_models() {
    let h = active_harness();
    h.state
        .ent
        .resolve(7)
        .await
        .expect("baseline resolve works");
    // Flip the account to suspended.
    let fake = FakeEnt {
        ent: Mutex::new(Entitlement {
            user_id: 7,
            status: "suspended".into(),
            plan: plan("pro"),
            period_end: None,
            allowed_models: vec![hosted("deepseek-v4-flash")],
            topup_balance: 0,
        }),
        settings: settings(),
        media: vec![],
        fail: None,
        keys: Arc::new(Registry::new(None)),
    };
    let h = Harness::new(fake);
    let (status, _, body) = h.get("/v1/models").await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["error"]["message"], "account is suspended");
}

/// An empty status must still produce a readable message, never "account is ".
#[tokio::test]
async fn an_unknown_status_is_named_unknown() {
    let h = Harness::new(FakeEnt {
        ent: Mutex::new(Entitlement {
            user_id: 7,
            status: String::new(),
            plan: plan("free"),
            period_end: None,
            allowed_models: vec![],
            topup_balance: 0,
        }),
        settings: settings(),
        media: vec![],
        fail: None,
        keys: Arc::new(Registry::new(None)),
    });
    let (status, _, body) = h.get("/v1/models").await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["error"]["message"], "account is unknown");
}

/// A saturated MySQL pool must surface as a fast retryable 503, not an opaque 500 --
/// the CLI backs off on the first and gives up on the second.
#[tokio::test]
async fn a_resolve_deadline_is_a_retryable_503() {
    let h = Harness::new(FakeEnt {
        ent: Mutex::new(Entitlement {
            user_id: 7,
            status: "active".into(),
            plan: plan("pro"),
            period_end: None,
            allowed_models: vec![],
            topup_balance: 0,
        }),
        settings: settings(),
        media: vec![],
        fail: Some(ResolveError::Deadline),
        keys: Arc::new(Registry::new(None)),
    });
    let (status, headers, body) = h.get("/v1/models").await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(headers.get("retry-after").unwrap(), "1");
    assert_eq!(body["error"]["message"], "gateway busy, please retry");
}

// --- metadata ---------------------------------------------------------------

#[tokio::test]
async fn whoami_reports_the_token_identity() {
    let h = active_harness();
    let (status, _, body) = h.get("/v1/_whoami").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["userId"], 7);
    assert_eq!(body["role"], "user");
}

#[tokio::test]
async fn entitlements_reports_the_resolved_plan_and_catalog() {
    let h = active_harness();
    let (status, _, body) = h.get("/v1/_entitlements").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["userId"], 7);
    assert_eq!(body["status"], "active");
    assert_eq!(body["plan"]["code"], "pro");
    assert_eq!(body["plan"]["creditsPerPeriod"], 1000);
    assert_eq!(body["topupBalance"], 250);
    assert_eq!(body["allowedModels"].as_array().unwrap().len(), 2);
    // The catalog entries must not leak pricing or upstream ids.
    let m = &body["allowedModels"][0];
    assert!(m.get("upstreamModelId").is_none());
    assert!(m.get("inputPricePer1mCents").is_none());
}

// --- count_tokens -----------------------------------------------------------

#[tokio::test]
async fn count_tokens_answers_the_anthropic_shape_with_an_estimate_header() {
    let h = active_harness();
    let (status, headers, body) = h
        .post(
            "/anthropic/v1/messages/count_tokens",
            r#"{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"count these tokens please"}]}"#,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        body.get("input_tokens").is_some(),
        "the SDK parses input_tokens: {body}"
    );
    assert!(body["input_tokens"].as_i64().unwrap() > 0);
    assert_eq!(
        headers.get("x-rayu-token-count").unwrap(),
        "estimate",
        "operators must be able to tell where the number came from"
    );
}

#[tokio::test]
async fn count_tokens_refuses_a_model_the_plan_cannot_use() {
    let h = active_harness();
    let (status, _, body) = h
        .post(
            "/anthropic/v1/messages/count_tokens",
            r#"{"model":"gpt-5.5","messages":[]}"#,
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(
        body["error"]["message"],
        "model not available on your plan: gpt-5.5"
    );
}

#[tokio::test]
async fn count_tokens_rejects_an_unparseable_body() {
    let h = active_harness();
    let (status, _, body) = h
        .post("/anthropic/v1/messages/count_tokens", "not json at all")
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"]["message"], "invalid JSON body");
}

/// Counting must be FREE: no upstream call, and (proven here) no daily turn or credit
/// reserve, because the handler never touches the limiter -- which is `None` in this
/// harness and would panic or 500 if it were used.
#[tokio::test]
async fn count_tokens_never_touches_the_limiter() {
    let h = active_harness();
    assert!(h.state.lim.is_none(), "the harness has no limiter at all");
    let (status, _, _) = h
        .post(
            "/anthropic/v1/messages/count_tokens",
            r#"{"model":"longcat-2","messages":[{"role":"user","content":"hi"}]}"#,
        )
        .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "counting must not require Redis -- it is metadata"
    );
}

// --- topup quote ------------------------------------------------------------

#[tokio::test]
async fn the_topup_quote_prices_from_live_settings() {
    let h = active_harness();
    // 500 credits/dollar with a 500-cent floor means the cheapest payable purchase is
    // 2500 credits, so quote comfortably above it.
    let (status, _, body) = h.get("/v1/credits/topup/quote?credits=5000").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["enabled"], true);
    assert_eq!(body["credits"], 5000);
    // 500 credits per dollar -> 5000 credits = $10.00 = 1000 cents.
    assert_eq!(body["amountCents"], 1000);
    assert_eq!(
        body["minCredits"], 2500,
        "derived from minTopupCents, not stored"
    );
    assert_eq!(
        body["currency"], "USD",
        "Go sends uppercase; the CLI matches it"
    );
    assert_eq!(body["rateCreditsPerDollar"], 500);
    assert_eq!(body["minTopupCents"], 500);
    assert_eq!(body["meetsMinimum"], true);
    assert_eq!(
        body["topUpEnabled"], true,
        "the PLAN flag is separate from whether top-ups exist at all"
    );
}

/// No amount chosen yet must quote the cheapest payable purchase rather than
/// rejecting, so the client can render the screen before the user types.
#[tokio::test]
async fn a_quote_with_no_amount_returns_the_minimum() {
    let h = active_harness();
    let (status, _, body) = h.get("/v1/credits/topup/quote").await;
    assert_eq!(status, StatusCode::OK);
    let min = body["minCredits"].as_i64().unwrap();
    assert!(min > 0);
    assert_eq!(body["credits"], min);
    assert_eq!(body["meetsMinimum"], true);

    // A blank or unparseable value behaves the same way.
    for q in ["?credits=", "?credits=abc", "?credits=0", "?credits=-5"] {
        let (status, _, body) = h.get(&format!("/v1/credits/topup/quote{q}")).await;
        assert_eq!(status, StatusCode::OK, "{q}");
        assert_eq!(body["credits"], min, "{q}");
    }
}

/// Below the floor the quote is bumped UP and flagged, so the client can explain why
/// the number changed instead of silently charging more.
#[tokio::test]
async fn a_below_minimum_quote_is_clamped_and_flagged() {
    let h = active_harness();
    let (status, _, body) = h.get("/v1/credits/topup/quote?credits=1").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["meetsMinimum"], false);
    assert_eq!(
        body["credits"], body["minCredits"],
        "the quote must be raised to the payable minimum"
    );
}

#[tokio::test]
async fn a_suspended_account_cannot_get_a_quote() {
    let h = Harness::new(FakeEnt {
        ent: Mutex::new(Entitlement {
            user_id: 7,
            status: "past_due".into(),
            plan: plan("pro"),
            period_end: None,
            allowed_models: vec![],
            topup_balance: 0,
        }),
        settings: settings(),
        media: vec![],
        fail: None,
        keys: Arc::new(Registry::new(None)),
    });
    let (status, _, body) = h.get("/v1/credits/topup/quote").await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["error"]["message"], "account is past_due");
}

// --- retired ingress --------------------------------------------------------

/// Kept registered rather than 404ing: a published CLI build still POSTs here and
/// must be told what to do.
#[tokio::test]
async fn the_retired_chat_completions_route_answers_410_with_instructions() {
    let h = active_harness();
    let (status, _, body) = h.post("/v1/chat/completions", "{}").await;
    assert_eq!(status, StatusCode::GONE);
    let msg = body["error"]["message"].as_str().unwrap();
    assert!(msg.contains("npm i -g @rayu-dev/rayu-cli"), "{msg}");
    assert!(msg.contains("/anthropic/v1/messages"), "{msg}");
}

// --- CORS + logging boundary ------------------------------------------------

/// A browser preflight must be answered BEFORE auth, or the dashboard cannot read
/// /v1/credits at all.
#[tokio::test]
async fn a_preflight_is_answered_without_a_token() {
    let h = active_harness();
    let req = Request::builder()
        .method(http::Method::OPTIONS)
        .uri("/v1/credits")
        .header("origin", "https://rayucode.com")
        .header("access-control-request-method", "GET")
        .body(Body::empty())
        .unwrap();
    let resp = rayu_gateway_lib::routes::router(h.state.clone())
        .oneshot(req)
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::NO_CONTENT);
    assert!(resp.headers().contains_key("access-control-allow-origin"));
}
