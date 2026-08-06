//! Turns the gateway's canonical Anthropic Messages request into whatever wire
//! format a provider actually speaks, and turns the provider's response back.
//!
//! Port of the Go gateway's `internal/translate`.
//!
//! # Why this exists
//!
//! The CLI is Anthropic-native: it speaks Anthropic Messages to the gateway and
//! nothing else. Providers are not -- a resold model may only offer an
//! OpenAI-compatible endpoint, OpenAI's Responses API, or Google's GenAI API.
//! Putting the translation HERE (rather than in the CLI) means:
//!
//! * a provider can be added from the admin dashboard with no client release;
//! * one billing path meters every format, because every adapter reports usage in
//!   the same normalized buckets the credit engine already prices;
//! * provider API keys never leave the gateway.
//!
//! The `anthropic_messages` adapter is a deliberate exception to "translate": it
//! relays bytes verbatim, so the dominant path pays no translation cost at all.

pub mod anthropic;
pub mod bedrock;
pub mod common;
pub mod eventstream;
pub mod genai;
pub mod openai_chat;
pub mod openai_responses;
pub mod thinking;

use serde_json::Value;

use crate::providercfg::Route;
use crate::sse::{OnStreamDone, StreamStart};
use crate::upstream::{ApiKey, OnKeyFailure, Upstream, Usage};

/// One hosted request, already authorized and metered-reserved by the route, in
/// canonical Anthropic Messages form.
pub struct AdapterRequest {
    /// The resolved provider (URL, auth scheme, format).
    pub route: Route,
    /// The provider's API keys in the order to try them: already filtered to those
    /// usable right now and ordered by priority. Each carries its id so a failure
    /// is attributed to the key that caused it.
    pub keys: Vec<ApiKey>,
    /// Records a per-key failure so the key's health survives the request.
    pub on_key_failure: Option<OnKeyFailure>,
    /// The provider's own model id. Adapters MUST send this as the model, never the
    /// Rayu model code -- that is the model-fidelity guarantee.
    pub upstream_model_id: String,
    /// The client's Anthropic Messages request body. The caller has already
    /// replaced `model` with [`AdapterRequest::upstream_model_id`].
    pub anthropic: Value,
    /// Mirrors `anthropic["stream"]`, resolved once by the caller.
    pub stream: bool,
    /// Idle-stream keepalive interval; 0 (the default) reproduces Go exactly.
    pub keepalive_seconds: i64,
}

/// The result of a non-streaming request.
///
/// Mirrors Go's `(usage, status, body, err)`: `status` is 0 when the upstream was
/// never reached, and `body` is either an Anthropic-shaped success or the upstream's
/// own error body for the caller to relay or mask.
pub struct CompleteOutcome {
    pub usage: Option<Usage>,
    pub status: u16,
    pub body: Vec<u8>,
    /// Set when the upstream could not be reached or its response was unusable.
    pub error: Option<String>,
}

impl CompleteOutcome {
    /// The "never reached the upstream" outcome.
    pub fn unreachable(error: String) -> Self {
        Self {
            usage: None,
            status: 0,
            body: Vec::new(),
            error: Some(error),
        }
    }
}

/// Serves a hosted request against one provider wire format.
#[async_trait::async_trait]
pub trait Adapter: Send + Sync {
    /// The `providers.format` value this adapter handles.
    fn format(&self) -> &'static str;

    /// Serves a streaming request.
    ///
    /// `on_done` is invoked exactly once when the stream finishes, with whatever
    /// usage was observed -- including when the client disconnected mid-stream,
    /// which is what makes billing survive a hang-up.
    async fn stream(
        &self,
        up: &Upstream,
        req: AdapterRequest,
        on_done: OnStreamDone,
    ) -> StreamStart;

    /// Serves a non-streaming request, returning the upstream status and a body
    /// already in Anthropic Messages shape (for a 200) or the upstream's error body
    /// (for a non-200, which the caller sanitizes or relays).
    async fn complete(&self, up: &Upstream, req: AdapterRequest) -> CompleteOutcome;
}

/// Returned when a provider row names a format this build cannot serve.
///
/// The caller must refuse the request WITHOUT charging the user: this is a
/// configuration problem, not a user error.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("no adapter for provider format {0:?}")]
pub struct UnsupportedFormat(pub String);

/// Returns the adapter for a provider format.
pub fn adapter_for(format: &str) -> Result<&'static dyn Adapter, UnsupportedFormat> {
    match format {
        crate::providercfg::FORMAT_ANTHROPIC_MESSAGES => {
            Ok(&anthropic::AnthropicPassthrough as &dyn Adapter)
        }
        crate::providercfg::FORMAT_OPENAI_CHAT => Ok(&openai_chat::OpenAiChat as &dyn Adapter),
        crate::providercfg::FORMAT_GENAI => Ok(&genai::GenAi as &dyn Adapter),
        crate::providercfg::FORMAT_BEDROCK_ANTHROPIC => {
            Ok(&bedrock::BedrockAnthropic as &dyn Adapter)
        }
        crate::providercfg::FORMAT_OPENAI_RESPONSES => {
            Ok(&openai_responses::OpenAiResponses as &dyn Adapter)
        }
        other => Err(UnsupportedFormat(other.to_string())),
    }
}

/// The wire formats this build can serve.
///
/// Used by boot logging so operators can see whether a registry row's format is
/// actually supported.
pub fn formats() -> Vec<&'static str> {
    vec![
        crate::providercfg::FORMAT_ANTHROPIC_MESSAGES,
        crate::providercfg::FORMAT_OPENAI_CHAT,
        crate::providercfg::FORMAT_OPENAI_RESPONSES,
        crate::providercfg::FORMAT_GENAI,
        crate::providercfg::FORMAT_BEDROCK_ANTHROPIC,
    ]
}

/// Convenience: whether a response body is worth relaying verbatim to the client.
pub fn response_is_error(status: u16) -> bool {
    status != 200
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_formats_are_refused_with_gos_message() {
        // `expect_err` would need `Debug` on the trait object, so match instead.
        let err = match adapter_for("grpc_magic") {
            Err(e) => e,
            Ok(_) => panic!("an unknown format must be refused"),
        };
        assert_eq!(
            err.to_string(),
            "no adapter for provider format \"grpc_magic\""
        );
    }

    #[test]
    fn the_anthropic_format_resolves() {
        let a = adapter_for(crate::providercfg::FORMAT_ANTHROPIC_MESSAGES).expect("registered");
        assert_eq!(a.format(), crate::providercfg::FORMAT_ANTHROPIC_MESSAGES);
    }

    #[test]
    fn formats_lists_what_this_build_serves() {
        let f = formats();
        assert!(f.contains(&crate::providercfg::FORMAT_ANTHROPIC_MESSAGES));
    }
}
