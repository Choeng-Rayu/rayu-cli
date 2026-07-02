// Package build implements the build lifecycle state machine, the worker pool,
// admission control, quotas, and the background reaper/cleanup/GC loops. The
// lifecycle state machine (Machine, in machine.go) is the first concrete piece;
// the worker pool, quotas, and engine are added in later tasks.
package build
