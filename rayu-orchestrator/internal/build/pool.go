package build

import (
	"context"
	"sync"

	"github.com/choeng-rayu/rayu-orchestrator/internal/store"
	"github.com/choeng-rayu/rayu-orchestrator/internal/stream"
)

// RunHook is invoked by the Pool immediately after it admits a build — i.e.
// after the build has been transitioned queued→provisioning — so the engine can
// start that build's owning goroutine. It must not block; the build engine
// simply spawns the goroutine and returns.
type RunHook func(buildID, ownerID string)

// queuedBuild is one build awaiting admission. The Pool's queue is kept in FIFO
// order, so index 0 is always the longest-queued build (Req 3.3).
type queuedBuild struct {
	buildID string
	ownerID string
}

// Pool is the in-process worker pool and admission controller (Req 3). It bounds
// the number of concurrently-building sandboxes to MAX_CONCURRENT_BUILDS and,
// whenever a slot is free, admits the longest-queued build whose owner is under
// PER_USER_CONCURRENCY, transitioning it queued→provisioning through the Machine
// and handing it to the RunHook. While a build waits it emits a queue-position
// status event (Req 3.5).
//
// Admission is driven synchronously: Enqueue and Release each run the admission
// loop (drain) before returning, so once they return the pool has admitted
// everything it currently can. A short mutex guards the queue and slot
// accounting; the Machine transition and RunHook run outside the lock. Slot
// accounting is keyed by Build_Id (the holding set), so Release is exactly-once
// per admitted build and the building count cannot drift.
type Pool struct {
	baseCtx context.Context
	machine *Machine
	emitter stream.Emitter
	run     RunHook

	maxConcurrent      int
	perUserConcurrency int

	mu       sync.Mutex
	building int               // global occupied slots (Req 3.1 cap)
	perOwner map[string]int    // ownerID -> occupied slots (Req 3.4 per-user cap)
	holding  map[string]string // buildID -> ownerID for builds occupying a slot
	queue    []queuedBuild     // FIFO; index 0 is the longest-queued (Req 3.3)
	lastPos  map[string]int    // buildID -> last emitted queue position (de-dups events)
	stopped  bool              // when true, admission is halted (engine shutdown)
}

// NewPool returns a Pool that admits at most maxConcurrent builds concurrently
// and at most perUserConcurrency per owner, transitioning admitted builds
// through machine, emitting queue-position events through emitter, and starting
// each admitted build via run. baseCtx scopes the transition and event writes
// (it outlives any single request); a nil baseCtx defaults to context.Background.
func NewPool(baseCtx context.Context, machine *Machine, emitter stream.Emitter, maxConcurrent, perUserConcurrency int, run RunHook) *Pool {
	if baseCtx == nil {
		baseCtx = context.Background()
	}
	return &Pool{
		baseCtx:            baseCtx,
		machine:            machine,
		emitter:            emitter,
		run:                run,
		maxConcurrent:      maxConcurrent,
		perUserConcurrency: perUserConcurrency,
		perOwner:           map[string]int{},
		holding:            map[string]string{},
		lastPos:            map[string]int{},
	}
}

// selectAdmissible returns the index of the build to admit next, or -1 if none
// can be admitted right now. It is the pure heart of the admission policy
// (Req 3.1–3.4) and the reference the admission property test (P6) checks:
//
//   - if the global building count is at the cap, nothing is admissible
//     (the building count never exceeds MAX_CONCURRENT_BUILDS, Req 3.1); else
//   - the longest-queued build (smallest index) whose owner is strictly under
//     PER_USER_CONCURRENCY occupied slots is chosen (Req 3.2, 3.3, 3.4);
//   - a build whose owner is at the per-user cap is skipped and stays queued
//     (Req 3.4).
func selectAdmissible(queue []queuedBuild, perOwner map[string]int, building, maxConcurrent, perUserConcurrency int) int {
	if building >= maxConcurrent {
		return -1
	}
	for i := range queue {
		if perOwner[queue[i].ownerID] < perUserConcurrency {
			return i
		}
	}
	return -1
}

// Enqueue adds a freshly-created queued build to the admission queue and runs
// the admission loop. The build must already exist in the Store in the queued
// status (the engine creates it before enqueuing).
func (p *Pool) Enqueue(buildID, ownerID string) {
	p.mu.Lock()
	p.queue = append(p.queue, queuedBuild{buildID: buildID, ownerID: ownerID})
	p.mu.Unlock()
	p.drain()
}

// Release frees the slot held by an admitted build (called when its owning
// goroutine exits, for any reason) and runs the admission loop so a waiting
// build can take the freed slot. It is idempotent: a build that holds no slot
// is a no-op.
func (p *Pool) Release(buildID string) {
	p.mu.Lock()
	owner, ok := p.holding[buildID]
	if ok {
		delete(p.holding, buildID)
		p.building--
		p.perOwner[owner]--
		if p.perOwner[owner] <= 0 {
			delete(p.perOwner, owner)
		}
	}
	p.mu.Unlock()
	if ok {
		p.drain()
	}
}

// Remove takes a still-queued build out of the admission queue, returning true
// if it was queued (so the caller knows it was never admitted). A build that is
// not in the queue — already admitted, already removed, or never enqueued —
// yields false. Used to cancel/delete a build before the pool starts it.
func (p *Pool) Remove(buildID string) bool {
	p.mu.Lock()
	found := false
	for i := range p.queue {
		if p.queue[i].buildID == buildID {
			p.queue = append(p.queue[:i], p.queue[i+1:]...)
			delete(p.lastPos, buildID)
			found = true
			break
		}
	}
	p.mu.Unlock()
	if found {
		p.emitPositions()
	}
	return found
}

// Stop halts further admission. In-flight builds keep their slots until their
// goroutines exit and Release them; new admissions are suppressed. Called by the
// engine on shutdown so draining does not race the cancellation of every build.
func (p *Pool) Stop() {
	p.mu.Lock()
	p.stopped = true
	p.mu.Unlock()
}

// drain admits as many builds as the global and per-user caps allow. For each
// admission it reserves the slot under the lock (so concurrent drains can never
// over-admit), then transitions the build queued→provisioning and starts it
// outside the lock. A transition that is rejected (the build was canceled or
// removed in the meantime) reclaims the slot and the build is dropped.
func (p *Pool) drain() {
	for {
		p.mu.Lock()
		if p.stopped {
			p.mu.Unlock()
			return
		}
		idx := selectAdmissible(p.queue, p.perOwner, p.building, p.maxConcurrent, p.perUserConcurrency)
		if idx < 0 {
			p.mu.Unlock()
			break
		}
		w := p.queue[idx]
		p.queue = append(p.queue[:idx], p.queue[idx+1:]...)
		delete(p.lastPos, w.buildID)
		p.building++
		p.perOwner[w.ownerID]++
		p.holding[w.buildID] = w.ownerID
		p.mu.Unlock()

		// Admit: queued→provisioning through the Machine (Req 3.2), outside the
		// lock so the Machine's persist+emit never blocks other admissions.
		if err := p.machine.Transition(p.baseCtx, w.buildID, store.StatusProvisioning, ""); err != nil {
			// The build could not be admitted (already terminal/removed or gone):
			// reclaim its slot and move on without starting it.
			p.releaseHeld(w.buildID)
			continue
		}
		if p.run != nil {
			p.run(w.buildID, w.ownerID)
		}
	}
	// Positions of the builds still queued may have shifted as builds were
	// admitted; refresh their queue-position events (Req 3.5).
	p.emitPositions()
}

// releaseHeld reclaims a reserved slot when admission could not be completed.
func (p *Pool) releaseHeld(buildID string) {
	p.mu.Lock()
	if owner, ok := p.holding[buildID]; ok {
		delete(p.holding, buildID)
		p.building--
		p.perOwner[owner]--
		if p.perOwner[owner] <= 0 {
			delete(p.perOwner, owner)
		}
	}
	p.mu.Unlock()
}

// emitPositions emits a queue-position status event for every still-queued build
// whose position changed since its last emitted value (Req 3.5). Positions are
// 1-based (the longest-queued build is position 1). The diff against lastPos
// avoids re-emitting an unchanged position, so a waiting build sees an event
// only when it is first queued and whenever it advances toward the front.
func (p *Pool) emitPositions() {
	type posUpdate struct {
		buildID string
		pos     int
	}
	p.mu.Lock()
	var updates []posUpdate
	for i := range p.queue {
		pos := i + 1
		if p.lastPos[p.queue[i].buildID] != pos {
			p.lastPos[p.queue[i].buildID] = pos
			updates = append(updates, posUpdate{buildID: p.queue[i].buildID, pos: pos})
		}
	}
	p.mu.Unlock()

	for _, u := range updates {
		_, _ = p.emitter.Emit(p.baseCtx, u.buildID, stream.KindStatus, map[string]any{
			"status":        string(store.StatusQueued),
			"queuePosition": u.pos,
		})
	}
}

// Building returns the number of slots currently occupied (builds in the
// provisioning/building phase). Exposed for the engine's gauge and for tests.
func (p *Pool) Building() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.building
}

// OwnerBuilding returns the number of slots ownerID currently occupies.
func (p *Pool) OwnerBuilding(ownerID string) int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.perOwner[ownerID]
}

// QueueLen returns the number of builds currently awaiting admission.
func (p *Pool) QueueLen() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.queue)
}
