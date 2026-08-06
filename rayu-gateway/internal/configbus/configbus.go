// Package configbus carries "the admin changed the configuration" between
// gateway replicas.
//
// # WHY IT EXISTS
//
// The gateway serves provider routes, models and keys from an in-memory snapshot
// refreshed on a timer (CONFIG_REFRESH_SECONDS). That is what keeps a request from
// touching MySQL, but it also means an admin's save is invisible for up to one
// refresh interval — long enough that "I saved it and it still uses the old
// configuration" is the reported experience.
//
// A single replica can fix that by refreshing when its own admin request arrives.
// Several replicas cannot: the dashboard's save reaches exactly one of them, and
// the rest keep serving the old snapshot until their timers fire. This bus is the
// fan-out: whichever replica hears about the change tells the others.
//
// It is deliberately a NOTIFICATION, never the data itself. A message says only
// "something changed"; every replica then re-reads the database, which is the
// single source of truth. So a lost, duplicated or out-of-order message can never
// corrupt configuration — it can only delay it to the next timer tick, exactly the
// behaviour that exists today.
package configbus

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"log"

	"github.com/redis/go-redis/v9"
)

// DefaultChannel is the Redis pub/sub channel used when none is configured.
const DefaultChannel = "rayu:config-changed"

// Reasons name what an admin changed. They exist for the log line an operator
// reads when they ask "did my save reach the gateway?", not for control flow.
const (
	ReasonProviders = "providers"
	ReasonKeys      = "keys"
	ReasonModels    = "models"
	ReasonPlans     = "plans"
	ReasonManual    = "manual"
)

// Event is one invalidation notice.
type Event struct {
	// Reason is what changed (see the Reason* constants). Informational.
	Reason string `json:"reason,omitempty"`
	// UserID, when non-zero, additionally drops that user's cached entitlement —
	// used when a change affects one account (plan switch, suspension) rather than
	// the shared catalog.
	UserID int64 `json:"userId,omitempty"`
	// Node identifies the publisher so it can ignore its own message: the replica
	// that published has already refreshed locally.
	Node string `json:"node,omitempty"`
}

// Bus publishes and receives invalidation notices over Redis pub/sub.
type Bus struct {
	rdb     redis.UniversalClient
	channel string
	node    string
}

// New builds a bus on an existing Redis client. An empty channel uses
// DefaultChannel.
func New(rdb redis.UniversalClient, channel string) *Bus {
	if channel == "" {
		channel = DefaultChannel
	}
	return &Bus{rdb: rdb, channel: channel, node: newNodeID()}
}

// Node is this process's publisher id (appears in logs).
func (b *Bus) Node() string { return b.node }

// Channel is the pub/sub channel in use (appears in logs).
func (b *Bus) Channel() string { return b.channel }

// Publish announces a change to every replica. The caller must have already
// refreshed itself: this is fan-out, not a local trigger.
//
// A publish failure is the caller's to log and ignore — the periodic refresh is
// still the safety net, so a Redis blip delays a change instead of losing it.
func (b *Bus) Publish(ctx context.Context, ev Event) error {
	if b == nil || b.rdb == nil {
		return nil
	}
	ev.Node = b.node
	payload, err := json.Marshal(ev)
	if err != nil {
		return err
	}
	return b.rdb.Publish(ctx, b.channel, payload).Err()
}

// Subscribe delivers events to onEvent until ctx is cancelled, skipping messages
// this process published itself.
//
// Reconnection is go-redis's: PubSub.Channel() re-subscribes after a dropped
// connection, so a Redis restart costs the delay until it comes back (during which
// the periodic refresh still runs) rather than a permanently deaf replica. A
// malformed payload is logged and dropped — one bad publisher cannot stop the
// stream.
func (b *Bus) Subscribe(ctx context.Context, onEvent func(Event)) {
	if b == nil || b.rdb == nil {
		return
	}
	sub := b.rdb.Subscribe(ctx, b.channel)
	ch := sub.Channel()
	go func() {
		defer func() { _ = sub.Close() }()
		for {
			select {
			case <-ctx.Done():
				return
			case msg, ok := <-ch:
				if !ok {
					return
				}
				var ev Event
				if err := json.Unmarshal([]byte(msg.Payload), &ev); err != nil {
					log.Printf("configbus: ignoring malformed message on %s: %v", b.channel, err)
					continue
				}
				if ev.Node != "" && ev.Node == b.node {
					continue // our own announcement; we already refreshed
				}
				onEvent(ev)
			}
		}
	}()
}

// newNodeID is a short random id for this process. Random rather than hostname
// based so two replicas on one host (or a restarted container reusing a name) never
// share an id and start ignoring each other's messages.
//
// On the (essentially impossible) failure of the system RNG it returns "", which
// DISABLES self-filtering rather than guessing: acting on one's own message costs a
// redundant refresh, whereas two replicas sharing a fallback id would silently ignore
// each other's — the exact failure this id exists to prevent.
func newNodeID() string {
	var b [6]byte
	if _, err := rand.Read(b[:]); err != nil {
		log.Printf("configbus: could not generate a node id (%v); self-filtering disabled", err)
		return ""
	}
	return hex.EncodeToString(b[:])
}
