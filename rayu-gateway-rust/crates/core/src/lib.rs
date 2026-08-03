//! Shared gateway primitives: configuration, structured logging, JWT
//! verification, the provider-key secret box, the MySQL store, the bounded
//! write queue, and the HTTP response envelopes.
//!
//! This crate is a port of the Go gateway's `internal/config`,
//! `internal/auth`, `internal/secretbox`, `internal/store`,
//! `internal/eventqueue`, and `internal/httpx` packages. Behaviour is a
//! deliberate clone: every default, error string, and JSON shape matches the
//! Go original, because the CLI and the dashboard pattern-match on them.

pub mod config;
pub mod eventqueue;
pub mod httpx;
pub mod jwt;
pub mod logging;
pub mod secretbox;
pub mod store;

pub use config::Config;
