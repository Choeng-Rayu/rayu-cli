//! Immediate config refreshes, shared by the admin paths that must see their own
//! write and by the invalidation bus.
//!
//! Port of the Go gateway's `internal/server/configreload.go`.
//!
//! # Why single-flight and not a debounce
//!
//! A refresh is several MySQL queries plus AES-GCM decryption of every stored
//! provider key, so it must not run once per click when the dashboard fires a
//! burst. The obvious fix -- "skip if we refreshed less than a second ago" -- is
//! WRONG here: an admin who saves, tests, saves again and tests again would get the
//! second test served from the pre-save snapshot, which is precisely the bug this
//! exists to remove. A time window cannot distinguish "we already have this write"
//! from "a newer write landed since".
//!
//! Single-flight has neither problem: genuinely concurrent callers share ONE
//! refresh, while sequential callers each get a fresh read of the database. The
//! only overlap window is the duration of a refresh itself (a few milliseconds),
//! which no human save-then-click cycle can fit inside.

use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::configbus::{Bus, Event};

/// Bounds one refresh, so a wedged database cannot pin the call forever.
pub const CONFIG_RELOAD_TIMEOUT: Duration = Duration::from_secs(10);

/// The refresh operation. Returns a short, log-safe message on failure.
pub type ReloadFn =
    Arc<dyn Fn() -> Pin<Box<dyn Future<Output = Result<(), String>> + Send>> + Send + Sync>;

/// The result of an in-flight shared refresh. `None` means "still running".
type ReloadSlot = tokio::sync::watch::Receiver<Option<Result<(), ReloadError>>>;

/// Why a refresh failed.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ReloadError {
    /// The refresh itself failed (the database is unreachable, a table is missing).
    #[error("{0}")]
    Failed(String),
    /// The refresh outlived [`CONFIG_RELOAD_TIMEOUT`].
    #[error("config refresh timed out")]
    Timeout,
}

/// Collapses concurrent immediate refreshes into one, and optionally announces a
/// refresh to the other replicas.
pub struct ConfigReloader {
    reload: ReloadFn,
    /// `None` means single replica, or no Redis: [`ConfigReloader::broadcast`] then
    /// only refreshes locally.
    bus: Option<Bus>,
    /// Behind an `Arc` so the detached refresh task can clear the slot without
    /// keeping the reloader itself alive.
    inflight: Arc<Mutex<Option<ReloadSlot>>>,
}

impl std::fmt::Debug for ConfigReloader {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ConfigReloader")
            .field("bus", &self.bus.is_some())
            .finish()
    }
}

impl ConfigReloader {
    /// Builds a reloader around a refresh function.
    pub fn new(reload: ReloadFn, bus: Option<Bus>) -> Self {
        Self {
            reload,
            bus,
            inflight: Arc::new(Mutex::new(None)),
        }
    }

    /// Convenience constructor from an async closure.
    pub fn from_fn<F, Fut>(f: F, bus: Option<Bus>) -> Self
    where
        F: Fn() -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<(), String>> + Send + 'static,
    {
        Self::new(Arc::new(move || Box::pin(f())), bus)
    }

    /// Whether a bus is configured (i.e. whether a broadcast can reach anyone).
    pub fn has_bus(&self) -> bool {
        self.bus.is_some()
    }

    /// Refreshes the config snapshot now, joining a refresh already in progress
    /// rather than starting a second one.
    ///
    /// A caller that gives up (its future is dropped because the client hung up)
    /// stops waiting; the shared refresh continues for everyone else, because it is
    /// doing work the other waiters -- and the next request -- still need.
    ///
    /// It does NOT announce anything: this is the local-only path, used by admin
    /// reads (the provider test) and by the bus subscriber itself, which must never
    /// re-publish what it just received.
    pub async fn reload(&self) -> Result<(), ReloadError> {
        let mut rx = self.begin();
        loop {
            if let Some(result) = rx.borrow_and_update().clone() {
                return result;
            }
            if rx.changed().await.is_err() {
                return Err(ReloadError::Failed(
                    "config refresh produced no result".into(),
                ));
            }
        }
    }

    /// Starts a refresh, or returns the slot of the one already running.
    fn begin(&self) -> ReloadSlot {
        let mut guard = self.inflight.lock().expect("inflight mutex poisoned");
        if let Some(existing) = guard.as_ref() {
            return existing.clone();
        }

        let (tx, rx) = tokio::sync::watch::channel(None);
        *guard = Some(rx.clone());
        drop(guard);

        let reload = self.reload.clone();
        let inflight = self.inflight.clone();
        // Detached: the result is shared, so one client hanging up must not abort a
        // refresh the others are waiting for.
        tokio::spawn(async move {
            let result = match tokio::time::timeout(CONFIG_RELOAD_TIMEOUT, reload()).await {
                Ok(Ok(())) => Ok(()),
                Ok(Err(e)) => Err(ReloadError::Failed(e)),
                Err(_) => Err(ReloadError::Timeout),
            };

            // Clear the slot BEFORE releasing the waiters: a caller arriving from
            // here on starts a new refresh instead of joining one that has already
            // read the database, so it can never be handed data older than its own
            // arrival.
            *inflight.lock().expect("inflight mutex poisoned") = None;
            let _ = tx.send(Some(result));
        });
        rx
    }

    /// Refreshes THIS replica and then tells the others to do the same.
    ///
    /// Refresh first, so the replica answering the admin is never the last to know.
    ///
    /// The publish failure is returned SEPARATELY from the refresh error: the local
    /// refresh may well have succeeded, and the caller reports them differently --
    /// one means "your change is not live here", the other means "it is live here
    /// but other replicas will wait for their timer".
    pub async fn broadcast(&self, event: Event) -> (Option<ReloadError>, Option<String>) {
        let reload_err = self.reload().await.err();
        let publish_err = match &self.bus {
            Some(bus) => bus.publish(event).await.err().map(|e| e.to_string()),
            None => None,
        };
        (reload_err, publish_err)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicI64, Ordering};

    /// A burst of admin tests (the dashboard fires one per key and one per model)
    /// must cost ONE database refresh, not one per click.
    #[tokio::test]
    async fn collapses_concurrent_callers() {
        let calls = Arc::new(AtomicI64::new(0));
        let gate = Arc::new(tokio::sync::Notify::new());
        let entered = Arc::new(tokio::sync::Notify::new());

        let (c, g, e) = (calls.clone(), gate.clone(), entered.clone());
        let r = Arc::new(ConfigReloader::from_fn(
            move || {
                let (c, g, e) = (c.clone(), g.clone(), e.clone());
                async move {
                    c.fetch_add(1, Ordering::SeqCst);
                    e.notify_waiters();
                    g.notified().await;
                    Ok(())
                }
            },
            None,
        ));

        // The first caller starts the refresh; wait until it is actually running so
        // the others cannot race ahead and start their own.
        let entered_wait = entered.notified();
        let mut handles = vec![{
            let r = r.clone();
            tokio::spawn(async move { r.reload().await })
        }];
        entered_wait.await;

        for _ in 1..8 {
            let r = r.clone();
            handles.push(tokio::spawn(async move { r.reload().await }));
        }
        // Deterministic instead of a fixed sleep: yield until every joiner has
        // registered on the in-flight slot.
        for _ in 0..64 {
            tokio::task::yield_now().await;
        }
        gate.notify_waiters();

        for h in handles {
            h.await.expect("task").expect("reload");
        }
        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "concurrent callers must share one refresh"
        );
    }

    /// Pins the design decision: NO time window. An admin who saves, tests, saves
    /// again and tests again must get fresh configuration both times -- a debounce
    /// would serve the second test from the pre-save snapshot, which is the bug this
    /// code exists to remove.
    #[tokio::test]
    async fn sequential_calls_each_refresh() {
        let calls = Arc::new(AtomicI64::new(0));
        let c = calls.clone();
        let r = ConfigReloader::from_fn(
            move || {
                let c = c.clone();
                async move {
                    c.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                }
            },
            None,
        );

        for i in 0..3 {
            r.reload()
                .await
                .unwrap_or_else(|e| panic!("reload {i}: {e}"));
        }
        assert_eq!(
            calls.load(Ordering::SeqCst),
            3,
            "one refresh per sequential call, no debounce"
        );
    }

    /// A failed refresh must reach every waiter: the caller decides what to do about
    /// it (the provider test answers from the last snapshot and says so).
    #[tokio::test]
    async fn propagates_the_error_to_every_waiter() {
        let gate = Arc::new(tokio::sync::Notify::new());
        let entered = Arc::new(tokio::sync::Notify::new());
        let (g, e) = (gate.clone(), entered.clone());
        let r = Arc::new(ConfigReloader::from_fn(
            move || {
                let (g, e) = (g.clone(), e.clone());
                async move {
                    e.notify_waiters();
                    g.notified().await;
                    Err("dial tcp: connection refused".to_string())
                }
            },
            None,
        ));

        let entered_wait = entered.notified();
        let mut handles = vec![{
            let r = r.clone();
            tokio::spawn(async move { r.reload().await })
        }];
        entered_wait.await;
        for _ in 1..3 {
            let r = r.clone();
            handles.push(tokio::spawn(async move { r.reload().await }));
        }
        for _ in 0..64 {
            tokio::task::yield_now().await;
        }
        gate.notify_waiters();

        for (i, h) in handles.into_iter().enumerate() {
            let err = h.await.expect("task").expect_err("must fail");
            assert_eq!(
                err,
                ReloadError::Failed("dial tcp: connection refused".into()),
                "caller {i}"
            );
        }
    }

    /// A client that hangs up must not abort a refresh the other waiters need.
    #[tokio::test]
    async fn cancelled_caller_does_not_abort_the_refresh() {
        let gate = Arc::new(tokio::sync::Notify::new());
        let entered = Arc::new(tokio::sync::Notify::new());
        let finished = Arc::new(std::sync::atomic::AtomicBool::new(false));

        let (g, e, f) = (gate.clone(), entered.clone(), finished.clone());
        let r = Arc::new(ConfigReloader::from_fn(
            move || {
                let (g, e, f) = (g.clone(), e.clone(), f.clone());
                async move {
                    e.notify_waiters();
                    g.notified().await;
                    f.store(true, Ordering::SeqCst);
                    Ok(())
                }
            },
            None,
        ));

        // Abandon the caller mid-refresh by dropping its future.
        let entered_wait = entered.notified();
        tokio::select! {
            _ = r.reload() => panic!("reload should not have completed yet"),
            _ = entered_wait => {}
        }

        gate.notify_waiters();
        for _ in 0..200 {
            if finished.load(Ordering::SeqCst) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert!(
            finished.load(Ordering::SeqCst),
            "the refresh did not complete after its caller gave up"
        );
    }

    /// A refresh that never returns is bounded, so an admin click cannot hang for
    /// ever on a wedged database.
    #[tokio::test(start_paused = true)]
    async fn refresh_is_bounded_by_the_timeout() {
        let r = Arc::new(ConfigReloader::from_fn(
            || async {
                tokio::time::sleep(Duration::from_secs(600)).await;
                Ok(())
            },
            None,
        ));
        let handle = {
            let r = r.clone();
            tokio::spawn(async move { r.reload().await })
        };
        tokio::time::advance(CONFIG_RELOAD_TIMEOUT + Duration::from_secs(1)).await;
        assert_eq!(
            handle.await.expect("task").expect_err("must time out"),
            ReloadError::Timeout
        );
    }

    /// With no bus, a broadcast is a local refresh and reports no publish error --
    /// that is the single-replica deployment, not a failure.
    #[tokio::test]
    async fn broadcast_without_a_bus_only_refreshes_locally() {
        let calls = Arc::new(AtomicI64::new(0));
        let c = calls.clone();
        let r = ConfigReloader::from_fn(
            move || {
                let c = c.clone();
                async move {
                    c.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                }
            },
            None,
        );
        assert!(!r.has_bus());
        let (reload_err, publish_err) = r.broadcast(Event::default()).await;
        assert!(reload_err.is_none());
        assert!(publish_err.is_none(), "no bus is not a publish failure");
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    /// The two failures are reported independently, because they mean different
    /// things to the admin.
    #[tokio::test]
    async fn broadcast_reports_reload_and_publish_failures_separately() {
        let r = ConfigReloader::from_fn(|| async { Err("db down".to_string()) }, None);
        let (reload_err, publish_err) = r.broadcast(Event::default()).await;
        assert_eq!(reload_err, Some(ReloadError::Failed("db down".into())));
        assert!(publish_err.is_none());
    }
}
