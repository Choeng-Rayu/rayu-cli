//! Gateway configuration, loaded from environment variables.
//!
//! Port of the Go gateway's `internal/config/config.go`. The gateway shares the
//! backend's `DATABASE_URL` (prisma-style) and `RAYU_JWT_SECRET`.
//!
//! Provider ROUTING is not configured here: it comes from the `providers` table
//! (the admin-managed registry). Provider API KEYS are not here either -- they
//! are encrypted rows in `provider_api_keys`. The only provider-related secret
//! in the environment is `RAYU_PROVIDER_SECRET` (see [`crate::secretbox`]), the
//! master key that opens them, which must match the backend's.

use std::time::Duration;

/// The environment variable holding the shared JWT signing secret.
pub const JWT_SECRET_ENV: &str = "RAYU_JWT_SECRET";

/// Secrets shorter than this are accepted but warned about at boot (I5).
///
/// The Go gateway performs no length check at all. Refusing to start would be a
/// behaviour change that could strand an existing deployment, so this is a
/// warning rather than a hard failure.
pub const MIN_RECOMMENDED_JWT_SECRET_LEN: usize = 32;

/// How log lines are rendered.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogFormat {
    /// Human-readable lines shaped like Go's `log.Printf` output (default).
    Human,
    /// Structured JSON, opted into with `LOG_FORMAT=json`.
    Json,
}

/// All runtime configuration for the gateway.
#[derive(Debug, Clone)]
pub struct Config {
    pub port: String,
    pub jwt_secret: String,
    /// Raw prisma-style URL. Empty is tolerated by [`Config::from_env`] so unit
    /// tests can build a config without a database; `main` refuses to boot
    /// without one, exactly as the Go gateway does.
    pub database_url: String,
    pub redis_url: String,
    /// Seconds between in-memory config refreshes.
    pub config_refresh: i64,
    /// Seconds to cache per-user entitlements.
    pub user_cache_ttl: i64,
    /// Redis pub/sub channel for admin config invalidation. Empty selects
    /// [`crate::config::DEFAULT_CONFIG_CHANNEL`].
    pub config_channel: String,
    /// Global cap on concurrently-processed hosted streaming requests
    /// (`RAYU_MAX_INFLIGHT`; 0 = unlimited).
    pub max_in_flight: i64,
    /// Allowed browser origins for the dashboard.
    pub cors_origins: Vec<String>,
    /// Permits http / private-host provider base URLs. Development only: a
    /// provider's API key is sent to that URL, so plaintext or internal targets
    /// are refused by default.
    pub allow_insecure_provider_base_url: bool,
    /// Hard-reject a `/v1/proxy` request whose intended model family differs
    /// from the model actually routed. Default off: mismatches are only logged.
    pub enforce_model_fidelity: bool,
    /// Bounds how long the gateway waits to read a `/v1/proxy` request body
    /// before giving up with 408. 0 = no explicit deadline. Deliberately NOT a
    /// global write timeout, which would break long SSE streams.
    pub proxy_body_read_timeout_seconds: i64,

    // --- additive, not present in the Go gateway -----------------------------
    /// Idle-stream keepalive interval. 0 (the default) reproduces Go exactly:
    /// no keepalive comments are ever written to an SSE stream.
    pub sse_keepalive_seconds: i64,
    /// Resolve a `/v1/proxy` upstream host once and connect to the pinned IP
    /// (I3). Closes the DNS-rebind window the Go gateway leaves open. Set
    /// `RAYU_PROXY_PIN_DNS=0` to fall back to Go's behaviour.
    pub proxy_pin_dns: bool,
    /// Log rendering. `LOG_FORMAT=json` opts into structured output.
    pub log_format: LogFormat,
}

/// The Redis pub/sub channel used when `RAYU_CONFIG_CHANNEL` is unset.
pub const DEFAULT_CONFIG_CHANNEL: &str = "rayu:config-changed";

/// Reports whether an env value means "on" (`1`/`true`/`yes`/`on`, any case).
///
/// Port of Go's `config.EnvTruthy`.
pub fn env_truthy(v: &str) -> bool {
    matches!(
        v.trim().to_ascii_lowercase().as_str(),
        "1" | "true" | "yes" | "on"
    )
}

/// Reads `key`, treating an empty value as unset. Port of Go's `getenv`.
fn getenv(key: &str, default: &str) -> String {
    match std::env::var(key) {
        Ok(v) if !v.is_empty() => v,
        _ => default.to_string(),
    }
}

/// Reads an integer env var the way Go's `strconv.Atoi(getenv(...))` does:
/// an unparseable value silently becomes 0 (the discarded error).
///
/// Replicated deliberately so a malformed value produces the same *number* Go
/// would compute. The one place Go would then panic (a 0-second refresh ticker)
/// is guarded at the call site with a warning instead of a crash.
fn getenv_int(key: &str, default: &str) -> i64 {
    getenv(key, default).trim().parse::<i64>().unwrap_or(0)
}

/// Errors that stop the gateway from starting.
#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("RAYU_JWT_SECRET is required")]
    MissingJwtSecret,
    #[error("parse DATABASE_URL: {0}")]
    DatabaseUrl(String),
}

impl Config {
    /// Loads configuration from the environment.
    ///
    /// `RAYU_JWT_SECRET` is required; everything else has a sensible default so
    /// the binary boots in development.
    pub fn from_env() -> Result<Self, ConfigError> {
        let jwt_secret = std::env::var(JWT_SECRET_ENV).unwrap_or_default();
        if jwt_secret.is_empty() {
            return Err(ConfigError::MissingJwtSecret);
        }

        let database_url = std::env::var("DATABASE_URL").unwrap_or_default();
        if !database_url.is_empty() {
            // Validated here, at load, so a typo fails the boot rather than the
            // first query. Mirrors Go calling MySQLDSN from Load.
            validate_database_url(&database_url).map_err(ConfigError::DatabaseUrl)?;
        }

        // Allowed browser origins for the dashboard's /v1/credits calls. The
        // default "*" is safe because every /v1 route still requires a valid
        // Rayu JWT.
        let cors_origins = getenv("GATEWAY_CORS_ORIGINS", "*")
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .collect();

        let log_format = if getenv("LOG_FORMAT", "").trim().eq_ignore_ascii_case("json") {
            LogFormat::Json
        } else {
            LogFormat::Human
        };

        Ok(Self {
            port: getenv("PORT", "8080"),
            jwt_secret,
            database_url,
            redis_url: getenv("REDIS_URL", "redis://localhost:6379"),
            config_refresh: getenv_int("CONFIG_REFRESH_SECONDS", "30"),
            user_cache_ttl: getenv_int("USER_CACHE_TTL_SECONDS", "10"),
            config_channel: std::env::var("RAYU_CONFIG_CHANNEL").unwrap_or_default(),
            // Global load-shedding valve: max hosted streaming requests
            // processed at once (0 = unlimited). When exceeded the gateway sheds
            // with a fast, clean 503 so a burst degrades gracefully instead of
            // exhausting the origin's connections and collapsing.
            max_in_flight: getenv_int("RAYU_MAX_INFLIGHT", "0"),
            cors_origins,
            allow_insecure_provider_base_url: env_truthy(
                &std::env::var("ALLOW_INSECURE_PROVIDER_BASE_URL").unwrap_or_default(),
            ),
            enforce_model_fidelity: env_truthy(
                &std::env::var("RAYU_ENFORCE_MODEL_FIDELITY").unwrap_or_default(),
            ),
            proxy_body_read_timeout_seconds: getenv_int("RAYU_PROXY_BODY_READ_TIMEOUT", "0"),
            sse_keepalive_seconds: getenv_int("RAYU_SSE_KEEPALIVE_SECONDS", "0"),
            proxy_pin_dns: env_truthy(&getenv("RAYU_PROXY_PIN_DNS", "1")),
            log_format,
        })
    }
}

/// The same values [`Config::from_env`] applies when no environment variable is set,
/// minus the two that have no default (`jwt_secret` and `database_url`, both empty).
///
/// This exists so a test can build a config by naming only the fields it cares about.
/// It is deliberately kept next to `from_env` and pinned by
/// `default_matches_from_env_defaults`, so the two cannot drift apart.
impl Default for Config {
    fn default() -> Self {
        Self {
            port: "8080".into(),
            jwt_secret: String::new(),
            database_url: String::new(),
            redis_url: "redis://localhost:6379".into(),
            config_refresh: 30,
            user_cache_ttl: 10,
            config_channel: String::new(),
            max_in_flight: 0,
            cors_origins: vec!["*".into()],
            allow_insecure_provider_base_url: false,
            enforce_model_fidelity: false,
            proxy_body_read_timeout_seconds: 0,
            sse_keepalive_seconds: 0,
            proxy_pin_dns: true,
            log_format: LogFormat::Human,
        }
    }
}

impl Config {
    /// The configured invalidation channel, or the default when unset.
    pub fn config_channel_or_default(&self) -> &str {
        if self.config_channel.is_empty() {
            DEFAULT_CONFIG_CHANNEL
        } else {
            &self.config_channel
        }
    }

    /// Interval for the periodic config refresh.
    ///
    /// Go would panic on a non-positive ticker interval; a malformed
    /// `CONFIG_REFRESH_SECONDS` is clamped to 1s here and warned about instead,
    /// because crashing on a typo helps nobody.
    pub fn config_refresh_interval(&self) -> Duration {
        if self.config_refresh <= 0 {
            tracing::warn!(
                "config: CONFIG_REFRESH_SECONDS={} is not positive; using 1s",
                self.config_refresh
            );
            return Duration::from_secs(1);
        }
        Duration::from_secs(self.config_refresh as u64)
    }

    /// TTL for a cached per-user entitlement.
    pub fn user_cache_ttl_duration(&self) -> Duration {
        Duration::from_secs(self.user_cache_ttl.max(0) as u64)
    }

    /// Whether `origin` may call the API. Mirrors Go's `corsMiddleware` map.
    pub fn cors_allows(&self, origin: &str) -> bool {
        self.cors_origins.iter().any(|o| o == "*" || o == origin)
    }

    /// A config with safe defaults, for tests that never touch the network.
    #[doc(hidden)]
    pub fn for_tests() -> Self {
        Self {
            port: "8080".into(),
            jwt_secret: "test-secret-test-secret-test-secret".into(),
            database_url: String::new(),
            redis_url: "redis://localhost:6379".into(),
            config_refresh: 30,
            user_cache_ttl: 10,
            config_channel: String::new(),
            max_in_flight: 0,
            cors_origins: vec!["*".into()],
            allow_insecure_provider_base_url: false,
            enforce_model_fidelity: false,
            proxy_body_read_timeout_seconds: 0,
            sse_keepalive_seconds: 0,
            proxy_pin_dns: true,
            log_format: LogFormat::Human,
        }
    }
}

/// Validates a prisma-style `mysql://user:pass@host:port/db?params` URL.
///
/// The Go gateway converts it to a go-sql-driver DSN here; sqlx consumes the URL
/// directly (see `store::open`), so this keeps only the validation half --
/// including the exact "unsupported scheme" message.
pub fn validate_database_url(raw: &str) -> Result<(), String> {
    let parsed = url::Url::parse(raw).map_err(|e| e.to_string())?;
    if parsed.scheme() != "mysql" {
        return Err(format!(
            "unsupported scheme {:?} (want mysql)",
            parsed.scheme()
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_truthy_accepts_go_values() {
        for v in [
            "1", "true", "TRUE", "True", "yes", "YES", "on", "ON", " on ",
        ] {
            assert!(env_truthy(v), "{v:?} should be truthy");
        }
        for v in ["", "0", "false", "no", "off", "maybe", "2"] {
            assert!(!env_truthy(v), "{v:?} should be falsy");
        }
    }

    #[test]
    fn validate_database_url_requires_mysql_scheme() {
        assert!(validate_database_url("mysql://u:p@127.0.0.1:3306/rayu").is_ok());
        assert_eq!(
            validate_database_url("postgres://u:p@127.0.0.1:5432/rayu").unwrap_err(),
            "unsupported scheme \"postgres\" (want mysql)"
        );
        assert!(validate_database_url("not a url").is_err());
    }

    #[test]
    fn config_channel_falls_back_to_default() {
        let mut c = Config::for_tests();
        assert_eq!(c.config_channel_or_default(), DEFAULT_CONFIG_CHANNEL);
        c.config_channel = "custom".into();
        assert_eq!(c.config_channel_or_default(), "custom");
    }

    #[test]
    fn cors_wildcard_and_explicit_origins() {
        let mut c = Config::for_tests();
        assert!(c.cors_allows("https://anything.example"));
        c.cors_origins = vec!["https://rayucode.com".into()];
        assert!(c.cors_allows("https://rayucode.com"));
        assert!(!c.cors_allows("https://evil.example"));
    }

    #[test]
    fn refresh_interval_clamps_non_positive() {
        let mut c = Config::for_tests();
        c.config_refresh = 0;
        assert_eq!(c.config_refresh_interval(), Duration::from_secs(1));
        c.config_refresh = 30;
        assert_eq!(c.config_refresh_interval(), Duration::from_secs(30));
    }

    /// `Default` must stay identical to what `from_env` produces with nothing set,
    /// or a test would silently exercise a configuration production never uses.
    #[test]
    fn default_matches_from_env_defaults() {
        let saved: Vec<(&str, Option<String>)> = [
            "PORT",
            "REDIS_URL",
            "CONFIG_REFRESH_SECONDS",
            "USER_CACHE_TTL_SECONDS",
            "RAYU_CONFIG_CHANNEL",
            "RAYU_MAX_INFLIGHT",
            "GATEWAY_CORS_ORIGINS",
            "ALLOW_INSECURE_PROVIDER_BASE_URL",
            "RAYU_ENFORCE_MODEL_FIDELITY",
            "RAYU_PROXY_BODY_READ_TIMEOUT",
            "RAYU_SSE_KEEPALIVE_SECONDS",
            "RAYU_PROXY_PIN_DNS",
            "LOG_FORMAT",
            "DATABASE_URL",
            JWT_SECRET_ENV,
        ]
        .iter()
        .map(|k| (*k, std::env::var(k).ok()))
        .collect();
        for (k, _) in &saved {
            std::env::remove_var(k);
        }
        std::env::set_var(JWT_SECRET_ENV, "x");

        let from_env = Config::from_env().expect("a bare config must load");
        let mut want = Config {
            jwt_secret: "x".into(),
            ..Default::default()
        };
        // Fields with no default are compared explicitly above.
        want.jwt_secret = from_env.jwt_secret.clone();

        assert_eq!(from_env.port, want.port);
        assert_eq!(from_env.redis_url, want.redis_url);
        assert_eq!(from_env.config_refresh, want.config_refresh);
        assert_eq!(from_env.user_cache_ttl, want.user_cache_ttl);
        assert_eq!(from_env.config_channel, want.config_channel);
        assert_eq!(from_env.max_in_flight, want.max_in_flight);
        assert_eq!(from_env.cors_origins, want.cors_origins);
        assert_eq!(
            from_env.allow_insecure_provider_base_url,
            want.allow_insecure_provider_base_url
        );
        assert_eq!(from_env.enforce_model_fidelity, want.enforce_model_fidelity);
        assert_eq!(
            from_env.proxy_body_read_timeout_seconds,
            want.proxy_body_read_timeout_seconds
        );
        assert_eq!(from_env.sse_keepalive_seconds, want.sse_keepalive_seconds);
        assert_eq!(from_env.proxy_pin_dns, want.proxy_pin_dns);
        assert_eq!(from_env.log_format, want.log_format);
        assert_eq!(from_env.database_url, want.database_url);

        for (k, v) in saved {
            match v {
                Some(v) => std::env::set_var(k, v),
                None => std::env::remove_var(k),
            }
        }
    }
}
