package store

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"pgregory.net/rapid"
)

func mustCreate(t *testing.T, s *InMemoryStore, id, owner string) {
	t.Helper()
	if err := s.CreateBuild(context.Background(), Build{ID: id, OwnerID: owner, Prompt: "p"}); err != nil {
		t.Fatalf("CreateBuild(%s): %v", id, err)
	}
}

// Req 9.2, 9.4 — appending then reading yields ascending, gap-free seqs from 1.
func TestAppendThenReadAscending(t *testing.T) {
	ctx := context.Background()
	s := NewInMemoryStore()
	mustCreate(t, s, "b1", "owner-1")

	const n = 5
	for i := 0; i < n; i++ {
		ev, err := s.AppendEvent(ctx, "b1", "log", json.RawMessage(`{"i":`+itoa(i)+`}`))
		if err != nil {
			t.Fatalf("AppendEvent: %v", err)
		}
		if ev.Seq != int64(i+1) {
			t.Fatalf("append %d returned seq %d, want %d", i, ev.Seq, i+1)
		}
	}

	got, err := s.ReadEvents(ctx, "b1", 0)
	if err != nil {
		t.Fatalf("ReadEvents: %v", err)
	}
	if len(got) != n {
		t.Fatalf("read %d events, want %d", len(got), n)
	}
	for i, ev := range got {
		if ev.Seq != int64(i+1) {
			t.Errorf("event %d has seq %d, want %d", i, ev.Seq, i+1)
		}
	}
}

// Req 9.2 — the first assigned sequence number is 1.
func TestSequenceStartsAtOne(t *testing.T) {
	ctx := context.Background()
	s := NewInMemoryStore()
	mustCreate(t, s, "b1", "owner-1")
	ev, err := s.AppendEvent(ctx, "b1", "status", json.RawMessage(`{}`))
	if err != nil {
		t.Fatalf("AppendEvent: %v", err)
	}
	if ev.Seq != 1 {
		t.Fatalf("first seq = %d, want 1", ev.Seq)
	}
}

// Req 9.4 — Last-Event-ID style replay returns only seq > afterSeq, ascending.
func TestReadEventsAfterSeq(t *testing.T) {
	ctx := context.Background()
	s := NewInMemoryStore()
	mustCreate(t, s, "b1", "owner-1")
	for i := 0; i < 5; i++ {
		if _, err := s.AppendEvent(ctx, "b1", "log", json.RawMessage(`{}`)); err != nil {
			t.Fatalf("AppendEvent: %v", err)
		}
	}
	got, err := s.ReadEvents(ctx, "b1", 3)
	if err != nil {
		t.Fatalf("ReadEvents: %v", err)
	}
	if len(got) != 2 || got[0].Seq != 4 || got[1].Seq != 5 {
		t.Fatalf("ReadEvents(afterSeq=3) = %+v, want seqs [4,5]", seqsOf(got))
	}
}

// An aborted append (unknown build) consumes no sequence number.
func TestAppendUnknownBuildBurnsNoNumber(t *testing.T) {
	ctx := context.Background()
	s := NewInMemoryStore()
	mustCreate(t, s, "b1", "owner-1")

	if _, err := s.AppendEvent(ctx, "b1", "log", json.RawMessage(`{}`)); err != nil {
		t.Fatalf("AppendEvent: %v", err)
	}
	if _, err := s.AppendEvent(ctx, "missing", "log", json.RawMessage(`{}`)); err != ErrNotFound {
		t.Fatalf("AppendEvent(missing) error = %v, want ErrNotFound", err)
	}
	// The next valid append still gets seq 2 — the failed one took nothing.
	ev, err := s.AppendEvent(ctx, "b1", "log", json.RawMessage(`{}`))
	if err != nil {
		t.Fatalf("AppendEvent: %v", err)
	}
	if ev.Seq != 2 {
		t.Fatalf("seq after failed append = %d, want 2", ev.Seq)
	}
}

func TestGetBuildNotFound(t *testing.T) {
	if _, err := NewInMemoryStore().GetBuild(context.Background(), "nope"); err != ErrNotFound {
		t.Fatalf("GetBuild(nope) error = %v, want ErrNotFound", err)
	}
}

func TestCreateBuildDefaults(t *testing.T) {
	ctx := context.Background()
	s := NewInMemoryStore()
	mustCreate(t, s, "b1", "owner-1")
	b, err := s.GetBuild(ctx, "b1")
	if err != nil {
		t.Fatalf("GetBuild: %v", err)
	}
	if b.Status != StatusQueued {
		t.Errorf("default status = %q, want queued", b.Status)
	}
	if b.NextSeq != 1 {
		t.Errorf("default NextSeq = %d, want 1", b.NextSeq)
	}
	if b.CreatedAt.IsZero() || b.UpdatedAt.IsZero() {
		t.Errorf("timestamps not set: %+v", b)
	}
}

// Req 16.1, 17 — owner-scoped active and daily counts.
func TestOwnerScopedQueries(t *testing.T) {
	ctx := context.Background()
	s := NewInMemoryStore()
	now := time.Date(2025, 1, 2, 12, 0, 0, 0, time.UTC)
	s.now = func() time.Time { return now }

	mustCreate(t, s, "a1", "alice")
	mustCreate(t, s, "a2", "alice")
	mustCreate(t, s, "a3", "alice")
	mustCreate(t, s, "b1", "bob")

	// alice: move a3 to a terminal status so it no longer counts as active.
	if err := s.SetStatus(ctx, "a3", StatusLive); err != nil {
		t.Fatalf("SetStatus: %v", err)
	}

	active, err := s.CountActiveByOwner(ctx, "alice")
	if err != nil {
		t.Fatalf("CountActiveByOwner: %v", err)
	}
	if active != 2 {
		t.Errorf("alice active = %d, want 2 (a1,a2; a3 is live)", active)
	}
	if bobActive, _ := s.CountActiveByOwner(ctx, "bob"); bobActive != 1 {
		t.Errorf("bob active = %d, want 1", bobActive)
	}

	// Daily window: all four were created "now"; a window starting 24h ago counts
	// alice's three, a window starting in the future counts none.
	since := now.Add(-24 * time.Hour)
	daily, err := s.CountCreatedSince(ctx, "alice", since)
	if err != nil {
		t.Fatalf("CountCreatedSince: %v", err)
	}
	if daily != 3 {
		t.Errorf("alice daily = %d, want 3", daily)
	}
	if future, _ := s.CountCreatedSince(ctx, "alice", now.Add(time.Hour)); future != 0 {
		t.Errorf("alice daily (future window) = %d, want 0", future)
	}
}

// A small rapid property: for K sequential appends the assigned sequence
// numbers are exactly 1..K. (The full concurrent + fault-injection property P2
// is implemented in a later task.)
func TestSequenceIsExactRangeProperty(t *testing.T) {
	rapid.Check(t, func(rt *rapid.T) {
		k := rapid.IntRange(1, 50).Draw(rt, "k")
		s := NewInMemoryStore()
		ctx := context.Background()
		if err := s.CreateBuild(ctx, Build{ID: "b", OwnerID: "o", Prompt: "p"}); err != nil {
			rt.Fatalf("CreateBuild: %v", err)
		}
		for i := 0; i < k; i++ {
			ev, err := s.AppendEvent(ctx, "b", "log", json.RawMessage(`{}`))
			if err != nil {
				rt.Fatalf("AppendEvent: %v", err)
			}
			if ev.Seq != int64(i+1) {
				rt.Fatalf("append %d seq = %d, want %d", i, ev.Seq, i+1)
			}
		}
		got, err := s.ReadEvents(ctx, "b", 0)
		if err != nil {
			rt.Fatalf("ReadEvents: %v", err)
		}
		if len(got) != k {
			rt.Fatalf("read %d, want %d", len(got), k)
		}
		for i, ev := range got {
			if ev.Seq != int64(i+1) {
				rt.Fatalf("read event %d seq = %d, want %d", i, ev.Seq, i+1)
			}
		}
	})
}

func seqsOf(evs []Event) []int64 {
	out := make([]int64, len(evs))
	for i, e := range evs {
		out[i] = e.Seq
	}
	return out
}

func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	neg := i < 0
	if neg {
		i = -i
	}
	var b [20]byte
	pos := len(b)
	for i > 0 {
		pos--
		b[pos] = byte('0' + i%10)
		i /= 10
	}
	if neg {
		pos--
		b[pos] = '-'
	}
	return string(b[pos:])
}
