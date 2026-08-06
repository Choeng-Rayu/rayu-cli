package server

import (
	"context"
	"errors"
)

// isClientGone reports whether an upstream call failed because the CLIENT
// disconnected rather than because the upstream misbehaved.
//
// The request context is canceled when the client hangs up (esc in the CLI,
// /clear, process exit), and every in-flight upstream call inherits it — so the
// transport error reads `Post "https://…": context canceled` even though the
// upstream was healthy. Observed in production as:
//
//	anthropic: upstream error ... wrote=false: Post "https://ollama.com/v1/messages": context canceled
//	POST /anthropic/v1/messages -> 502 (3.281s, 161B)
//
// Distinguishing the two matters twice over: the log line stops blaming a
// healthy provider (and stops polluting provider-health triage), and we skip
// writing a 502 to a connection nobody is reading.
//
// Both signals are required: ctx.Err() alone can be set by a deadline WE
// imposed, and matching the error alone can catch a cancellation raised by an
// inner timeout rather than the client.
func isClientGone(ctx context.Context, err error) bool {
	if !errors.Is(ctx.Err(), context.Canceled) {
		return false
	}
	return errors.Is(err, context.Canceled) ||
		errors.Is(err, context.DeadlineExceeded)
}
