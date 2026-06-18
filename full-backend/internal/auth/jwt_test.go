package auth

import (
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

func sign(t *testing.T, method jwt.SigningMethod, secret string, claims jwt.MapClaims) string {
	t.Helper()
	s, err := jwt.NewWithClaims(method, claims).SignedString([]byte(secret))
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	return s
}

func TestVerifyAccessToken(t *testing.T) {
	const secret = "test-secret"
	now := time.Now()
	access := func(secret string, m jwt.SigningMethod, extra jwt.MapClaims) string {
		c := jwt.MapClaims{"sub": 42, "role": "user", "type": "access", "exp": now.Add(time.Hour).Unix()}
		for k, v := range extra {
			c[k] = v
		}
		return sign(t, m, secret, c)
	}

	tests := []struct {
		name     string
		token    string
		wantErr  bool
		wantUser int64
	}{
		{"valid", access(secret, jwt.SigningMethodHS256, nil), false, 42},
		{"expired", access(secret, jwt.SigningMethodHS256, jwt.MapClaims{"exp": now.Add(-time.Hour).Unix()}), true, 0},
		{"wrong type", access(secret, jwt.SigningMethodHS256, jwt.MapClaims{"type": "refresh"}), true, 0},
		{"bad signature", access("other-secret", jwt.SigningMethodHS256, nil), true, 0},
		{"wrong alg HS512", access(secret, jwt.SigningMethodHS512, nil), true, 0},
		{"garbage", "not.a.jwt", true, 0},
		{"empty", "", true, 0},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			c, err := VerifyAccessToken(tc.token, secret)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("expected error, got claims %+v", c)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if c.UserID != tc.wantUser {
				t.Fatalf("UserID=%d, want %d", c.UserID, tc.wantUser)
			}
			if c.Role != "user" {
				t.Fatalf("Role=%q, want user", c.Role)
			}
		})
	}
}
