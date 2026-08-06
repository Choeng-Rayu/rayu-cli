//! The gateway domain: provider configuration and key rotation, entitlements,
//! credits and rate limiting, upstream I/O with failover, the five wire-format
//! adapters, and the HTTP routes.
//!
//! Port of the Go gateway's `internal/providercfg`, `internal/providerkeys`,
//! `internal/entitlements`, `internal/configbus`, `internal/credits`,
//! `internal/circuitbreaker`, `internal/proxy`, `internal/translate`,
//! `internal/tokencount`, `internal/orgcredits`, and `internal/server`.

pub mod adapters;
pub mod capabilities;
pub mod circuitbreaker;
pub mod configbus;
pub mod configreload;
pub mod cors;
pub mod credits;
pub mod entitlements;
pub mod hosted;
pub mod limiter;
pub mod middleware;
pub mod orgcredits;
pub mod providercfg;
pub mod proxy;
pub mod providerkeys;
pub mod reservedenial;
pub mod routes;
pub mod sse;
pub mod state;
pub mod tokencount;
pub mod topup;
pub mod upstream;
