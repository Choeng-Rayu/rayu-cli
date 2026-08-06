// Package circuitbreaker implements a small, dependency-free half-open
// circuit breaker keyed per upstream host (e.g. api.deepseek.com,
// api.deepinfra.com).
//
// Why: proxy.go already retries a single request up to 2 times on a
// transient upstream 502/503/504 (doWithRetry in proxy.go). That smooths
// over sub-second blips, but under a SUSTAINED upstream outage every one of
// the gateway's concurrent in-flight requests independently retries against
// the same dead upstream — a thundering herd that (a) wastes gateway
// goroutines/connections holding the MySQL/Redis resources they already
// reserved while waiting on a doomed upstream call, and (b) keeps hammering
// an upstream that is trying to recover.
//
// This breaker sits in front of that per-request retry: once a host
// accumulates enough consecutive failures, the breaker OPENS and every
// subsequent call fails immediately (ErrOpen) for a cooldown window, instead
// of paying the full request timeout + 2 retries. After the cooldown it goes
// HALF-OPEN and lets a single trial call through; success CLOSES the breaker,
// failure re-OPENS it with the cooldown reset.
package circuitbreaker

import (
	"errors"
	"sync"
	"time"
)

// ErrOpen is returned by Allow (and by Do, wrapping the caller's own
// "circuit open" signal) when the breaker for a host is open and the
// cooldown has not yet elapsed.
var ErrOpen = errors.New("circuit breaker open")

type state int

const (
	closed state = iota
	open
	halfOpen
)

// Config controls the failure threshold and cooldown.
type Config struct {
	// FailureThreshold is how many consecutive failures open the breaker.
	// 0 uses DefaultFailureThreshold.
	FailureThreshold int
	// Cooldown is how long the breaker stays open before allowing a single
	// half-open trial call. 0 uses DefaultCooldown.
	Cooldown time.Duration
}

const (
	DefaultFailureThreshold = 5
	DefaultCooldown         = 15 * time.Second
)

// Registry holds one breaker per host key, created lazily on first use.
type Registry struct {
	cfg Config

	mu    sync.Mutex
	hosts map[string]*breaker
}

// New builds a Registry. cfg's zero values fall back to the Default*
// constants.
func New(cfg Config) *Registry {
	if cfg.FailureThreshold <= 0 {
		cfg.FailureThreshold = DefaultFailureThreshold
	}
	if cfg.Cooldown <= 0 {
		cfg.Cooldown = DefaultCooldown
	}
	return &Registry{cfg: cfg, hosts: map[string]*breaker{}}
}

type breaker struct {
	mu               sync.Mutex
	st               state
	consecutiveFails int
	openedAt         time.Time
	// trialInFlight prevents more than one half-open probe from being
	// admitted at once — additional callers during the trial are told to
	// wait (ErrOpen) rather than piling onto the same untested upstream.
	trialInFlight bool
}

func (r *Registry) get(host string) *breaker {
	r.mu.Lock()
	defer r.mu.Unlock()
	b, ok := r.hosts[host]
	if !ok {
		b = &breaker{}
		r.hosts[host] = b
	}
	return b
}

// Allow reports whether a call to host may proceed right now. When it
// returns true for a half-open trial, the caller MUST report the outcome via
// Success or Failure exactly once — that report is what closes or re-opens
// the breaker. Prefer Do over calling Allow/Success/Failure directly unless
// you need finer control (e.g. streaming responses where success/failure is
// only known after the caller has already started writing to the client).
func (r *Registry) Allow(host string) bool {
	b := r.get(host)
	b.mu.Lock()
	defer b.mu.Unlock()
	switch b.st {
	case closed:
		return true
	case open:
		if time.Since(b.openedAt) < r.cooldown() {
			return false
		}
		// Cooldown elapsed: admit exactly one trial call.
		if b.trialInFlight {
			return false
		}
		b.st = halfOpen
		b.trialInFlight = true
		return true
	case halfOpen:
		// Another trial is already in flight (or this IS that trial being
		// re-checked, which callers shouldn't do — Allow is meant to be
		// called once per attempt).
		return false
	default:
		return true
	}
}

func (r *Registry) cooldown() time.Duration { return r.cfg.Cooldown }

// Success reports that a call admitted by Allow succeeded: closes the
// breaker and resets the failure counter.
func (r *Registry) Success(host string) {
	b := r.get(host)
	b.mu.Lock()
	defer b.mu.Unlock()
	b.st = closed
	b.consecutiveFails = 0
	b.trialInFlight = false
}

// Failure reports that a call admitted by Allow failed. If this pushes the
// consecutive-failure count to the threshold (or the failing call was the
// half-open trial), the breaker opens (or re-opens) with a fresh cooldown.
func (r *Registry) Failure(host string) {
	b := r.get(host)
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.st == halfOpen {
		// Trial failed: re-open immediately, don't wait for the threshold.
		b.trialInFlight = false
		b.st = open
		b.openedAt = time.Now()
		return
	}
	b.consecutiveFails++
	if b.consecutiveFails >= r.cfg.FailureThreshold {
		b.st = open
		b.openedAt = time.Now()
	}
}

// State reports the current state as a string, for logging/metrics/tests.
func (r *Registry) State(host string) string {
	b := r.get(host)
	b.mu.Lock()
	defer b.mu.Unlock()
	switch b.st {
	case open:
		return "open"
	case halfOpen:
		return "half_open"
	default:
		return "closed"
	}
}

// Do runs fn only if Allow(host) permits it, and reports the outcome
// automatically based on fn's returned error (any non-nil error counts as a
// failure). Returns ErrOpen without calling fn if the breaker is open.
func (r *Registry) Do(host string, fn func() error) error {
	if !r.Allow(host) {
		return ErrOpen
	}
	err := fn()
	if err != nil {
		r.Failure(host)
		return err
	}
	r.Success(host)
	return nil
}
