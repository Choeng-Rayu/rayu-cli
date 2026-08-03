//! A bounded, async write queue for best-effort durability writes (credit ledger
//! rows, usage-tracking events, provider-key health) that must never block the
//! request path they're attached to.
//!
//! Port of the Go gateway's `internal/eventqueue`.
//!
//! # Why
//!
//! The Go gateway once spawned one untracked goroutine per write, each opening
//! its own short-lived MySQL connection with no shared backpressure. Under
//! concurrent load those competed for the same limited pool as the synchronous
//! request path (entitlement lookups), starving both.
//!
//! This gives all such writes ONE bounded queue and a fixed worker count:
//!
//! * [`Queue::enqueue`] never blocks. At capacity it drops the OLDEST pending
//!   item rather than blocking the caller or growing memory without bound -- a
//!   dropped ledger row is an acceptable, logged loss under extreme load;
//!   stalling the request that scheduled it is not.
//! * Workers process one item at a time, so writes never fan out into more
//!   concurrent MySQL connections than [`Config::workers`].
//! * A failed write is retried with exponential backoff plus jitter.
//! * After [`Config::max_consecutive_failures`] the item is dropped (and
//!   reported), so one never-succeeding write cannot wedge the queue.

use std::collections::VecDeque;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio_util::sync::CancellationToken;

/// Defaults mirroring Go's: small enough to bound MySQL connection usage, large
/// enough that a normal request burst never drops.
pub const DEFAULT_CAPACITY: usize = 4096;
pub const DEFAULT_WORKERS: usize = 4;
pub const DEFAULT_RUN_TIMEOUT: Duration = Duration::from_secs(5);
pub const DEFAULT_BASE_DELAY: Duration = Duration::from_millis(250);
pub const DEFAULT_MAX_DELAY: Duration = Duration::from_secs(10);
pub const DEFAULT_JITTER: Duration = Duration::from_millis(250);
pub const DEFAULT_MAX_CONSECUTIVE_FAILURES: u32 = 5;

/// Why an item was dropped.
pub const REASON_MAX_FAILURES: &str = "max_failures";
pub const REASON_QUEUE_FULL: &str = "queue_full";

/// The error a queued write reports.
///
/// `retry_after` lets an implementation carry a server-supplied backoff hint
/// (e.g. a 429 from a downstream), mirroring Go's `RetryAfter` wrapper error.
#[derive(Debug, Clone)]
pub struct EventError {
    pub message: String,
    pub retry_after: Option<Duration>,
}

impl EventError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            retry_after: None,
        }
    }

    /// An error carrying an explicit backoff, which overrides the exponential
    /// base for the next attempt.
    pub fn with_retry_after(message: impl Into<String>, retry_after: Duration) -> Self {
        Self {
            message: message.into(),
            retry_after: Some(retry_after),
        }
    }
}

impl std::fmt::Display for EventError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for EventError {}

impl From<sqlx::Error> for EventError {
    fn from(e: sqlx::Error) -> Self {
        Self::new(e.to_string())
    }
}

/// The future a queued write returns.
pub type RunFuture = Pin<Box<dyn Future<Output = Result<(), EventError>> + Send>>;

/// A queued write plus the closure that performs it.
///
/// The closure is invoked fresh on every attempt (Go passes a new context per
/// attempt), and always on a DETACHED task -- the whole point is that a client
/// disconnecting must not cancel a durable write that is already queued.
#[derive(Clone)]
pub struct Item {
    /// Identifies the item in logs (e.g. `"record_ledger"`).
    pub name: String,
    /// Performs the write. Returning an error triggers a retry.
    pub run: Arc<dyn Fn() -> RunFuture + Send + Sync>,
}

impl Item {
    /// Builds an item from an async closure.
    pub fn new<F, Fut>(name: impl Into<String>, f: F) -> Self
    where
        F: Fn() -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<(), EventError>> + Send + 'static,
    {
        Self {
            name: name.into(),
            run: Arc::new(move || Box::pin(f()) as RunFuture),
        }
    }
}

impl std::fmt::Debug for Item {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Item").field("name", &self.name).finish()
    }
}

/// Called when an item is dropped: after exhausting retries
/// ([`REASON_MAX_FAILURES`]) or when [`Queue::enqueue`] evicts the oldest pending
/// item under sustained overload ([`REASON_QUEUE_FULL`]).
pub type OnDrop = Arc<dyn Fn(&Item, &str, Option<&EventError>) + Send + Sync>;

/// Queue capacity, concurrency, and retry policy.
#[derive(Clone)]
pub struct Config {
    /// Max pending items before [`Queue::enqueue`] starts dropping the oldest.
    /// 0 uses [`DEFAULT_CAPACITY`].
    pub capacity: usize,
    /// How many items may be in flight at once. Bounds how many concurrent MySQL
    /// connections this queue can hold, independent of how many HTTP requests are
    /// enqueueing. 0 uses [`DEFAULT_WORKERS`].
    pub workers: usize,
    /// Bounds a single attempt. 0 uses [`DEFAULT_RUN_TIMEOUT`].
    pub run_timeout: Duration,
    /// Exponential backoff shape between retries of the SAME item.
    pub base_delay: Duration,
    pub max_delay: Duration,
    pub jitter: Duration,
    /// Caps retries for a single item before it is dropped and the worker moves
    /// on. 0 uses [`DEFAULT_MAX_CONSECUTIVE_FAILURES`].
    pub max_consecutive_failures: u32,
    pub on_drop: Option<OnDrop>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            capacity: DEFAULT_CAPACITY,
            workers: DEFAULT_WORKERS,
            run_timeout: DEFAULT_RUN_TIMEOUT,
            base_delay: DEFAULT_BASE_DELAY,
            max_delay: DEFAULT_MAX_DELAY,
            jitter: DEFAULT_JITTER,
            max_consecutive_failures: DEFAULT_MAX_CONSECUTIVE_FAILURES,
            on_drop: None,
        }
    }
}

impl Config {
    /// Applies Go's zero-value fallbacks.
    fn normalised(mut self) -> Self {
        if self.capacity == 0 {
            self.capacity = DEFAULT_CAPACITY;
        }
        if self.workers == 0 {
            self.workers = DEFAULT_WORKERS;
        }
        if self.run_timeout.is_zero() {
            self.run_timeout = DEFAULT_RUN_TIMEOUT;
        }
        if self.base_delay.is_zero() {
            self.base_delay = DEFAULT_BASE_DELAY;
        }
        if self.max_delay.is_zero() {
            self.max_delay = DEFAULT_MAX_DELAY;
        }
        if self.max_consecutive_failures == 0 {
            self.max_consecutive_failures = DEFAULT_MAX_CONSECUTIVE_FAILURES;
        }
        self
    }
}

impl std::fmt::Debug for Config {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Config")
            .field("capacity", &self.capacity)
            .field("workers", &self.workers)
            .field("run_timeout", &self.run_timeout)
            .field("base_delay", &self.base_delay)
            .field("max_delay", &self.max_delay)
            .field("jitter", &self.jitter)
            .field("max_consecutive_failures", &self.max_consecutive_failures)
            .field("on_drop", &self.on_drop.is_some())
            .finish()
    }
}

struct Shared {
    cfg: Config,
    pending: Mutex<VecDeque<Item>>,
    /// Wakes a worker when an item may be ready.
    notify: tokio::sync::Notify,
    /// Cancelled by [`Queue::close`]. Workers still DRAIN the queue afterwards
    /// and only exit once it is empty -- matching Go, where `take()` failing is
    /// the only path that observes `done`.
    shutdown: CancellationToken,
    closed: std::sync::atomic::AtomicBool,
    enqueued: AtomicI64,
    dropped: AtomicI64,
    succeeded: AtomicI64,
}

/// A bounded async write queue. Construct with [`Queue::new`].
pub struct Queue {
    shared: Arc<Shared>,
    workers: Mutex<Vec<tokio::task::JoinHandle<()>>>,
}

impl std::fmt::Debug for Queue {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Queue")
            .field("pending", &self.pending())
            .field("enqueued", &self.enqueued())
            .field("succeeded", &self.succeeded())
            .field("dropped", &self.dropped())
            .finish()
    }
}

impl Queue {
    /// Builds a queue and starts its workers.
    ///
    /// Must be called from within a tokio runtime.
    pub fn new(cfg: Config) -> Self {
        let cfg = cfg.normalised();
        let workers_n = cfg.workers;
        let shared = Arc::new(Shared {
            cfg,
            pending: Mutex::new(VecDeque::new()),
            notify: tokio::sync::Notify::new(),
            shutdown: CancellationToken::new(),
            closed: std::sync::atomic::AtomicBool::new(false),
            enqueued: AtomicI64::new(0),
            dropped: AtomicI64::new(0),
            succeeded: AtomicI64::new(0),
        });

        let mut handles = Vec::with_capacity(workers_n);
        for _ in 0..workers_n {
            let s = shared.clone();
            handles.push(tokio::spawn(async move { worker(s).await }));
        }
        Self {
            shared,
            workers: Mutex::new(handles),
        }
    }

    /// Adds an item to the pending buffer. Never blocks.
    ///
    /// At capacity the oldest pending item is evicted (reported with
    /// [`REASON_QUEUE_FULL`]) to make room. This is the fast path the request
    /// handler uses -- an HTTP request must never wait on it.
    ///
    /// A no-op after [`Queue::close`].
    pub fn enqueue(&self, item: Item) {
        if self.shared.closed.load(Ordering::SeqCst) {
            return;
        }
        let evicted = {
            let mut q = self.shared.pending.lock().expect("pending mutex poisoned");
            let evicted = if q.len() >= self.shared.cfg.capacity {
                q.pop_front()
            } else {
                None
            };
            q.push_back(item);
            evicted
        };
        if let Some(old) = evicted {
            self.shared.dropped.fetch_add(1, Ordering::Relaxed);
            if let Some(cb) = &self.shared.cfg.on_drop {
                cb(&old, REASON_QUEUE_FULL, None);
            }
        }
        self.shared.enqueued.fetch_add(1, Ordering::Relaxed);
        self.shared.notify.notify_one();
    }

    /// Lifetime count of accepted items.
    pub fn enqueued(&self) -> i64 {
        self.shared.enqueued.load(Ordering::Relaxed)
    }
    /// Lifetime count of dropped items (evicted or retry-exhausted).
    pub fn dropped(&self) -> i64 {
        self.shared.dropped.load(Ordering::Relaxed)
    }
    /// Lifetime count of successful writes.
    pub fn succeeded(&self) -> i64 {
        self.shared.succeeded.load(Ordering::Relaxed)
    }
    /// Current queue depth.
    pub fn pending(&self) -> usize {
        self.shared
            .pending
            .lock()
            .expect("pending mutex poisoned")
            .len()
    }

    /// Stops accepting new items and signals workers.
    ///
    /// Workers still drain whatever is already pending and exit once the queue is
    /// empty; only a retry backoff is cut short. Use [`Queue::wait`] to join them.
    pub fn close(&self) {
        if self.shared.closed.swap(true, Ordering::SeqCst) {
            return;
        }
        self.shared.shutdown.cancel();
        // Wake every parked worker so they observe the cancellation.
        self.shared.notify.notify_waiters();
    }

    /// Waits for all workers to exit. Call [`Queue::close`] first.
    pub async fn wait(&self) {
        let handles: Vec<_> = {
            let mut w = self.workers.lock().expect("workers mutex poisoned");
            std::mem::take(&mut *w)
        };
        for h in handles {
            let _ = h.await;
        }
    }

    /// Drains the queue, then closes it.
    ///
    /// Waits up to `timeout` for the queue to empty, then closes regardless -- a
    /// slow/stuck MySQL at shutdown must not hang the process past its own
    /// termination deadline. Port of Go's `Server.Shutdown`.
    pub async fn shutdown(&self, timeout: Duration) {
        let deadline = tokio::time::Instant::now() + timeout;
        while self.pending() > 0 && tokio::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let pending = self.pending();
        if pending > 0 {
            tracing::warn!("eventqueue: shutdown timeout with {pending} item(s) still pending");
        }
        self.close();
        self.wait().await;
    }

    /// The backoff before the next attempt. Exposed for tests.
    #[doc(hidden)]
    pub fn retry_delay(&self, failures: u32, err: &EventError) -> Duration {
        retry_delay(&self.shared.cfg, failures, err)
    }
}

impl Drop for Queue {
    fn drop(&mut self) {
        self.close();
    }
}

/// Mirrors Go's `retryDelay`: exponential backoff clamped to `max_delay`, plus
/// uniform jitter. An explicit `retry_after` overrides the exponential base.
fn retry_delay(cfg: &Config, failures: u32, err: &EventError) -> Duration {
    let jitter = if cfg.jitter.is_zero() {
        Duration::ZERO
    } else {
        let nanos = rand::random::<u64>() % (cfg.jitter.as_nanos() as u64).max(1);
        Duration::from_nanos(nanos)
    };

    if let Some(ra) = err.retry_after.filter(|d| !d.is_zero()) {
        return ra.clamp(cfg.base_delay, cfg.max_delay) + jitter;
    }

    // base * 2^(failures-1), with an overflow guard, then clamp.
    let exp = cfg
        .base_delay
        .checked_mul(
            1u32.checked_shl(failures.saturating_sub(1))
                .unwrap_or(u32::MAX),
        )
        .unwrap_or(cfg.max_delay)
        .min(cfg.max_delay);
    exp + jitter
}

async fn worker(shared: Arc<Shared>) {
    loop {
        let next = {
            let mut q = shared.pending.lock().expect("pending mutex poisoned");
            q.pop_front()
        };
        match next {
            Some(item) => run_with_retry(&shared, item).await,
            None => {
                // Queue empty: exit only if closed, else park until woken. Go
                // observes `done` in exactly this position, which is why closing
                // still drains whatever is already pending.
                if shared.shutdown.is_cancelled() {
                    return;
                }
                tokio::select! {
                    _ = shared.notify.notified() => {}
                    _ = shared.shutdown.cancelled() => {}
                }
            }
        }
    }
}

/// Runs one item, retrying with backoff on failure up to
/// `max_consecutive_failures`.
///
/// A panic inside the write is recovered and treated as a failed attempt rather
/// than crashing the worker. This matters more in Rust than the comment in Go
/// suggests: an un-recovered panic in a spawned task would silently kill that
/// worker, permanently reducing the queue's concurrency with no other symptom.
async fn run_with_retry(shared: &Arc<Shared>, item: Item) {
    let mut failures: u32 = 0;
    loop {
        let err = run_once(shared, &item).await;
        let Some(err) = err else {
            shared.succeeded.fetch_add(1, Ordering::Relaxed);
            return;
        };

        failures += 1;
        if failures >= shared.cfg.max_consecutive_failures {
            shared.dropped.fetch_add(1, Ordering::Relaxed);
            if let Some(cb) = &shared.cfg.on_drop {
                cb(&item, REASON_MAX_FAILURES, Some(&err));
            }
            return;
        }

        let delay = retry_delay(&shared.cfg, failures, &err);
        tokio::select! {
            _ = shared.shutdown.cancelled() => return,
            _ = tokio::time::sleep(delay) => {}
        }
    }
}

/// Invokes the write once, converting a timeout or a panic into an error so the
/// retry/drop accounting handles all three uniformly.
async fn run_once(shared: &Arc<Shared>, item: &Item) -> Option<EventError> {
    let fut = (item.run)();
    // Spawning isolates a panic: the JoinHandle reports it instead of unwinding
    // through -- and therefore killing -- this worker.
    let handle = tokio::spawn(fut);
    match tokio::time::timeout(shared.cfg.run_timeout, handle).await {
        Ok(Ok(Ok(()))) => None,
        Ok(Ok(Err(e))) => Some(e),
        Ok(Err(join_err)) => Some(EventError::new(if join_err.is_panic() {
            format!("panic in eventqueue item {:?}", item.name)
        } else {
            format!("eventqueue item {:?} was cancelled", item.name)
        })),
        Err(_) => Some(EventError::new(format!(
            "eventqueue item {:?} timed out after {:?}",
            item.name, shared.cfg.run_timeout
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicI32};

    /// Polls `cond` until true or the timeout elapses. Keeps the async assertions
    /// free of sleep-and-hope.
    async fn wait_for(timeout: Duration, mut cond: impl FnMut() -> bool) {
        let deadline = tokio::time::Instant::now() + timeout;
        while tokio::time::Instant::now() < deadline {
            if cond() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
        assert!(cond(), "condition not met within {timeout:?}");
    }

    fn fast_cfg(workers: usize) -> Config {
        Config {
            workers,
            base_delay: Duration::from_millis(1),
            max_delay: Duration::from_millis(5),
            jitter: Duration::ZERO,
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn runs_successfully() {
        let q = Queue::new(fast_cfg(1));
        let ran = Arc::new(AtomicBool::new(false));
        let flag = ran.clone();
        q.enqueue(Item::new("test", move || {
            let flag = flag.clone();
            async move {
                flag.store(true, Ordering::SeqCst);
                Ok(())
            }
        }));

        wait_for(Duration::from_secs(1), || ran.load(Ordering::SeqCst)).await;
        wait_for(Duration::from_secs(1), || q.succeeded() == 1).await;
        assert_eq!(q.dropped(), 0);
        assert_eq!(q.enqueued(), 1);
    }

    #[tokio::test]
    async fn retries_on_failure_then_succeeds() {
        let q = Queue::new(fast_cfg(1));
        let attempts = Arc::new(AtomicI32::new(0));
        let a = attempts.clone();
        q.enqueue(Item::new("flaky", move || {
            let a = a.clone();
            async move {
                let n = a.fetch_add(1, Ordering::SeqCst) + 1;
                if n < 3 {
                    return Err(EventError::new("transient failure"));
                }
                Ok(())
            }
        }));

        wait_for(Duration::from_secs(2), || q.succeeded() == 1).await;
        assert_eq!(
            attempts.load(Ordering::SeqCst),
            3,
            "want 2 failures then success"
        );
    }

    #[tokio::test]
    async fn drops_after_max_consecutive_failures() {
        let dropped: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        let seen = dropped.clone();
        let cfg = Config {
            max_consecutive_failures: 3,
            on_drop: Some(Arc::new(move |_item, reason, err| {
                assert!(err.is_some(), "drop must carry the last error");
                *seen.lock().unwrap() = Some(reason.to_string());
            })),
            ..fast_cfg(1)
        };
        let q = Queue::new(cfg);

        let attempts = Arc::new(AtomicI32::new(0));
        let a = attempts.clone();
        q.enqueue(Item::new("always-fails", move || {
            let a = a.clone();
            async move {
                a.fetch_add(1, Ordering::SeqCst);
                Err(EventError::new("permanent failure"))
            }
        }));

        wait_for(Duration::from_secs(2), || dropped.lock().unwrap().is_some()).await;
        assert_eq!(
            attempts.load(Ordering::SeqCst),
            3,
            "want exactly max_consecutive_failures attempts"
        );
        assert_eq!(
            dropped.lock().unwrap().as_deref(),
            Some(REASON_MAX_FAILURES)
        );
        assert_eq!(q.dropped(), 1);
        assert_eq!(q.succeeded(), 0);
    }

    #[tokio::test]
    async fn queue_full_evicts_the_oldest_pending_item() {
        // Block the single worker on the first item so the queue backs up, then
        // verify a later enqueue evicts the OLDEST pending item rather than
        // blocking the caller.
        let dropped: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let seen = dropped.clone();
        let cfg = Config {
            capacity: 2,
            on_drop: Some(Arc::new(move |item: &Item, reason: &str, _| {
                seen.lock()
                    .unwrap()
                    .push(format!("{}:{}", item.name, reason));
            })),
            ..fast_cfg(1)
        };
        let q = Queue::new(cfg);

        let release = Arc::new(tokio::sync::Notify::new());
        let started = Arc::new(AtomicBool::new(false));
        let (r, s) = (release.clone(), started.clone());
        q.enqueue(Item::new("first", move || {
            let (r, s) = (r.clone(), s.clone());
            async move {
                s.store(true, Ordering::SeqCst);
                r.notified().await; // block the only worker
                Ok(())
            }
        }));
        // Ensure "first" is already executing, not merely pending.
        wait_for(Duration::from_secs(1), || started.load(Ordering::SeqCst)).await;

        q.enqueue(Item::new("second", || async { Ok(()) }));
        q.enqueue(Item::new("third", || async { Ok(()) }));
        // Capacity is 2 and "first" is off the pending queue (it is running), so
        // "second" and "third" fill it; "fourth" must evict "second".
        q.enqueue(Item::new("fourth", || async { Ok(()) }));

        release.notify_waiters();

        wait_for(Duration::from_secs(1), || {
            !dropped.lock().unwrap().is_empty()
        })
        .await;
        assert_eq!(
            dropped.lock().unwrap().first().map(String::as_str),
            Some("second:queue_full")
        );
    }

    #[tokio::test]
    async fn panic_is_recovered_and_the_worker_survives() {
        let drop_err: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        let seen = drop_err.clone();
        let cfg = Config {
            max_consecutive_failures: 1,
            on_drop: Some(Arc::new(move |_item, _reason, err| {
                *seen.lock().unwrap() = err.map(|e| e.message.clone());
            })),
            ..fast_cfg(1)
        };
        let q = Queue::new(cfg);

        q.enqueue(Item::new("panics", || async {
            panic!("boom");
        }));

        wait_for(Duration::from_secs(2), || {
            drop_err.lock().unwrap().is_some()
        })
        .await;
        let msg = drop_err.lock().unwrap().clone().unwrap();
        assert!(msg.contains("panic"), "error should name the panic: {msg}");

        // The worker must still be alive: enqueue and run an unrelated item.
        let ran = Arc::new(AtomicBool::new(false));
        let flag = ran.clone();
        q.enqueue(Item::new("after-panic", move || {
            let flag = flag.clone();
            async move {
                flag.store(true, Ordering::SeqCst);
                Ok(())
            }
        }));
        wait_for(Duration::from_secs(2), || ran.load(Ordering::SeqCst)).await;
    }

    #[tokio::test]
    async fn a_hung_write_is_bounded_by_the_run_timeout() {
        let dropped = Arc::new(AtomicBool::new(false));
        let seen = dropped.clone();
        let cfg = Config {
            run_timeout: Duration::from_millis(50),
            max_consecutive_failures: 1,
            on_drop: Some(Arc::new(move |_i, reason, err| {
                assert_eq!(reason, REASON_MAX_FAILURES);
                assert!(err.unwrap().message.contains("timed out"));
                seen.store(true, Ordering::SeqCst);
            })),
            ..fast_cfg(1)
        };
        let q = Queue::new(cfg);

        q.enqueue(Item::new("hangs", || async {
            tokio::time::sleep(Duration::from_secs(60)).await;
            Ok(())
        }));

        wait_for(Duration::from_secs(3), || dropped.load(Ordering::SeqCst)).await;
    }

    #[tokio::test]
    async fn retry_after_overrides_the_backoff_base() {
        let q = Queue::new(Config {
            base_delay: Duration::from_secs(1),
            max_delay: Duration::from_secs(60),
            jitter: Duration::ZERO,
            ..Default::default()
        });
        let d = q.retry_delay(
            1,
            &EventError::with_retry_after("rate limited", Duration::from_secs(3)),
        );
        assert_eq!(d, Duration::from_secs(3));
    }

    #[tokio::test]
    async fn retry_after_is_clamped_to_max_delay() {
        let q = Queue::new(Config {
            base_delay: Duration::from_secs(1),
            max_delay: Duration::from_secs(5),
            jitter: Duration::ZERO,
            ..Default::default()
        });
        let d = q.retry_delay(
            1,
            &EventError::with_retry_after("rate limited", Duration::from_secs(3600)),
        );
        assert_eq!(d, Duration::from_secs(5));
    }

    #[tokio::test]
    async fn retry_after_is_floored_at_base_delay() {
        // Go raises a sub-base RetryAfter up to BaseDelay.
        let q = Queue::new(Config {
            base_delay: Duration::from_secs(1),
            max_delay: Duration::from_secs(5),
            jitter: Duration::ZERO,
            ..Default::default()
        });
        let d = q.retry_delay(
            1,
            &EventError::with_retry_after("rate limited", Duration::from_millis(10)),
        );
        assert_eq!(d, Duration::from_secs(1));
    }

    #[tokio::test]
    async fn exponential_backoff_without_retry_after() {
        let q = Queue::new(Config {
            base_delay: Duration::from_millis(100),
            max_delay: Duration::from_secs(10),
            jitter: Duration::ZERO,
            ..Default::default()
        });
        let e = EventError::new("plain");
        // failures=1 -> base * 2^0
        assert_eq!(q.retry_delay(1, &e), Duration::from_millis(100));
        // failures=3 -> base * 2^2
        assert_eq!(q.retry_delay(3, &e), Duration::from_millis(400));
        // A large failure count clamps rather than overflowing.
        assert_eq!(q.retry_delay(40, &e), Duration::from_secs(10));
    }

    #[tokio::test]
    async fn enqueue_after_close_is_a_no_op() {
        let q = Queue::new(fast_cfg(1));
        q.close();

        let ran = Arc::new(AtomicBool::new(false));
        let flag = ran.clone();
        q.enqueue(Item::new("after-close", move || {
            let flag = flag.clone();
            async move {
                flag.store(true, Ordering::SeqCst);
                Ok(())
            }
        }));
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(
            !ran.load(Ordering::SeqCst),
            "enqueue after close must no-op"
        );
        assert_eq!(q.enqueued(), 0);
    }

    #[tokio::test]
    async fn pending_reflects_queue_depth() {
        let q = Queue::new(Config {
            capacity: 10,
            ..fast_cfg(1)
        });

        let release = Arc::new(tokio::sync::Notify::new());
        let started = Arc::new(AtomicBool::new(false));
        let (r, s) = (release.clone(), started.clone());
        q.enqueue(Item::new("blocker", move || {
            let (r, s) = (r.clone(), s.clone());
            async move {
                s.store(true, Ordering::SeqCst);
                r.notified().await;
                Ok(())
            }
        }));
        wait_for(Duration::from_secs(1), || started.load(Ordering::SeqCst)).await;

        q.enqueue(Item::new("waiting-1", || async { Ok(()) }));
        q.enqueue(Item::new("waiting-2", || async { Ok(()) }));

        wait_for(Duration::from_secs(1), || q.pending() == 2).await;
        release.notify_waiters();
    }

    /// The queue's whole reason for existing is bounding concurrent DB
    /// connections, so the worker count must be a hard ceiling.
    #[tokio::test]
    async fn concurrency_never_exceeds_the_worker_count() {
        let live = Arc::new(AtomicI32::new(0));
        let peak = Arc::new(AtomicI32::new(0));
        let q = Queue::new(Config {
            workers: 3,
            capacity: 100,
            ..fast_cfg(3)
        });

        for _ in 0..30 {
            let (live, peak) = (live.clone(), peak.clone());
            q.enqueue(Item::new("counted", move || {
                let (live, peak) = (live.clone(), peak.clone());
                async move {
                    let now = live.fetch_add(1, Ordering::SeqCst) + 1;
                    peak.fetch_max(now, Ordering::SeqCst);
                    tokio::time::sleep(Duration::from_millis(5)).await;
                    live.fetch_sub(1, Ordering::SeqCst);
                    Ok(())
                }
            }));
        }

        wait_for(Duration::from_secs(5), || q.succeeded() == 30).await;
        assert!(
            peak.load(Ordering::SeqCst) <= 3,
            "peak concurrency {} exceeded workers=3",
            peak.load(Ordering::SeqCst)
        );
    }

    /// A restart must not silently lose queued writes: shutdown drains first.
    #[tokio::test]
    async fn shutdown_drains_before_closing() {
        let done = Arc::new(AtomicI32::new(0));
        let q = Queue::new(Config {
            capacity: 100,
            ..fast_cfg(2)
        });

        for _ in 0..20 {
            let done = done.clone();
            q.enqueue(Item::new("slow", move || {
                let done = done.clone();
                async move {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                    done.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                }
            }));
        }

        q.shutdown(Duration::from_secs(5)).await;
        assert_eq!(
            done.load(Ordering::SeqCst),
            20,
            "shutdown must drain every pending write"
        );
        assert_eq!(q.pending(), 0);
    }

    /// Volume check: 5000 writes against a sink where every 5th call fails once.
    /// Every item must eventually succeed (retry works), nothing may be dropped
    /// (capacity is ample), and the counters must add up exactly.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn high_volume_against_a_flaky_sink_keeps_exact_counters() {
        const N: i64 = 5000;
        let dropped_names: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let seen = dropped_names.clone();
        let q = Queue::new(Config {
            workers: 4,
            capacity: 8192,
            base_delay: Duration::from_micros(200),
            max_delay: Duration::from_millis(2),
            jitter: Duration::ZERO,
            on_drop: Some(Arc::new(move |item: &Item, reason: &str, _| {
                seen.lock()
                    .unwrap()
                    .push(format!("{}:{}", item.name, reason));
            })),
            ..Default::default()
        });

        let attempts = Arc::new(AtomicI64::new(0));
        for i in 0..N {
            let attempts = attempts.clone();
            let failed_once = Arc::new(AtomicBool::new(false));
            q.enqueue(Item::new(format!("w{i}"), move || {
                let (attempts, failed_once) = (attempts.clone(), failed_once.clone());
                async move {
                    attempts.fetch_add(1, Ordering::Relaxed);
                    // Every 5th item fails its first attempt, then succeeds.
                    if i % 5 == 0 && !failed_once.swap(true, Ordering::SeqCst) {
                        return Err(EventError::new("flaky sink"));
                    }
                    Ok(())
                }
            }));
        }

        wait_for(Duration::from_secs(30), || q.succeeded() == N).await;
        assert_eq!(q.enqueued(), N, "every enqueue must be accepted");
        assert_eq!(q.succeeded(), N, "every item must eventually succeed");
        assert_eq!(
            q.dropped(),
            0,
            "nothing may be dropped: {:?}",
            dropped_names.lock().unwrap()
        );
        assert_eq!(q.pending(), 0);
        // N items plus one extra attempt for each of the N/5 flaky ones.
        assert_eq!(attempts.load(Ordering::Relaxed), N + N / 5);
    }
}
