package server

import (
	"bytes"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/choeng-rayu/rayu-gateway/internal/entitlements"
	"github.com/choeng-rayu/rayu-gateway/internal/store"
)

func TestAllowedModelCodes(t *testing.T) {
	got := allowedModelCodes([]store.HostedModel{{Code: "glm-5.2"}, {Code: "deepseek-v4-pro"}})
	if got != "glm-5.2,deepseek-v4-pro" {
		t.Fatalf("allowedModelCodes=%q want glm-5.2,deepseek-v4-pro", got)
	}
	if allowedModelCodes(nil) != "" {
		t.Fatal("empty catalog should be empty string")
	}
}

// The "model not allowed" reject must log WHICH CLI feature issued it (source)
// and the plan's actual allow-list — so an operator can immediately see e.g. a
// utility task firing claude-haiku-4-5 while the user is on GLM-5.2.
func TestHostedModelNotAllowedLogsSourceAndAllowlist(t *testing.T) {
	fe := &fakeEnt{
		ent: entitlements.Entitlement{
			UserID: 2, Status: "active",
			Plan: store.Plan{Code: "pro", Name: "Pro"},
			AllowedModels: []store.HostedModel{
				{Code: "glm-5.2", Provider: "rayu-ollama", Enabled: true},
				{Code: "deepseek-v4-pro", Provider: "deepseek", Enabled: true},
			},
		},
		settings: store.AppSettings{BaselineCreditsPer1M: 1000},
	}
	h, _ := chatHarness(t, fe)

	var buf bytes.Buffer
	log.SetOutput(&buf)
	defer log.SetOutput(os.Stderr)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/anthropic/v1/messages",
		strings.NewReader(`{"model":"claude-haiku-4-5-20251001","stream":true}`))
	req.Header.Set("Authorization", "Bearer "+accessToken(t, 2))
	req.Header.Set("X-Rayu-Query-Source", "tool_use_summary")
	req.Header.Set("X-Rayu-Request-Id", "REQ-123")
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("status=%d, want 403; body=%s", rec.Code, rec.Body.String())
	}
	logs := buf.String()
	for _, want := range []string{
		"source=tool_use_summary",
		"reqid=REQ-123",
		`model="claude-haiku-4-5-20251001"`,
		"allowed=[glm-5.2,deepseek-v4-pro]",
	} {
		if !strings.Contains(logs, want) {
			t.Fatalf("reject log missing %q; got:\n%s", want, logs)
		}
	}
}

// The auth middleware must log a reason on 401 so silent 401 storms (e.g. an
// expired token) are diagnosable.
func TestAuthMiddlewareLogs401Reason(t *testing.T) {
	s := testServer()
	h := New(s.cfg, nil, nil, nil)

	var buf bytes.Buffer
	log.SetOutput(&buf)
	defer log.SetOutput(os.Stderr)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/anthropic/v1/messages",
		strings.NewReader(`{"model":"glm-5.2"}`))
	req.Header.Set("X-Rayu-Request-Id", "REQ-401")
	// no Authorization header
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d, want 401", rec.Code)
	}
	logs := buf.String()
	if !strings.Contains(logs, "auth: 401") || !strings.Contains(logs, "reason=missing_bearer_token") {
		t.Fatalf("missing auth 401 reason log; got:\n%s", logs)
	}
	if !strings.Contains(logs, "reqid=REQ-401") {
		t.Fatalf("auth 401 log missing reqid; got:\n%s", logs)
	}
}

// An OLDER CLI that doesn't send X-Rayu-* headers must still get a
// gateway-assigned reqid (so the request is correlatable in the gateway log),
// with source=unknown signalling "old client, please update".
func TestHostedAssignsRequestIdWhenClientOmitsIt(t *testing.T) {
	fe := &fakeEnt{
		ent: entitlements.Entitlement{
			UserID: 50, Status: "active",
			Plan:          store.Plan{Code: "max", Name: "Max"},
			AllowedModels: []store.HostedModel{{Code: "deepseek-v4-pro", Provider: "deepseek", Enabled: true}},
		},
		settings: store.AppSettings{BaselineCreditsPer1M: 1000},
	}
	h, _ := chatHarness(t, fe)

	var buf bytes.Buffer
	log.SetOutput(&buf)
	defer log.SetOutput(os.Stderr)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/anthropic/v1/messages",
		strings.NewReader(`{"model":"claude-haiku-4-5-20251001"}`)) // not allowed -> logs
	req.Header.Set("Authorization", "Bearer "+accessToken(t, 50))
	// NO X-Rayu-* headers at all (simulates the old published CLI).
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("status=%d, want 403", rec.Code)
	}
	logs := buf.String()
	if !strings.Contains(logs, "reqid=gw_") {
		t.Fatalf("expected a gateway-assigned reqid (gw_…) for a header-less client; got:\n%s", logs)
	}
	if !strings.Contains(logs, "source=unknown") {
		t.Fatalf("expected source=unknown for an old client; got:\n%s", logs)
	}
}
