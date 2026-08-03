package auth

import (
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// The team claims are ADDITIVE: a token without them is still a valid individual
// access token (that is the whole backwards-compatibility contract with already
// installed CLIs), and a token with them must surface both values so the gateway
// can bill the org.
func TestVerifyAccessTokenOrgClaims(t *testing.T) {
	const secret = "test-secret"
	now := time.Now()
	token := func(extra jwt.MapClaims) string {
		c := jwt.MapClaims{
			"sub":  42,
			"role": "user",
			"type": "access",
			"exp":  now.Add(time.Hour).Unix(),
		}
		for k, v := range extra {
			c[k] = v
		}
		return sign(t, jwt.SigningMethodHS256, secret, c)
	}

	tests := []struct {
		name        string
		token       string
		wantOrgID   int64
		wantOrgRole string
	}{
		{
			name:        "team member token carries orgId and orgRole",
			token:       token(jwt.MapClaims{"orgId": 21, "orgRole": "member"}),
			wantOrgID:   21,
			wantOrgRole: "member",
		},
		{
			name:        "team admin token",
			token:       token(jwt.MapClaims{"orgId": 7, "orgRole": "admin"}),
			wantOrgID:   7,
			wantOrgRole: "admin",
		},
		{
			// The pre-teams token shape. It must keep working untouched.
			name:      "individual token has no org claims",
			token:     token(nil),
			wantOrgID: 0,
		},
		{
			name:      "zero orgId is treated as absent",
			token:     token(jwt.MapClaims{"orgId": 0}),
			wantOrgID: 0,
		},
		{
			// A junk claim must not fail an otherwise valid token: the caller is
			// simply billed individually.
			name:      "malformed orgId is ignored, not an error",
			token:     token(jwt.MapClaims{"orgId": "not-a-number"}),
			wantOrgID: 0,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			claims, err := VerifyAccessToken(tc.token, secret)
			if err != nil {
				t.Fatalf("VerifyAccessToken: %v", err)
			}
			if claims.UserID != 42 {
				t.Errorf("UserID = %d, want 42", claims.UserID)
			}
			if claims.OrgID != tc.wantOrgID {
				t.Errorf("OrgID = %d, want %d", claims.OrgID, tc.wantOrgID)
			}
			if claims.OrgRole != tc.wantOrgRole {
				t.Errorf("OrgRole = %q, want %q", claims.OrgRole, tc.wantOrgRole)
			}
		})
	}
}
