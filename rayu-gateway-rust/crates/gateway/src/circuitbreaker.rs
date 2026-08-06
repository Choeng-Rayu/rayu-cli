//! A small, dependency-free half-open circuit breaker keyed per upstream host.
//!
//! Port of the Go gateway's `internal/circuitbreaker`.
//!
//! # Why
//!
//! [`crate::upstream`] already retries a single request up to twice on a transient
//! upstream 502/503/504. That smooths over sub-second blips, but under a SUSTAINED
//! outage every one of the gateway's concurrent in-flight requests independently
//! retries against the same dead upstream -- a thundering herd that (a) wastes
//! gateway tasks holding the MySQL/Redis resources they already reserved while
//! waiting on a doomed call, and (b) keeps hammering an upstream that is trying to
//! recover.
//!
//! This breaker sits in front of that per-request retry: once a host accumulates
//! enough consecutive failures it OPENS and every subsequent call fails immediately
//! ([`ERR_OPEN`]) for a cooldown window, instead of paying the full request timeout
//! plus retries. After the cooldown it goes HALF-OPEN and lets a single trial call
//! through; success CLOSES it, failure re-OPENS it with the cooldown reset.

use std::time::{Duration, Instant};

use dashmap::DashMap;

/// The message [`Registry::allow`] denials surface as.
///
/// A distinct marker so the routes can answer 503 + `Retry-After: 5` for
/// "we didn't even dial" rather than the 502 used for "we tried and it didn't
/// answer".
pub const ERR_OPEN: &str = "circuit breaker open";

/// Returned when the breaker for a host is open and the cooldown has not elapsed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("{ERR_OPEN}")]
pub struct ErrOpen;

/// How many consecutive failures open the breaker.
pub const DEFAULT_FAILURE_THRESHOLD: u32 = 5;
/// How long the breaker stays open before allowing a single half-open trial.
pub const DEFAULT_COOLDOWN: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    Closed,
    Open,
    HalfOpen,
}

/// The failure threshold and cooldown. Zero values fall back to the defaults.
#[derive(Debug, Clone, Copy)]
pub struct Config {
    pub failure_threshold: u32,
    pub cooldown: Duration,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            failure_threshold: DEFAULT_FAILURE_THRESHOLD,
            cooldown: DEFAULT_COOLDOWN,
        }
    }
}

impl Config {
    fn normalised(mut self) -> Self {
        if self.failure_threshold == 0 {
            self.failure_threshold = DEFAULT_FAILURE_THRESHOLD;
        }
        if self.cooldown.is_zero() {
            self.cooldown = DEFAULT_COOLDOWN;
        }
        self
    }
}

#[derive(Debug)]
struct Breaker {
    state: State,
    consecutive_fails: u32,
    opened_at: Option<Instant>,
    /// Prevents more than one half-open probe being admitted at once -- additional
    /// callers during the trial are told to wait rather than piling onto the same
    /// untested upstream.
    trial_in_flight: bool,
}

impl Default for Breaker {
    fn default() -> Self {
        Self {
            state: State::Closed,
            consecutive_fails: 0,
            opened_at: None,
            trial_in_flight: false,
        }
    }
}

/// Holds one breaker per host key, created lazily on first use.
///
/// Sharded per host ([`dashmap`]) because [`Registry::allow`] is on the path of
/// every upstream call.
#[derive(Debug)]
pub struct Registry {
    cfg: Config,
    hosts: DashMap<String, Breaker>,
}

impl Default for Registry {
    fn default() -> Self {
        Self::new(Config::default())
    }
}

impl Registry {
    /// Builds a registry. Zero-valued config fields fall back to the defaults.
    pub fn new(cfg: Config) -> Self {
        Self {
            cfg: cfg.normalised(),
            hosts: DashMap::new(),
        }
    }

    /// The configured threshold (diagnostics/tests).
    pub fn failure_threshold(&self) -> u32 {
        self.cfg.failure_threshold
    }
    /// The configured cooldown (diagnostics/tests).
    pub fn cooldown(&self) -> Duration {
        self.cfg.cooldown
    }

    /// Whether a call to `host` may proceed right now.
    ///
    /// When this returns true for a half-open trial, the caller MUST report the
    /// outcome via [`Registry::success`] or [`Registry::failure`] exactly once --
    /// that report is what closes or re-opens the breaker.
    pub fn allow(&self, host: &str) -> bool {
        let mut b = self.hosts.entry(host.to_string()).or_default();
        match b.state {
            State::Closed => true,
            State::Open => {
                let elapsed = b.opened_at.map(|t| t.elapsed()).unwrap_or(Duration::MAX);
                if elapsed < self.cfg.cooldown {
                    return false;
                }
                // Cooldown elapsed: admit exactly one trial call.
                if b.trial_in_flight {
                    return false;
                }
                b.state = State::HalfOpen;
                b.trial_in_flight = true;
                true
            }
            // Another trial is already in flight.
            State::HalfOpen => false,
        }
    }

    /// Reports that a call admitted by [`Registry::allow`] succeeded: closes the
    /// breaker and resets the failure counter.
    pub fn success(&self, host: &str) {
        let mut b = self.hosts.entry(host.to_string()).or_default();
        b.state = State::Closed;
        b.consecutive_fails = 0;
        b.trial_in_flight = false;
    }

    /// Reports that a call admitted by [`Registry::allow`] failed.
    ///
    /// If this pushes the consecutive-failure count to the threshold -- or the
    /// failing call WAS the half-open trial -- the breaker opens (or re-opens) with
    /// a fresh cooldown.
    pub fn failure(&self, host: &str) {
        let mut b = self.hosts.entry(host.to_string()).or_default();
        if b.state == State::HalfOpen {
            // The trial failed: re-open immediately, don't wait for the threshold.
            b.trial_in_flight = false;
            b.state = State::Open;
            b.opened_at = Some(Instant::now());
            return;
        }
        b.consecutive_fails += 1;
        if b.consecutive_fails >= self.cfg.failure_threshold {
            b.state = State::Open;
            b.opened_at = Some(Instant::now());
        }
    }

    /// The current state as a string, for logging/metrics/tests.
    pub fn state(&self, host: &str) -> &'static str {
        match self.hosts.get(host).map(|b| b.state) {
            Some(State::Open) => "open",
            Some(State::HalfOpen) => "half_open",
            _ => "closed",
        }
    }

    /// Every host's state, for the admin stats endpoint (I4).
    pub fn states(&self) -> Vec<(String, &'static str)> {
        self.hosts
            .iter()
            .map(|e| {
                let s = match e.value().state {
                    State::Open => "open",
                    State::HalfOpen => "half_open",
                    State::Closed => "closed",
                };
                (e.key().clone(), s)
            })
            .collect()
    }

    /// Runs `f` only if [`Registry::allow`] permits it, reporting the outcome
    /// automatically based on the returned error.
    ///
    /// Returns [`ErrOpen`] without calling `f` if the breaker is open.
    pub async fn run<F, Fut, T, E>(&self, host: &str, f: F) -> Result<T, BreakerError<E>>
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = Result<T, E>>,
    {
        if !self.allow(host) {
            return Err(BreakerError::Open);
        }
        match f().await {
            Ok(v) => {
                self.success(host);
                Ok(v)
            }
            Err(e) => {
                self.failure(host);
                Err(BreakerError::Inner(e))
            }
        }
    }
}

/// The outcome of [`Registry::run`]: either the breaker refused, or the inner
/// operation failed.
#[derive(Debug)]
pub enum BreakerError<E> {
    Open,
    Inner(E),
}

impl<E: std::fmt::Display> std::fmt::Display for BreakerError<E> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            BreakerError::Open => f.write_str(ERR_OPEN),
            BreakerError::Inner(e) => write!(f, "{e}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOST: &str = "api.example.com";

    #[test]
    fn closed_by_default() {
        let r = Registry::new(Config::default());
        assert!(r.allow(HOST), "a fresh breaker should be closed");
        assert_eq!(r.state(HOST), "closed");
    }

    #[test]
    fn opens_after_the_threshold() {
        let r = Registry::new(Config {
            failure_threshold: 3,
            cooldown: Duration::from_secs(3600),
        });
        for i in 0..2 {
            r.failure(HOST);
            assert_eq!(
                r.state(HOST),
                "closed",
                "after {} failures with threshold 3",
                i + 1
            );
        }
        r.failure(HOST); // the 3rd consecutive failure trips it
        assert_eq!(r.state(HOST), "open");
        assert!(!r.allow(HOST), "open and within cooldown must refuse");
    }

    #[test]
    fn success_resets_the_failure_count() {
        let r = Registry::new(Config {
            failure_threshold: 3,
            cooldown: Duration::from_secs(3600),
        });
        r.failure(HOST);
        r.failure(HOST);
        r.success(HOST); // resets the consecutive counter
        r.failure(HOST);
        r.failure(HOST);
        assert_eq!(
            r.state(HOST),
            "closed",
            "the counter should have reset after success"
        );
    }

    #[test]
    fn half_open_admits_exactly_one_trial_after_cooldown() {
        let r = Registry::new(Config {
            failure_threshold: 1,
            cooldown: Duration::from_millis(10),
        });
        r.failure(HOST); // opens immediately at threshold 1
        assert_eq!(r.state(HOST), "open");
        assert!(!r.allow(HOST), "must refuse immediately after opening");

        std::thread::sleep(Duration::from_millis(20)); // cooldown elapses

        assert!(r.allow(HOST), "must admit one half-open trial");
        assert_eq!(r.state(HOST), "half_open");
        // A second concurrent caller must NOT also get a trial slot.
        assert!(
            !r.allow(HOST),
            "a second concurrent half-open trial must be refused"
        );
    }

    #[test]
    fn half_open_success_closes() {
        let r = Registry::new(Config {
            failure_threshold: 1,
            cooldown: Duration::from_millis(10),
        });
        r.failure(HOST);
        std::thread::sleep(Duration::from_millis(20));
        assert!(r.allow(HOST));
        r.success(HOST);
        assert_eq!(r.state(HOST), "closed");
        assert!(r.allow(HOST));
    }

    #[test]
    fn half_open_failure_reopens_with_a_fresh_cooldown() {
        let r = Registry::new(Config {
            failure_threshold: 1,
            cooldown: Duration::from_millis(10),
        });
        r.failure(HOST);
        std::thread::sleep(Duration::from_millis(20));
        assert!(r.allow(HOST));
        r.failure(HOST); // the trial failed
        assert_eq!(r.state(HOST), "open");
        assert!(
            !r.allow(HOST),
            "a re-open must start a fresh cooldown, not stay admissible"
        );
    }

    #[test]
    fn hosts_are_independent() {
        let r = Registry::new(Config {
            failure_threshold: 1,
            cooldown: Duration::from_secs(3600),
        });
        r.failure("a.example.com");
        assert_eq!(r.state("a.example.com"), "open");
        assert_eq!(r.state("b.example.com"), "closed");
        assert!(r.allow("b.example.com"));
    }

    #[tokio::test]
    async fn run_success_path() {
        let r = Registry::new(Config::default());
        let calls = std::sync::atomic::AtomicUsize::new(0);
        let out: Result<i32, BreakerError<String>> = r
            .run(HOST, || async {
                calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                Ok(7)
            })
            .await;
        assert!(matches!(out, Ok(7)));
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert_eq!(r.state(HOST), "closed");
    }

    #[tokio::test]
    async fn run_failure_path_opens_at_threshold_one() {
        let r = Registry::new(Config {
            failure_threshold: 1,
            ..Config::default()
        });
        let out: Result<(), BreakerError<String>> =
            r.run(HOST, || async { Err("boom".to_string()) }).await;
        assert!(matches!(out, Err(BreakerError::Inner(ref e)) if e == "boom"));
        assert_eq!(r.state(HOST), "open");
    }

    #[tokio::test]
    async fn run_returns_open_without_calling_the_closure() {
        let r = Registry::new(Config {
            failure_threshold: 1,
            cooldown: Duration::from_secs(3600),
        });
        r.failure(HOST); // opens the breaker

        let calls = std::sync::atomic::AtomicUsize::new(0);
        let out: Result<(), BreakerError<String>> = r
            .run(HOST, || async {
                calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                Ok(())
            })
            .await;
        assert!(matches!(out, Err(BreakerError::Open)));
        assert_eq!(
            calls.load(std::sync::atomic::Ordering::SeqCst),
            0,
            "the closure must not run while the breaker is open"
        );
    }

    #[test]
    fn defaults_apply_when_zero() {
        let r = Registry::new(Config {
            failure_threshold: 0,
            cooldown: Duration::ZERO,
        });
        assert_eq!(r.failure_threshold(), DEFAULT_FAILURE_THRESHOLD);
        assert_eq!(r.cooldown(), DEFAULT_COOLDOWN);
    }

    #[test]
    fn err_open_message_matches_go() {
        assert_eq!(ErrOpen.to_string(), "circuit breaker open");
    }
}
