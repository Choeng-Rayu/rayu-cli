// Package api hosts the orchestrator's HTTP surface: the chi router, the
// machine-readable JSON request/response helpers, the build lifecycle handlers,
// and the resumable SSE progress endpoint.
//
// The router establishes the middleware spine — recover → request-log, with
// ordered seams reserved for the service-auth → rate-limit → per-user-authz
// chain added in task 18 — and keeps GET /healthz and GET /metrics off that
// chain (Req 1.7, 1.8, 15.3). Lifecycle side effects flow through the Controller
// seam so the real build engine can be dropped in without touching handlers.
package api

import (
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	"github.com/choeng-rayu/rayu-orchestrator/internal/obs"
	"github.com/choeng-rayu/rayu-orchestrator/internal/store"
)

// SSEStreamer serves the Server-Sent Events progress stream for a build. The
// stream.Hub is the production implementation (its ServeSSE handles the
// existence check, Last-Event-ID replay, live tail, heartbeat, and terminal
// close); a fake is used in tests.
type SSEStreamer interface {
	ServeSSE(w http.ResponseWriter, r *http.Request, buildID string)
}

// Deps are the collaborators the router needs. Store, Builds, and Stream back
// the /v1 surface; Metrics and Logger are observability and may be nil.
type Deps struct {
	// Store is read directly by the status handler and the cancel/delete
	// acknowledgments.
	Store store.Store
	// Builds is the build-lifecycle seam (create/cancel/delete + admission and
	// teardown). The real engine (task 6.5) implements Controller; until then
	// NewMachineController provides a state-machine-backed default.
	Builds Controller
	// Stream serves GET /v1/builds/{id}/stream. When nil that endpoint returns
	// 503; the rest of the surface is unaffected.
	Stream SSEStreamer
	// Metrics exposes the Prometheus registry at GET /metrics (off the auth
	// chain). May be nil.
	Metrics *obs.Metrics
	// Logger backs the request-log middleware. May be nil (logging is skipped).
	Logger *obs.Logger
}

// NewRouter builds the orchestrator HTTP handler.
//
// Middleware spine (applied to every route, including health/metrics):
// RealIP → Recoverer (recover) → request-log. The /v1 surface adds the
// service-auth → rate-limit → per-user-authz chain in task 18 at the marked
// seams; GET /healthz and GET /metrics are registered outside /v1 so they stay
// exempt from that chain (Req 1.7, 1.8, 15.3).
func NewRouter(d Deps) http.Handler {
	r := chi.NewRouter()

	// --- recover → request-log spine (Req 1.9 plumbing) ---
	r.Use(middleware.RealIP)
	r.Use(middleware.Recoverer)
	r.Use(requestLogger(d.Logger))

	// Liveness + metrics: deliberately registered at the root, OUTSIDE the /v1
	// group, so they never pick up the auth/rate-limit/authz chain (Req 15.3).
	r.Get("/healthz", handleHealthz)
	if d.Metrics != nil {
		r.Get("/metrics", d.Metrics.Handler().ServeHTTP)
	}

	// Versioned build API. Registered only when its collaborators are present so
	// a partially-wired deployment still serves health/metrics rather than
	// nil-panicking.
	if d.Store != nil && d.Builds != nil {
		h := &buildHandlers{
			store:    d.Store,
			builds:   d.Builds,
			streamer: d.Stream,
			log:      d.Logger,
		}
		r.Route("/v1", func(r chi.Router) {
			// --- reserved middleware seams (task 18), applied in this order ---
			//   r.Use(serviceAuth(...))  // Req 15.1–15.3: 401 + no side effects
			//   r.Use(rateLimit(...))    // Req 15.4: 429 rate_limited
			// Per-user authorization (Req 16) is applied inside the per-build
			// subrouter below, where the build id is in scope.

			r.Post("/builds", h.create)
			r.Route("/builds/{id}", func(r chi.Router) {
				//   r.Use(perUserAuthz(d.Store)) // Req 16: non-owner ⇒ 404
				r.Get("/", h.get)
				r.Get("/stream", h.stream)
				r.Post("/cancel", h.cancel)
				r.Delete("/", h.delete)
			})
		})
	}

	return r
}

// handleHealthz is a 200 stub (Req 1.7). Real Store + container-runtime
// reachability (503 when either is down) is implemented in task 21.2.
func handleHealthz(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// requestLogger emits one structured line per request (method, path, status,
// size, latency) through the obs logger, which routes it through the central
// redactor. A nil logger disables request logging without changing behavior.
func requestLogger(l *obs.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		if l == nil {
			return next
		}
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ww := middleware.NewWrapResponseWriter(w, r.ProtoMajor)
			start := time.Now()
			defer func() {
				l.Info("http request",
					"method", r.Method,
					"path", r.URL.Path,
					"status", ww.Status(),
					"bytes", ww.BytesWritten(),
					"duration_ms", time.Since(start).Milliseconds(),
					"remote", r.RemoteAddr,
				)
			}()
			next.ServeHTTP(ww, r)
		})
	}
}
