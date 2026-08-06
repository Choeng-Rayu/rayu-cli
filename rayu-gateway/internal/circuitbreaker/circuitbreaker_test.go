package circuitbreaker

import (
	"errors"
	"testing"
	"time"
)

func TestAllow_ClosedByDefault(t *testing.T) {
	r := New(Config{})
	if !r.Allow("api.example.com") {
		t.Fatal("a fresh breaker should be closed (Allow=true)")
	}
	if got := r.State("api.example.com"); got != "closed" {
		t.Fatalf("State=%q, want closed", got)
	}
}

func TestOpensAfterThreshold(t *testing.T) {
	r := New(Config{FailureThreshold: 3, Cooldown: time.Hour})
	host := "api.example.com"
	for i := 0; i < 2; i++ {
		r.Failure(host)
		if got := r.State(host); got != "closed" {
			t.Fatalf("after %d failures, State=%q, want closed (threshold=3)", i+1, got)
		}
	}
	r.Failure(host) // 3rd consecutive failure trips it
	if got := r.State(host); got != "open" {
		t.Fatalf("after 3 failures, State=%q, want open", got)
	}
	if r.Allow(host) {
		t.Fatal("Allow should be false while open and within cooldown")
	}
}

func TestSuccessResetsFailureCount(t *testing.T) {
	r := New(Config{FailureThreshold: 3, Cooldown: time.Hour})
	host := "api.example.com"
	r.Failure(host)
	r.Failure(host)
	r.Success(host) // resets the consecutive counter
	r.Failure(host)
	r.Failure(host)
	if got := r.State(host); got != "closed" {
		t.Fatalf("State=%q, want closed (counter should have reset after Success)", got)
	}
}

func TestHalfOpenAfterCooldown(t *testing.T) {
	r := New(Config{FailureThreshold: 1, Cooldown: 10 * time.Millisecond})
	host := "api.example.com"
	r.Failure(host) // opens immediately (threshold=1)
	if got := r.State(host); got != "open" {
		t.Fatalf("State=%q, want open", got)
	}
	if r.Allow(host) {
		t.Fatal("Allow should be false immediately after opening")
	}

	time.Sleep(20 * time.Millisecond) // cooldown elapses

	if !r.Allow(host) {
		t.Fatal("Allow should admit exactly one half-open trial after cooldown")
	}
	if got := r.State(host); got != "half_open" {
		t.Fatalf("State=%q, want half_open after the cooldown trial is admitted", got)
	}
	// A second concurrent caller must NOT also get a trial slot.
	if r.Allow(host) {
		t.Fatal("Allow should refuse a second concurrent half-open trial")
	}
}

func TestHalfOpenSuccessCloses(t *testing.T) {
	r := New(Config{FailureThreshold: 1, Cooldown: 10 * time.Millisecond})
	host := "api.example.com"
	r.Failure(host)
	time.Sleep(20 * time.Millisecond)
	if !r.Allow(host) {
		t.Fatal("expected half-open trial to be admitted")
	}
	r.Success(host)
	if got := r.State(host); got != "closed" {
		t.Fatalf("State=%q, want closed after a successful half-open trial", got)
	}
	if !r.Allow(host) {
		t.Fatal("Allow should be true once closed again")
	}
}

func TestHalfOpenFailureReopens(t *testing.T) {
	r := New(Config{FailureThreshold: 1, Cooldown: 10 * time.Millisecond})
	host := "api.example.com"
	r.Failure(host)
	time.Sleep(20 * time.Millisecond)
	if !r.Allow(host) {
		t.Fatal("expected half-open trial to be admitted")
	}
	r.Failure(host) // trial failed
	if got := r.State(host); got != "open" {
		t.Fatalf("State=%q, want open again after a failed half-open trial", got)
	}
	if r.Allow(host) {
		t.Fatal("Allow should be false immediately after a re-open (fresh cooldown)")
	}
}

func TestHostsAreIndependent(t *testing.T) {
	r := New(Config{FailureThreshold: 1, Cooldown: time.Hour})
	r.Failure("a.example.com")
	if got := r.State("a.example.com"); got != "open" {
		t.Fatalf("a.example.com State=%q, want open", got)
	}
	if got := r.State("b.example.com"); got != "closed" {
		t.Fatalf("b.example.com State=%q, want closed (independent of a.example.com)", got)
	}
	if !r.Allow("b.example.com") {
		t.Fatal("b.example.com should still allow calls")
	}
}

func TestDo_SuccessPath(t *testing.T) {
	r := New(Config{})
	calls := 0
	err := r.Do("api.example.com", func() error {
		calls++
		return nil
	})
	if err != nil {
		t.Fatalf("Do returned %v, want nil", err)
	}
	if calls != 1 {
		t.Fatalf("fn called %d times, want 1", calls)
	}
	if got := r.State("api.example.com"); got != "closed" {
		t.Fatalf("State=%q, want closed", got)
	}
}

func TestDo_FailurePath(t *testing.T) {
	r := New(Config{FailureThreshold: 1})
	wantErr := errors.New("boom")
	err := r.Do("api.example.com", func() error { return wantErr })
	if !errors.Is(err, wantErr) {
		t.Fatalf("Do returned %v, want %v", err, wantErr)
	}
	if got := r.State("api.example.com"); got != "open" {
		t.Fatalf("State=%q, want open after Do's fn failed (threshold=1)", got)
	}
}

func TestDo_ReturnsErrOpenWithoutCallingFn(t *testing.T) {
	r := New(Config{FailureThreshold: 1, Cooldown: time.Hour})
	r.Failure("api.example.com") // opens the breaker

	calls := 0
	err := r.Do("api.example.com", func() error {
		calls++
		return nil
	})
	if !errors.Is(err, ErrOpen) {
		t.Fatalf("Do returned %v, want ErrOpen", err)
	}
	if calls != 0 {
		t.Fatalf("fn should not be called while breaker is open, called %d times", calls)
	}
}

func TestDefaultsApplyWhenZero(t *testing.T) {
	r := New(Config{}) // FailureThreshold/Cooldown both zero -> defaults
	if r.cfg.FailureThreshold != DefaultFailureThreshold {
		t.Fatalf("FailureThreshold=%d, want default %d", r.cfg.FailureThreshold, DefaultFailureThreshold)
	}
	if r.cfg.Cooldown != DefaultCooldown {
		t.Fatalf("Cooldown=%v, want default %v", r.cfg.Cooldown, DefaultCooldown)
	}
}
