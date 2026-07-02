package obs

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// The logger routes every serialized entry through the redactor hook (Req 21.4),
// so installing a redactor that strips a secret keeps it out of the output.
func TestLoggerRoutesThroughRedactor(t *testing.T) {
	var buf bytes.Buffer
	l := NewLogger(&buf)
	l.SetRedactor(func(s string) string { return strings.ReplaceAll(s, "sk-secret", "[REDACTED]") })

	l.Info("starting build", "buildId", "bld_1", "apiKey", "sk-secret")

	out := buf.String()
	if strings.Contains(out, "sk-secret") {
		t.Fatalf("secret leaked into log output: %s", out)
	}
	if !strings.Contains(out, "[REDACTED]") {
		t.Fatalf("redactor not applied: %s", out)
	}
	if !strings.Contains(out, `"buildId":"bld_1"`) || !strings.Contains(out, `"msg":"starting build"`) {
		t.Fatalf("structured fields missing: %s", out)
	}
}

func TestLoggerIdentityByDefault(t *testing.T) {
	var buf bytes.Buffer
	l := NewLogger(&buf)
	l.Info("hello", "k", "v")
	if !strings.Contains(buf.String(), `"k":"v"`) {
		t.Fatalf("default logger dropped fields: %s", buf.String())
	}
}

// The declared collectors are registered, so /metrics serves them in Prometheus
// text format (Req 1.8, 21.2).
func TestMetricsHandlerExposesCollectors(t *testing.T) {
	m := NewMetrics()
	// Touch one labeled counter so it materializes in the output.
	m.BuildsTotal.WithLabelValues("live").Add(0)

	req := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	rec := httptest.NewRecorder()
	m.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	body := rec.Body.String()
	for _, want := range []string{
		"rayu_orchestrator_builds_total",
		"rayu_orchestrator_building",
		"rayu_orchestrator_live",
		"rayu_orchestrator_build_duration_seconds",
	} {
		if !strings.Contains(body, want) {
			t.Errorf("metrics output missing %q", want)
		}
	}
}
