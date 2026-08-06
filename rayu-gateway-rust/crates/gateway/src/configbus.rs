//! Carries "the admin changed the configuration" between gateway replicas.
//!
//! Port of the Go gateway's `internal/configbus`.
//!
//! # Why it exists
//!
//! The gateway serves provider routes, models and keys from an in-memory snapshot
//! refreshed on a timer (`CONFIG_REFRESH_SECONDS`). That is what keeps a request
//! from touching MySQL, but it also means an admin's save is invisible for up to
//! one refresh interval -- long enough that "I saved it and it still uses the old
//! configuration" is the reported experience.
//!
//! A single replica can fix that by refreshing when its own admin request arrives.
//! Several replicas cannot: the dashboard's save reaches exactly one of them, and
//! the rest keep serving the old snapshot until their timers fire. This bus is the
//! fan-out.
//!
//! It is deliberately a NOTIFICATION, never the data itself. A message says only
//! "something changed"; every replica then re-reads the database, which is the
//! single source of truth. So a lost, duplicated or out-of-order message can never
//! corrupt configuration -- it can only delay it to the next timer tick, exactly
//! the behaviour that exists today.

use std::sync::Arc;
use std::time::Duration;

use futures::StreamExt;
use tokio_util::sync::CancellationToken;

/// The Redis pub/sub channel used when none is configured.
pub const DEFAULT_CHANNEL: &str = "rayu:config-changed";

/// Reasons naming what an admin changed.
///
/// They exist for the log line an operator reads when they ask "did my save reach
/// the gateway?", not for control flow.
pub const REASON_PROVIDERS: &str = "providers";
pub const REASON_KEYS: &str = "keys";
pub const REASON_MODELS: &str = "models";
pub const REASON_PLANS: &str = "plans";
pub const REASON_MANUAL: &str = "manual";

/// How long to wait before re-subscribing after the connection drops.
const RECONNECT_DELAY: Duration = Duration::from_secs(1);

/// One invalidation notice.
///
/// Field names and the omit-when-empty behaviour match Go's struct tags, so the
/// on-the-wire payload is interchangeable with the Go gateway's during a canary.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Event {
    /// What changed (see the `REASON_*` constants). Informational.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub reason: String,
    /// When non-zero, additionally drops that user's cached entitlement -- used
    /// when a change affects one account (plan switch, suspension) rather than the
    /// shared catalog.
    #[serde(rename = "userId", default, skip_serializing_if = "is_zero")]
    pub user_id: i64,
    /// Identifies the publisher so it can ignore its own message: the replica that
    /// published has already refreshed locally.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub node: String,
}

fn is_zero(v: &i64) -> bool {
    *v == 0
}

/// Publishes and receives invalidation notices over Redis pub/sub.
///
/// A bus with no client is the "no Redis configured" case: publishing and
/// subscribing are no-ops, so the gateway still runs on the timer alone.
#[derive(Clone)]
pub struct Bus {
    client: Option<redis::Client>,
    /// Reconnecting connection used for publishing.
    publisher: Option<Arc<tokio::sync::Mutex<redis::aio::ConnectionManager>>>,
    channel: String,
    node: String,
}

impl std::fmt::Debug for Bus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Bus")
            .field("channel", &self.channel)
            .field("node", &self.node)
            .field("connected", &self.client.is_some())
            .finish()
    }
}

impl Bus {
    /// Builds an inert bus (no Redis). Publishing and subscribing do nothing.
    pub fn disabled(channel: &str) -> Self {
        Self {
            client: None,
            publisher: None,
            channel: resolve_channel(channel),
            node: new_node_id(),
        }
    }

    /// Builds a bus on a Redis URL.
    ///
    /// An empty channel uses [`DEFAULT_CHANNEL`].
    pub async fn connect(redis_url: &str, channel: &str) -> Result<Self, redis::RedisError> {
        let client = redis::Client::open(redis_url)?;
        let manager = redis::aio::ConnectionManager::new(client.clone()).await?;
        Ok(Self {
            client: Some(client),
            publisher: Some(Arc::new(tokio::sync::Mutex::new(manager))),
            channel: resolve_channel(channel),
            node: new_node_id(),
        })
    }

    /// This process's publisher id (appears in logs).
    pub fn node(&self) -> &str {
        &self.node
    }

    /// The pub/sub channel in use (appears in logs).
    pub fn channel(&self) -> &str {
        &self.channel
    }

    /// Announces a change to every replica.
    ///
    /// The caller must have already refreshed itself: this is fan-out, not a local
    /// trigger.
    ///
    /// A publish failure is the caller's to log and ignore -- the periodic refresh
    /// is still the safety net, so a Redis blip delays a change instead of losing
    /// it.
    pub async fn publish(&self, mut event: Event) -> Result<(), redis::RedisError> {
        let Some(publisher) = &self.publisher else {
            return Ok(());
        };
        event.node = self.node.clone();
        let payload = serde_json::to_string(&event).unwrap_or_else(|_| "{}".into());
        let mut conn = publisher.lock().await;
        redis::cmd("PUBLISH")
            .arg(&self.channel)
            .arg(payload)
            .query_async::<()>(&mut *conn)
            .await
    }

    /// Delivers events to `on_event` until `cancel` fires, skipping messages this
    /// process published itself.
    ///
    /// Reconnects on a dropped connection, so a Redis restart costs the delay until
    /// it comes back (during which the periodic refresh still runs) rather than a
    /// permanently deaf replica. A malformed payload is logged and dropped -- one
    /// bad publisher cannot stop the stream.
    ///
    /// Returns a handle that resolves when the subscriber loop exits.
    pub fn subscribe<F>(
        &self,
        cancel: CancellationToken,
        on_event: F,
    ) -> tokio::task::JoinHandle<()>
    where
        F: Fn(Event) + Send + Sync + 'static,
    {
        let Some(client) = self.client.clone() else {
            return tokio::spawn(async {});
        };
        let channel = self.channel.clone();
        let node = self.node.clone();

        tokio::spawn(async move {
            while !cancel.is_cancelled() {
                match run_subscription(&client, &channel, &node, &cancel, &on_event).await {
                    Ok(()) => {} // cancelled or the stream ended cleanly
                    Err(e) => {
                        tracing::warn!("configbus: subscription to {channel} dropped: {e}");
                    }
                }
                if cancel.is_cancelled() {
                    break;
                }
                tokio::select! {
                    _ = cancel.cancelled() => break,
                    _ = tokio::time::sleep(RECONNECT_DELAY) => {}
                }
            }
        })
    }

    /// How many subscribers Redis currently sees on this channel. Test helper: a
    /// publish issued before the subscription is registered is dropped by Redis.
    #[doc(hidden)]
    pub async fn subscriber_count(&self) -> Result<i64, redis::RedisError> {
        let Some(publisher) = &self.publisher else {
            return Ok(0);
        };
        let mut conn = publisher.lock().await;
        let counts: Vec<redis::Value> = redis::cmd("PUBSUB")
            .arg("NUMSUB")
            .arg(&self.channel)
            .query_async(&mut *conn)
            .await?;
        // Reply shape is [channel, count].
        match counts.get(1) {
            Some(redis::Value::Int(n)) => Ok(*n),
            _ => Ok(0),
        }
    }

    /// Publishes a raw payload, bypassing serialization. Test helper for the
    /// malformed-message case.
    #[doc(hidden)]
    pub async fn publish_raw(&self, payload: &str) -> Result<(), redis::RedisError> {
        let Some(publisher) = &self.publisher else {
            return Ok(());
        };
        let mut conn = publisher.lock().await;
        redis::cmd("PUBLISH")
            .arg(&self.channel)
            .arg(payload)
            .query_async::<()>(&mut *conn)
            .await
    }
}

/// Runs one subscription until it fails or is cancelled.
async fn run_subscription<F>(
    client: &redis::Client,
    channel: &str,
    node: &str,
    cancel: &CancellationToken,
    on_event: &F,
) -> Result<(), redis::RedisError>
where
    F: Fn(Event) + Send + Sync,
{
    let mut pubsub = client.get_async_pubsub().await?;
    pubsub.subscribe(channel).await?;
    let mut stream = pubsub.on_message();

    loop {
        tokio::select! {
            _ = cancel.cancelled() => return Ok(()),
            msg = stream.next() => {
                let Some(msg) = msg else { return Ok(()) };
                let payload: String = match msg.get_payload() {
                    Ok(p) => p,
                    Err(e) => {
                        tracing::warn!("configbus: unreadable message on {channel}: {e}");
                        continue;
                    }
                };
                match serde_json::from_str::<Event>(&payload) {
                    Ok(ev) => {
                        // Our own announcement: we already refreshed.
                        if !ev.node.is_empty() && ev.node == node {
                            continue;
                        }
                        on_event(ev);
                    }
                    Err(e) => {
                        tracing::warn!("configbus: ignoring malformed message on {channel}: {e}");
                    }
                }
            }
        }
    }
}

fn resolve_channel(channel: &str) -> String {
    if channel.is_empty() {
        DEFAULT_CHANNEL.to_string()
    } else {
        channel.to_string()
    }
}

/// A short random id for this process.
///
/// Random rather than hostname-based so two replicas on one host (or a restarted
/// container reusing a name) never share an id and start ignoring each other's
/// messages.
fn new_node_id() -> String {
    let mut b = [0u8; 6];
    rand::Rng::fill(&mut rand::thread_rng(), &mut b[..]);
    hex::encode(b)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// The bus tests need real pub/sub semantics (a stub would prove nothing), so
    /// they are skipped unless a throwaway Redis is configured.
    fn redis_url() -> Option<String> {
        std::env::var("RAYU_TEST_REDIS_URL").ok()
    }

    macro_rules! require_redis {
        () => {
            match redis_url() {
                Some(u) => u,
                None => {
                    eprintln!("skipping: RAYU_TEST_REDIS_URL not set");
                    return;
                }
            }
        };
    }

    /// Two independent buses on one Redis, on a channel unique to the caller so
    /// parallel tests cannot cross-talk.
    async fn bus_pair(channel: &str) -> (Bus, Bus) {
        let url = redis_url().expect("checked by require_redis!");
        (
            Bus::connect(&url, channel).await.expect("publisher"),
            Bus::connect(&url, channel).await.expect("subscriber"),
        )
    }

    /// Blocks until the subscription is actually registered, so a publish cannot
    /// race ahead of it (pub/sub drops messages with no subscribers).
    async fn wait_for_subscriber(publisher: &Bus) {
        for _ in 0..200 {
            if publisher.subscriber_count().await.unwrap_or(0) > 0 {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("subscriber never registered on the channel");
    }

    #[tokio::test]
    async fn publish_reaches_the_other_replica() {
        let _ = require_redis!();
        let (publisher, subscriber) = bus_pair("test:config:reaches").await;

        let seen: Arc<Mutex<Vec<Event>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        let cancel = CancellationToken::new();
        subscriber.subscribe(cancel.clone(), move |ev| {
            sink.lock().unwrap().push(ev);
        });
        wait_for_subscriber(&publisher).await;

        publisher
            .publish(Event {
                reason: REASON_MODELS.into(),
                user_id: 42,
                ..Default::default()
            })
            .await
            .expect("publish");

        let got = wait_for_event(&seen).await;
        assert_eq!(got.reason, REASON_MODELS);
        assert_eq!(got.user_id, 42);
        assert_eq!(
            got.node,
            publisher.node(),
            "the publisher's id must travel with the event"
        );
        cancel.cancel();
    }

    /// A replica must ignore its OWN announcement: it refreshed before publishing,
    /// so acting on it again would double every admin save's database cost.
    #[tokio::test]
    async fn subscriber_ignores_its_own_messages() {
        let url = require_redis!();
        let bus = Bus::connect(&url, "test:config:self").await.expect("bus");

        let seen: Arc<Mutex<Vec<Event>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        let cancel = CancellationToken::new();
        bus.subscribe(cancel.clone(), move |ev| {
            sink.lock().unwrap().push(ev);
        });
        wait_for_subscriber(&bus).await;

        bus.publish(Event {
            reason: REASON_KEYS.into(),
            ..Default::default()
        })
        .await
        .expect("publish");

        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(
            seen.lock().unwrap().is_empty(),
            "acted on its own message: {:?}",
            seen.lock().unwrap()
        );
        cancel.cancel();
    }

    /// One bad publisher (or a stray tool writing to the channel) must not stop a
    /// replica from hearing the next real change.
    #[tokio::test]
    async fn malformed_payload_is_skipped() {
        let _ = require_redis!();
        let (publisher, subscriber) = bus_pair("test:config:malformed").await;

        let seen: Arc<Mutex<Vec<Event>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        let cancel = CancellationToken::new();
        subscriber.subscribe(cancel.clone(), move |ev| {
            sink.lock().unwrap().push(ev);
        });
        wait_for_subscriber(&publisher).await;

        publisher
            .publish_raw("not json")
            .await
            .expect("publish junk");
        publisher
            .publish(Event {
                reason: REASON_PLANS.into(),
                ..Default::default()
            })
            .await
            .expect("publish");

        let got = wait_for_event(&seen).await;
        assert_eq!(
            got.reason, REASON_PLANS,
            "a malformed message stopped the stream"
        );
        cancel.cancel();
    }

    /// Cancelling must stop the subscriber without panicking, so shutdown is clean.
    #[tokio::test]
    async fn subscribe_stops_when_cancelled() {
        let url = require_redis!();
        let bus = Bus::connect(&url, "test:config:cancel").await.expect("bus");
        let cancel = CancellationToken::new();
        let handle = bus.subscribe(cancel.clone(), |_| {});
        wait_for_subscriber(&bus).await;
        cancel.cancel();
        tokio::time::timeout(Duration::from_secs(5), handle)
            .await
            .expect("subscriber must stop promptly")
            .expect("no panic");
    }

    async fn wait_for_event(seen: &Arc<Mutex<Vec<Event>>>) -> Event {
        for _ in 0..200 {
            if let Some(ev) = seen.lock().unwrap().first().cloned() {
                return ev;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("event never arrived");
    }

    /// The "no Redis configured" case: publishing and subscribing are no-ops rather
    /// than a crash, so the gateway still runs on the timer alone.
    #[tokio::test]
    async fn disabled_bus_is_inert() {
        let bus = Bus::disabled("");
        assert_eq!(bus.channel(), DEFAULT_CHANNEL);
        bus.publish(Event::default()).await.expect("inert publish");
        let cancel = CancellationToken::new();
        let handle = bus.subscribe(cancel.clone(), |_| {
            panic!("an inert bus delivered an event");
        });
        handle.await.expect("inert subscribe returns immediately");
    }

    #[test]
    fn channel_defaults_and_overrides() {
        assert_eq!(Bus::disabled("").channel(), DEFAULT_CHANNEL);
        assert_eq!(Bus::disabled("custom").channel(), "custom");
    }

    #[test]
    fn node_ids_are_distinct() {
        let a = Bus::disabled("").node().to_string();
        let b = Bus::disabled("").node().to_string();
        assert_ne!(a, b, "two replicas must never share a node id");
        assert_eq!(a.len(), 12, "6 random bytes as hex");
    }

    /// The payload must match Go's struct tags so a Rust replica and a Go replica
    /// can share a channel during the canary.
    #[test]
    fn event_payload_omits_empty_fields() {
        let full = Event {
            reason: "models".into(),
            user_id: 42,
            node: "abc123".into(),
        };
        assert_eq!(
            serde_json::to_string(&full).unwrap(),
            r#"{"reason":"models","userId":42,"node":"abc123"}"#
        );
        // Empty reason / zero user id are omitted, exactly like Go's omitempty.
        let bare = Event {
            node: "abc123".into(),
            ..Default::default()
        };
        assert_eq!(
            serde_json::to_string(&bare).unwrap(),
            r#"{"node":"abc123"}"#
        );
        // And a Go-shaped payload decodes.
        let decoded: Event =
            serde_json::from_str(r#"{"reason":"keys","userId":7,"node":"deadbeef"}"#).unwrap();
        assert_eq!(decoded.reason, "keys");
        assert_eq!(decoded.user_id, 7);
        assert_eq!(decoded.node, "deadbeef");
        // Missing fields default rather than failing.
        let sparse: Event = serde_json::from_str("{}").unwrap();
        assert_eq!(sparse, Event::default());
    }
}
