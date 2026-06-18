package auth

import (
	"context"
	"net/http"
	"strings"

	"github.com/choeng-rayu/rayu-gateway/internal/httpx"
)

type ctxKey int

const claimsKey ctxKey = iota

// Middleware extracts and verifies the Bearer access token, storing the claims
// in the request context. Requests without a valid token get a 401.
func Middleware(secret string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			authz := r.Header.Get("Authorization")
			if !strings.HasPrefix(authz, "Bearer ") {
				httpx.WriteError(w, http.StatusUnauthorized, "missing bearer token")
				return
			}
			tok := strings.TrimSpace(strings.TrimPrefix(authz, "Bearer "))
			claims, err := VerifyAccessToken(tok, secret)
			if err != nil {
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
