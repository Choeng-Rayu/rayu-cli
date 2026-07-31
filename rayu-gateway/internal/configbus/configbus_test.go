package configbus

import (
	"context"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
)

// The bus is what makes an admin save visible on a replica that did not serve the
// save. These tests run against a real (in-process) Redis so the pub/sub semantics
// are the library's, not a stub's.

func busPair(t *testing.T) (a, b *Bus) {
	t.Helper()
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("miniredis: %v", err)
	}
	t.Cleanup(mr.Close)
	newClient := func() redis.UniversalClient {
		c := redis.NewClient(&redis.Options{Addr: mr.Addr()})
		t.Cleanup(func() { _ = c.Close() })
		return c
	}
	return New(newClient(), "test:config"), New(newClient(), "test:config")
}

func TestPublishReachesTheOtherReplica(t *testing.T) {
	publisher, subscriber := busPair(t)

	got := make(chan Event, 4)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	subscriber.Subscribe(ctx, func(ev Event) { got <- ev })
	waitForSubscriber(t, publisher, subscriber)

	if err := publisher.Publish(ctx, Event{Reason: ReasonModels, UserID: 42}); err != nil {
		t.Fatalf("publish: %v", err)
	}

	select {
	case ev := <-got:
		if ev.Reason != ReasonModels || ev.UserID != 42 {
			t.Fatalf("received %+v, want reason=models userId=42", ev)
		}
		if ev.Node != publisher.Node() {
			t.Errorf("node=%q, want the publisher's id %q", ev.Node, publisher.Node())
		}
	case <-time.After(2 * time.Second):
		t.Fatal("event never arrived")
	}
}

// A replica must ignore its OWN announcement: it refreshed before publishing, so
// acting on it again would double every admin save's database cost.
func TestSubscriberIgnoresItsOwnMessages(t *testing.T) {
	self, _ := busPair(t)

	got := make(chan Event, 4)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	self.Subscribe(ctx, func(ev Event) { got <- ev })
	waitForSubscriber(t, self, self)

	if err := self.Publish(ctx, Event{Reason: ReasonKeys}); err != nil {
		t.Fatalf("publish: %v", err)
	}
	select {
	case ev := <-got:
		t.Fatalf("acted on its own message: %+v", ev)
	case <-time.After(300 * time.Millisecond):
	}
}

// One bad publisher (or a stray tool writing to the channel) must not stop a
// replica from hearing the next real change.
func TestMalformedPayloadIsSkipped(t *testing.T) {
	publisher, subscriber := busPair(t)

	got := make(chan Event, 4)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	subscriber.Subscribe(ctx, func(ev Event) { got <- ev })
	waitForSubscriber(t, publisher, subscriber)

	if err := publisher.rdb.Publish(ctx, publisher.channel, "not json").Err(); err != nil {
		t.Fatalf("publish garbage: %v", err)
	}
	if err := publisher.Publish(ctx, Event{Reason: ReasonPlans}); err != nil {
		t.Fatalf("publish: %v", err)
	}

	select {
	case ev := <-got:
		if ev.Reason != ReasonPlans {
			t.Fatalf("received %+v, want the well-formed event", ev)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("a malformed message stopped the stream")
	}
}

// Cancelling the context must stop the subscriber without panicking, so shutdown
// is clean.
func TestSubscribeStopsWithTheContext(t *testing.T) {
	_, subscriber := busPair(t)
	ctx, cancel := context.WithCancel(context.Background())
	subscriber.Subscribe(ctx, func(Event) {})
	cancel()
	time.Sleep(100 * time.Millisecond)
}

// A nil bus is the "no Redis configured" case: publishing and subscribing are
// no-ops rather than a crash, so the gateway still runs on the timer alone.
func TestNilBusIsInert(t *testing.T) {
	var b *Bus
	if err := b.Publish(context.Background(), Event{}); err != nil {
		t.Fatalf("nil bus publish: %v", err)
	}
	b.Subscribe(context.Background(), func(Event) { t.Fatal("nil bus delivered an event") })

	empty := New(nil, "")
	if err := empty.Publish(context.Background(), Event{}); err != nil {
		t.Fatalf("client-less bus publish: %v", err)
	}
	if empty.Channel() != DefaultChannel {
		t.Errorf("channel=%q, want the default", empty.Channel())
	}
}

// waitForSubscriber blocks until the subscription is actually registered, so a
// publish cannot race ahead of it (pub/sub drops messages with no subscribers).
func waitForSubscriber(t *testing.T, publisher, subscriber *Bus) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		n, err := publisher.rdb.PubSubNumSub(context.Background(), subscriber.channel).Result()
		if err == nil && n[subscriber.channel] > 0 {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("subscriber never registered on the channel")
}
