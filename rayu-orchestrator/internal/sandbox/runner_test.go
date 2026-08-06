package sandbox

import (
	"context"
	"errors"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/network"
	ocispec "github.com/opencontainers/image-spec/specs-go/v1"
)

// fakeDocker is a DockerAPI test double. It captures the arguments passed to
// ContainerCreate so the run policy can be asserted without a daemon, and lets a
// test inject create/start failures and observe lifecycle calls.
type fakeDocker struct {
	// captured create args
	gotConfig *container.Config
	gotHost   *container.HostConfig
	gotNet    *network.NetworkingConfig
	gotName   string

	// injectable failures
	createErr error
	startErr  error

	// observed calls
	startedID  string
	removedID  string
	removeOpts container.RemoveOptions
	stoppedID  string
	stopOpts   container.StopOptions
}

func (f *fakeDocker) ContainerCreate(_ context.Context, config *container.Config, hostConfig *container.HostConfig, net *network.NetworkingConfig, _ *ocispec.Platform, name string) (container.CreateResponse, error) {
	f.gotConfig, f.gotHost, f.gotNet, f.gotName = config, hostConfig, net, name
	if f.createErr != nil {
		return container.CreateResponse{}, f.createErr
	}
	return container.CreateResponse{ID: "cid-123"}, nil
}

func (f *fakeDocker) ContainerStart(_ context.Context, id string, _ container.StartOptions) error {
	f.startedID = id
	return f.startErr
}

func (f *fakeDocker) ContainerLogs(_ context.Context, _ string, _ container.LogsOptions) (io.ReadCloser, error) {
	return io.NopCloser(strings.NewReader("")), nil
}

func (f *fakeDocker) ContainerWait(_ context.Context, _ string, _ container.WaitCondition) (<-chan container.WaitResponse, <-chan error) {
	okc := make(chan container.WaitResponse, 1)
	okc <- container.WaitResponse{StatusCode: 0}
	return okc, make(chan error, 1)
}

func (f *fakeDocker) ContainerInspect(_ context.Context, _ string) (types.ContainerJSON, error) {
	return types.ContainerJSON{ContainerJSONBase: &types.ContainerJSONBase{State: &types.ContainerState{}}}, nil
}

func (f *fakeDocker) ContainerStop(_ context.Context, id string, opts container.StopOptions) error {
	f.stoppedID, f.stopOpts = id, opts
	return nil
}

func (f *fakeDocker) ContainerRemove(_ context.Context, id string, opts container.RemoveOptions) error {
	f.removedID, f.removeOpts = id, opts
	return nil
}

func sampleSpec() RunSpec {
	return RunSpec{
		Image:            "sandbox:pinned",
		Name:             "build-bld_abc",
		Labels:           map[string]string{"rayu.build.id": "bld_abc"},
		WorkspaceHostDir: "/srv/builds/bld_abc/workspace",
		Env:              map[string]string{"RAYU_PROMPT": "build a thing", "BUILD_MODEL": "m", "RAYU_OPENAI_API_KEY": "sk-secret"},
		Limits:           ResourceLimits{PidsLimit: 512, NanoCPUs: 2_000_000_000, MemBytes: 4 << 30},
		Network:          "egress",
	}
}

func contains(ss []string, want string) bool {
	for _, s := range ss {
		if s == want {
			return true
		}
	}
	return false
}

// Task 9.2 — the RunSpec → HostConfig/Config mapping encodes every Req-5 control.
func TestStart_RunPolicyMapping(t *testing.T) {
	f := &fakeDocker{}
	r := NewRunner(f, Config{})

	h, err := r.Start(context.Background(), sampleSpec())
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if h.ID != "cid-123" {
		t.Fatalf("handle ID = %q, want cid-123", h.ID)
	}
	if f.startedID != "cid-123" {
		t.Fatalf("ContainerStart id = %q, want cid-123", f.startedID)
	}
	if f.gotName != "build-bld_abc" {
		t.Fatalf("container name = %q, want build-bld_abc", f.gotName)
	}

	hc := f.gotHost
	// Req 5.1 / 22.1 — all capabilities dropped.
	if len(hc.CapDrop) != 1 || hc.CapDrop[0] != "ALL" {
		t.Errorf("CapDrop = %v, want [ALL]", hc.CapDrop)
	}
	// Req 5.3 — read-only root filesystem.
	if !hc.ReadonlyRootfs {
		t.Error("ReadonlyRootfs = false, want true")
	}
	// writable /tmp tmpfs with a size bound (rootfs is read-only).
	tmp, ok := hc.Tmpfs["/tmp"]
	if !ok || !strings.Contains(tmp, "size=") {
		t.Errorf("Tmpfs[/tmp] = %q, want an entry containing size=", tmp)
	}
	// Req 5.5 / 22.1 — no privilege escalation.
	if !contains(hc.SecurityOpt, "no-new-privileges:true") {
		t.Errorf("SecurityOpt = %v, want to contain no-new-privileges:true", hc.SecurityOpt)
	}
	// default Config (no SeccompProfile) relies on the daemon default profile and
	// must never disable seccomp.
	for _, o := range hc.SecurityOpt {
		if o == "seccomp=unconfined" {
			t.Error("SecurityOpt must never contain seccomp=unconfined")
		}
		if strings.HasPrefix(o, "seccomp=") {
			t.Errorf("unexpected explicit seccomp opt with no profile configured: %q", o)
		}
	}
	// Req 5.7 — egress-restricted network.
	if string(hc.NetworkMode) != "egress" {
		t.Errorf("NetworkMode = %q, want egress", hc.NetworkMode)
	}
	// Req 5.2 — workspace bind mount, read-write.
	wantBind := "/srv/builds/bld_abc/workspace:/workspace:rw"
	if len(hc.Binds) != 1 || hc.Binds[0] != wantBind {
		t.Errorf("Binds = %v, want [%s]", hc.Binds, wantBind)
	}
	// Req 5.6 / 22.2 — resource limits.
	if hc.Resources.PidsLimit == nil || *hc.Resources.PidsLimit != 512 {
		t.Errorf("PidsLimit = %v, want 512", hc.Resources.PidsLimit)
	}
	if hc.Resources.NanoCPUs != 2_000_000_000 {
		t.Errorf("NanoCPUs = %d, want 2e9", hc.Resources.NanoCPUs)
	}
	if hc.Resources.Memory != 4<<30 {
		t.Errorf("Memory = %d, want %d", hc.Resources.Memory, int64(4<<30))
	}
	// Wait()/Inspect() must be able to read exit state, so AutoRemove must be off.
	if hc.AutoRemove {
		t.Error("AutoRemove = true, want false")
	}

	cfg := f.gotConfig
	if cfg.Image != "sandbox:pinned" {
		t.Errorf("Image = %q", cfg.Image)
	}
	// Req 5.4 / 6.8 — non-root user.
	if cfg.User != "10001" {
		t.Errorf("User = %q, want 10001", cfg.User)
	}
	// stdout/stderr must stay separable for stdcopy demux (Req 8.7).
	if cfg.Tty {
		t.Error("Tty = true, want false")
	}
	if cfg.WorkingDir != "/workspace" {
		t.Errorf("WorkingDir = %q, want /workspace", cfg.WorkingDir)
	}
	if cfg.Labels["rayu.build.id"] != "bld_abc" {
		t.Errorf("Labels = %v, want rayu.build.id=bld_abc", cfg.Labels)
	}

	// Network endpoint also recorded for unambiguous attachment.
	if f.gotNet == nil || f.gotNet.EndpointsConfig["egress"] == nil {
		t.Errorf("NetworkingConfig = %+v, want an 'egress' endpoint", f.gotNet)
	}
}

// IS_SANDBOX=1 is forced and HOME defaults to the writable tmpfs; BYOK/prompt env
// is passed through (Req 6.5, 22.7).
func TestStart_EnvForcesSandboxFlag(t *testing.T) {
	f := &fakeDocker{}
	r := NewRunner(f, Config{})
	if _, err := r.Start(context.Background(), sampleSpec()); err != nil {
		t.Fatalf("Start: %v", err)
	}
	env := f.gotConfig.Env
	if !contains(env, "IS_SANDBOX=1") {
		t.Errorf("env = %v, want to contain IS_SANDBOX=1", env)
	}
	if !contains(env, "HOME=/tmp") {
		t.Errorf("env = %v, want default HOME=/tmp", env)
	}
	if !contains(env, "RAYU_OPENAI_API_KEY=sk-secret") || !contains(env, "BUILD_MODEL=m") {
		t.Errorf("env = %v, want provided BYOK/model passed through", env)
	}
}

func TestEnvSlice_SandboxFlagNotOverridable(t *testing.T) {
	// A caller must not be able to disable the sandbox precondition.
	got := envSlice(map[string]string{"IS_SANDBOX": "0"})
	if !contains(got, "IS_SANDBOX=1") || contains(got, "IS_SANDBOX=0") {
		t.Errorf("envSlice = %v, want IS_SANDBOX forced to 1", got)
	}
}

func TestEnvSlice_HomeOverridable(t *testing.T) {
	got := envSlice(map[string]string{"HOME": "/workspace/.home"})
	if !contains(got, "HOME=/workspace/.home") {
		t.Errorf("envSlice = %v, want caller HOME to win", got)
	}
}

// A configured seccomp profile is emitted as an explicit SecurityOpt.
func TestSecurityOpt_ExplicitSeccompProfile(t *testing.T) {
	f := &fakeDocker{}
	r := NewRunner(f, Config{SeccompProfile: "/etc/seccomp/sandbox.json"})
	if _, err := r.Start(context.Background(), sampleSpec()); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if !contains(f.gotHost.SecurityOpt, "seccomp=/etc/seccomp/sandbox.json") {
		t.Errorf("SecurityOpt = %v, want explicit seccomp profile", f.gotHost.SecurityOpt)
	}
}

// A failed ContainerStart must force-remove the created container (no leak).
func TestStart_RemovesContainerOnStartFailure(t *testing.T) {
	f := &fakeDocker{startErr: errors.New("boom")}
	r := NewRunner(f, Config{})
	if _, err := r.Start(context.Background(), sampleSpec()); err == nil {
		t.Fatal("expected Start error")
	}
	if f.removedID != "cid-123" {
		t.Errorf("removed id = %q, want cid-123 (cleanup on start failure)", f.removedID)
	}
	if !f.removeOpts.Force {
		t.Error("cleanup remove must be forced")
	}
}

func TestStart_PropagatesCreateError(t *testing.T) {
	f := &fakeDocker{createErr: errors.New("nope")}
	r := NewRunner(f, Config{})
	if _, err := r.Start(context.Background(), sampleSpec()); err == nil {
		t.Fatal("expected create error")
	}
	if f.startedID != "" {
		t.Error("ContainerStart must not be called when create fails")
	}
}

// Wait reports OOM kills so the engine can map failed(resource_exhausted).
func TestWait_ReportsOOMKill(t *testing.T) {
	f := &oomDocker{}
	r := NewRunner(f, Config{})
	res, err := r.Wait(context.Background(), Handle{ID: "cid-123"})
	if err != nil {
		t.Fatalf("Wait: %v", err)
	}
	if !res.OOMKilled {
		t.Error("OOMKilled = false, want true")
	}
	if res.ExitCode != 137 {
		t.Errorf("ExitCode = %d, want 137", res.ExitCode)
	}
}

// oomDocker embeds fakeDocker and overrides the exit signals to mimic an OOM kill.
type oomDocker struct{ fakeDocker }

func (f *oomDocker) ContainerWait(_ context.Context, _ string, _ container.WaitCondition) (<-chan container.WaitResponse, <-chan error) {
	okc := make(chan container.WaitResponse, 1)
	okc <- container.WaitResponse{StatusCode: 137}
	return okc, make(chan error, 1)
}

func (f *oomDocker) ContainerInspect(_ context.Context, _ string) (types.ContainerJSON, error) {
	return types.ContainerJSON{ContainerJSONBase: &types.ContainerJSONBase{
		State: &types.ContainerState{OOMKilled: true, ExitCode: 137},
	}}, nil
}

func TestStopAndCleanup_CallThrough(t *testing.T) {
	f := &fakeDocker{}
	r := NewRunner(f, Config{StopTimeout: 7 * time.Second})

	if err := r.Stop(context.Background(), Handle{ID: "cid-123"}); err != nil {
		t.Fatalf("Stop: %v", err)
	}
	if f.stoppedID != "cid-123" {
		t.Errorf("stopped id = %q, want cid-123", f.stoppedID)
	}
	if f.stopOpts.Timeout == nil || *f.stopOpts.Timeout != 7 {
		t.Errorf("stop timeout = %v, want 7s", f.stopOpts.Timeout)
	}

	if err := r.Cleanup(context.Background(), Handle{ID: "cid-123"}); err != nil {
		t.Fatalf("Cleanup: %v", err)
	}
	if f.removedID != "cid-123" || !f.removeOpts.Force {
		t.Errorf("cleanup remove = (%q, force=%v), want (cid-123, true)", f.removedID, f.removeOpts.Force)
	}
}

func TestNewRunner_Defaults(t *testing.T) {
	r := NewRunner(&fakeDocker{}, Config{})
	if r.tmpfsSize != defaultTmpfsSize {
		t.Errorf("tmpfsSize = %q, want %q", r.tmpfsSize, defaultTmpfsSize)
	}
	if r.stopTimeout != defaultStopTimeout {
		t.Errorf("stopTimeout = %v, want %v", r.stopTimeout, defaultStopTimeout)
	}
}
