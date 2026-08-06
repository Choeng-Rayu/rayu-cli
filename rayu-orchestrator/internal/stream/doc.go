// Package stream defines the normalized Progress_Event model (event.go), the
// stream-json parser/mapper that turns the swarm's NDJSON stdout into
// Progress_Events (mapper.go), and — in a later task — the SSE hub
// (persist-before-deliver, replay, heartbeat).
//
// The model and the mapper are pure: they assign neither the gap-free
// Sequence_Number nor the timestamp (the Emitter/Hub does, via the store), so
// they are trivially testable in isolation against golden NDJSON fixtures.
package stream
