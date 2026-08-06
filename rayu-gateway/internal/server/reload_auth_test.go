package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/choeng-rayu/rayu-gateway/internal/config"
)

// The new admin endpoint must be behind the same JWT middleware as everything else
// under /v1 — an unauthenticated caller must never be able to make the gateway
// hammer the database.
func TestReloadRequiresAuthentication(t *testing.T) {
	h := New(&config.Config{JWTSecret: testSecret}, nil, nil, nil, nil)
	for _, hdr := range []string{"", "Bearer garbage"} {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/v1/_reload", strings.NewReader(`{}`))
		if hdr != "" {
			req.Header.Set("Authorization", hdr)
		}
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("Authorization=%q -> %d, want 401", hdr, rec.Code)
		}
	}
}
