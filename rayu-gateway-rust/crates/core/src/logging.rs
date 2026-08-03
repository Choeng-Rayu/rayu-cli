//! Logging setup.
//!
//! The Go gateway logs with `log.Printf`, so every line is a single
//! human-readable sentence. That text is load-bearing: operators grep it, and
//! several lines are quoted in the runbooks. The message bodies emitted here are
//! therefore identical to Go's; only the prefix differs (Rust adds a level after
//! the timestamp).
//!
//! # I2 -- field redaction
//!
//! [`RedactingFields`] is the field formatter for both output modes. It replaces
//! the value of any field whose *name* is a known credential carrier, so a
//! future `tracing::info!(authorization = ...)` cannot leak a secret even by
//! accident. This is an intentional addition: the Go gateway has no such guard
//! and relies on call-site discipline.
//!
//! Redaction works on field NAMES, not values. Message bodies still have to be
//! written carefully -- which is why the provider-key paths log masks
//! (`secretbox::mask`) rather than secrets.

use std::fmt;

use tracing::field::{Field, Visit};
use tracing_subscriber::fmt::format::Writer;
use tracing_subscriber::fmt::{FormatFields, FormattedFields};
use tracing_subscriber::prelude::*;
use tracing_subscriber::EnvFilter;

use crate::config::LogFormat;

/// Field names that must never reach a log sink.
///
/// Matched case-insensitively, and also against the last dotted segment so a
/// middleware recording `http.header.authorization` is covered.
const REDACTED_FIELDS: &[&str] = &[
    "authorization",
    "x-api-key",
    "x_api_key",
    "x-goog-api-key",
    "x_goog_api_key",
    "x-rayu-token",
    "x_rayu_token",
    "apikey",
    "api_key",
    "secret",
    "encryptedkey",
    "encrypted_key",
    "rayu_jwt_secret",
    "rayu_provider_secret",
    "bearer",
    "password",
    "token",
];

/// The placeholder written in place of a redacted value.
pub const REDACTED_PLACEHOLDER: &str = "<redacted>";

/// Reports whether a structured field name carries credential material.
pub fn is_redacted_field(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    if REDACTED_FIELDS.contains(&lower.as_str()) {
        return true;
    }
    match lower.rsplit_once('.') {
        Some((_, tail)) => REDACTED_FIELDS.contains(&tail),
        None => false,
    }
}

/// A field formatter that replaces the values of credential-carrying fields.
///
/// Implemented from scratch rather than by wrapping `DefaultFields` /
/// `JsonFields`, because `RecordFields` is sealed -- there is no way to
/// interpose a filtering visitor in front of the built-in formatters.
#[derive(Debug, Clone, Copy)]
pub struct RedactingFields {
    /// Emit `"key":value` pairs (JSON mode) instead of `key=value` (human).
    pub json: bool,
}

impl<'writer> FormatFields<'writer> for RedactingFields {
    fn format_fields<R: tracing_subscriber::field::RecordFields>(
        &self,
        writer: Writer<'writer>,
        fields: R,
    ) -> fmt::Result {
        let mut visitor = RedactVisitor {
            writer,
            json: self.json,
            first: true,
            result: Ok(()),
        };
        fields.record(&mut visitor);
        visitor.result
    }

    fn add_fields(
        &self,
        current: &'writer mut FormattedFields<Self>,
        fields: &tracing::span::Record<'_>,
    ) -> fmt::Result {
        let first = current.fields.is_empty();
        let mut visitor = RedactVisitor {
            writer: current.as_writer(),
            json: self.json,
            first,
            result: Ok(()),
        };
        fields.record(&mut visitor);
        visitor.result
    }
}

/// Writes fields, substituting redacted values as it goes.
struct RedactVisitor<'w> {
    writer: Writer<'w>,
    json: bool,
    first: bool,
    result: fmt::Result,
}

impl RedactVisitor<'_> {
    /// Emits one field. When `quoted` is false, `raw` is already a valid JSON
    /// scalar (number/bool) and is written as-is.
    fn emit(&mut self, name: &str, raw: &str, quoted: bool) {
        if self.result.is_err() {
            return;
        }
        let redacted = is_redacted_field(name);
        let text = if redacted { REDACTED_PLACEHOLDER } else { raw };

        self.result = (|| -> fmt::Result {
            if self.json {
                if !self.first {
                    self.writer.write_char(',')?;
                }
                self.writer.write_str(&json_string(name))?;
                self.writer.write_char(':')?;
                if quoted || redacted {
                    self.writer.write_str(&json_string(text))?;
                } else {
                    self.writer.write_str(text)?;
                }
            } else {
                if !self.first {
                    self.writer.write_char(' ')?;
                }
                // The `message` field IS the line, so it is written bare --
                // matching Go's `log.Printf` output and tracing's own default.
                if name == "message" {
                    self.writer.write_str(text)?;
                } else {
                    write!(self.writer, "{name}={text}")?;
                }
            }
            Ok(())
        })();
        self.first = false;
    }
}

/// Renders `s` as a JSON string literal (escaping included).
fn json_string(s: &str) -> String {
    serde_json::Value::String(s.to_string()).to_string()
}

/// Drops one layer of surrounding quotes, for human output.
fn strip_quotes(s: &str) -> &str {
    s.strip_prefix('"')
        .and_then(|t| t.strip_suffix('"'))
        .unwrap_or(s)
}

impl Visit for RedactVisitor<'_> {
    fn record_debug(&mut self, field: &Field, value: &dyn fmt::Debug) {
        // `{:?}` on a &str yields a quoted literal; normalise to the bare text so
        // human output reads like Go's and JSON output is quoted exactly once.
        let rendered = format!("{value:?}");
        let bare = strip_quotes(&rendered).to_string();
        self.emit(field.name(), &bare, true);
    }

    fn record_str(&mut self, field: &Field, value: &str) {
        self.emit(field.name(), value, true);
    }

    fn record_error(&mut self, field: &Field, value: &(dyn std::error::Error + 'static)) {
        self.emit(field.name(), &value.to_string(), true);
    }

    fn record_i64(&mut self, field: &Field, value: i64) {
        self.emit(field.name(), &value.to_string(), false);
    }

    fn record_u64(&mut self, field: &Field, value: u64) {
        self.emit(field.name(), &value.to_string(), false);
    }

    fn record_bool(&mut self, field: &Field, value: bool) {
        self.emit(field.name(), &value.to_string(), false);
    }

    fn record_f64(&mut self, field: &Field, value: f64) {
        self.emit(field.name(), &value.to_string(), false);
    }
}

/// A JSON event formatter that applies redaction.
///
/// `tracing_subscriber`'s built-in `Format<Json>` serialises event fields with
/// its own private visitor and IGNORES the configured [`FormatFields`], so
/// wiring [`RedactingFields`] into `.json()` silently does nothing (a test
/// proves it). This formatter owns the whole line instead, which is also the only
/// way to guarantee the field set.
#[derive(Debug, Clone, Copy, Default)]
pub struct RedactingJsonFormat;

/// Collects event fields into a JSON object, redacting credential-carrying names.
#[derive(Default)]
struct JsonFieldCollector(serde_json::Map<String, serde_json::Value>);

impl JsonFieldCollector {
    fn put(&mut self, name: &str, value: serde_json::Value) {
        if is_redacted_field(name) {
            self.0.insert(
                name.to_string(),
                serde_json::Value::String(REDACTED_PLACEHOLDER.to_string()),
            );
            return;
        }
        self.0.insert(name.to_string(), value);
    }
}

impl Visit for JsonFieldCollector {
    fn record_debug(&mut self, field: &Field, value: &dyn fmt::Debug) {
        let rendered = format!("{value:?}");
        self.put(
            field.name(),
            serde_json::Value::String(strip_quotes(&rendered).to_string()),
        );
    }
    fn record_str(&mut self, field: &Field, value: &str) {
        self.put(field.name(), serde_json::Value::String(value.to_string()));
    }
    fn record_error(&mut self, field: &Field, value: &(dyn std::error::Error + 'static)) {
        self.put(field.name(), serde_json::Value::String(value.to_string()));
    }
    fn record_i64(&mut self, field: &Field, value: i64) {
        self.put(field.name(), serde_json::Value::from(value));
    }
    fn record_u64(&mut self, field: &Field, value: u64) {
        self.put(field.name(), serde_json::Value::from(value));
    }
    fn record_bool(&mut self, field: &Field, value: bool) {
        self.put(field.name(), serde_json::Value::from(value));
    }
    fn record_f64(&mut self, field: &Field, value: f64) {
        self.put(field.name(), serde_json::Value::from(value));
    }
}

impl<S, N> tracing_subscriber::fmt::FormatEvent<S, N> for RedactingJsonFormat
where
    S: tracing::Subscriber + for<'a> tracing_subscriber::registry::LookupSpan<'a>,
    N: for<'a> FormatFields<'a> + 'static,
{
    fn format_event(
        &self,
        _ctx: &tracing_subscriber::fmt::FmtContext<'_, S, N>,
        mut writer: Writer<'_>,
        event: &tracing::Event<'_>,
    ) -> fmt::Result {
        let meta = event.metadata();
        let mut collector = JsonFieldCollector::default();
        event.record(&mut collector);

        let mut line = serde_json::Map::new();
        line.insert(
            "timestamp".into(),
            serde_json::Value::String(
                chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Micros, true),
            ),
        );
        line.insert(
            "level".into(),
            serde_json::Value::String(meta.level().to_string()),
        );
        line.insert(
            "target".into(),
            serde_json::Value::String(meta.target().to_string()),
        );
        line.insert("fields".into(), serde_json::Value::Object(collector.0));

        writeln!(writer, "{}", serde_json::Value::Object(line))
    }
}

/// Installs the process-wide subscriber.
///
/// Honours `RUST_LOG`; defaults to `info` (with sqlx quieted) so a deployment
/// that sets nothing gets roughly the volume the Go gateway produces.
pub fn init(format: LogFormat) {
    let filter =
        EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info,sqlx=warn"));

    match format {
        LogFormat::Json => {
            let layer = tracing_subscriber::fmt::layer()
                .event_format(RedactingJsonFormat)
                .fmt_fields(RedactingFields { json: true });
            let _ = tracing_subscriber::registry()
                .with(filter)
                .with(layer)
                .try_init();
        }
        LogFormat::Human => {
            // No ANSI (logs go to a file/aggregator) and no target, so the result
            // is `<time> <LEVEL> <message>`: Go's line with a level inserted.
            let layer = tracing_subscriber::fmt::layer()
                .fmt_fields(RedactingFields { json: false })
                .with_ansi(false)
                .with_target(false)
                .with_level(true);
            let _ = tracing_subscriber::registry()
                .with(filter)
                .with(layer)
                .try_init();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use tracing_subscriber::fmt::MakeWriter;

    #[test]
    fn redacts_known_credential_field_names() {
        for name in [
            "authorization",
            "Authorization",
            "x-api-key",
            "X-API-Key",
            "encryptedKey",
            "RAYU_JWT_SECRET",
            "rayu_provider_secret",
            "http.header.authorization",
            "request.x-rayu-token",
        ] {
            assert!(is_redacted_field(name), "{name} should be redacted");
        }
    }

    #[test]
    fn leaves_ordinary_field_names_alone() {
        for name in [
            "user", "reqid", "model", "status", "provider", "keyId", "masked", "source",
        ] {
            assert!(!is_redacted_field(name), "{name} should not be redacted");
        }
    }

    #[derive(Clone, Default)]
    struct Buf(Arc<Mutex<Vec<u8>>>);
    impl std::io::Write for Buf {
        fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(b);
            Ok(b.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    impl<'a> MakeWriter<'a> for Buf {
        type Writer = Buf;
        fn make_writer(&'a self) -> Self::Writer {
            self.clone()
        }
    }
    impl Buf {
        fn text(&self) -> String {
            String::from_utf8(self.0.lock().unwrap().clone()).unwrap()
        }
    }

    /// The redaction layer is only useful if the *value* disappears.
    #[test]
    fn human_output_redacts_value_and_keeps_message_bare() {
        let buf = Buf::default();
        let subscriber = tracing_subscriber::fmt()
            .fmt_fields(RedactingFields { json: false })
            .with_writer(buf.clone())
            .with_ansi(false)
            .with_target(false)
            .finish();

        tracing::subscriber::with_default(subscriber, || {
            tracing::info!(
                authorization = "Bearer super-secret-value",
                user = 42,
                "auth check"
            );
        });

        let out = buf.text();
        assert!(
            !out.contains("super-secret-value"),
            "secret leaked into logs: {out}"
        );
        assert!(
            out.contains(REDACTED_PLACEHOLDER),
            "no placeholder in {out}"
        );
        assert!(out.contains("user=42"), "ordinary field dropped: {out}");
        // The message is written bare, without a `message=` key or quotes.
        assert!(out.contains("auth check"), "message dropped: {out}");
        assert!(!out.contains("message="), "message was keyed: {out}");
    }

    #[test]
    fn json_output_is_valid_and_redacted() {
        let buf = Buf::default();
        let subscriber = tracing_subscriber::fmt()
            .event_format(RedactingJsonFormat)
            .fmt_fields(RedactingFields { json: true })
            .with_writer(buf.clone())
            .finish();

        tracing::subscriber::with_default(subscriber, || {
            tracing::info!(
                encryptedKey = "v1:AAAA",
                model = "glm-5.2",
                count = 3,
                "reload done"
            );
        });

        let out = buf.text();
        assert!(!out.contains("v1:AAAA"), "secret leaked: {out}");
        let parsed: serde_json::Value =
            serde_json::from_str(out.trim()).unwrap_or_else(|e| panic!("invalid JSON {out}: {e}"));
        let fields = &parsed["fields"];
        assert_eq!(fields["encryptedKey"], REDACTED_PLACEHOLDER);
        assert_eq!(fields["model"], "glm-5.2");
        assert_eq!(fields["count"], 3);
        assert_eq!(fields["message"], "reload done");
        assert_eq!(parsed["level"], "INFO");
    }
}
