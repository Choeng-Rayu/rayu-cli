// Package auth verifies Rayu access JWTs (issued by the NestJS backend) and
// provides the HTTP auth middleware. Tokens are HS256-signed with the shared
// RAYU_JWT_SECRET; access tokens carry { sub:<userId>, role, type:"access" }.
package auth

import (
	"errors"
	"fmt"

	"github.com/golang-jwt/jwt/v5"
)

// Claims is the subset of the access token we consume.
type Claims struct {
	UserID int64
	Role   string
	// OrgID/OrgRole are the TEAM claims. They are OPTIONAL: 0/"" means the caller
	// is an individual user and is billed against their own subscription, exactly
	// as every token issued before teams existed. A gateway build that predates
	// teams ignores them, and a token that predates teams is still valid here —
	// which is what keeps the CLI contract unbroken in both directions.
	OrgID   int64
	OrgRole string
}

var (
	// ErrInvalidToken covers signature/format/expiry failures.
	ErrInvalidToken = errors.New("invalid or expired token")
	// ErrWrongType is returned for non-access tokens (e.g. refresh tokens).
	ErrWrongType = errors.New("not an access token")
)

// VerifyAccessToken validates an HS256 Rayu access token and returns its claims.
// It rejects non-HMAC/non-HS256 algorithms, expired tokens, and any token whose
// `type` claim is not exactly "access".
func VerifyAccessToken(tokenStr, secret string) (*Claims, error) {
	parsed, err := jwt.Parse(tokenStr, func(t *jwt.Token) (interface{}, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", t.Header["alg"])
		}
		return []byte(secret), nil
	}, jwt.WithValidMethods([]string{"HS256"}))
	if err != nil || parsed == nil || !parsed.Valid {
		return nil, ErrInvalidToken
	}
	mc, ok := parsed.Claims.(jwt.MapClaims)
	if !ok {
		return nil, ErrInvalidToken
	}
	if t, _ := mc["type"].(string); t != "access" {
		return nil, ErrWrongType
	}
	sub, ok := mc["sub"].(float64)
	if !ok {
		return nil, ErrInvalidToken
	}
	role, _ := mc["role"].(string)
	// Team claims, when present. A malformed/absent value is NOT an error: the
	// token is still a perfectly valid individual access token.
	var orgID int64
	if v, ok := mc["orgId"].(float64); ok && v > 0 {
		orgID = int64(v)
	}
	orgRole, _ := mc["orgRole"].(string)
	return &Claims{UserID: int64(sub), Role: role, OrgID: orgID, OrgRole: orgRole}, nil
}
