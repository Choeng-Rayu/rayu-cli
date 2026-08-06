//! SSE plumbing shared by every wire-format adapter: reading an upstream stream
//! incrementally, writing an Anthropic-format stream to the client, and the
//! block-index bookkeeping that turns a provider's incremental output into the
//! Anthropic Messages event sequence.
//!
//! Port of the Go gateway's `internal/translate/sse.go`.
//!
//! # Performance contract (every adapter must honour it)
//!
//! * Streaming translation is INCREMENTAL: read an upstream event, write the
//!   Anthropic event(s), flush. Never buffer a whole response -- the point of
//!   streaming is time-to-first-token.
//! * All upstream I/O goes through [`crate::upstream`], so every format inherits
//!   the circuit breaker, transient retry, and multi-key failover.
//!
//! # How streaming maps onto axum
//!
//! Go writes directly into an `http.ResponseWriter` and returns when the stream
//! ends. axum handlers must return a `Response` *before* its body is drained, so
//! the shape here is:
//!
//! 1. the adapter performs the upstream request and inspects the status;
//! 2. a non-200 becomes [`StreamStart::Failed`] -- nothing has been sent, so the
//!    caller may still write its own error body (Go's `wrote == false`);
//! 3. a 200 becomes [`StreamStart::Streaming`], whose body is fed by a task that
//!    pumps upstream events into an [`EventSink`] and finally reports usage
//!    (Go's `wrote == true`).
//!
//! Returning the decision as an enum removes Go's `wrote` boolean: the two states
//! are distinct types, so a handler cannot accidentally write an error over a
//! stream that has already started.

use std::sync::Arc;

use axum::body::Body;
use axum::response::Response;
use bytes::Bytes;
use http::StatusCode;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};

use crate::providercfg::{self, Route};
use crate::upstream::{UpstreamError, Usage};

/// Bounds one upstream SSE line.
///
/// A provider that never emits a newline must not be able to grow the gateway's
/// memory without limit; 1 MiB is far above any real event (a big tool-call
/// argument chunk is a few KiB).
pub const MAX_SSE_LINE_BYTES: usize = 1 << 20;

/// How much of the upstream stream to buffer while looking for line breaks.
const READ_BUF: usize = 64 << 10;

/// Anthropic content-block kinds an adapter can emit.
const BLOCK_TEXT: &str = "text";
const BLOCK_THINKING: &str = "thinking";
const BLOCK_TOOL_USE: &str = "tool_use";

/// Why reading an upstream SSE stream stopped.
#[derive(Debug, thiserror::Error)]
pub enum SseError {
    /// A single line exceeded [`MAX_SSE_LINE_BYTES`].
    #[error("upstream SSE line exceeds {MAX_SSE_LINE_BYTES} bytes")]
    LineTooLong,
    /// The upstream connection failed mid-stream.
    #[error("{0}")]
    Upstream(String),
    /// The client hung up, so there is nobody left to write to.
    #[error("client disconnected")]
    Disconnected,
}

/// Builds a POST with the provider's auth scheme applied.
///
/// Adapters use this so a provider row's `authScheme` is honoured identically
/// everywhere.
pub fn new_upstream_req(
    client: &reqwest::Client,
    url: &str,
    api_key: &str,
    route: &Route,
    body: Vec<u8>,
) -> Result<reqwest::Request, UpstreamError> {
    let mut req = client
        .post(url)
        .header(http::header::CONTENT_TYPE, "application/json");
    req = match route.auth_scheme.as_str() {
        providercfg::AUTH_BEARER => {
            req.header(http::header::AUTHORIZATION, format!("Bearer {api_key}"))
        }
        providercfg::AUTH_X_GOOG_API_KEY => req.header("x-goog-api-key", api_key),
        // providercfg::AUTH_X_API_KEY and anything else
        _ => req.header("x-api-key", api_key),
    };
    req.body(body)
        .build()
        .map_err(|e| UpstreamError::Build(e.to_string()))
}

/// Reads an SSE body INCREMENTALLY, yielding each `data:` payload as it arrives.
///
/// Comment/blank/`event:` lines are skipped; the OpenAI-style `[DONE]` sentinel
/// ends the scan. Translation therefore never waits for (or buffers) the whole
/// response.
///
/// Implemented with an explicit `fill_buf`/`consume` loop rather than
/// `read_until`, because `read_until` would grow its buffer without bound before
/// returning -- the very thing [`MAX_SSE_LINE_BYTES`] exists to prevent.
pub struct SseScanner<R> {
    reader: BufReader<R>,
    line: Vec<u8>,
    done: bool,
}

impl<R: AsyncRead + Unpin> SseScanner<R> {
    pub fn new(inner: R) -> Self {
        Self {
            reader: BufReader::with_capacity(READ_BUF, inner),
            line: Vec::with_capacity(4096),
            done: false,
        }
    }

    /// Yields the next `data:` payload, `None` at end of stream (or after
    /// `[DONE]`).
    pub async fn next_data(&mut self) -> Option<Result<Vec<u8>, SseError>> {
        if self.done {
            return None;
        }
        loop {
            // Pull whatever is buffered without waiting for a full line.
            let available = match self.reader.fill_buf().await {
                Ok(b) => b,
                Err(e) => {
                    self.done = true;
                    return Some(Err(SseError::Upstream(e.to_string())));
                }
            };

            if available.is_empty() {
                // End of stream: emit any trailing partial line, then stop.
                self.done = true;
                if self.line.is_empty() {
                    return None;
                }
                let line = std::mem::take(&mut self.line);
                return match sse_data(&line) {
                    Some(p) if p != b"[DONE]" => Some(Ok(p)),
                    _ => None,
                };
            }

            match available.iter().position(|&b| b == b'\n') {
                Some(idx) => {
                    // The cap is on the LINE, not on how the upstream happened to
                    // chunk it: without this check a 2 MiB line whose final chunk
                    // carried the newline would slip through, since the accumulating
                    // branch below would never have seen an over-long chunk.
                    if self.line.len() + idx > MAX_SSE_LINE_BYTES {
                        self.done = true;
                        return Some(Err(SseError::LineTooLong));
                    }
                    self.line.extend_from_slice(&available[..=idx]);
                    self.reader.consume(idx + 1);
                    let line = std::mem::take(&mut self.line);
                    if let Some(payload) = sse_data(&line) {
                        if payload == b"[DONE]" {
                            self.done = true;
                            return None;
                        }
                        return Some(Ok(payload));
                    }
                    // A comment / blank / `event:` line: keep reading.
                }
                None => {
                    if self.line.len() + available.len() > MAX_SSE_LINE_BYTES {
                        self.done = true;
                        return Some(Err(SseError::LineTooLong));
                    }
                    self.line.extend_from_slice(available);
                    let n = available.len();
                    self.reader.consume(n);
                }
            }
        }
    }

    /// Yields the next raw line INCLUDING its terminator, for the byte-verbatim
    /// passthrough relay.
    pub async fn next_line(&mut self) -> Option<Result<Vec<u8>, SseError>> {
        if self.done {
            return None;
        }
        loop {
            let available = match self.reader.fill_buf().await {
                Ok(b) => b,
                Err(e) => {
                    self.done = true;
                    return Some(Err(SseError::Upstream(e.to_string())));
                }
            };
            if available.is_empty() {
                self.done = true;
                if self.line.is_empty() {
                    return None;
                }
                return Some(Ok(std::mem::take(&mut self.line)));
            }
            match available.iter().position(|&b| b == b'\n') {
                Some(idx) => {
                    // Same line-level cap as `next_data`: chunk boundaries must not
                    // decide whether an over-long line is rejected.
                    if self.line.len() + idx > MAX_SSE_LINE_BYTES {
                        self.done = true;
                        return Some(Err(SseError::LineTooLong));
                    }
                    self.line.extend_from_slice(&available[..=idx]);
                    self.reader.consume(idx + 1);
                    return Some(Ok(std::mem::take(&mut self.line)));
                }
                None => {
                    if self.line.len() + available.len() > MAX_SSE_LINE_BYTES {
                        self.done = true;
                        return Some(Err(SseError::LineTooLong));
                    }
                    self.line.extend_from_slice(available);
                    let n = available.len();
                    self.reader.consume(n);
                }
            }
        }
    }
}

/// Extracts the payload of a `data:` line, or `None` for any other line.
fn sse_data(line: &[u8]) -> Option<Vec<u8>> {
    let trimmed = trim_ascii(line);
    let rest = trimmed.strip_prefix(b"data:")?;
    let payload = trim_ascii(rest);
    if payload.is_empty() {
        return None;
    }
    Some(payload.to_vec())
}

fn trim_ascii(b: &[u8]) -> &[u8] {
    let start = b.iter().position(|c| !c.is_ascii_whitespace()).unwrap_or(0);
    let end = b
        .iter()
        .rposition(|c| !c.is_ascii_whitespace())
        .map(|i| i + 1)
        .unwrap_or(start);
    &b[start..end]
}

/// Writes an Anthropic-format SSE stream to the client.
///
/// Each event is sent as its own body chunk, which is what makes it reach the user
/// as it is produced -- the equivalent of Go's explicit `Flush()` per event.
pub struct EventSink {
    tx: tokio::sync::mpsc::Sender<Bytes>,
    wrote: bool,
}

impl EventSink {
    /// Builds a sink plus the response that drains it.
    ///
    /// The channel is small on purpose: if the client reads slowly, the sender
    /// blocks, which propagates backpressure up to the upstream read instead of
    /// buffering an entire generation in memory.
    pub fn new_response(keepalive_seconds: i64) -> (Self, Response) {
        let (tx, rx) = tokio::sync::mpsc::channel::<Bytes>(8);
        let response = sse_response(rx, keepalive_seconds);
        (Self { tx, wrote: false }, response)
    }

    /// Whether anything has been sent to the client yet.
    pub fn wrote(&self) -> bool {
        self.wrote
    }

    /// Writes one named SSE event whose data is `payload` as JSON.
    pub async fn event(&mut self, name: &str, payload: &Value) -> Result<(), SseError> {
        let body = serde_json::to_vec(payload).unwrap_or_else(|_| b"{}".to_vec());
        let mut buf = Vec::with_capacity(body.len() + name.len() + 16);
        buf.extend_from_slice(b"event: ");
        buf.extend_from_slice(name.as_bytes());
        buf.extend_from_slice(b"\ndata: ");
        buf.extend_from_slice(&body);
        buf.extend_from_slice(b"\n\n");
        self.raw(Bytes::from(buf)).await
    }

    /// Writes bytes verbatim, for the passthrough relay.
    pub async fn raw(&mut self, bytes: Bytes) -> Result<(), SseError> {
        match self.tx.send(bytes).await {
            Ok(()) => {
                self.wrote = true;
                Ok(())
            }
            // The receiver is gone: the client hung up.
            Err(_) => Err(SseError::Disconnected),
        }
    }
}

/// Builds the streaming response around a channel of already-framed SSE chunks.
///
/// Headers match Go's `sseWriter.begin()` exactly.
fn sse_response(rx: tokio::sync::mpsc::Receiver<Bytes>, keepalive_seconds: i64) -> Response {
    let stream = tokio_stream::wrappers::ReceiverStream::new(rx);
    let body = if keepalive_seconds > 0 {
        // Additive (I4): the Go gateway sends no keepalive at all, so this is off
        // unless RAYU_SSE_KEEPALIVE_SECONDS is set. A comment line is invisible to
        // an SSE parser but keeps an idle connection from being reaped by an
        // intermediary during a long thinking block.
        let interval = std::time::Duration::from_secs(keepalive_seconds as u64);
        Body::from_stream(KeepAlive::new(stream, interval))
    } else {
        Body::from_stream(stream.map(Ok::<Bytes, std::io::Error>))
    };

    Response::builder()
        .status(StatusCode::OK)
        .header(http::header::CONTENT_TYPE, "text/event-stream")
        .header(http::header::CACHE_CONTROL, "no-cache")
        .header(http::header::CONNECTION, "keep-alive")
        .body(body)
        .expect("static response builder cannot fail")
}

use futures::StreamExt as _;

/// Interleaves SSE comment lines into an idle stream. Only used when keepalive is
/// explicitly enabled.
struct KeepAlive<S> {
    inner: S,
    interval: tokio::time::Interval,
    done: bool,
}

impl<S> KeepAlive<S> {
    fn new(inner: S, period: std::time::Duration) -> Self {
        let mut interval = tokio::time::interval(period);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        Self {
            inner,
            interval,
            done: false,
        }
    }
}

impl<S> futures::Stream for KeepAlive<S>
where
    S: futures::Stream<Item = Bytes> + Unpin,
{
    type Item = Result<Bytes, std::io::Error>;

    fn poll_next(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Self::Item>> {
        use std::task::Poll;
        if self.done {
            return Poll::Ready(None);
        }
        match self.inner.poll_next_unpin(cx) {
            Poll::Ready(Some(b)) => {
                // Any real event resets the idle timer.
                self.interval.reset();
                Poll::Ready(Some(Ok(b)))
            }
            Poll::Ready(None) => {
                self.done = true;
                Poll::Ready(None)
            }
            Poll::Pending => match self.interval.poll_tick(cx) {
                Poll::Ready(_) => Poll::Ready(Some(Ok(Bytes::from_static(b": ping\n\n")))),
                Poll::Pending => Poll::Pending,
            },
        }
    }
}

/// The outcome of starting an upstream stream.
///
/// Replaces Go's `(usage, wrote, err)` triple. The three states are distinct
/// types, so a caller cannot write an error response over a stream that already
/// started, and cannot double-write an error the adapter already produced.
pub enum StreamStart {
    /// The upstream answered with an error STATUS. The adapter has already chosen
    /// the relay body (real status for a client-fixable 4xx, sanitized 502
    /// otherwise), so the caller sends `response` as-is. Go's `wrote == true`.
    Failed {
        response: Response,
        /// For the gateway's own log line; never sent to the client.
        error: String,
        /// Usage, when the upstream reported any before failing.
        usage: Option<Usage>,
    },
    /// The upstream was never reached (transport failure or an open breaker).
    /// The CALLER picks the response, because only it knows the route's policy:
    /// 503 + `Retry-After: 5` for a circuit-open, 502 otherwise. Go's
    /// `wrote == false`.
    Unreachable(UpstreamError),
    /// The response streams. Usage is delivered to the settle callback by the pump
    /// task when the stream ends -- including when the client disconnects, which is
    /// what makes billing survive a hang-up.
    Streaming(Response),
}

/// Called exactly once when a stream finishes, with whatever usage was observed.
///
/// The pump task owns this, so it runs even if the client disconnected mid-stream
/// -- which is what makes billing survive a hang-up.
pub type OnStreamDone = Box<dyn FnOnce(Option<Usage>, Option<String>) + Send>;

/// Mints an Anthropic-looking message id.
///
/// Clients treat it as opaque; the `rayu` marker makes it obvious in logs that the
/// message was assembled by the translation layer rather than passed through.
pub fn new_message_id() -> String {
    let mut b = [0u8; 12];
    rand::Rng::fill(&mut rand::thread_rng(), &mut b[..]);
    format!("msg_rayu_{}", hex::encode(b))
}

/// Renders normalized usage in Anthropic's field names.
pub fn anthropic_usage_payload(u: Option<&Usage>) -> Value {
    match u {
        None => json!({"input_tokens": 0, "output_tokens": 0}),
        Some(u) => json!({
            "input_tokens": u.fresh_input_tokens(),
            "output_tokens": u.completion_tokens,
            "cache_read_input_tokens": u.cache_read_tokens(),
            "cache_creation_input_tokens": 0,
        }),
    }
}

/// Assembles a non-streaming Anthropic Messages response from translated content
/// blocks.
pub fn anthropic_message_json(
    model: &str,
    stop_reason: &str,
    blocks: Vec<Value>,
    u: Option<&Usage>,
) -> Vec<u8> {
    let stop = if stop_reason.is_empty() {
        "end_turn"
    } else {
        stop_reason
    };
    let body = json!({
        "id": new_message_id(),
        "type": "message",
        "role": "assistant",
        "model": model,
        "content": blocks,
        "stop_reason": stop,
        "stop_sequence": Value::Null,
        "usage": anthropic_usage_payload(u),
    });
    serde_json::to_vec(&body).unwrap_or_else(|_| b"{}".to_vec())
}

/// Emits one Anthropic event as SSE.
///
/// The `event:` name is required: the Anthropic SDK dispatches on it, and a stream
/// of bare `data:` lines would parse as nothing.
pub fn format_sse_event(event_json: &[u8]) -> Bytes {
    #[derive(serde::Deserialize, Default)]
    struct Head {
        #[serde(default, rename = "type")]
        ty: String,
    }
    let head: Head = serde_json::from_slice(event_json).unwrap_or_default();
    let name = if head.ty.is_empty() {
        // Never seen in practice; keeps the stream valid.
        "message_delta"
    } else {
        &head.ty
    };
    let mut buf = Vec::with_capacity(event_json.len() + name.len() + 16);
    buf.extend_from_slice(b"event: ");
    buf.extend_from_slice(name.as_bytes());
    buf.extend_from_slice(b"\ndata: ");
    buf.extend_from_slice(event_json);
    buf.extend_from_slice(b"\n\n");
    Bytes::from(buf)
}

/// Turns a provider's incremental output into the Anthropic Messages event
/// sequence:
///
/// ```text
/// message_start → (content_block_start → content_block_delta* →
/// content_block_stop)* → message_delta → message_stop
/// ```
///
/// It owns block indices and open/close bookkeeping so each adapter only has to
/// say "here is more text" / "a tool call started" / "we're done". Every method
/// writes through immediately -- nothing is held back for the end of the stream.
///
/// # Usage note
///
/// Providers on the OpenAI/GenAI side report token usage only at the END of a
/// stream, whereas Anthropic reports input usage in `message_start`. So
/// `message_start` carries zeros and the FULL usage is sent on `message_delta`.
/// Billing is unaffected -- the gateway meters from the usage the adapter returns,
/// not from its own output stream.
pub struct AnthropicEmitter {
    sink: EventSink,
    model: String,
    msg_id: String,
    started: bool,
    block_open: bool,
    block_kind: String,
    block_index: i64,
    stopped: bool,
}

impl AnthropicEmitter {
    pub fn new(sink: EventSink, model: &str) -> Self {
        Self {
            sink,
            model: model.to_string(),
            msg_id: new_message_id(),
            started: false,
            block_open: false,
            block_kind: String::new(),
            block_index: 0,
            stopped: false,
        }
    }

    /// The synthesised message id, which the GenAI adapter derives tool ids from.
    pub fn message_id(&self) -> &str {
        &self.msg_id
    }

    /// Whether anything has been sent to the client yet.
    pub fn wrote(&self) -> bool {
        self.sink.wrote()
    }

    async fn start(&mut self) -> Result<(), SseError> {
        if self.started {
            return Ok(());
        }
        self.started = true;
        let payload = json!({
            "type": "message_start",
            "message": {
                "id": self.msg_id,
                "type": "message",
                "role": "assistant",
                "model": self.model,
                "content": [],
                "stop_reason": Value::Null,
                "stop_sequence": Value::Null,
                // Real counts arrive on message_delta (see the type comment).
                "usage": {"input_tokens": 0, "output_tokens": 0},
            },
        });
        self.sink.event("message_start", &payload).await
    }

    /// Closes any block of a different kind and opens one of kind `k`.
    async fn open_block(&mut self, k: &str, block: Value) -> Result<(), SseError> {
        self.start().await?;
        if self.block_open && self.block_kind == k && k != BLOCK_TOOL_USE {
            // Text and thinking blocks are appended to; every tool_use is its own
            // block, so two in a row correctly produce two parallel tool calls.
            return Ok(());
        }
        self.close_block().await?;
        self.block_open = true;
        self.block_kind = k.to_string();
        let payload = json!({
            "type": "content_block_start",
            "index": self.block_index,
            "content_block": block,
        });
        self.sink.event("content_block_start", &payload).await
    }

    async fn close_block(&mut self) -> Result<(), SseError> {
        if !self.block_open {
            return Ok(());
        }
        self.block_open = false;
        let idx = self.block_index;
        self.block_index += 1;
        let payload = json!({"type": "content_block_stop", "index": idx});
        self.sink.event("content_block_stop", &payload).await
    }

    /// Appends assistant text.
    pub async fn text(&mut self, delta: &str) -> Result<(), SseError> {
        if delta.is_empty() {
            return Ok(());
        }
        self.open_block(BLOCK_TEXT, json!({"type": "text", "text": ""}))
            .await?;
        let payload = json!({
            "type": "content_block_delta",
            "index": self.block_index,
            "delta": {"type": "text_delta", "text": delta},
        });
        self.sink.event("content_block_delta", &payload).await
    }

    /// Appends reasoning text as an Anthropic thinking block, which is how the CLI
    /// renders a model's chain of thought.
    pub async fn thinking(&mut self, delta: &str) -> Result<(), SseError> {
        if delta.is_empty() {
            return Ok(());
        }
        self.open_block(
            BLOCK_THINKING,
            json!({"type": "thinking", "thinking": "", "signature": ""}),
        )
        .await?;
        let payload = json!({
            "type": "content_block_delta",
            "index": self.block_index,
            "delta": {"type": "thinking_delta", "thinking": delta},
        });
        self.sink.event("content_block_delta", &payload).await
    }

    /// Opens a `tool_use` block.
    pub async fn tool_start(&mut self, id: &str, name: &str) -> Result<(), SseError> {
        let id = if id.is_empty() {
            format!("toolu_{}", new_message_id())
        } else {
            id.to_string()
        };
        self.open_block(
            BLOCK_TOOL_USE,
            json!({"type": "tool_use", "id": id, "name": name, "input": {}}),
        )
        .await
    }

    /// Appends a fragment of the current tool call's JSON arguments.
    pub async fn tool_args(&mut self, fragment: &str) -> Result<(), SseError> {
        if fragment.is_empty() || !self.block_open || self.block_kind != BLOCK_TOOL_USE {
            return Ok(());
        }
        let payload = json!({
            "type": "content_block_delta",
            "index": self.block_index,
            "delta": {"type": "input_json_delta", "partial_json": fragment},
        });
        self.sink.event("content_block_delta", &payload).await
    }

    /// Attaches a provider-specific opaque signature to the OPEN `tool_use` block.
    ///
    /// Gemini 3 requires its `thoughtSignature` to be echoed back on later turns;
    /// relaying it to the client lets the next turn carry it even if this gateway
    /// instance no longer remembers it. Clients that don't understand the delta
    /// simply ignore it.
    pub async fn tool_signature(&mut self, sig: &str) -> Result<(), SseError> {
        if sig.is_empty() || !self.block_open || self.block_kind != BLOCK_TOOL_USE {
            return Ok(());
        }
        let payload = json!({
            "type": "content_block_delta",
            "index": self.block_index,
            "delta": {"type": "signature_delta", "signature": sig},
        });
        self.sink.event("content_block_delta", &payload).await
    }

    /// Reports a mid-stream provider failure in Anthropic's streaming error shape,
    /// so a client that has already started receiving events learns the turn failed
    /// instead of seeing a silently truncated message.
    pub async fn error(&mut self, message: &str) -> Result<(), SseError> {
        let payload = json!({
            "type": "error",
            "error": {"type": "api_error", "message": message},
        });
        self.sink.event("error", &payload).await
    }

    /// Closes the stream: any open block, then `message_delta` (stop reason plus
    /// the authoritative usage) and `message_stop`.
    pub async fn finish(&mut self, stop_reason: &str, u: Option<&Usage>) -> Result<(), SseError> {
        if self.stopped {
            return Ok(());
        }
        self.stopped = true;
        self.start().await?;
        self.close_block().await?;
        let stop = if stop_reason.is_empty() {
            "end_turn"
        } else {
            stop_reason
        };
        let delta = json!({
            "type": "message_delta",
            "delta": {"stop_reason": stop, "stop_sequence": Value::Null},
            "usage": anthropic_usage_payload(u),
        });
        self.sink.event("message_delta", &delta).await?;
        self.sink
            .event("message_stop", &json!({"type": "message_stop"}))
            .await
    }
}

/// A shared handle to the upstream client, passed to every adapter.
pub type SharedUpstream = Arc<crate::upstream::Upstream>;

#[cfg(test)]
mod tests {
    use super::*;
    use http_body_util::BodyExt;

    /// Drives a scanner over a fixed byte string.
    async fn scan(input: &'static str) -> Vec<String> {
        let mut s = SseScanner::new(input.as_bytes());
        let mut out = Vec::new();
        while let Some(item) = s.next_data().await {
            out.push(String::from_utf8(item.expect("no error")).unwrap());
        }
        out
    }

    #[tokio::test]
    async fn scanner_yields_data_payloads_and_skips_the_rest() {
        let got = scan(
            "event: message_start\n\
             data: {\"a\":1}\n\
             \n\
             : a comment\n\
             data: {\"b\":2}\n\
             event: done\n\
             data: {\"c\":3}\n",
        )
        .await;
        assert_eq!(got, vec![r#"{"a":1}"#, r#"{"b":2}"#, r#"{"c":3}"#]);
    }

    #[tokio::test]
    async fn scanner_stops_at_the_done_sentinel() {
        let got = scan("data: {\"a\":1}\ndata: [DONE]\ndata: {\"never\":true}\n").await;
        assert_eq!(got, vec![r#"{"a":1}"#], "[DONE] must end the scan");
    }

    #[tokio::test]
    async fn scanner_handles_a_trailing_line_without_a_newline() {
        let got = scan("data: {\"a\":1}\ndata: {\"last\":true}").await;
        assert_eq!(got, vec![r#"{"a":1}"#, r#"{"last":true}"#]);
    }

    #[tokio::test]
    async fn scanner_tolerates_crlf_and_extra_spacing() {
        let got = scan("data:  {\"a\":1}  \r\ndata:{\"b\":2}\r\n").await;
        assert_eq!(got, vec![r#"{"a":1}"#, r#"{"b":2}"#]);
    }

    /// A payload split across read boundaries must reassemble -- upstream chunks
    /// never align with SSE lines.
    #[tokio::test]
    async fn scanner_reassembles_a_payload_split_across_chunks() {
        use tokio::io::duplex;
        use tokio::io::AsyncWriteExt;

        let (client, mut server) = duplex(16);
        let writer = tokio::spawn(async move {
            server.write_all(b"data: {\"hel").await.unwrap();
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            server.write_all(b"lo\":\"world\"}\n").await.unwrap();
            server.shutdown().await.unwrap();
        });

        let mut s = SseScanner::new(client);
        let first = s.next_data().await.expect("one payload").expect("no error");
        assert_eq!(String::from_utf8(first).unwrap(), r#"{"hello":"world"}"#);
        writer.await.unwrap();
    }

    /// A provider that never emits a newline must not be able to exhaust memory.
    #[tokio::test]
    async fn scanner_rejects_a_line_over_the_cap() {
        let huge = "data: ".to_string() + &"x".repeat(MAX_SSE_LINE_BYTES + 10);
        let mut s = SseScanner::new(std::io::Cursor::new(huge.into_bytes()));
        let err = s
            .next_data()
            .await
            .expect("an item")
            .expect_err("must fail");
        assert!(matches!(err, SseError::LineTooLong), "{err}");
        assert_eq!(err.to_string(), "upstream SSE line exceeds 1048576 bytes");
        // The scanner is finished; it must not loop forever.
        assert!(s.next_data().await.is_none());
    }

    /// The cap must depend on the LINE length, not on how the upstream chunked it.
    ///
    /// Regression: the check originally lived only in the "chunk contained no
    /// newline" branch, so an over-long line whose FINAL chunk carried the
    /// terminator was accepted -- while Go's `bufio.Scanner`, which caps the token
    /// itself, always rejects it.
    #[tokio::test]
    async fn the_cap_is_on_the_line_not_the_chunk() {
        // A terminated over-long line: the newline arrives in the same read.
        let huge = "data: ".to_string() + &"x".repeat(MAX_SSE_LINE_BYTES + 10) + "\n\n";
        let mut s = SseScanner::new(std::io::Cursor::new(huge.clone().into_bytes()));
        let err = s
            .next_data()
            .await
            .expect("an item")
            .expect_err("a terminated over-long line must still be rejected");
        assert!(matches!(err, SseError::LineTooLong), "{err}");

        // next_line (the verbatim passthrough path) must agree.
        let mut s = SseScanner::new(std::io::Cursor::new(huge.into_bytes()));
        let err = s
            .next_line()
            .await
            .expect("an item")
            .expect_err("must fail");
        assert!(matches!(err, SseError::LineTooLong), "{err}");

        // A line of exactly the cap is still accepted, so the boundary is inclusive.
        let exact = "data: ".to_string() + &"y".repeat(MAX_SSE_LINE_BYTES - 6) + "\n\n";
        let mut s = SseScanner::new(std::io::Cursor::new(exact.into_bytes()));
        let payload = s
            .next_data()
            .await
            .expect("an item")
            .expect("a line at exactly the cap is legal");
        assert_eq!(payload.len(), MAX_SSE_LINE_BYTES - 6);
    }

    #[tokio::test]
    async fn next_line_relays_bytes_verbatim_including_terminators() {
        let mut s = SseScanner::new("event: x\ndata: {\"a\":1}\n\n".as_bytes());
        let mut lines = Vec::new();
        while let Some(l) = s.next_line().await {
            lines.push(String::from_utf8(l.unwrap()).unwrap());
        }
        assert_eq!(lines, vec!["event: x\n", "data: {\"a\":1}\n", "\n"]);
    }

    /// Collects the whole SSE body a sink produced.
    async fn drain(response: Response) -> String {
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        String::from_utf8(bytes.to_vec()).unwrap()
    }

    #[tokio::test]
    async fn response_headers_match_go() {
        let (sink, response) = EventSink::new_response(0);
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers().get(http::header::CONTENT_TYPE).unwrap(),
            "text/event-stream"
        );
        assert_eq!(
            response.headers().get(http::header::CACHE_CONTROL).unwrap(),
            "no-cache"
        );
        assert_eq!(
            response.headers().get(http::header::CONNECTION).unwrap(),
            "keep-alive"
        );
        drop(sink);
        assert_eq!(drain(response).await, "", "no events, no body");
    }

    /// The full happy-path event sequence, asserted as bytes.
    #[tokio::test]
    async fn emitter_writes_the_anthropic_event_sequence() {
        let (sink, response) = EventSink::new_response(0);
        let pump = tokio::spawn(async move {
            let mut em = AnthropicEmitter::new(sink, "deepseek-chat");
            em.text("Hello").await.unwrap();
            em.text(" world").await.unwrap();
            em.finish("end_turn", None).await.unwrap();
        });
        let body = drain(response).await;
        pump.await.unwrap();

        // Event names and their order are the contract the Anthropic SDK parses.
        let names: Vec<&str> = body
            .lines()
            .filter_map(|l| l.strip_prefix("event: "))
            .collect();
        assert_eq!(
            names,
            vec![
                "message_start",
                "content_block_start",
                "content_block_delta",
                "content_block_delta",
                "content_block_stop",
                "message_delta",
                "message_stop",
            ],
            "body was:\n{body}"
        );
        // Two text deltas append to ONE block, so there is a single block_start.
        assert_eq!(body.matches("content_block_start").count(), 2); // event: + type:
        assert!(body.contains(r#""text":"Hello""#));
        assert!(body.contains(r#""text":" world""#));
        assert!(body.contains(r#""stop_reason":"end_turn""#));
        // message_start must carry zeroed usage.
        assert!(body.contains(r#""usage":{"input_tokens":0,"output_tokens":0}"#));
        // Every event is separated by a blank line.
        assert!(body.ends_with("\n\n"));
    }

    /// Switching kinds closes the previous block and advances the index; two tool
    /// calls in a row must NOT be merged.
    #[tokio::test]
    async fn emitter_block_indices_and_kind_switching() {
        let (sink, response) = EventSink::new_response(0);
        let pump = tokio::spawn(async move {
            let mut em = AnthropicEmitter::new(sink, "m");
            em.thinking("pondering").await.unwrap();
            em.text("answer").await.unwrap();
            em.tool_start("call_1", "bash").await.unwrap();
            em.tool_args(r#"{"cmd":"ls"}"#).await.unwrap();
            em.tool_start("call_2", "read").await.unwrap();
            em.tool_args(r#"{"p":"a"}"#).await.unwrap();
            em.finish("tool_use", None).await.unwrap();
        });
        let body = drain(response).await;
        pump.await.unwrap();

        // thinking(0) -> text(1) -> tool_use(2) -> tool_use(3), then stop(3).
        let starts: Vec<&str> = body
            .lines()
            .filter(|l| l.contains(r#""type":"content_block_start""#))
            .collect();
        assert_eq!(starts.len(), 4, "two tool calls must be separate blocks");
        assert!(starts[0].contains(r#""index":0"#) && starts[0].contains(r#""thinking""#));
        assert!(starts[1].contains(r#""index":1"#) && starts[1].contains(r#""text""#));
        assert!(starts[2].contains(r#""index":2"#) && starts[2].contains("call_1"));
        assert!(starts[3].contains(r#""index":3"#) && starts[3].contains("call_2"));
        assert!(body.contains(r#""stop_reason":"tool_use""#));
    }

    /// Arguments arriving with no open tool block must be dropped, not attributed to
    /// a text block.
    #[tokio::test]
    async fn tool_args_without_an_open_tool_block_are_ignored() {
        let (sink, response) = EventSink::new_response(0);
        let pump = tokio::spawn(async move {
            let mut em = AnthropicEmitter::new(sink, "m");
            em.text("hi").await.unwrap();
            em.tool_args("{}").await.unwrap(); // no tool block open
            em.tool_signature("sig").await.unwrap(); // likewise
            em.finish("", None).await.unwrap();
        });
        let body = drain(response).await;
        pump.await.unwrap();
        assert!(!body.contains("input_json_delta"));
        assert!(!body.contains("signature_delta"));
        // An empty stop reason defaults to end_turn.
        assert!(body.contains(r#""stop_reason":"end_turn""#));
    }

    #[tokio::test]
    async fn emitter_emits_signature_delta_on_an_open_tool_block() {
        let (sink, response) = EventSink::new_response(0);
        let pump = tokio::spawn(async move {
            let mut em = AnthropicEmitter::new(sink, "m");
            em.tool_start("call_1", "bash").await.unwrap();
            em.tool_signature("opaque-sig").await.unwrap();
            em.finish("tool_use", None).await.unwrap();
        });
        let body = drain(response).await;
        pump.await.unwrap();
        assert!(body.contains(r#""type":"signature_delta""#));
        assert!(body.contains(r#""signature":"opaque-sig""#));
    }

    #[tokio::test]
    async fn finish_reports_the_authoritative_usage() {
        let (sink, response) = EventSink::new_response(0);
        let usage = Usage {
            prompt_tokens: 2000,
            completion_tokens: 300,
            total_tokens: 2300,
            prompt_cache_hit_tokens: 1500,
            prompt_cache_miss_tokens: 500,
            ..Default::default()
        };
        let pump = tokio::spawn(async move {
            let mut em = AnthropicEmitter::new(sink, "m");
            em.text("x").await.unwrap();
            em.finish("end_turn", Some(&usage)).await.unwrap();
        });
        let body = drain(response).await;
        pump.await.unwrap();
        // input_tokens is the FRESH count, with cache reads reported separately.
        assert!(body.contains(r#""input_tokens":500"#), "{body}");
        assert!(body.contains(r#""cache_read_input_tokens":1500"#));
        assert!(body.contains(r#""output_tokens":300"#));
        assert!(body.contains(r#""cache_creation_input_tokens":0"#));
    }

    #[tokio::test]
    async fn finish_is_idempotent() {
        let (sink, response) = EventSink::new_response(0);
        let pump = tokio::spawn(async move {
            let mut em = AnthropicEmitter::new(sink, "m");
            em.finish("end_turn", None).await.unwrap();
            em.finish("end_turn", None).await.unwrap(); // must be a no-op
        });
        let body = drain(response).await;
        pump.await.unwrap();
        assert_eq!(body.matches("event: message_stop").count(), 1);
    }

    #[tokio::test]
    async fn error_event_shape() {
        let (sink, response) = EventSink::new_response(0);
        let pump = tokio::spawn(async move {
            let mut em = AnthropicEmitter::new(sink, "m");
            em.text("partial").await.unwrap();
            em.error("The model provider ended the response unexpectedly.")
                .await
                .unwrap();
            em.finish("", None).await.unwrap();
        });
        let body = drain(response).await;
        pump.await.unwrap();
        assert!(body.contains("event: error"));
        assert!(body.contains(r#""type":"api_error""#));
        assert!(body.contains("ended the response unexpectedly"));
    }

    /// A disconnected client must surface as an error the adapter can stop on,
    /// rather than blocking forever or panicking.
    #[tokio::test]
    async fn writing_to_a_disconnected_client_reports_it() {
        let (mut sink, response) = EventSink::new_response(0);
        drop(response); // the client hung up
        let err = sink
            .event("message_start", &json!({}))
            .await
            .expect_err("must report the disconnect");
        assert!(matches!(err, SseError::Disconnected), "{err}");
    }

    #[test]
    fn message_ids_are_unique_and_prefixed() {
        let a = new_message_id();
        let b = new_message_id();
        assert_ne!(a, b);
        assert!(a.starts_with("msg_rayu_"));
        assert_eq!(a.len(), "msg_rayu_".len() + 24, "12 bytes as hex");
    }

    #[test]
    fn usage_payload_without_usage_is_zeroed() {
        let p = anthropic_usage_payload(None);
        assert_eq!(p["input_tokens"], 0);
        assert_eq!(p["output_tokens"], 0);
        assert!(
            p.get("cache_read_input_tokens").is_none(),
            "the zero form omits the cache fields, like Go"
        );
    }

    #[test]
    fn non_streaming_message_json_shape() {
        let blocks = vec![json!({"type": "text", "text": "hi"})];
        let raw = anthropic_message_json("deepseek-chat", "", blocks, None);
        let v: Value = serde_json::from_slice(&raw).unwrap();
        assert_eq!(v["type"], "message");
        assert_eq!(v["role"], "assistant");
        assert_eq!(v["model"], "deepseek-chat");
        assert_eq!(v["content"][0]["text"], "hi");
        assert_eq!(v["stop_reason"], "end_turn", "empty defaults to end_turn");
        assert!(v["stop_sequence"].is_null());
        assert!(v["id"].as_str().unwrap().starts_with("msg_rayu_"));
    }

    #[test]
    fn format_sse_event_uses_the_payload_type_as_the_event_name() {
        let framed = format_sse_event(br#"{"type":"content_block_delta","index":0}"#);
        let text = String::from_utf8(framed.to_vec()).unwrap();
        assert!(text.starts_with("event: content_block_delta\ndata: {"));
        assert!(text.ends_with("\n\n"));
        // A payload with no type still produces a parseable event.
        let fallback = format_sse_event(br#"{"foo":1}"#);
        assert!(String::from_utf8(fallback.to_vec())
            .unwrap()
            .starts_with("event: message_delta\n"));
    }

    #[test]
    fn upstream_request_applies_the_provider_auth_scheme() {
        let client = reqwest::Client::new();
        for (scheme, header, want) in [
            (providercfg::AUTH_BEARER, "authorization", "Bearer sk-1"),
            (providercfg::AUTH_X_API_KEY, "x-api-key", "sk-1"),
            (providercfg::AUTH_X_GOOG_API_KEY, "x-goog-api-key", "sk-1"),
            // An unknown scheme falls back to x-api-key, like Go's default branch.
            ("something-new", "x-api-key", "sk-1"),
        ] {
            let route = Route {
                auth_scheme: scheme.into(),
                ..Default::default()
            };
            let req = new_upstream_req(
                &client,
                "https://api.example.com/v1/messages",
                "sk-1",
                &route,
                b"{}".to_vec(),
            )
            .expect("build");
            assert_eq!(
                req.headers().get(header).unwrap().to_str().unwrap(),
                want,
                "scheme={scheme}"
            );
            assert_eq!(
                req.headers()
                    .get(http::header::CONTENT_TYPE)
                    .unwrap()
                    .to_str()
                    .unwrap(),
                "application/json"
            );
            assert_eq!(req.method(), http::Method::POST);
        }
    }

    /// Keepalive is OFF by default so the byte stream matches Go's exactly.
    #[tokio::test]
    async fn keepalive_is_off_by_default() {
        let (sink, response) = EventSink::new_response(0);
        let pump = tokio::spawn(async move {
            let mut em = AnthropicEmitter::new(sink, "m");
            // A pause long enough that any enabled keepalive would fire.
            tokio::time::sleep(std::time::Duration::from_millis(60)).await;
            em.text("late").await.unwrap();
            em.finish("", None).await.unwrap();
        });
        let body = drain(response).await;
        pump.await.unwrap();
        assert!(
            !body.contains(": ping"),
            "no keepalive comment may appear by default: {body}"
        );
    }

    /// When explicitly enabled, an idle stream gets comment lines that an SSE parser
    /// ignores but an intermediary counts as traffic.
    #[tokio::test]
    async fn keepalive_emits_comments_when_enabled() {
        let (sink, response) = EventSink::new_response(1);
        let pump = tokio::spawn(async move {
            let mut em = AnthropicEmitter::new(sink, "m");
            em.text("first").await.unwrap();
            // Idle for longer than the 1s interval.
            tokio::time::sleep(std::time::Duration::from_millis(1200)).await;
            em.finish("", None).await.unwrap();
        });
        let body = drain(response).await;
        pump.await.unwrap();
        assert!(body.contains(": ping"), "expected a keepalive: {body}");
        // The real events still arrive intact.
        assert!(body.contains(r#""text":"first""#));
        assert!(body.contains("event: message_stop"));
    }
}
