//! Integration tests for [`rayu_gateway_lib::upstream`] against a fake upstream.
//!
//! These are the behaviours that decide whether a provider blip costs a user their
//! turn: which statuses are retried, which rotate to the next key, and which key
//! failures get reported for health tracking. They run against `wiremock` rather
//! than a mocked client, so the retry loop, the connection pool and the breaker are
//! all real.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rayu_gateway_lib::upstream::*;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

/// Builds a POST request factory for `url`, stamping the key as `x-api-key` so the
/// mock can assert which credential arrived.
fn builder(url: String) -> impl Fn(&str) -> Result<reqwest::Request, UpstreamError> {
    move |secret: &str| {
        reqwest::Client::new()
            .post(&url)
            .header("x-api-key", secret)
            .body("{}")
            .build()
            .map_err(|e| UpstreamError::Build(e.to_string()))
    }
}

fn keys(n: usize) -> Vec<ApiKey> {
    (1..=n)
        .map(|i| ApiKey {
            id: i as i64,
            secret: zeroize::Zeroizing::new(format!("sk-key-{i}")),
        })
        .collect()
}

/// Collects every reported key failure.
fn recorder() -> (OnKeyFailure, Arc<Mutex<Vec<KeyFailure>>>) {
    let seen: Arc<Mutex<Vec<KeyFailure>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = seen.clone();
    let cb: OnKeyFailure = Arc::new(move |f: KeyFailure| sink.lock().unwrap().push(f));
    (cb, seen)
}

#[tokio::test]
async fn a_transient_5xx_is_retried_then_succeeds() {
    let server = MockServer::start().await;
    // First two attempts fail with 503, the third succeeds.
    Mock::given(method("POST"))
        .and(path("/v1/x"))
        .respond_with(ResponseTemplate::new(503))
        .up_to_n_times(2)
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/v1/x"))
        .respond_with(ResponseTemplate::new(200).set_body_string("ok"))
        .mount(&server)
        .await;

    let up = Upstream::new();
    let url = format!("{}/v1/x", server.uri());
    let resp = up
        .do_with_retry(|| {
            reqwest::Client::new()
                .post(&url)
                .build()
                .map_err(|e| UpstreamError::Build(e.to_string()))
        })
        .await
        .expect("should succeed on the third attempt");
    assert_eq!(resp.status().as_u16(), 200);
    assert_eq!(
        server.received_requests().await.unwrap().len(),
        3,
        "two retries then success"
    );
}

#[tokio::test]
async fn retries_stop_after_the_limit_and_return_the_last_response() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(502))
        .mount(&server)
        .await;

    let up = Upstream::new();
    let url = server.uri();
    let resp = up
        .do_with_retry(|| {
            reqwest::Client::new()
                .post(&url)
                .build()
                .map_err(|e| UpstreamError::Build(e.to_string()))
        })
        .await
        .expect("a persistent 502 is returned, not an error");
    assert_eq!(resp.status().as_u16(), 502);
    assert_eq!(
        server.received_requests().await.unwrap().len(),
        3,
        "the initial attempt plus exactly 2 retries"
    );
    // Exhausting retries against a still-retryable status is the breaker's signal.
    let host = reqwest::Url::parse(&server.uri()).unwrap();
    let key = format!("{}:{}", host.host_str().unwrap(), host.port().unwrap_or(80));
    assert_eq!(up.breakers.state(&key), "closed", "one failure of five");
}

/// 429 is the case a naive port gets wrong: it looks transient but retrying it
/// sub-second cannot clear a per-key quota, and the CLI has its own longer backoff.
#[tokio::test]
async fn a_429_is_never_retried() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(429))
        .mount(&server)
        .await;

    let up = Upstream::new();
    let url = server.uri();
    let resp = up
        .do_with_retry(|| {
            reqwest::Client::new()
                .post(&url)
                .build()
                .map_err(|e| UpstreamError::Build(e.to_string()))
        })
        .await
        .expect("429 is returned as-is");
    assert_eq!(resp.status().as_u16(), 429);
    assert_eq!(
        server.received_requests().await.unwrap().len(),
        1,
        "429 must be returned on the first attempt"
    );
}

#[tokio::test]
async fn failover_rotates_past_rate_limited_keys_and_reports_each() {
    let server = MockServer::start().await;
    // Keys 1 and 2 are rate limited; key 3 works. The mock keys off the header.
    Mock::given(method("POST"))
        .and(wiremock::matchers::header("x-api-key", "sk-key-1"))
        .respond_with(ResponseTemplate::new(429).insert_header("retry-after", "7"))
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(wiremock::matchers::header("x-api-key", "sk-key-2"))
        .respond_with(ResponseTemplate::new(402))
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(wiremock::matchers::header("x-api-key", "sk-key-3"))
        .respond_with(ResponseTemplate::new(200).set_body_string("ok"))
        .mount(&server)
        .await;

    let up = Upstream::new();
    let (cb, seen) = recorder();
    let (resp, used) = up
        .send_with_failover(&keys(3), builder(server.uri()), Some(&cb))
        .await
        .expect("the third key must serve the request");

    assert_eq!(resp.status().as_u16(), 200);
    assert_eq!(used.id, 3, "the surviving key is reported back");

    let failures = seen.lock().unwrap();
    assert_eq!(failures.len(), 2, "both failing keys must be reported");
    assert_eq!(failures[0].key_id, 1);
    assert_eq!(failures[0].status, 429);
    assert_eq!(
        failures[0].retry_after,
        Duration::from_secs(7),
        "the provider's Retry-After drives the cooldown"
    );
    assert!(failures[0].rate_limited());
    assert_eq!(failures[1].key_id, 2);
    assert_eq!(failures[1].status, 402);
}

/// The LAST key's failure must still be reported, or a provider whose every key is
/// exhausted would show as healthy and never recover.
#[tokio::test]
async fn the_last_keys_failure_is_still_reported() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(401))
        .mount(&server)
        .await;

    let up = Upstream::new();
    let (cb, seen) = recorder();
    let (resp, used) = up
        .send_with_failover(&keys(2), builder(server.uri()), Some(&cb))
        .await
        .expect("the last key's response is returned, not an error");

    assert_eq!(resp.status().as_u16(), 401);
    assert_eq!(used.id, 2, "the last key tried is reported");
    let failures = seen.lock().unwrap();
    assert_eq!(failures.len(), 2, "including the last key");
    assert!(
        failures.iter().all(|f| !f.rate_limited()),
        "401 means the credential is wrong, not throttled"
    );
}

/// A retryable 5xx is NOT a per-key problem, so it must be returned as-is rather
/// than burning every key in rotation.
#[tokio::test]
async fn a_retryable_5xx_does_not_fail_over_to_the_next_key() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(503))
        .mount(&server)
        .await;

    let up = Upstream::new();
    let (cb, seen) = recorder();
    let (resp, used) = up
        .send_with_failover(&keys(3), builder(server.uri()), Some(&cb))
        .await
        .expect("the 503 is returned");

    assert_eq!(resp.status().as_u16(), 503);
    assert_eq!(used.id, 1, "the first key was never rotated away from");
    assert!(
        seen.lock().unwrap().is_empty(),
        "a 5xx is not a key failure and must not be recorded against one"
    );
    // 3 attempts (1 + 2 retries) against ONE key, not 3 keys x 3 attempts.
    assert_eq!(server.received_requests().await.unwrap().len(), 3);
}

/// A non-rotatable, non-retryable status is returned immediately: one attempt, one
/// key, no health record.
#[tokio::test]
async fn a_client_error_is_returned_without_retry_or_rotation() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(
            ResponseTemplate::new(400).set_body_string(r#"{"error":{"message":"no images"}}"#),
        )
        .mount(&server)
        .await;

    let up = Upstream::new();
    let (cb, seen) = recorder();
    let (resp, _) = up
        .send_with_failover(&keys(3), builder(server.uri()), Some(&cb))
        .await
        .expect("400 is returned");
    assert_eq!(resp.status().as_u16(), 400);
    let body = resp.bytes().await.unwrap();
    assert_eq!(upstream_error_message(&body), "no images");
    assert!(seen.lock().unwrap().is_empty());
    assert_eq!(server.received_requests().await.unwrap().len(), 1);
}

/// An empty key list still gets one attempt, so a keyless provider surfaces the
/// upstream's own 401 rather than a silent gateway error.
#[tokio::test]
async fn an_empty_key_list_still_makes_one_attempt() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(200).set_body_string("ok"))
        .mount(&server)
        .await;

    let up = Upstream::new();
    let (resp, used) = up
        .send_with_failover(&[], builder(server.uri()), None)
        .await
        .expect("one attempt with an empty secret");
    assert_eq!(resp.status().as_u16(), 200);
    assert_eq!(used.id, 0);
    assert_eq!(server.received_requests().await.unwrap().len(), 1);
}

/// A transport error rotates to the next key: the first URL is unroutable, the
/// second works. This also proves a transport failure is NOT retried against the
/// same key (one attempt each).
#[tokio::test]
async fn a_transport_error_rotates_to_the_next_key() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(200).set_body_string("ok"))
        .mount(&server)
        .await;

    let up = Upstream::new();
    let good = server.uri();
    // Key 1 is sent to a closed port; key 2 to the live server.
    let build = move |secret: &str| {
        let url = if secret == "sk-key-1" {
            // Port 1 is reserved and never listening.
            "http://127.0.0.1:1/v1/x".to_string()
        } else {
            format!("{good}/v1/x")
        };
        reqwest::Client::new()
            .post(url)
            .header("x-api-key", secret)
            .body("{}")
            .build()
            .map_err(|e| UpstreamError::Build(e.to_string()))
    };

    let (resp, used) = up
        .send_with_failover(&keys(2), build, None)
        .await
        .expect("the second key must serve it");
    assert_eq!(resp.status().as_u16(), 200);
    assert_eq!(used.id, 2);
}

/// When every key fails at the transport level the error surfaces, so the route can
/// answer 502 rather than pretending success.
#[tokio::test]
async fn all_keys_failing_at_the_transport_level_surfaces_an_error() {
    let up = Upstream::new();
    let build = |secret: &str| {
        reqwest::Client::new()
            .post("http://127.0.0.1:1/v1/x")
            .header("x-api-key", secret)
            .build()
            .map_err(|e| UpstreamError::Build(e.to_string()))
    };
    let err = up
        .send_with_failover(&keys(2), build, None)
        .await
        .expect_err("must fail");
    assert!(matches!(err, UpstreamError::Transport(_)), "got {err:?}");
    assert!(!err.is_circuit_open());
}

/// The breaker opens after enough consecutive failures and then refuses to dial,
/// which the routes translate into 503 + Retry-After rather than 502.
#[tokio::test]
async fn the_breaker_opens_and_then_refuses_to_dial() {
    let up = Upstream::new();
    let build = || {
        reqwest::Client::new()
            .post("http://127.0.0.1:1/v1/x")
            .build()
            .map_err(|e| UpstreamError::Build(e.to_string()))
    };

    // Five consecutive transport failures trip the default threshold.
    for i in 0..5 {
        let err = up.do_with_retry(build).await.expect_err("attempt {i}");
        assert!(matches!(err, UpstreamError::Transport(_)), "attempt {i}");
    }
    assert_eq!(up.breakers.state("127.0.0.1:1"), "open");

    let err = up
        .do_with_retry(build)
        .await
        .expect_err("the breaker must refuse");
    assert!(err.is_circuit_open(), "got {err:?}");
    assert_eq!(err.to_string(), "circuit breaker open");
}

/// THE critical streaming property: the 30s header timeout must bound only the wait
/// for the first byte, never the body. A response whose body streams for longer
/// than the header timeout must complete -- otherwise every long generation would be
/// truncated.
#[tokio::test]
async fn a_slow_body_is_not_cut_off_by_the_header_timeout() {
    let server = MockServer::start().await;
    // Headers arrive at once; the body is delivered after a delay that would trip a
    // whole-response timeout if one existed.
    Mock::given(method("POST"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_string("late but complete")
                .set_delay(Duration::from_millis(300)),
        )
        .mount(&server)
        .await;

    let up = Upstream::new();
    let url = server.uri();
    let resp = up
        .do_with_retry(|| {
            reqwest::Client::new()
                .post(&url)
                .build()
                .map_err(|e| UpstreamError::Build(e.to_string()))
        })
        .await
        .expect("headers arrived promptly");
    assert_eq!(resp.status().as_u16(), 200);
    // Reading the body must succeed even though it arrived well after the send.
    let body = resp.text().await.expect("the body must not be cut off");
    assert_eq!(body, "late but complete");
}

/// Concurrent callers share the pool and the breaker without tripping over each
/// other -- the gateway serves thousands of these at once.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_callers_share_the_client_safely() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(200).set_body_string("ok"))
        .mount(&server)
        .await;

    let up = Arc::new(Upstream::new());
    let ok = Arc::new(AtomicUsize::new(0));
    let mut handles = Vec::new();
    for _ in 0..50 {
        let (up, ok, url) = (up.clone(), ok.clone(), server.uri());
        handles.push(tokio::spawn(async move {
            let resp = up
                .do_with_retry(|| {
                    reqwest::Client::new()
                        .post(&url)
                        .build()
                        .map_err(|e| UpstreamError::Build(e.to_string()))
                })
                .await
                .expect("concurrent call");
            if resp.status().is_success() {
                ok.fetch_add(1, Ordering::SeqCst);
            }
        }));
    }
    for h in handles {
        h.await.expect("no task may panic");
    }
    assert_eq!(ok.load(Ordering::SeqCst), 50);
}
