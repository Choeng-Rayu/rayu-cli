//! Verifies Rayu access JWTs (issued by the NestJS backend) and provides the
//! HTTP auth middleware.
//!
//! Port of the Go gateway's `internal/auth`. Tokens are HS256-signed with the
//! shared `RAYU_JWT_SECRET`; access tokens carry
//! `{ sub:<userId>, role, type:"access" }`.

use axum::extract::Request;
use axum::middleware::Next;
use axum::response::Response;
use http::StatusCode;
use jsonwebtoken::{Algorithm, DecodingKey, Validation};

/// The subset of the access token the gateway consumes.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Claims {
    pub user_id: i64,
    pub role: String,
    /// TEAM claims. OPTIONAL: `0`/`""` means the caller is an individual user
    /// billed against their own subscription, exactly as every token issued
    /// before teams existed. A gateway build that predates teams ignores them,
    /// and a token that predates teams is still valid here -- which is what keeps
    /// the CLI contract unbroken in both directions.
    pub org_id: i64,
    pub org_role: String,
}

impl Claims {
    /// Whether the caller may use the admin-only routes.
    ///
    /// Port of the inline `claims.Role != "admin" && claims.Role != "superadmin"`
    /// check repeated across the Go admin handlers.
    pub fn is_admin(&self) -> bool {
        self.role == "admin" || self.role == "superadmin"
    }
}

/// Why a token was rejected.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum AuthError {
    /// Covers signature/format/expiry failures.
    #[error("invalid or expired token")]
    InvalidToken,
    /// Returned for non-access tokens (e.g. refresh tokens).
    #[error("not an access token")]
    WrongType,
}

/// Validates an HS256 Rayu access token and returns its claims.
///
/// Rejects non-HMAC/non-HS256 algorithms, expired tokens, and any token whose
/// `type` claim is not exactly `"access"`.
///
/// Claims are decoded into a generic JSON map rather than a typed struct on
/// purpose: Go reads `sub` via a `float64` type assertion, so a *string* `sub` is
/// a hard rejection rather than a coerced value, and `orgId` junk is ignored
/// rather than fatal. A typed struct would silently change both behaviours.
pub fn verify_access_token(token: &str, secret: &str) -> Result<Claims, AuthError> {
    let mut validation = Validation::new(Algorithm::HS256);
    // Go's jwt/v5 validates `exp` only when present and applies NO leeway;
    // jsonwebtoken would otherwise require `exp` and allow 60s of slack, which
    // would accept tokens the Go gateway rejects.
    validation.required_spec_claims.clear();
    validation.leeway = 0;
    validation.validate_aud = false;

    let data = jsonwebtoken::decode::<serde_json::Value>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &validation,
    )
    .map_err(|_| AuthError::InvalidToken)?;

    let claims = data.claims.as_object().ok_or(AuthError::InvalidToken)?;

    // Order matters: Go checks `type` BEFORE `sub`, so a refresh token with a
    // malformed `sub` reports WrongType, not InvalidToken.
    if claims.get("type").and_then(|v| v.as_str()) != Some("access") {
        return Err(AuthError::WrongType);
    }

    let sub = claims
        .get("sub")
        .and_then(|v| v.as_f64())
        .ok_or(AuthError::InvalidToken)?;

    let role = claims
        .get("role")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();

    // Team claims, when present. A malformed/absent value is NOT an error: the
    // token is still a perfectly valid individual access token.
    let org_id = claims
        .get("orgId")
        .and_then(|v| v.as_f64())
        .filter(|v| *v > 0.0)
        .map(|v| v as i64)
        .unwrap_or(0);
    let org_role = claims
        .get("orgRole")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();

    Ok(Claims {
        user_id: sub as i64,
        role,
        org_id,
        org_role,
    })
}

/// Returns the CLI correlation id (`X-Rayu-Request-Id`) or `-`, so a 401 can be
/// joined to the CLI/edge logs.
fn req_id_of(req: &Request) -> String {
    req.headers()
        .get("x-rayu-request-id")
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("-")
        .to_string()
}

/// Extracts and verifies the Bearer access token, storing the claims in the
/// request extensions.
///
/// Requests without a valid token get a 401 -- with a logged reason (missing /
/// invalid) so silent 401 storms are diagnosable (e.g. an expired token the CLI
/// should have refreshed).
pub async fn middleware(secret: String, req: Request, next: Next) -> Response {
    let authz = req
        .headers()
        .get(http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();

    if !authz.starts_with("Bearer ") {
        tracing::info!(
            "auth: 401 {} {} reqid={} reason=missing_bearer_token",
            req.method(),
            req.uri().path(),
            req_id_of(&req)
        );
        return crate::httpx::write_error(StatusCode::UNAUTHORIZED, "missing bearer token");
    }

    let token = authz.trim_start_matches("Bearer ").trim();
    match verify_access_token(token, &secret) {
        Ok(claims) => {
            let mut req = req;
            req.extensions_mut().insert(claims);
            next.run(req).await
        }
        Err(e) => {
            // The error text distinguishes expired vs malformed vs bad-signature,
            // which tells whether the CLI needs to refresh or to re-login.
            tracing::info!(
                "auth: 401 {} {} reqid={} reason=invalid_token: {}",
                req.method(),
                req.uri().path(),
                req_id_of(&req),
                e
            );
            crate::httpx::write_error(StatusCode::UNAUTHORIZED, "invalid token")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use jsonwebtoken::{encode, EncodingKey, Header};
    use serde_json::json;

    const SECRET: &str = "test-secret";

    fn now() -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64
    }

    fn sign(alg: Algorithm, secret: &str, claims: serde_json::Value) -> String {
        encode(
            &Header::new(alg),
            &claims,
            &EncodingKey::from_secret(secret.as_bytes()),
        )
        .expect("sign")
    }

    /// Builds an access token, letting a test override or add claims.
    fn access(secret: &str, alg: Algorithm, extra: serde_json::Value) -> String {
        let mut c = json!({
            "sub": 42, "role": "user", "type": "access", "exp": now() + 3600
        });
        if let Some(obj) = extra.as_object() {
            for (k, v) in obj {
                c[k] = v.clone();
            }
        }
        sign(alg, secret, c)
    }

    /// Port of Go's `TestVerifyAccessToken` table.
    #[test]
    fn verify_access_token_table() {
        let valid = access(SECRET, Algorithm::HS256, json!({}));
        let expired = access(SECRET, Algorithm::HS256, json!({"exp": now() - 3600}));
        let wrong_type = access(SECRET, Algorithm::HS256, json!({"type": "refresh"}));
        let bad_sig = access("other-secret", Algorithm::HS256, json!({}));
        let hs512 = access(SECRET, Algorithm::HS512, json!({}));

        let claims = verify_access_token(&valid, SECRET).expect("valid token");
        assert_eq!(claims.user_id, 42);
        assert_eq!(claims.role, "user");

        for (name, token) in [
            ("expired", expired.as_str()),
            ("wrong type", wrong_type.as_str()),
            ("bad signature", bad_sig.as_str()),
            ("wrong alg HS512", hs512.as_str()),
            ("garbage", "not.a.jwt"),
            ("empty", ""),
        ] {
            assert!(
                verify_access_token(token, SECRET).is_err(),
                "{name} should be rejected"
            );
        }
    }

    #[test]
    fn wrong_type_is_reported_before_a_malformed_sub() {
        // Go asserts `type` first, so this must be WrongType rather than
        // InvalidToken -- the distinction shows up in the 401 log line.
        let token = access(
            SECRET,
            Algorithm::HS256,
            json!({"type": "refresh", "sub": "not-a-number"}),
        );
        assert_eq!(
            verify_access_token(&token, SECRET).unwrap_err(),
            AuthError::WrongType
        );
    }

    #[test]
    fn string_sub_is_rejected() {
        let token = access(SECRET, Algorithm::HS256, json!({"sub": "42"}));
        assert_eq!(
            verify_access_token(&token, SECRET).unwrap_err(),
            AuthError::InvalidToken
        );
    }

    #[test]
    fn alg_none_is_rejected() {
        // A `none` token cannot even be produced by jsonwebtoken, so craft it by
        // hand: this is the classic algorithm-confusion attack.
        use base64::Engine as _;
        let b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD;
        let header = b64.encode(br#"{"alg":"none","typ":"JWT"}"#);
        let payload = b64.encode(br#"{"sub":42,"role":"admin","type":"access"}"#);
        let token = format!("{header}.{payload}.");
        assert!(verify_access_token(&token, SECRET).is_err());
    }

    #[test]
    fn token_without_exp_is_accepted_like_go() {
        // golang-jwt/v5 validates `exp` only when present; jsonwebtoken requires
        // it by default, which would reject tokens the Go gateway accepts.
        let token = sign(
            Algorithm::HS256,
            SECRET,
            json!({"sub": 7, "role": "user", "type": "access"}),
        );
        let claims = verify_access_token(&token, SECRET).expect("no-exp token");
        assert_eq!(claims.user_id, 7);
    }

    #[test]
    fn expiry_has_no_leeway() {
        // jsonwebtoken's default 60s leeway would accept this; Go would not.
        let token = access(SECRET, Algorithm::HS256, json!({"exp": now() - 5}));
        assert!(verify_access_token(&token, SECRET).is_err());
    }

    /// Port of Go's `TestVerifyAccessTokenOrgClaims` table.
    #[test]
    fn org_claims_are_additive() {
        let cases = [
            (
                "team member token carries orgId and orgRole",
                json!({"orgId": 21, "orgRole": "member"}),
                21i64,
                "member",
            ),
            (
                "team admin token",
                json!({"orgId": 7, "orgRole": "admin"}),
                7,
                "admin",
            ),
            ("individual token has no org claims", json!({}), 0, ""),
            (
                "zero orgId is treated as absent",
                json!({"orgId": 0}),
                0,
                "",
            ),
            (
                "malformed orgId is ignored, not an error",
                json!({"orgId": "not-a-number"}),
                0,
                "",
            ),
        ];
        for (name, extra, want_org, want_role) in cases {
            let token = access(SECRET, Algorithm::HS256, extra);
            let claims = verify_access_token(&token, SECRET)
                .unwrap_or_else(|e| panic!("{name}: unexpected error {e}"));
            assert_eq!(claims.user_id, 42, "{name}");
            assert_eq!(claims.org_id, want_org, "{name}");
            assert_eq!(claims.org_role, want_role, "{name}");
        }
    }

    #[test]
    fn admin_roles() {
        for (role, want) in [
            ("admin", true),
            ("superadmin", true),
            ("user", false),
            ("", false),
        ] {
            let c = Claims {
                role: role.into(),
                ..Default::default()
            };
            assert_eq!(c.is_admin(), want, "role={role}");
        }
    }

    /// Tokens minted by the REAL `golang-jwt/jwt/v5` library (the one the Go
    /// gateway and the NestJS backend use), with no `exp` so the fixtures cannot
    /// rot. If the two implementations ever disagree on HS256 signing or on how
    /// `sub`/`orgId` are read, this fails.
    #[test]
    fn opens_tokens_minted_by_golang_jwt() {
        const GO_SECRET: &str = "cross-language-jwt-secret-0123456789abcdef";
        const GO_INDIVIDUAL: &str = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoidXNlciIsInN1YiI6NDIsInR5cGUiOiJhY2Nlc3MifQ.tS7jr7CPIX2bblufXmXBZK3j5SaUb0JNtuaFHRXfxJ4";
        const GO_TEAM: &str = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJvcmdJZCI6MjEsIm9yZ1JvbGUiOiJtZW1iZXIiLCJyb2xlIjoiYWRtaW4iLCJzdWIiOjk5LCJ0eXBlIjoiYWNjZXNzIn0.gfGwAFDdUbjuxg4Zdj7DQ43Lh6kCjrZF5ak16X2KLzY";
        const GO_REFRESH: &str = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoidXNlciIsInN1YiI6NDIsInR5cGUiOiJyZWZyZXNoIn0.OhvepGNDwrhwQADEAVYzjNphvVzTfLBCH0lz7Y3SEMw";

        let individual =
            verify_access_token(GO_INDIVIDUAL, GO_SECRET).expect("go individual token");
        assert_eq!(individual.user_id, 42);
        assert_eq!(individual.role, "user");
        assert_eq!(individual.org_id, 0);

        let team = verify_access_token(GO_TEAM, GO_SECRET).expect("go team token");
        assert_eq!(team.user_id, 99);
        assert_eq!(team.role, "admin");
        assert_eq!(team.org_id, 21);
        assert_eq!(team.org_role, "member");
        assert!(team.is_admin());

        assert_eq!(
            verify_access_token(GO_REFRESH, GO_SECRET).unwrap_err(),
            AuthError::WrongType
        );
        // Wrong secret must fail even for an otherwise perfect token.
        assert!(verify_access_token(GO_INDIVIDUAL, "not-the-secret").is_err());
    }
}
