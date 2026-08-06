package api

import (
	"context"
	"io"
	"net/http"
	"testing"

	"github.com/choeng-rayu/rayu-orchestrator/internal/build"
	"github.com/choeng-rayu/rayu-orchestrator/internal/obs"
	"github.com/choeng-rayu/rayu-orchestrator/internal/store"
)

// Compile-time proof that the production build engine satisfies the API's
// Controller seam structurally — the basis for main.go passing a *build.Engine
// as Deps.Builds without the build package importing api (no import cycle).
var _ Controller = (*build.Engine)(nil)

// fakeController returns a preset error from Create so the handler's quota-error
// mapping can be tested in isolation from the engine.
type fakeController struct {
	createErr error
}

func (f *fakeController) Create(_ context.Context, req build.CreateRequest) (store.Build, error) {
	if f.createErr != nil {
		return store.Build{}, f.createErr
	}
	return store.Build{ID: "bld-stub00000000", OwnerID: req.OwnerID, Status: store.StatusQueued, Prompt: req.Prompt}, nil
}

func (f *fakeController) Cancel(_ context.Context, _ string) error { return nil }
func (f *fakeController) Delete(_ context.Context, _ string) error { return nil }

func routerWithController(c Controller) http.Handler {
	return NewRouter(Deps{
		Store:  store.NewInMemoryStore(),
		Builds: c,
		Logger: obs.NewLogger(io.Discard),
	})
}

// Req 17.2 — a per-user concurrency quota breach maps to 429 with the
// quota_exceeded code.
func TestCreateBuild_429ConcurrencyQuota(t *testing.T) {
	r := routerWithController(&fakeController{createErr: build.ErrConcurrencyQuotaExceeded})
	rec := do(t, r, http.MethodPost, "/v1/builds", map[string]any{"prompt": "p", "ownerId": "o"})

	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429; body=%s", rec.Code, rec.Body.String())
	}
	if code := decodeBody[errorResponse](t, rec).Error.Code; code != codeQuotaExceeded {
		t.Fatalf("error code = %q, want %q", code, codeQuotaExceeded)
	}
}

// Req 17.4 — a per-user daily quota breach maps to 429 with the DISTINCT
// daily_quota_exceeded code.
func TestCreateBuild_429DailyQuota(t *testing.T) {
	r := routerWithController(&fakeController{createErr: build.ErrDailyQuotaExceeded})
	rec := do(t, r, http.MethodPost, "/v1/builds", map[string]any{"prompt": "p", "ownerId": "o"})

	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429; body=%s", rec.Code, rec.Body.String())
	}
	if code := decodeBody[errorResponse](t, rec).Error.Code; code != codeDailyQuotaExceeded {
		t.Fatalf("error code = %q, want %q", code, codeDailyQuotaExceeded)
	}
}
