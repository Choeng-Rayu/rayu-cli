package providerkeys

import (
	"sync"
	"testing"
	"time"
)

// Rotation is the whole reason multiple keys exist, so these tests pin the
// behaviour that makes it work: a rate-limited key steps aside temporarily, a
// rejected key steps aside until an admin fixes it, and a 30s config refresh
// never resurrects a cooling key early.

const pid int64 = 7

func key(id int64, priority int) Key {
	return Key{
		ID: id, Label: "Key", Secret: "sk-secret", Masked: "sk-sec…(9)",
		Priority: priority, Enabled: true, Status: StatusActive,
	}
}

// fixedClock lets cooldown expiry be tested without sleeping.
func withClock(r *Registry, t *time.Time) {
	r.now = func() time.Time { return *t }
}

func ids(keys []Key) []int64 {
	out := make([]int64, 0, len(keys))
	for _, k := range keys {
		out = append(out, k.ID)
	}
	return out
}

func TestPickReturnsKeysInPriorityOrder(t *testing.T) {
	r := New(nil)
	r.Replace(pid, []Key{key(1, 0), key(2, 1), key(3, 2)})
	if got := ids(r.Pick(pid)); len(got) != 3 || got[0] != 1 || got[2] != 3 {
		t.Fatalf("Pick = %v, want [1 2 3]", got)
	}
}

func TestRateLimitedKeyIsSkippedThenRestoredAfterCooldown(t *testing.T) {
	now := time.Date(2026, 7, 1, 12, 0, 0, 0, time.UTC)
	r := New(nil)
	withClock(r, &now)
	r.Replace(pid, []Key{key(1, 0), key(2, 1)})

	r.MarkRateLimited(pid, 1, 30*time.Second)
	if got := ids(r.Pick(pid)); len(got) != 1 || got[0] != 2 {
		t.Fatalf("during cooldown Pick = %v, want only key 2", got)
	}

	// Still cooling one second before expiry.
	now = now.Add(29 * time.Second)
	if got := ids(r.Pick(pid)); len(got) != 1 {
		t.Fatalf("key 1 came back early: %v", got)
	}

	// Cooldown elapsed → back in rotation, in its original priority position.
	now = now.Add(2 * time.Second)
	if got := ids(r.Pick(pid)); len(got) != 2 || got[0] != 1 {
		t.Fatalf("after cooldown Pick = %v, want [1 2]", got)
	}
}

func TestInvalidKeyIsNeverRetried(t *testing.T) {
	now := time.Now()
	r := New(nil)
	withClock(r, &now)
	r.Replace(pid, []Key{key(1, 0), key(2, 1)})

	r.MarkInvalid(pid, 1, "HTTP 401")
	// Not even an hour later: a credential the provider rejected stays out until
	// an admin replaces it.
	now = now.Add(time.Hour)
	if got := ids(r.Pick(pid)); len(got) != 1 || got[0] != 2 {
		t.Fatalf("Pick = %v, want only key 2 (invalid key must not be retried)", got)
	}
}

func TestAllKeysUnusableYieldsNothing(t *testing.T) {
	now := time.Now()
	r := New(nil)
	withClock(r, &now)
	r.Replace(pid, []Key{key(1, 0), key(2, 1)})
	r.MarkRateLimited(pid, 1, time.Minute)
	r.MarkInvalid(pid, 2, "HTTP 403")
	if got := r.Pick(pid); len(got) != 0 {
		t.Fatalf("Pick = %v, want empty so the caller can fail fast", ids(got))
	}
	if r.Usable(pid) != 0 {
		t.Errorf("Usable = %d, want 0", r.Usable(pid))
	}
}

func TestAdminDisabledKeyIsExcluded(t *testing.T) {
	r := New(nil)
	k := key(1, 0)
	k.Enabled = false
	r.Replace(pid, []Key{k, key(2, 1)})
	if got := ids(r.Pick(pid)); len(got) != 1 || got[0] != 2 {
		t.Fatalf("Pick = %v, want only the enabled key", got)
	}
}

// A config refresh happens every ~30s. If it reset health, a cooling key would be
// retried on every refresh regardless of its cooldown.
func TestConfigRefreshPreservesLiveHealth(t *testing.T) {
	now := time.Now()
	r := New(nil)
	withClock(r, &now)
	r.Replace(pid, []Key{key(1, 0), key(2, 1)})
	r.MarkRateLimited(pid, 1, 5*time.Minute)

	// Same keys arrive again from the database (status there still says active).
	r.Replace(pid, []Key{key(1, 0), key(2, 1)})

	if got := ids(r.Pick(pid)); len(got) != 1 || got[0] != 2 {
		t.Fatalf("after refresh Pick = %v — the cooldown was lost", got)
	}
}

// A restart has no memory, so the PERSISTED cooldown must be honoured on load.
func TestPersistedCooldownIsHonouredOnFirstLoad(t *testing.T) {
	now := time.Date(2026, 7, 1, 12, 0, 0, 0, time.UTC)
	r := New(nil)
	withClock(r, &now)
	cooling := key(1, 0)
	cooling.Status = StatusRateLimited
	cooling.CooldownUntil = now.Add(2 * time.Minute)
	r.Replace(pid, []Key{cooling, key(2, 1)})

	if got := ids(r.Pick(pid)); len(got) != 1 || got[0] != 2 {
		t.Fatalf("Pick = %v — a restart re-hammered a key the provider was still limiting", got)
	}
	now = now.Add(3 * time.Minute)
	if got := ids(r.Pick(pid)); len(got) != 2 {
		t.Fatalf("Pick = %v, want both keys after the persisted cooldown elapsed", got)
	}
}

func TestStateChangesAreReportedForWriteBack(t *testing.T) {
	var mu sync.Mutex
	var seen []StateChange
	r := New(func(c StateChange) {
		mu.Lock()
		defer mu.Unlock()
		seen = append(seen, c)
	})
	now := time.Now()
	withClock(r, &now)
	r.Replace(pid, []Key{key(1, 0), key(2, 1)})

	r.MarkRateLimited(pid, 1, 45*time.Second)
	r.MarkInvalid(pid, 2, "HTTP 401")
	r.MarkUsed(pid, 1)

	mu.Lock()
	defer mu.Unlock()
	if len(seen) != 3 {
		t.Fatalf("emitted %d changes, want 3: %+v", len(seen), seen)
	}
	if seen[0].Status != StatusRateLimited || seen[0].CooldownUntil.IsZero() {
		t.Errorf("rate-limit change=%+v want a cooldown deadline", seen[0])
	}
	if seen[1].Status != StatusInvalid || seen[1].LastError != "HTTP 401" {
		t.Errorf("invalid change=%+v", seen[1])
	}
	// Nothing reported may contain the secret.
	for _, c := range seen {
		if c.LastError == "sk-secret" {
			t.Error("a state change leaked the key")
		}
	}
}

func TestCooldownIsCappedAndDefaulted(t *testing.T) {
	now := time.Date(2026, 7, 1, 12, 0, 0, 0, time.UTC)
	var got []StateChange
	r := New(func(c StateChange) { got = append(got, c) })
	withClock(r, &now)
	r.Replace(pid, []Key{key(1, 0), key(2, 1)})

	// No Retry-After → the default window.
	r.MarkRateLimited(pid, 1, 0)
	if want := now.Add(DefaultCooldown); !got[0].CooldownUntil.Equal(want) {
		t.Errorf("default cooldown = %v, want %v", got[0].CooldownUntil, want)
	}
	// An absurd Retry-After must not remove a key from rotation for that long.
	r.MarkRateLimited(pid, 2, 6*time.Hour)
	if want := now.Add(MaxCooldown); !got[1].CooldownUntil.Equal(want) {
		t.Errorf("capped cooldown = %v, want %v", got[1].CooldownUntil, want)
	}
}

func TestSuccessClearsARateLimit(t *testing.T) {
	now := time.Now()
	r := New(nil)
	withClock(r, &now)
	r.Replace(pid, []Key{key(1, 0)})
	r.MarkRateLimited(pid, 1, time.Hour)
	if len(r.Pick(pid)) != 0 {
		t.Fatal("expected the key to be cooling")
	}
	// A success proves the limit lifted (e.g. the provider reset the window).
	r.MarkUsed(pid, 1)
	if len(r.Pick(pid)) != 1 {
		t.Fatal("a successful use must return the key to rotation")
	}
}

func TestSnapshotExposesHealthWithoutSecrets(t *testing.T) {
	now := time.Now()
	r := New(nil)
	withClock(r, &now)
	disabled := key(3, 2)
	disabled.Enabled = false
	r.Replace(pid, []Key{key(1, 0), key(2, 1), disabled})
	r.MarkRateLimited(pid, 2, time.Minute)

	snaps := r.SnapshotFor(pid)
	if len(snaps) != 3 {
		t.Fatalf("snapshots=%d want 3", len(snaps))
	}
	byID := map[int64]Snapshot{}
	for _, s := range snaps {
		byID[s.ID] = s
	}
	if byID[1].Status != StatusActive {
		t.Errorf("key 1 status=%s want active", byID[1].Status)
	}
	// A healthy key reports NO cooldown at all (null), not a zero timestamp — a
	// dashboard must never show "cooling until 0001-01-01".
	if byID[1].CooldownUntil != nil {
		t.Errorf("key 1 carries a cooldown %v while active", byID[1].CooldownUntil)
	}
	if byID[2].Status != StatusRateLimited || byID[2].CooldownUntil == nil {
		t.Errorf("key 2 snapshot=%+v want rate_limited with a cooldown", byID[2])
	}
	if byID[3].Status != StatusDisabled {
		t.Errorf("key 3 status=%s want disabled", byID[3].Status)
	}
	// The snapshot carries the mask, never the secret.
	for _, s := range snaps {
		if s.Masked == "sk-secret" {
			t.Error("snapshot leaked the key")
		}
	}
}

// A sink must never be invoked while the registry lock is held: it performs I/O
// on the caller's behalf (a queued database write), so a slow or re-entrant sink
// would otherwise block every request that needs a key. This exercises the one
// path that used to do it — a cooldown expiring inside Pick.
func TestSinkIsNeverCalledUnderTheLock(t *testing.T) {
	clock := time.Unix(1000, 0)
	var reentered int
	r := New(nil)
	withClock(r, &clock)
	r.Replace(pid, []Key{key(1, 0)})
	r.MarkRateLimited(pid, 1, 10*time.Second)

	// A sink that re-enters the registry is the deadlock shape.
	r.sink = func(StateChange) {
		r.Usable(pid)
		reentered++
	}

	clock = clock.Add(time.Minute) // cooldown elapsed
	done := make(chan []Key, 1)
	go func() { done <- r.Pick(pid) }()
	select {
	case got := <-done:
		if len(got) != 1 {
			t.Fatalf("Pick returned %d keys, want 1 (cooldown elapsed)", len(got))
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Pick deadlocked: the sink was called while the registry lock was held")
	}
	if reentered == 0 {
		t.Error("the cooldown expiry was never reported to the sink")
	}
}

// A key whose secret could not be decrypted is unusable, but that verdict is
// about the GATEWAY's master key, not the credential — so fixing the master key
// must bring it back on the next refresh, with no restart.
func TestUndecryptableKeyRecoversWhenItBecomesReadable(t *testing.T) {
	r := New(nil)
	broken := key(1, 0)
	broken.Secret = "" // entitlements could not open the envelope
	r.Replace(pid, []Key{broken})
	if got := r.Usable(pid); got != 0 {
		t.Fatalf("usable=%d, want 0 while the key cannot be decrypted", got)
	}
	if snap := r.SnapshotFor(pid); snap[0].Status != StatusInvalid {
		t.Fatalf("status=%s, want invalid", snap[0].Status)
	}

	// Master key fixed → same row, now decryptable.
	r.Replace(pid, []Key{key(1, 0)})
	if got := r.Usable(pid); got != 1 {
		t.Fatalf("usable=%d, want 1 once the key decrypts again (no restart required)", got)
	}
}

// Replacing a key in the dashboard keeps its id but changes the credential, so an
// earlier "invalid" verdict must not follow it — otherwise fixing a revoked key
// appears to do nothing until the gateway restarts.
func TestReplacingTheSecretClearsAnOldVerdict(t *testing.T) {
	r := New(nil)
	r.Replace(pid, []Key{key(1, 0)})
	r.MarkInvalid(pid, 1, "HTTP 401")
	if got := r.Usable(pid); got != 0 {
		t.Fatalf("usable=%d, want 0 after a 401", got)
	}

	// Config refresh with the SAME secret must keep the key out of rotation.
	r.Replace(pid, []Key{key(1, 0)})
	if got := r.Usable(pid); got != 0 {
		t.Fatalf("usable=%d — a refresh must not resurrect a rejected credential", got)
	}

	// Admin pasted a new secret for the same key id.
	replaced := key(1, 0)
	replaced.Secret = "sk-brand-new"
	r.Replace(pid, []Key{replaced})
	if got := r.Usable(pid); got != 1 {
		t.Fatalf("usable=%d, want 1 after the secret was replaced", got)
	}
}

func TestForgetDropsAProvider(t *testing.T) {
	r := New(nil)
	r.Replace(pid, []Key{key(1, 0)})
	r.Forget(pid)
	if len(r.Pick(pid)) != 0 {
		t.Fatal("Forget should remove the provider's keys")
	}
}

// Pick and the Mark* helpers run concurrently on the request path, so the
// registry must be race-free (run with -race).
func TestConcurrentPickAndMark(t *testing.T) {
	r := New(func(StateChange) {})
	r.Replace(pid, []Key{key(1, 0), key(2, 1), key(3, 2)})

	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(3)
		go func() { defer wg.Done(); r.Pick(pid) }()
		go func() { defer wg.Done(); r.MarkRateLimited(pid, 2, time.Second) }()
		go func() { defer wg.Done(); r.Replace(pid, []Key{key(1, 0), key(2, 1), key(3, 2)}) }()
	}
	wg.Wait()
}
