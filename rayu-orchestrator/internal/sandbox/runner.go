package sandbox

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"sort"
	"sync"
	"time"

	"github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/network"
	"github.com/docker/docker/api/types/strslice"
	"github.com/docker/docker/pkg/stdcopy"
	ocispec "github.com/opencontainers/image-spec/specs-go/v1"
)

// sandboxUID is the non-root user the swarm runs as (Req 4.3, 5.4). It mirrors
// the `useradd -u 10001` in the Sandbox_Image and is asserted on every container
// so the policy holds even if a future image drifts.
const sandboxUID = "10001"

// workspaceMount is the in-container path the per-build workspace bind-mounts to;
// it matches the Entry_Script's WORKSPACE default and the swarm's `/workspace`.
const workspaceMount = "/workspace"

// Defaults applied by NewRunner when a Config field is zero.
const (
	defaultTmpfsSize   = "512m" // see note in Config.TmpfsSize
	defaultStopTimeout = 10 * time.Second
)

// DockerAPI is the minimal slice of the Docker Engine client the runner needs.
// Narrowing the dependency to these methods keeps the run policy unit-testable
// with a fake (no daemon) while *client.Client satisfies it in production.
type DockerAPI interface {
	ContainerCreate(ctx context.Context, config *container.Config, hostConfig *container.HostConfig, networkingConfig *network.NetworkingConfig, platform *ocispec.Platform, containerName string) (container.CreateResponse, error)
	ContainerStart(ctx context.Context, containerID string, options container.StartOptions) error
	ContainerLogs(ctx context.Context, containerID string, options container.LogsOptions) (io.ReadCloser, error)
	ContainerWait(ctx context.Context, containerID string, condition container.WaitCondition) (<-chan container.WaitResponse, <-chan error)
	ContainerInspect(ctx context.Context, containerID string) (types.ContainerJSON, error)
	ContainerStop(ctx context.Context, containerID string, options container.StopOptions) error
	ContainerRemove(ctx context.Context, containerID string, options container.RemoveOptions) error
}

// ResourceLimits bounds a Sandbox so a runaway or malicious build cannot starve
// the host (Req 5.6, 22.2). NanoCPUs is CPU-count * 1e9 and MemBytes is a byte
// count — both already pre-converted by internal/config so the runner does no
// re-parsing.
type ResourceLimits struct {
	PidsLimit int64
	NanoCPUs  int64
	MemBytes  int64
}

// RunSpec is the per-build input to Start. Image/limits/network come from
// configuration; Env carries the BYOK provider vars + prompt/model the
// Entry_Script consumes (IS_SANDBOX=1 is forced by the runner, not the caller).
// Name and Labels are set by the engine to a deterministic `build-<id>` identity
// so reaping and orphan GC (later tasks) can reconcile containers to builds.
type RunSpec struct {
	Image            string
	Name             string
	Labels           map[string]string
	WorkspaceHostDir string
	Env              map[string]string
	Limits           ResourceLimits
	Network          string
}

// Handle identifies a started Sandbox for the rest of its lifecycle.
type Handle struct {
	ID               string
	Name             string
	WorkspaceHostDir string
}

// ExitResult is the outcome of a finished Sandbox. OOMKilled lets the engine map
// a memory-limit kill to failed(resource_exhausted) (Req 5.8); the runner only
// reports the mechanism and never classifies the build status itself.
type ExitResult struct {
	ExitCode  int
	OOMKilled bool
}

// StdLine is one line of demultiplexed container output. Stream is "stdout" or
// "stderr"; the mapper turns stderr lines into `error` events (Req 8.7).
type StdLine struct {
	Stream string
	Line   string
}

// SandboxRunner is the lifecycle contract the build engine depends on (Req 5, 6,
// 20). Start creates+starts the hardened container; Stream demuxes its output;
// Wait blocks for exit (with OOM detection); Stop/Cleanup tear it down.
type SandboxRunner interface {
	Start(ctx context.Context, spec RunSpec) (Handle, error)
	Stream(ctx context.Context, h Handle) (<-chan StdLine, error)
	Wait(ctx context.Context, h Handle) (ExitResult, error)
	Stop(ctx context.Context, h Handle) error
	Cleanup(ctx context.Context, h Handle) error
}

// Config tunes the run policy. All fields are optional; NewRunner fills defaults.
type Config struct {
	// TmpfsSize is the size= option for the writable /tmp tmpfs. The Sandbox
	// rootfs is read-only (Req 5.3), so /tmp is the only writable in-image path;
	// the runner points HOME there so rayu-cli/npm have a writable home + cache.
	// Defaults to 512m (more than the design's illustrative 64m) because the
	// swarm's self-verification can run package installs whose caches land here.
	TmpfsSize string
	// SeccompProfile, when non-empty, is passed as `seccomp=<profile>` in
	// SecurityOpt. When empty the daemon's built-in default seccomp profile
	// applies (the desired hardening) — the runner never sets `seccomp=unconfined`.
	SeccompProfile string
	// StopTimeout bounds graceful Stop before the daemon forces a kill.
	StopTimeout time.Duration
}

// Runner is the Docker-backed SandboxRunner.
type Runner struct {
	cli            DockerAPI
	tmpfsSize      string
	seccompProfile string
	stopTimeout    time.Duration
}

// NewRunner builds a Runner over the given Docker client, applying defaults for
// any unset Config field.
func NewRunner(cli DockerAPI, cfg Config) *Runner {
	if cfg.TmpfsSize == "" {
		cfg.TmpfsSize = defaultTmpfsSize
	}
	if cfg.StopTimeout <= 0 {
		cfg.StopTimeout = defaultStopTimeout
	}
	return &Runner{
		cli:            cli,
		tmpfsSize:      cfg.TmpfsSize,
		seccompProfile: cfg.SeccompProfile,
		stopTimeout:    cfg.StopTimeout,
	}
}

var _ SandboxRunner = (*Runner)(nil)

// Start creates and starts the hardened Sandbox. On a start failure it force-
// removes the created container so a failed Start leaks nothing.
func (r *Runner) Start(ctx context.Context, spec RunSpec) (Handle, error) {
	created, err := r.cli.ContainerCreate(ctx, r.containerConfig(spec), r.hostConfig(spec), networkingConfig(spec), nil, spec.Name)
	if err != nil {
		return Handle{}, fmt.Errorf("sandbox: create container: %w", err)
	}
	if err := r.cli.ContainerStart(ctx, created.ID, container.StartOptions{}); err != nil {
		// Best-effort cleanup; report the start error regardless.
		_ = r.cli.ContainerRemove(ctx, created.ID, container.RemoveOptions{Force: true})
		return Handle{}, fmt.Errorf("sandbox: start container: %w", err)
	}
	return Handle{ID: created.ID, Name: spec.Name, WorkspaceHostDir: spec.WorkspaceHostDir}, nil
}

// containerConfig builds the container.Config. User=10001 and Tty=false are
// load-bearing: non-root is a hardening + skip-permissions precondition (Req
// 5.4, 6.8), and a non-TTY container keeps stdout/stderr separable so Stream can
// demux them (Req 8.7).
func (r *Runner) containerConfig(spec RunSpec) *container.Config {
	return &container.Config{
		Image:      spec.Image,
		User:       sandboxUID,
		Env:        envSlice(spec.Env),
		Labels:     spec.Labels,
		WorkingDir: workspaceMount,
		Tty:        false,
	}
}

// hostConfig encodes the Requirement-5 run policy. Every field here is a
// hardening control asserted by the unit tests and `docker inspect` integration
// checks.
func (r *Runner) hostConfig(spec RunSpec) *container.HostConfig {
	pids := spec.Limits.PidsLimit
	return &container.HostConfig{
		CapDrop:        strslice.StrSlice{"ALL"},                                         // Req 5.1, 22.1
		ReadonlyRootfs: true,                                                             // Req 5.3
		Tmpfs:          map[string]string{"/tmp": "rw,nosuid,nodev,size=" + r.tmpfsSize}, // writable scratch (rootfs is RO)
		SecurityOpt:    r.securityOpt(),                                                  // Req 5.5, 22.1
		NetworkMode:    container.NetworkMode(spec.Network),                              // Req 5.7 (egress-restricted)
		Binds:          []string{spec.WorkspaceHostDir + ":" + workspaceMount + ":rw"},   // Req 5.2
		Resources: container.Resources{ // Req 5.6, 22.2
			NanoCPUs:  spec.Limits.NanoCPUs,
			Memory:    spec.Limits.MemBytes,
			PidsLimit: &pids,
		},
		// Explicitly NOT AutoRemove: Wait()+Inspect() must read the exit state
		// (incl. OOMKilled) after the process exits; Cleanup removes it later.
		AutoRemove: false,
	}
}

// securityOpt always disables privilege escalation; it adds an explicit seccomp
// profile only when one is configured. With no entry, the daemon applies its
// built-in default seccomp profile (the hardening we want) — the runner never
// emits `seccomp=unconfined`.
func (r *Runner) securityOpt() []string {
	opts := []string{"no-new-privileges:true"}
	if r.seccompProfile != "" {
		opts = append(opts, "seccomp="+r.seccompProfile)
	}
	return opts
}

// networkingConfig attaches the container to exactly the egress-restricted
// network named in the spec (NetworkMode in hostConfig does the actual join; an
// explicit endpoint entry keeps inspect output unambiguous).
func networkingConfig(spec RunSpec) *network.NetworkingConfig {
	if spec.Network == "" {
		return nil
	}
	return &network.NetworkingConfig{
		EndpointsConfig: map[string]*network.EndpointSettings{
			spec.Network: {},
		},
	}
}

// envSlice converts the spec env map into a sorted "K=V" slice and forces the
// runner-owned variables. HOME is defaulted to the writable tmpfs (the rootfs is
// read-only) but may be overridden by the caller; IS_SANDBOX=1 is forced last and
// is NOT overridable — it is a security precondition of skip-permissions (Req
// 6.5, 22.7), so a caller must never be able to unset it.
func envSlice(env map[string]string) []string {
	merged := map[string]string{"HOME": "/tmp"}
	for k, v := range env {
		merged[k] = v
	}
	merged["IS_SANDBOX"] = "1"

	keys := make([]string, 0, len(merged))
	for k := range merged {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	out := make([]string, 0, len(merged))
	for _, k := range keys {
		out = append(out, k+"="+merged[k])
	}
	return out
}

// Stream returns a channel of demultiplexed stdout/stderr lines for a running
// Sandbox. It follows the container logs and uses stdcopy to split the two
// streams, scanning each line-by-line (Req 6.6, 8.7). The channel closes when the
// container's output ends or ctx is canceled. Large NDJSON lines (assistant text)
// are supported via an enlarged scanner buffer.
func (r *Runner) Stream(ctx context.Context, h Handle) (<-chan StdLine, error) {
	rc, err := r.cli.ContainerLogs(ctx, h.ID, container.LogsOptions{
		ShowStdout: true,
		ShowStderr: true,
		Follow:     true,
	})
	if err != nil {
		return nil, fmt.Errorf("sandbox: container logs: %w", err)
	}

	ch := make(chan StdLine, 64)
	outR, outW := io.Pipe()
	errR, errW := io.Pipe()

	// Demux the multiplexed log stream into the two pipes.
	go func() {
		_, copyErr := stdcopy.StdCopy(outW, errW, rc)
		_ = outW.CloseWithError(copyErr)
		_ = errW.CloseWithError(copyErr)
		_ = rc.Close()
	}()

	var wg sync.WaitGroup
	wg.Add(2)
	scan := func(rd io.Reader, stream string) {
		defer wg.Done()
		sc := bufio.NewScanner(rd)
		sc.Buffer(make([]byte, 0, 64*1024), 8*1024*1024) // up to 8 MiB per line
		for sc.Scan() {
			select {
			case ch <- StdLine{Stream: stream, Line: sc.Text()}:
			case <-ctx.Done():
				return
			}
		}
	}
	go scan(outR, "stdout")
	go scan(errR, "stderr")
	go func() {
		wg.Wait()
		close(ch)
	}()

	return ch, nil
}

// Wait blocks until the Sandbox exits, then inspects it for the OOM flag and the
// authoritative exit code (Req 5.8). It honors ctx cancellation.
func (r *Runner) Wait(ctx context.Context, h Handle) (ExitResult, error) {
	okCh, errCh := r.cli.ContainerWait(ctx, h.ID, container.WaitConditionNotRunning)
	select {
	case <-ctx.Done():
		return ExitResult{}, ctx.Err()
	case err := <-errCh:
		if err != nil {
			return ExitResult{}, fmt.Errorf("sandbox: wait: %w", err)
		}
		return ExitResult{}, nil
	case resp := <-okCh:
		res := ExitResult{ExitCode: int(resp.StatusCode)}
		// Inspect for OOM + the final exit code; the wait status code can be 0
		// while the daemon recorded an OOM kill, so the inspect value wins.
		if ins, err := r.cli.ContainerInspect(ctx, h.ID); err == nil && ins.State != nil {
			res.OOMKilled = ins.State.OOMKilled
			if ins.State.ExitCode != 0 {
				res.ExitCode = ins.State.ExitCode
			}
		}
		return res, nil
	}
}

// Stop gracefully stops the Sandbox (used when a build leaves `building` for any
// reason — Req 20.1). It is safe to call on an already-stopped container.
func (r *Runner) Stop(ctx context.Context, h Handle) error {
	secs := int(r.stopTimeout.Seconds())
	if err := r.cli.ContainerStop(ctx, h.ID, container.StopOptions{Timeout: &secs}); err != nil {
		return fmt.Errorf("sandbox: stop: %w", err)
	}
	return nil
}

// Cleanup force-removes the Sandbox container and its anonymous volumes (Req
// 20.1). Removal of the bind-mounted workspace directory on the host is the
// engine's responsibility (the workspace artifact may be needed by the deploy
// pipeline before teardown), so it is intentionally not done here.
func (r *Runner) Cleanup(ctx context.Context, h Handle) error {
	if err := r.cli.ContainerRemove(ctx, h.ID, container.RemoveOptions{Force: true, RemoveVolumes: true}); err != nil {
		return fmt.Errorf("sandbox: remove: %w", err)
	}
	return nil
}
