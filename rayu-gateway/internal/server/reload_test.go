package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/choeng-rayu/rayu-gateway/internal/config"
	"github.com/choeng-rayu/rayu-gateway/internal/configbus"
	"github.com/choeng-rayu/rayu-gateway/internal/entitlements"
	"github.com/choeng-rayu/rayu-gateway/internal/store"
)

// POST /v1/_reload is what removes the delay between an admin saving and real
// traffic seeing it. It carries no configuration — only "re-read the database" —
// so these tests pin the three things that matter: only admins may call it, it
// actually refreshes, and it tells the other replicas.

func reloadHarness(t *testing.T) (http.Handler, *fakeEnt) {
	t.Helper()
	fe := &fakeEnt{
		ent: entitlements.Entitlement{
			UserID: 900, Status: "active",
			Plan:          store.Plan{Code: "pro", Name: "Pro"},
			AllowedModels: []store.HostedModel{hostedModel("longcat-2", longcatProvider("http://127.0.0.1:1"), "LongCat-2.0", 1)},
		},
		settings: store.AppSettings{BaselineCreditsPer1M: 1},
	}
	h, _ := chatHarness(t, fe)
	return h, fe
}

func postReload(t *testing.T, h http.Handler, role, body string) (int, reloadResponse) {
	t.Helper()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/_reload", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+accessTokenRole(t, 900, role))
	h.ServeHTTP(rec, req)
	var out reloadResponse
	if rec.Code == http.StatusOK {
		if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
			t.Fatalf("decode: %v (body=%s)", err, rec.Body.String())
		}
	}
	return rec.Code, out
}

func TestReloadRefreshesTheSnapshot(t *testing.T) {
	h, fe := reloadHarness(t)

	code, res := postReload(t, h, "admin", `{"reason":"models"}`)
	if code != http.StatusOK {
		t.Fatalf("status=%d, want 200", code)
	}
	if !res.OK || !res.Reloaded {
		t.Fatalf("response=%+v, want ok+reloaded", res)
	}
	if fe.reloadCount() != 1 {
		t.Errorf("reloads=%d, want 1", fe.reloadCount())
	}
}

// An empty body means "re-read everything" — the dashboard should not have to
// describe its own change for the refresh to work.
func TestReloadAcceptsAnEmptyBody(t *testing.T) {
	h, fe := reloadHarness(t)
	if code, _ := postReload(t, h, "admin", ""); code != http.StatusOK {
		t.Fatalf("status=%d, want 200", code)
	}
	if fe.reloadCount() != 1 {
		t.Errorf("reloads=%d, want 1", fe.reloadCount())
	}
}

// Configuration is admin territory: a normal user must not be able to make the
// gateway hammer the database, even though the endpoint reveals nothing.
func TestReloadIsAdminOnly(t *testing.T) {
	h, fe := reloadHarness(t)
	for _, role := range []string{"", "user"} {
		if code, _ := postReload(t, h, role, `{}`); code != http.StatusForbidden {
			t.Errorf("role=%q status=%d, want 403", role, code)
		}
	}
	if fe.reloadCount() != 0 {
		t.Errorf("reloads=%d, want 0 — a rejected caller must not trigger work", fe.reloadCount())
	}
}

// A failed refresh is reported honestly (ok=false + why) rather than as a silent
// success, because the admin's next action depends on it.
func TestReloadReportsAFailedRefresh(t *testing.T) {
	h, fe := reloadHarness(t)
	fe.reloadErr = errors.New("dial tcp 10.0.0.9:3306: connect: connection refused")

	code, res := postReload(t, h, "admin", `{"reason":"keys"}`)
	if code != http.StatusOK {
		t.Fatalf("status=%d, want 200 (the request was valid; the refresh failed)", code)
	}
	if res.OK || res.Reloaded {
		t.Fatalf("response=%+v, want ok=false", res)
	}
	if !strings.Contains(res.Message, "connection refused") {
		t.Errorf("message does not explain the failure: %q", res.Message)
	}
}

// A change that affects ONE account (plan switch, suspension) must also drop that
// user's cached entitlement, or they keep their old plan for up to USER_CACHE_TTL.
func TestReloadInvalidatesTheNamedUser(t *testing.T) {
	fe := &fakeEnt{
		ent: entitlements.Entitlement{
			UserID: 900, Status: "active",
			Plan:          store.Plan{Code: "pro", Name: "Pro"},
			AllowedModels: []store.HostedModel{hostedModel("longcat-2", longcatProvider("http://127.0.0.1:1"), "LongCat-2.0", 1)},
		},
		settings: store.AppSettings{BaselineCreditsPer1M: 1},
	}
	h, _ := chatHarness(t, fe)

	if code, _ := postReload(t, h, "admin", `{"reason":"plans","userId":77}`); code != http.StatusOK {
		t.Fatalf("status=%d", code)
	}
	if len(fe.invalidatedUsers()) != 1 || fe.invalidatedUsers()[0] != 77 {
		t.Fatalf("invalidated=%v, want [77]", fe.invalidatedUsers())
	}
}

// The replica that serves the save must tell the others, or a multi-replica
// deployment fixes only the one the dashboard happened to reach.
func TestReloadBroadcastsToOtherReplicas(t *testing.T) {
	fe := &fakeEnt{
		ent: entitlements.Entitlement{
			UserID: 900, Status: "active",
			Plan:          store.Plan{Code: "pro", Name: "Pro"},
			AllowedModels: []store.HostedModel{hostedModel("longcat-2", longcatProvider("http://127.0.0.1:1"), "LongCat-2.0", 1)},
		},
		settings: store.AppSettings{BaselineCreditsPer1M: 1},
	}
	var published []configbus.Event
	reloader := NewConfigReloader(fe.Reload, func(_ context.Context, ev configbus.Event) error {
		published = append(published, ev)
		return nil
	})
	h := New(&config.Config{JWTSecret: testSecret}, fe, nil, nil, reloader)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/_reload",
		strings.NewReader(`{"reason":"models","userId":5}`))
	req.Header.Set("Authorization", "Bearer "+accessTokenRole(t, 900, "admin"))
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(published) != 1 {
		t.Fatalf("published %d events, want 1", len(published))
	}
	if published[0].Reason != "models" || published[0].UserID != 5 {
		t.Errorf("published %+v, want reason=models userId=5", published[0])
	}
	var res reloadResponse
	_ = json.Unmarshal(rec.Body.Bytes(), &res)
	if !res.Broadcast {
		t.Error("response says the change was not broadcast")
	}
	// Refresh locally FIRST, then announce: the replica answering the admin must
	// never be the last to know.
	if fe.reloadCount() != 1 {
		t.Errorf("reloads=%d, want 1", fe.reloadCount())
	}
}

// A Redis blip must not turn a good save into an error: this replica is fresh, and
// the others still have the periodic refresh.
func TestReloadSurvivesABrokenBus(t *testing.T) {
	fe := &fakeEnt{
		ent: entitlements.Entitlement{
			UserID: 900, Status: "active",
			Plan:          store.Plan{Code: "pro", Name: "Pro"},
			AllowedModels: []store.HostedModel{hostedModel("longcat-2", longcatProvider("http://127.0.0.1:1"), "LongCat-2.0", 1)},
		},
		settings: store.AppSettings{BaselineCreditsPer1M: 1},
	}
	reloader := NewConfigReloader(fe.Reload, func(context.Context, configbus.Event) error {
		return errors.New("redis: connection pool timeout")
	})
	h := New(&config.Config{JWTSecret: testSecret}, fe, nil, nil, reloader)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/_reload", strings.NewReader(`{}`))
	req.Header.Set("Authorization", "Bearer "+accessTokenRole(t, 900, "admin"))
	h.ServeHTTP(rec, req)

	var res reloadResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &res); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !res.OK || !res.Reloaded {
		t.Fatalf("response=%+v — a failed broadcast must not fail the local refresh", res)
	}
	if res.Broadcast {
		t.Error("broadcast reported as done when the publish failed")
	}
	if !strings.Contains(res.Message, "not notified") {
		t.Errorf("message does not mention the broadcast failure: %q", res.Message)
	}
}

// The dashboard fires one refresh per save, so the endpoint is bounded per admin.
func TestReloadIsRateLimited(t *testing.T) {
	h, _ := reloadHarness(t)
	var last int
	for i := 0; i < reloadPerAdmin+1; i++ {
		last, _ = postReload(t, h, "admin", `{}`)
	}
	if last != http.StatusTooManyRequests {
		t.Fatalf("status after %d refreshes=%d, want 429", reloadPerAdmin+1, last)
	}
}

// A bus message must refresh the replica WITHOUT publishing another one, or two
// replicas would keep answering each other forever.
func TestBusSubscriberDoesNotRepublish(t *testing.T) {
	var reloads, publishes atomic.Int64
	reloader := NewConfigReloader(
		func(context.Context) error { reloads.Add(1); return nil },
		func(context.Context, configbus.Event) error { publishes.Add(1); return nil },
	)

	// This is what main.go's subscriber does: the LOCAL refresh, never Broadcast.
	if err := reloader.Reload(context.Background()); err != nil {
		t.Fatalf("reload: %v", err)
	}
	if reloads.Load() != 1 {
		t.Fatalf("reloads=%d, want 1", reloads.Load())
	}
	if publishes.Load() != 0 {
		t.Fatalf("publishes=%d, want 0 — reacting to a message must not emit one", publishes.Load())
	}
}
