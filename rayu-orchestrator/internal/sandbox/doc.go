// Package sandbox implements the hardened SandboxRunner that creates, starts,
// streams, waits on, stops, and cleans up the per-build Sandbox container via the
// Docker Engine API.
//
// The Sandbox is the runtime trust boundary for executing untrusted, AI-generated
// work: the run policy (runner.go) encodes every Requirement-5 control — dropped
// capabilities, read-only rootfs, a non-root user, no-new-privileges + seccomp,
// CPU/memory/pid limits, and an egress-restricted network — and forces
// IS_SANDBOX=1 so the rayu-cli swarm's --dangerously-skip-permissions precondition
// holds (Req 6.8, 22.7). Those same controls are what make auto-approve safe, so
// they are a precondition of running the swarm, not mere defense-in-depth.
package sandbox
