//! Picks which of a provider's API keys to use, and tracks each key's health in
//! memory.
//!
//! Port of the Go gateway's `internal/providerkeys`.
//!
//! # Why per-key state
//!
//! A provider may hold several keys precisely so that one hitting a rate limit
//! doesn't stop traffic. That only works if failures are attributed to the KEY
//! that caused them: treating a provider's keys as one blob means a single
//! exhausted credential looks like "the provider is down".
//!
//! So each key has its own state:
//!
//! | status | meaning |
//! |---|---|
//! | `active` | usable now |
//! | `rate_limited` | a 429 was seen; skipped until `cooldown_until` passes |
//! | `invalid` | a 401/403 was seen (or it failed to decrypt); skipped until an admin replaces it -- retrying a rejected credential wastes latency and can trip provider-side abuse counters |
//! | `disabled` | an admin switched it off |
//!
//! # Speed
//!
//! Everything here is in memory: a request never reads the database and never
//! decrypts. State changes are reported to a sink (the gateway's bounded event
//! queue) so they survive a restart without putting a write on the request path.
//!
//! Sharded per provider ([`dashmap`]) rather than behind one global lock, because
//! [`Registry::pick`] runs on every hosted request and a thousand concurrent
//! streams would otherwise serialise on it.

use std::collections::HashMap;
use std::sync::Arc;

use chrono::{DateTime, Duration as ChronoDuration, Utc};
use dashmap::DashMap;
use subtle::ConstantTimeEq;
use zeroize::Zeroizing;

/// A key's health. Values match the backend's `PROVIDER_KEY_STATUSES` so the
/// dashboard renders what the gateway observed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub enum Status {
    #[serde(rename = "active")]
    Active,
    #[serde(rename = "rate_limited")]
    RateLimited,
    #[serde(rename = "invalid")]
    Invalid,
    #[serde(rename = "disabled")]
    Disabled,
}

impl Status {
    /// The database representation.
    pub fn as_str(&self) -> &'static str {
        match self {
            Status::Active => "active",
            Status::RateLimited => "rate_limited",
            Status::Invalid => "invalid",
            Status::Disabled => "disabled",
        }
    }

    /// Parses a persisted status. An unrecognised or empty value is treated as
    /// active, matching Go's `Status(k.Status)` cast plus its `== ""` fallback.
    pub fn from_db(s: &str) -> Self {
        match s {
            "rate_limited" => Status::RateLimited,
            "invalid" => Status::Invalid,
            "disabled" => Status::Disabled,
            _ => Status::Active,
        }
    }
}

impl std::fmt::Display for Status {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// How long a rate-limited key is skipped when the provider gives no
/// `Retry-After`.
///
/// Long enough to let a per-minute quota recover, short enough that a multi-key
/// provider isn't left with fewer keys than it has.
pub const DEFAULT_COOLDOWN: std::time::Duration = std::time::Duration::from_secs(60);

/// Caps a provider-supplied `Retry-After`: a provider asking for an hour must not
/// silently remove a key from rotation for an hour.
pub const MAX_COOLDOWN: std::time::Duration = std::time::Duration::from_secs(10 * 60);

/// One decrypted, ready-to-use credential.
#[derive(Debug, Clone, Default)]
pub struct Key {
    pub id: i64,
    pub label: String,
    /// Plaintext, in memory only. Zeroized on drop (I1).
    pub secret: Zeroizing<String>,
    /// Safe to log.
    pub masked: String,
    pub priority: i64,
    /// The admin switch from the database.
    pub enabled: bool,
    /// The persisted status the row carried at load time; the in-memory state
    /// machine may move it on from there.
    pub status: Option<Status>,
    /// The persisted cooldown, so a restart doesn't immediately re-hammer a key
    /// the provider was still rate-limiting.
    pub cooldown_until: Option<DateTime<Utc>>,
}

/// An observed health transition, handed to the [`Sink`] for durable write-back.
///
/// Keeping this a plain value (not a DB call) is what keeps the request path free
/// of I/O.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StateChange {
    pub key_id: i64,
    pub status: Status,
    pub cooldown_until: Option<DateTime<Utc>>,
    /// A short, log-safe reason (e.g. `"HTTP 429"`). Never a key.
    pub last_error: String,
    pub used_at: DateTime<Utc>,
}

/// Receives state changes asynchronously. Implementations must not block.
pub type Sink = Arc<dyn Fn(StateChange) + Send + Sync>;

/// Returns the current time. Injectable so cooldown expiry is testable without
/// sleeping.
pub type Clock = Arc<dyn Fn() -> DateTime<Utc> + Send + Sync>;

/// The mutable half of a key, kept separate so a config refresh can replace the
/// immutable half without losing live health.
#[derive(Debug, Clone)]
struct KeyState {
    status: Status,
    cooldown_until: Option<DateTime<Utc>>,
    /// Marks "invalid because THIS gateway could not open the envelope", which is
    /// a property of the master key rather than of the credential. It must never
    /// be latched across refreshes: fixing `RAYU_PROVIDER_SECRET` has to bring the
    /// key back without a restart.
    undecryptable: bool,
}

/// One provider's key set plus their live health.
#[derive(Debug, Default)]
struct ProviderEntry {
    /// Keys in priority order, exactly as loaded.
    keys: Vec<Key>,
    live: HashMap<i64, KeyState>,
}

/// Holds per-provider key sets and their live health.
pub struct Registry {
    providers: DashMap<i64, ProviderEntry>,
    sink: Option<Sink>,
    now: Clock,
}

impl std::fmt::Debug for Registry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Registry")
            .field("providers", &self.providers.len())
            .field("sink", &self.sink.is_some())
            .finish()
    }
}

impl Registry {
    /// Creates an empty registry. `sink` may be `None` (state stays in memory).
    pub fn new(sink: Option<Sink>) -> Self {
        Self {
            providers: DashMap::new(),
            sink,
            now: Arc::new(Utc::now),
        }
    }

    /// Replaces the clock. Test-only seam.
    #[doc(hidden)]
    pub fn with_clock(mut self, now: Clock) -> Self {
        self.now = now;
        self
    }

    /// Installs the key set for a provider, PRESERVING the live health of keys
    /// whose CREDENTIAL is unchanged.
    ///
    /// Preserving health matters: config refreshes every 30s, and if a refresh
    /// reset health, a rate-limited key would be retried every 30s regardless of
    /// its cooldown -- exactly the hammering the cooldown exists to prevent.
    ///
    /// Three cases must NOT be preserved, or a fixed key would stay dead until the
    /// process restarts:
    ///
    /// * the secret is empty (it could not be decrypted): that is a statement
    ///   about THIS gateway's master key, not about the credential, so it is
    ///   re-evaluated on every refresh and never latched;
    /// * the secret CHANGED: an admin replaced the key in the dashboard, so the
    ///   old verdict was about a credential that no longer exists;
    /// * the key is new to this registry: start from what the database recorded.
    pub fn replace(&self, provider_id: i64, keys: Vec<Key>) {
        let mut entry = self.providers.entry(provider_id).or_default();

        let prev_secret: HashMap<i64, Zeroizing<String>> = entry
            .keys
            .iter()
            .map(|k| (k.id, k.secret.clone()))
            .collect();

        let mut next = HashMap::with_capacity(keys.len());
        for k in &keys {
            if k.secret.is_empty() {
                // Unusable, but recoverable the moment the master key is fixed.
                next.insert(
                    k.id,
                    KeyState {
                        status: Status::Invalid,
                        cooldown_until: None,
                        undecryptable: true,
                    },
                );
                continue;
            }

            let previous = entry.live.get(&k.id);
            let old_secret = prev_secret.get(&k.id);
            let same_secret = old_secret
                .map(|s| secrets_equal(s, &k.secret))
                .unwrap_or(false);

            match previous {
                Some(p) if !p.undecryptable && same_secret => {
                    // Same credential -> keep observed health.
                    next.insert(k.id, p.clone());
                    continue;
                }
                _ => {}
            }

            let had_other_secret = old_secret.is_some_and(|s| !s.is_empty() && !same_secret);
            if had_other_secret {
                // A replacement deserves a clean slate: any stored verdict
                // describes the credential that was thrown away.
                next.insert(
                    k.id,
                    KeyState {
                        status: Status::Active,
                        cooldown_until: None,
                        undecryptable: false,
                    },
                );
                continue;
            }

            // New to this registry, or newly decryptable: trust the database.
            next.insert(
                k.id,
                KeyState {
                    status: k.status.unwrap_or(Status::Active),
                    cooldown_until: k.cooldown_until,
                    undecryptable: false,
                },
            );
        }

        entry.keys = keys;
        entry.live = next;
    }

    /// Drops a provider entirely (deleted in the dashboard).
    pub fn forget(&self, provider_id: i64) {
        self.providers.remove(&provider_id);
    }

    /// Returns the keys to try for a provider, best first, EXCLUDING keys that are
    /// disabled, invalid, or still cooling down.
    ///
    /// Returns the whole usable list (not just one key) so the caller can fail
    /// over within a single request without another round of bookkeeping.
    pub fn pick(&self, provider_id: i64) -> Vec<Key> {
        let now = (self.now)();
        let mut out = Vec::new();
        // Keys whose cooldown just elapsed. Collected here and reported AFTER the
        // shard guard is released: the sink is caller-supplied (it enqueues a
        // database write), and calling it while holding the guard would let an
        // unrelated component stall every request that needs a key -- and would
        // deadlock outright if the sink re-entered this provider.
        let mut restored: Vec<i64> = Vec::new();

        {
            let Some(mut entry) = self.providers.get_mut(&provider_id) else {
                return out;
            };
            let entry = &mut *entry;
            out.reserve(entry.keys.len());

            for k in &entry.keys {
                if !k.enabled {
                    continue;
                }
                match entry.live.get_mut(&k.id) {
                    None => {
                        out.push(k.clone());
                    }
                    Some(st) => match st.status {
                        Status::Invalid | Status::Disabled => continue,
                        Status::RateLimited => {
                            if st.cooldown_until.is_some_and(|until| now < until) {
                                continue; // still cooling
                            }
                            // Cooldown elapsed: give it another chance and say so,
                            // so the dashboard stops showing a stale "rate limited".
                            st.status = Status::Active;
                            st.cooldown_until = None;
                            restored.push(k.id);
                            out.push(k.clone());
                        }
                        Status::Active => out.push(k.clone()),
                    },
                }
            }
        }

        for id in restored {
            self.emit(StateChange {
                key_id: id,
                status: Status::Active,
                cooldown_until: None,
                last_error: String::new(),
                used_at: now,
            });
        }
        out
    }

    /// How many keys could serve a request right now (health output).
    pub fn usable(&self, provider_id: i64) -> usize {
        self.pick(provider_id).len()
    }

    /// Puts a key on cooldown after a 429.
    ///
    /// A `retry_after` of zero uses [`DEFAULT_COOLDOWN`]; anything longer than
    /// [`MAX_COOLDOWN`] is capped so a provider can't remove a key from rotation
    /// indefinitely.
    pub fn mark_rate_limited(
        &self,
        provider_id: i64,
        key_id: i64,
        retry_after: std::time::Duration,
    ) {
        let mut window = retry_after;
        if window.is_zero() {
            window = DEFAULT_COOLDOWN;
        }
        if window > MAX_COOLDOWN {
            window = MAX_COOLDOWN;
        }
        let until = (self.now)()
            + ChronoDuration::from_std(window).unwrap_or_else(|_| ChronoDuration::seconds(60));
        self.transition(
            provider_id,
            key_id,
            Status::RateLimited,
            Some(until),
            "HTTP 429 rate limited",
        );
    }

    /// Takes a key out of rotation after an auth/permission failure or a decrypt
    /// failure.
    ///
    /// It stays out until an admin replaces it: retrying a credential the provider
    /// has rejected wastes latency and can trip abuse counters.
    pub fn mark_invalid(&self, provider_id: i64, key_id: i64, reason: &str) {
        self.transition(provider_id, key_id, Status::Invalid, None, reason);
    }

    /// Records a successful use, which is proof the key works: any unhealthy
    /// status is cleared.
    ///
    /// In production a rate-limited key can only reach here after its cooldown
    /// elapsed, and an invalid key can only reach here via the admin provider test
    /// (which deliberately targets keys [`Registry::pick`] would skip) -- in both
    /// cases the response, not the old verdict, is the truth.
    pub fn mark_used(&self, provider_id: i64, key_id: i64) {
        if let Some(mut entry) = self.providers.get_mut(&provider_id) {
            if let Some(st) = entry.live.get_mut(&key_id) {
                if st.status != Status::Active {
                    st.status = Status::Active;
                    st.cooldown_until = None;
                }
            }
        }
        // Emitted unconditionally, matching Go: the write also refreshes lastUsedAt.
        self.emit(StateChange {
            key_id,
            status: Status::Active,
            cooldown_until: None,
            last_error: String::new(),
            used_at: (self.now)(),
        });
    }

    fn transition(
        &self,
        provider_id: i64,
        key_id: i64,
        status: Status,
        until: Option<DateTime<Utc>>,
        reason: &str,
    ) {
        {
            let mut entry = self.providers.entry(provider_id).or_default();
            let st = entry.live.entry(key_id).or_insert(KeyState {
                status: Status::Active,
                cooldown_until: None,
                undecryptable: false,
            });
            st.status = status;
            st.cooldown_until = until;
        }
        self.emit(StateChange {
            key_id,
            status,
            cooldown_until: until,
            last_error: reason.to_string(),
            used_at: (self.now)(),
        });
    }

    fn emit(&self, change: StateChange) {
        if let Some(sink) = &self.sink {
            sink(change);
        }
    }

    /// Returns one key by id, INCLUDING keys [`Registry::pick`] would skip
    /// (disabled, invalid, or cooling down).
    ///
    /// Used by the admin provider test: re-checking a key that was taken out of
    /// rotation is exactly what an admin does after replacing it.
    pub fn find(&self, provider_id: i64, key_id: i64) -> Option<Key> {
        let entry = self.providers.get(&provider_id)?;
        entry.keys.iter().find(|k| k.id == key_id).cloned()
    }

    /// Returns the live health of every key of a provider.
    pub fn snapshot_for(&self, provider_id: i64) -> Vec<Snapshot> {
        let Some(entry) = self.providers.get(&provider_id) else {
            return Vec::new();
        };
        entry
            .keys
            .iter()
            .map(|k| {
                let mut s = Snapshot {
                    id: k.id,
                    label: k.label.clone(),
                    masked: k.masked.clone(),
                    priority: k.priority,
                    enabled: k.enabled,
                    status: Status::Active,
                    cooldown_until: None,
                };
                if let Some(st) = entry.live.get(&k.id) {
                    s.status = st.status;
                    s.cooldown_until = st.cooldown_until;
                }
                // The admin switch wins over observed health: a disabled key must
                // read "disabled" even if it was healthy when it was switched off.
                if !k.enabled {
                    s.status = Status::Disabled;
                    s.cooldown_until = None;
                }
                s
            })
            .collect()
    }

    /// How many providers are tracked (diagnostics).
    pub fn provider_count(&self) -> usize {
        self.providers.len()
    }
}

/// A key's health for the admin health endpoint. Carries the MASK, never the
/// secret.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Snapshot {
    pub id: i64,
    pub label: String,
    #[serde(rename = "maskedKey")]
    pub masked: String,
    pub priority: i64,
    pub enabled: bool,
    pub status: Status,
    /// `None` serializes as `null` rather than a zero timestamp -- a dashboard
    /// showing "cooling until 0001-01-01" would be worse than showing nothing.
    #[serde(rename = "cooldownUntil")]
    pub cooldown_until: Option<DateTime<Utc>>,
}

/// Compares two provider secrets without an early-exit branch (I1).
///
/// The Go original uses `==`. A timing side channel on a server-side comparison of
/// two values the gateway already holds is far-fetched, but this costs nothing and
/// removes the question.
fn secrets_equal(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.ct_eq(b).into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    const PID: i64 = 7;

    fn key(id: i64, priority: i64) -> Key {
        Key {
            id,
            label: "Key".into(),
            secret: Zeroizing::new("sk-secret".into()),
            masked: "sk-sec…(9)".into(),
            priority,
            enabled: true,
            status: Some(Status::Active),
            cooldown_until: None,
        }
    }

    /// A clock a test can advance without sleeping.
    #[derive(Clone)]
    struct TestClock(Arc<Mutex<DateTime<Utc>>>);
    impl TestClock {
        fn new(at: DateTime<Utc>) -> Self {
            Self(Arc::new(Mutex::new(at)))
        }
        fn advance(&self, by: ChronoDuration) {
            let mut g = self.0.lock().unwrap();
            *g += by;
        }
        fn clock(&self) -> Clock {
            let inner = self.0.clone();
            Arc::new(move || *inner.lock().unwrap())
        }
    }

    fn at(secs: i64) -> DateTime<Utc> {
        DateTime::from_timestamp(secs, 0).expect("valid timestamp")
    }

    /// Convenience: build a registry pinned to a test clock.
    fn registry_at(clock: &TestClock, sink: Option<Sink>) -> Registry {
        Registry::new(sink).with_clock(clock.clock())
    }

    fn ids(keys: &[Key]) -> Vec<i64> {
        keys.iter().map(|k| k.id).collect()
    }

    #[test]
    fn pick_returns_keys_in_priority_order() {
        let r = Registry::new(None);
        r.replace(PID, vec![key(1, 0), key(2, 1), key(3, 2)]);
        assert_eq!(ids(&r.pick(PID)), vec![1, 2, 3]);
    }

    #[test]
    fn rate_limited_key_is_skipped_then_restored_after_cooldown() {
        let clock = TestClock::new(at(1_800_000_000));
        let r = registry_at(&clock, None);
        r.replace(PID, vec![key(1, 0), key(2, 1)]);

        r.mark_rate_limited(PID, 1, std::time::Duration::from_secs(30));
        assert_eq!(
            ids(&r.pick(PID)),
            vec![2],
            "during cooldown only key 2 is usable"
        );

        // Still cooling one second before expiry.
        clock.advance(ChronoDuration::seconds(29));
        assert_eq!(ids(&r.pick(PID)), vec![2], "key 1 came back early");

        // Cooldown elapsed -> back in rotation, in its original priority position.
        clock.advance(ChronoDuration::seconds(2));
        assert_eq!(ids(&r.pick(PID)), vec![1, 2]);
    }

    #[test]
    fn invalid_key_is_never_retried() {
        let clock = TestClock::new(at(1_800_000_000));
        let r = registry_at(&clock, None);
        r.replace(PID, vec![key(1, 0), key(2, 1)]);

        r.mark_invalid(PID, 1, "HTTP 401");
        // Not even an hour later: a credential the provider rejected stays out
        // until an admin replaces it.
        clock.advance(ChronoDuration::hours(1));
        assert_eq!(ids(&r.pick(PID)), vec![2]);
    }

    #[test]
    fn all_keys_unusable_yields_nothing() {
        let clock = TestClock::new(at(1_800_000_000));
        let r = registry_at(&clock, None);
        r.replace(PID, vec![key(1, 0), key(2, 1)]);
        r.mark_rate_limited(PID, 1, std::time::Duration::from_secs(60));
        r.mark_invalid(PID, 2, "HTTP 403");
        assert!(
            r.pick(PID).is_empty(),
            "want empty so the caller can fail fast"
        );
        assert_eq!(r.usable(PID), 0);
    }

    #[test]
    fn admin_disabled_key_is_excluded() {
        let r = Registry::new(None);
        let mut k = key(1, 0);
        k.enabled = false;
        r.replace(PID, vec![k, key(2, 1)]);
        assert_eq!(ids(&r.pick(PID)), vec![2]);
    }

    /// A config refresh happens every ~30s. If it reset health, a cooling key would
    /// be retried on every refresh regardless of its cooldown.
    #[test]
    fn config_refresh_preserves_live_health() {
        let clock = TestClock::new(at(1_800_000_000));
        let r = registry_at(&clock, None);
        r.replace(PID, vec![key(1, 0), key(2, 1)]);
        r.mark_rate_limited(PID, 1, std::time::Duration::from_secs(300));

        // The same keys arrive again from the database (whose status still says
        // active).
        r.replace(PID, vec![key(1, 0), key(2, 1)]);

        assert_eq!(ids(&r.pick(PID)), vec![2], "the cooldown was lost");
    }

    /// A restart has no memory, so the PERSISTED cooldown must be honoured on load.
    #[test]
    fn persisted_cooldown_is_honoured_on_first_load() {
        let clock = TestClock::new(at(1_800_000_000));
        let r = registry_at(&clock, None);
        let mut cooling = key(1, 0);
        cooling.status = Some(Status::RateLimited);
        cooling.cooldown_until = Some(at(1_800_000_000) + ChronoDuration::seconds(120));
        r.replace(PID, vec![cooling, key(2, 1)]);

        assert_eq!(
            ids(&r.pick(PID)),
            vec![2],
            "a restart re-hammered a key the provider was still limiting"
        );
        clock.advance(ChronoDuration::seconds(180));
        assert_eq!(ids(&r.pick(PID)), vec![1, 2]);
    }

    #[test]
    fn state_changes_are_reported_for_write_back() {
        let seen: Arc<Mutex<Vec<StateChange>>> = Arc::new(Mutex::new(Vec::new()));
        let sink_seen = seen.clone();
        let clock = TestClock::new(at(1_800_000_000));
        let r = registry_at(
            &clock,
            Some(Arc::new(move |c: StateChange| {
                sink_seen.lock().unwrap().push(c);
            })),
        );
        r.replace(PID, vec![key(1, 0), key(2, 1)]);

        r.mark_rate_limited(PID, 1, std::time::Duration::from_secs(45));
        r.mark_invalid(PID, 2, "HTTP 401");
        r.mark_used(PID, 1);

        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 3, "{seen:?}");
        assert_eq!(seen[0].status, Status::RateLimited);
        assert!(
            seen[0].cooldown_until.is_some(),
            "rate-limit change wants a cooldown deadline"
        );
        assert_eq!(seen[1].status, Status::Invalid);
        assert_eq!(seen[1].last_error, "HTTP 401");
        assert_eq!(seen[2].status, Status::Active);
        // Nothing reported may contain the secret.
        for c in seen.iter() {
            assert_ne!(c.last_error, "sk-secret", "a state change leaked the key");
        }
    }

    #[test]
    fn cooldown_is_capped_and_defaulted() {
        let seen: Arc<Mutex<Vec<StateChange>>> = Arc::new(Mutex::new(Vec::new()));
        let sink_seen = seen.clone();
        let start = at(1_800_000_000);
        let clock = TestClock::new(start);
        let r = registry_at(
            &clock,
            Some(Arc::new(move |c: StateChange| {
                sink_seen.lock().unwrap().push(c);
            })),
        );
        r.replace(PID, vec![key(1, 0), key(2, 1)]);

        // No Retry-After -> the default window.
        r.mark_rate_limited(PID, 1, std::time::Duration::ZERO);
        assert_eq!(
            seen.lock().unwrap()[0].cooldown_until,
            Some(start + ChronoDuration::seconds(60))
        );
        // An absurd Retry-After must not remove a key from rotation for that long.
        r.mark_rate_limited(PID, 2, std::time::Duration::from_secs(6 * 3600));
        assert_eq!(
            seen.lock().unwrap()[1].cooldown_until,
            Some(start + ChronoDuration::seconds(600))
        );
    }

    #[test]
    fn success_clears_a_rate_limit() {
        let clock = TestClock::new(at(1_800_000_000));
        let r = registry_at(&clock, None);
        r.replace(PID, vec![key(1, 0)]);
        r.mark_rate_limited(PID, 1, std::time::Duration::from_secs(3600));
        assert!(r.pick(PID).is_empty(), "expected the key to be cooling");

        // A success proves the limit lifted (e.g. the provider reset the window).
        r.mark_used(PID, 1);
        assert_eq!(r.pick(PID).len(), 1);
    }

    #[test]
    fn snapshot_exposes_health_without_secrets() {
        let clock = TestClock::new(at(1_800_000_000));
        let r = registry_at(&clock, None);
        let mut disabled = key(3, 2);
        disabled.enabled = false;
        r.replace(PID, vec![key(1, 0), key(2, 1), disabled]);
        r.mark_rate_limited(PID, 2, std::time::Duration::from_secs(60));

        let snaps = r.snapshot_for(PID);
        assert_eq!(snaps.len(), 3);
        let by_id: HashMap<i64, &Snapshot> = snaps.iter().map(|s| (s.id, s)).collect();

        assert_eq!(by_id[&1].status, Status::Active);
        // A healthy key reports NO cooldown at all (null), not a zero timestamp.
        assert_eq!(by_id[&1].cooldown_until, None);
        assert_eq!(by_id[&2].status, Status::RateLimited);
        assert!(by_id[&2].cooldown_until.is_some());
        assert_eq!(by_id[&3].status, Status::Disabled);
        assert_eq!(by_id[&3].cooldown_until, None);
        // The snapshot carries the mask, never the secret.
        for s in &snaps {
            assert_ne!(s.masked, "sk-secret", "snapshot leaked the key");
        }
    }

    /// A healthy key must serialize `cooldownUntil: null`, and the field names must
    /// be the ones the dashboard reads.
    #[test]
    fn snapshot_json_shape() {
        let r = Registry::new(None);
        r.replace(PID, vec![key(1, 0)]);
        let snaps = r.snapshot_for(PID);
        let json = serde_json::to_value(&snaps[0]).unwrap();
        assert_eq!(json["id"], 1);
        assert_eq!(json["maskedKey"], "sk-sec…(9)");
        assert_eq!(json["status"], "active");
        assert!(json["cooldownUntil"].is_null());
        assert_eq!(json["enabled"], true);
        assert_eq!(json["priority"], 0);
    }

    /// A sink must never be invoked while the shard guard is held: it performs I/O
    /// on the caller's behalf (a queued database write), so a slow or re-entrant
    /// sink would otherwise block every request that needs a key -- and with
    /// per-provider sharding it would DEADLOCK outright. This exercises the one
    /// path that can do it: a cooldown expiring inside `pick`.
    #[test]
    fn sink_is_never_called_under_the_lock() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::OnceLock;

        let clock = TestClock::new(at(1000));
        let hits = Arc::new(AtomicUsize::new(0));

        // The sink needs to call back into the registry that owns it, so it reads
        // a handle filled in immediately after construction. A Weak keeps the
        // cycle from leaking.
        let handle: Arc<OnceLock<std::sync::Weak<Registry>>> = Arc::new(OnceLock::new());
        let sink_handle = handle.clone();
        let sink_hits = hits.clone();
        let sink: Sink = Arc::new(move |_c: StateChange| {
            if let Some(reg) = sink_handle.get().and_then(|w| w.upgrade()) {
                // Re-entering the same provider is the deadlock shape.
                reg.usable(PID);
            }
            sink_hits.fetch_add(1, Ordering::SeqCst);
        });

        let reg = Arc::new(Registry::new(Some(sink)).with_clock(clock.clock()));
        handle
            .set(Arc::downgrade(&reg))
            .expect("handle is set exactly once");

        reg.replace(PID, vec![key(1, 0)]);
        reg.mark_rate_limited(PID, 1, std::time::Duration::from_secs(10));
        let before = hits.load(Ordering::SeqCst);

        clock.advance(ChronoDuration::seconds(60)); // cooldown elapsed

        // If `pick` still held the shard guard while emitting, this would hang.
        let got = reg.pick(PID);
        assert_eq!(got.len(), 1, "cooldown elapsed, the key must be back");
        assert!(
            hits.load(Ordering::SeqCst) > before,
            "the cooldown expiry was never reported to the sink"
        );
    }

    /// A key whose secret could not be decrypted is unusable, but that verdict is
    /// about the GATEWAY's master key, not the credential -- so fixing the master
    /// key must bring it back on the next refresh, with no restart.
    #[test]
    fn undecryptable_key_recovers_when_it_becomes_readable() {
        let r = Registry::new(None);
        let mut broken = key(1, 0);
        broken.secret = Zeroizing::new(String::new());
        r.replace(PID, vec![broken]);
        assert_eq!(r.usable(PID), 0, "unusable while it cannot be decrypted");
        assert_eq!(r.snapshot_for(PID)[0].status, Status::Invalid);

        // Master key fixed -> same row, now decryptable.
        r.replace(PID, vec![key(1, 0)]);
        assert_eq!(
            r.usable(PID),
            1,
            "must recover once the key decrypts again (no restart required)"
        );
    }

    /// Replacing a key in the dashboard keeps its id but changes the credential, so
    /// an earlier "invalid" verdict must not follow it -- otherwise fixing a
    /// revoked key appears to do nothing until the gateway restarts.
    #[test]
    fn replacing_the_secret_clears_an_old_verdict() {
        let r = Registry::new(None);
        r.replace(PID, vec![key(1, 0)]);
        r.mark_invalid(PID, 1, "HTTP 401");
        assert_eq!(r.usable(PID), 0, "want 0 after a 401");

        // A config refresh with the SAME secret must keep the key out of rotation.
        r.replace(PID, vec![key(1, 0)]);
        assert_eq!(
            r.usable(PID),
            0,
            "a refresh must not resurrect a rejected credential"
        );

        // Admin pasted a new secret for the same key id.
        let mut replaced = key(1, 0);
        replaced.secret = Zeroizing::new("sk-brand-new".into());
        r.replace(PID, vec![replaced]);
        assert_eq!(r.usable(PID), 1, "want 1 after the secret was replaced");
    }

    #[test]
    fn forget_drops_a_provider() {
        let r = Registry::new(None);
        r.replace(PID, vec![key(1, 0)]);
        assert_eq!(r.provider_count(), 1);
        r.forget(PID);
        assert!(r.pick(PID).is_empty());
        assert_eq!(r.provider_count(), 0);
    }

    #[test]
    fn find_includes_keys_pick_would_skip() {
        let r = Registry::new(None);
        let mut disabled = key(2, 1);
        disabled.enabled = false;
        r.replace(PID, vec![key(1, 0), disabled]);
        r.mark_invalid(PID, 1, "HTTP 401");

        // pick() excludes both, but the admin test must still reach them.
        assert!(r.pick(PID).is_empty());
        assert_eq!(r.find(PID, 1).unwrap().id, 1);
        assert_eq!(r.find(PID, 2).unwrap().id, 2);
        assert!(r.find(PID, 99).is_none());
        assert!(r.find(404, 1).is_none());
    }

    #[test]
    fn status_round_trips_through_the_database_representation() {
        for (s, text) in [
            (Status::Active, "active"),
            (Status::RateLimited, "rate_limited"),
            (Status::Invalid, "invalid"),
            (Status::Disabled, "disabled"),
        ] {
            assert_eq!(s.as_str(), text);
            assert_eq!(Status::from_db(text), s);
        }
        // An unknown or empty persisted status reads as active, like Go's cast.
        assert_eq!(Status::from_db(""), Status::Active);
        assert_eq!(Status::from_db("something-new"), Status::Active);
    }

    #[test]
    fn secrets_equal_is_length_safe() {
        assert!(secrets_equal("abc", "abc"));
        assert!(!secrets_equal("abc", "abd"));
        assert!(!secrets_equal("abc", "abcd"));
        assert!(!secrets_equal("", "a"));
        assert!(secrets_equal("", ""));
    }

    /// `pick` and the `mark_*` helpers run concurrently on the request path, so the
    /// registry must be race-free.
    #[test]
    fn concurrent_pick_and_mark() {
        let r = Arc::new(Registry::new(Some(Arc::new(|_| {}))));
        r.replace(PID, vec![key(1, 0), key(2, 1), key(3, 2)]);

        let mut handles = Vec::new();
        for _ in 0..50 {
            for job in 0..3 {
                let r = r.clone();
                handles.push(std::thread::spawn(move || match job {
                    0 => {
                        r.pick(PID);
                    }
                    1 => r.mark_rate_limited(PID, 2, std::time::Duration::from_secs(1)),
                    _ => r.replace(PID, vec![key(1, 0), key(2, 1), key(3, 2)]),
                }));
            }
        }
        for h in handles {
            h.join().expect("no thread may panic");
        }
    }

    /// The whole rotation lifecycle a multi-key provider goes through in
    /// production, asserted end to end: a 429 steps a key aside, traffic moves to
    /// the next key, the cooldown expiring brings it back in its original
    /// position, and a 401 removes a key until an admin replaces it.
    #[test]
    fn rotation_lifecycle_of_a_three_key_provider() {
        let start = at(1_800_000_000);
        let clock = TestClock::new(start);
        let changes: Arc<Mutex<Vec<(i64, Status)>>> = Arc::new(Mutex::new(Vec::new()));
        let sink_changes = changes.clone();
        let r = registry_at(
            &clock,
            Some(Arc::new(move |c: StateChange| {
                sink_changes.lock().unwrap().push((c.key_id, c.status));
            })),
        );
        r.replace(PID, vec![key(1, 0), key(2, 1), key(3, 2)]);

        // 1. All three keys are available, in priority order.
        assert_eq!(ids(&r.pick(PID)), vec![1, 2, 3]);
        assert_eq!(r.usable(PID), 3);

        // 2. Key 1 hits a 429 with a provider-supplied Retry-After of 30s.
        r.mark_rate_limited(PID, 1, std::time::Duration::from_secs(30));
        assert_eq!(ids(&r.pick(PID)), vec![2, 3], "traffic rotates past key 1");
        let snaps = r.snapshot_for(PID);
        assert_eq!(snaps[0].status, Status::RateLimited);
        assert_eq!(
            snaps[0].cooldown_until,
            Some(start + ChronoDuration::seconds(30))
        );

        // 3. Key 2 is rejected outright.
        r.mark_invalid(PID, 2, "HTTP 401");
        assert_eq!(ids(&r.pick(PID)), vec![3], "only key 3 is left");

        // 4. Key 1's cooldown elapses: it returns, in its ORIGINAL position.
        clock.advance(ChronoDuration::seconds(31));
        assert_eq!(ids(&r.pick(PID)), vec![1, 3]);
        assert_eq!(r.snapshot_for(PID)[0].status, Status::Active);

        // 5. Key 2 stays out however long we wait -- only an admin can fix it.
        clock.advance(ChronoDuration::hours(6));
        assert_eq!(ids(&r.pick(PID)), vec![1, 3]);
        assert_eq!(r.snapshot_for(PID)[1].status, Status::Invalid);

        // 6. The admin pastes a new secret for key 2: clean slate, back in rotation.
        let mut fixed = key(2, 1);
        fixed.secret = Zeroizing::new("sk-replacement".into());
        r.replace(PID, vec![key(1, 0), fixed, key(3, 2)]);
        assert_eq!(ids(&r.pick(PID)), vec![1, 2, 3]);

        // Every transition was reported for durable write-back, and none of them
        // carried the secret.
        let seen = changes.lock().unwrap();
        assert!(
            seen.contains(&(1, Status::RateLimited)),
            "missing the 429: {seen:?}"
        );
        assert!(
            seen.contains(&(2, Status::Invalid)),
            "missing the 401: {seen:?}"
        );
        assert!(
            seen.contains(&(1, Status::Active)),
            "missing the cooldown restore: {seen:?}"
        );
    }
}
