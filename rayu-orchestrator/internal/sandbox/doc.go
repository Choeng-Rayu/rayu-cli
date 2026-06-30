// Package sandbox implements the hardened SandboxRunner that creates, starts,
// streams, waits on, stops, and cleans up the per-build sandbox container via
// the Docker Engine API. The full run policy is implemented in a later task;
// this placeholder establishes the package in the module layout and pins the
// Docker SDK dependency the runner is built on.
package sandbox

import "github.com/docker/docker/client"

// runner is a scaffold for the hardened SandboxRunner. The Docker client field
// pins the SDK dependency that the full implementation uses.
type runner struct {
	docker client.APIClient
}
