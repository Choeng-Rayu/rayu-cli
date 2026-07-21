package auth

import (
	"context"
	"log"
	"net/http"
	"strings"

	"github.com/choeng-rayu/rayu-gateway/internal/httpx"
)

type ctxKey int

const claimsKey ctxKey = iota

// reqIDOf returns the CLI correlation id (X-Rayu-Request-Id) or "-" so a 401 can
// be joined to the CLI/edge logs.
func reqIDOf(r *http.Request) string {
	if v := strings.TrimSpace(r.Header.Get("X-Rayu-Request-Id")); v != "" {
		return v
	}
	return "-"
}

// Middleware extracts and verifies the Bearer access token, storing the claims
// in the request context. Requests without a valid token get a 401 — now with a
// logged reason (missing / expired / invalid) so silent 401 storms are
// diagnosable (e.g. an expired token the CLI should have refreshed).
func Middleware(secret string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			authz := r.Header.Get("Authorization")
			if !strings.HasPrefix(authz, "Bearer ") {
				log.Printf("auth: 401 %s %s reqid=%s reason=missing_bearer_token",
					r.Method, r.URL.Path, reqIDOf(r))
				httpx.WriteError(w, http.StatusUnauthorized, "missing bearer token")
				return
			}
			tok := strings.TrimSpace(strings.TrimPrefix(authz, "Bearer "))
			claims, err := VerifyAccessToken(tok, secret)
			if err != nil {
				// err text distinguishes expired vs malformed vs bad-signature
				// (jwt/v5), which tells whether the CLI needs to refresh vs re-login.
				log.Printf("auth: 401 %s %s reqid=%s reason=invalid_token: %v",
					r.Method, r.URL.Path, reqIDOf(r), err)
				httpx.WriteError(w, http.StatusUnauthorized, "invalid token")
				return
			}
			ctx := context.WithValue(r.Context(), claimsKey, claims)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// ClaimsFromContext returns the verified claims attached by Middleware.
func ClaimsFromContext(ctx context.Context) (*Claims, bool) {
	c, ok := ctx.Value(claimsKey).(*Claims)
	return c, ok
}
