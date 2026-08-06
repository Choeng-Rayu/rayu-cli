//! AWS event-stream decoding, for Bedrock's `invoke-with-response-stream`.
//!
//! Port of the Go gateway's `internal/translate/eventstream.go`.
//!
//! # Why this exists
//!
//! Bedrock returns a streaming Anthropic response, but NOT as SSE: it wraps each
//! event in an `application/vnd.amazon.eventstream` frame. The CLI only speaks
//! Anthropic SSE, so the frames have to be unwrapped and re-emitted. There is no
//! way around it -- this is the only streaming shape Bedrock offers.
//!
//! # Frame layout (all integers big-endian)
//!
//! ```text
//!  0..3   total length (including this prelude and the trailing CRC)
//!  4..7   headers length
//!  8..11  prelude CRC32
//! 12..    headers, then payload, then a 4-byte message CRC32
//! ```
//!
//! Each header is: name length (1 byte), name, value type (1 byte), value. Only the
//! string and byte-array types carry a value this decoder reads; the rest are
//! skipped by length, because the headers it cares about (`:event-type`,
//! `:exception-type`) are strings.
//!
//! The payload of a Bedrock chunk is `{"bytes":"<base64>"}`, and the decoded bytes
//! are one standard Anthropic streaming event (`message_start`,
//! `content_block_delta`, ...). CRCs are NOT verified: this is a TLS connection to
//! a known host, so a corrupt frame is not a threat model, and a mismatched CRC
//! would leave nothing better to do than fail the stream -- which malformed JSON
//! already does.

use base64::Engine as _;
use tokio::io::{AsyncRead, AsyncReadExt};

pub const EVENT_STREAM_PRELUDE_LEN: usize = 12;
pub const EVENT_STREAM_CRC_LEN: usize = 4;

/// Caps a single frame so a malformed length cannot make the gateway allocate
/// unbounded memory on an upstream's say-so.
pub const MAX_FRAME_LEN: u32 = 16 << 20; // 16 MiB

/// The AWS event-stream header value type for a string.
pub const HEADER_TYPE_STRING: u8 = 7;

/// One decoded frame.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct EventStreamFrame {
    /// The `:event-type` header (`"chunk"` for payload events).
    pub event_type: String,
    /// Names the failure when the upstream reports one mid-stream (throttling,
    /// model timeout, ...).
    ///
    /// Bedrock signals these as a frame with `:message-type: exception`, NOT as an
    /// HTTP status, so a reader that only looked at event types would treat an
    /// error as a clean end of stream.
    pub exception_type: String,
    /// The raw frame payload (for a chunk: `{"bytes": "..."}`).
    pub payload: Vec<u8>,
}

#[derive(Debug, thiserror::Error)]
pub enum EventStreamError {
    /// The connection ended mid-frame -- normal when a client disconnects, a
    /// genuine upstream failure otherwise.
    #[error("event stream ended mid-frame")]
    Truncated,
    #[error("event stream frame length {0} out of range")]
    FrameLength(u32),
    #[error("event stream headers length {0} exceeds frame")]
    HeadersLength(u32),
    #[error("{0}")]
    Io(String),
    #[error("bedrock chunk is not JSON: {0}")]
    ChunkNotJson(String),
    #[error("bedrock chunk carried no bytes")]
    EmptyChunk,
}

/// Reads AWS event-stream frames from an async byte source.
pub struct EventStreamReader<R> {
    reader: R,
    done: bool,
}

impl<R: AsyncRead + Unpin> EventStreamReader<R> {
    pub fn new(reader: R) -> Self {
        Self {
            reader,
            done: false,
        }
    }

    /// Reads exactly one frame.
    ///
    /// `None` means a clean end of stream (Go's `io.EOF`); `Some(Err(..))` means the
    /// stream failed and must not be treated as a normal finish.
    pub async fn next_frame(&mut self) -> Option<Result<EventStreamFrame, EventStreamError>> {
        if self.done {
            return None;
        }
        let mut prelude = [0u8; EVENT_STREAM_PRELUDE_LEN];
        match self.fill(&mut prelude).await {
            // A clean end of stream: zero bytes at a frame boundary.
            Ok(0) => {
                self.done = true;
                return None;
            }
            Ok(n) if n < EVENT_STREAM_PRELUDE_LEN => {
                self.done = true;
                return Some(Err(EventStreamError::Truncated));
            }
            Err(e) => {
                self.done = true;
                return Some(Err(e));
            }
            Ok(_) => {}
        }

        let total = u32::from_be_bytes([prelude[0], prelude[1], prelude[2], prelude[3]]);
        let headers_len = u32::from_be_bytes([prelude[4], prelude[5], prelude[6], prelude[7]]);

        let min = (EVENT_STREAM_PRELUDE_LEN + EVENT_STREAM_CRC_LEN) as u32;
        if total < min || total > MAX_FRAME_LEN {
            self.done = true;
            return Some(Err(EventStreamError::FrameLength(total)));
        }
        let rest = total as usize - EVENT_STREAM_PRELUDE_LEN;
        if headers_len as usize > rest - EVENT_STREAM_CRC_LEN {
            self.done = true;
            return Some(Err(EventStreamError::HeadersLength(headers_len)));
        }

        let mut buf = vec![0u8; rest];
        match self.fill(&mut buf).await {
            Ok(n) if n == rest => {}
            _ => {
                self.done = true;
                return Some(Err(EventStreamError::Truncated));
            }
        }

        let headers_end = headers_len as usize;
        let mut frame = EventStreamFrame {
            payload: buf[headers_end..buf.len() - EVENT_STREAM_CRC_LEN].to_vec(),
            ..Default::default()
        };
        let mut message_type = String::new();
        for (name, value) in parse_event_stream_headers(&buf[..headers_end]) {
            match name.as_str() {
                ":event-type" => frame.event_type = value,
                ":message-type" => message_type = value,
                ":exception-type" | ":error-code" => frame.exception_type = value,
                _ => {}
            }
        }
        // An exception/error message is a failure even when the specific type header
        // is missing -- falling through as a normal frame would hide an upstream
        // outage.
        if frame.exception_type.is_empty()
            && (message_type == "exception" || message_type == "error")
        {
            frame.exception_type = message_type;
        }
        Some(Ok(frame))
    }

    /// Reads until `buf` is full, returning how many bytes were actually read.
    ///
    /// A short read is how a truncated frame is detected, so it must be reported
    /// rather than retried forever.
    async fn fill(&mut self, buf: &mut [u8]) -> Result<usize, EventStreamError> {
        let mut read = 0;
        while read < buf.len() {
            match self.reader.read(&mut buf[read..]).await {
                Ok(0) => return Ok(read),
                Ok(n) => read += n,
                Err(e) => return Err(EventStreamError::Io(e.to_string())),
            }
        }
        Ok(read)
    }
}

/// Reads the header block, skipping value types it does not need.
///
/// A malformed block yields the headers parsed so far rather than an error: the
/// payload is what matters, and headers are only used for routing.
fn parse_event_stream_headers(b: &[u8]) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < b.len() {
        let name_len = b[i] as usize;
        i += 1;
        if i + name_len > b.len() {
            return out;
        }
        let name = String::from_utf8_lossy(&b[i..i + name_len]).to_string();
        i += name_len;
        if i >= b.len() {
            return out;
        }
        let value_type = b[i];
        i += 1;
        match value_type {
            // 7 = string, 6 = byte array (both length-prefixed).
            HEADER_TYPE_STRING | 6 => {
                if i + 2 > b.len() {
                    return out;
                }
                let n = u16::from_be_bytes([b[i], b[i + 1]]) as usize;
                i += 2;
                if i + n > b.len() {
                    return out;
                }
                out.push((name, String::from_utf8_lossy(&b[i..i + n]).to_string()));
                i += n;
            }
            0 | 1 => {}      // true / false: no value bytes
            2 => i += 1,     // byte
            3 => i += 2,     // int16
            4 => i += 4,     // int32
            5 | 8 => i += 8, // int64 / timestamp
            9 => i += 16,    // uuid
            // Unknown type: its length cannot be known, so stop here.
            _ => return out,
        }
    }
    out
}

/// Extracts the Anthropic event JSON carried by a chunk frame.
///
/// Bedrock base64-encodes it in a `bytes` field.
pub fn bedrock_chunk_event(payload: &[u8]) -> Result<Vec<u8>, EventStreamError> {
    #[derive(serde::Deserialize, Default)]
    struct Wrapper {
        #[serde(default)]
        bytes: String,
    }
    let wrapper: Wrapper = serde_json::from_slice(payload)
        .map_err(|e| EventStreamError::ChunkNotJson(e.to_string()))?;
    if wrapper.bytes.is_empty() {
        return Err(EventStreamError::EmptyChunk);
    }
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(wrapper.bytes.as_bytes())
        .map_err(|e| EventStreamError::ChunkNotJson(e.to_string()))?;
    if decoded.is_empty() {
        return Err(EventStreamError::EmptyChunk);
    }
    Ok(decoded)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Builds one AWS event-stream frame the way Bedrock does.
    ///
    /// Headers are passed through verbatim so a test can build both a normal chunk
    /// and the exception shape (`:message-type: exception`).
    pub(crate) fn frame(headers: &[(&str, &str)], payload: &[u8]) -> Vec<u8> {
        let mut hdr = Vec::new();
        for (name, value) in headers {
            hdr.push(name.len() as u8);
            hdr.extend_from_slice(name.as_bytes());
            hdr.push(HEADER_TYPE_STRING);
            hdr.extend_from_slice(&(value.len() as u16).to_be_bytes());
            hdr.extend_from_slice(value.as_bytes());
        }
        let total =
            (EVENT_STREAM_PRELUDE_LEN + hdr.len() + payload.len() + EVENT_STREAM_CRC_LEN) as u32;
        let mut out = Vec::with_capacity(total as usize);
        out.extend_from_slice(&total.to_be_bytes());
        out.extend_from_slice(&(hdr.len() as u32).to_be_bytes());
        out.extend_from_slice(&0u32.to_be_bytes()); // prelude CRC (not verified)
        out.extend_from_slice(&hdr);
        out.extend_from_slice(payload);
        out.extend_from_slice(&0u32.to_be_bytes()); // message CRC (not verified)
        out
    }

    /// Wraps an Anthropic event the way Bedrock does: base64 inside `{"bytes":...}`.
    pub(crate) fn chunk(event: &str) -> Vec<u8> {
        let payload = serde_json::json!({
            "bytes": base64::engine::general_purpose::STANDARD.encode(event.as_bytes()),
            "p": "abc",
        });
        frame(
            &[
                (":event-type", "chunk"),
                (":content-type", "application/json"),
                (":message-type", "event"),
            ],
            serde_json::to_string(&payload).unwrap().as_bytes(),
        )
    }

    #[tokio::test]
    async fn a_complete_frame_decodes() {
        let raw = chunk(r#"{"type":"message_stop"}"#);
        let mut r = EventStreamReader::new(std::io::Cursor::new(raw));
        let f = r.next_frame().await.expect("a frame").expect("no error");
        assert_eq!(f.event_type, "chunk");
        assert!(f.exception_type.is_empty());
        let event = bedrock_chunk_event(&f.payload).expect("a chunk event");
        assert_eq!(
            String::from_utf8(event).unwrap(),
            r#"{"type":"message_stop"}"#
        );
        // Clean end of stream.
        assert!(r.next_frame().await.is_none());
    }

    /// A truncated frame must FAIL rather than be silently accepted as a short
    /// stream: otherwise a dropped connection looks like a finished answer.
    #[tokio::test]
    async fn a_truncated_frame_is_rejected() {
        let full = chunk(r#"{"type":"message_stop"}"#);
        let cut = &full[..full.len() - 6];
        let mut r = EventStreamReader::new(std::io::Cursor::new(cut.to_vec()));
        let err = r
            .next_frame()
            .await
            .expect("an item")
            .expect_err("must fail");
        assert!(matches!(err, EventStreamError::Truncated), "{err}");
        // The reader is finished and must not loop.
        assert!(r.next_frame().await.is_none());
    }

    /// A prelude that is itself cut short is also truncation, not a clean EOF.
    #[tokio::test]
    async fn a_partial_prelude_is_truncation() {
        let mut r = EventStreamReader::new(std::io::Cursor::new(vec![0u8, 0, 0]));
        let err = r
            .next_frame()
            .await
            .expect("an item")
            .expect_err("must fail");
        assert!(matches!(err, EventStreamError::Truncated), "{err}");
    }

    #[tokio::test]
    async fn an_exception_frame_is_recognised() {
        let raw = frame(
            &[
                (":message-type", "exception"),
                (":exception-type", "throttlingException"),
                (":content-type", "application/json"),
            ],
            br#"{"message":"slow down"}"#,
        );
        let mut r = EventStreamReader::new(std::io::Cursor::new(raw));
        let f = r.next_frame().await.unwrap().unwrap();
        assert_eq!(f.exception_type, "throttlingException");
        assert_eq!(f.payload, br#"{"message":"slow down"}"#);
    }

    /// An exception with NO `:exception-type` must still be a failure, or an
    /// upstream outage would look like a clean finish.
    #[tokio::test]
    async fn a_bare_exception_message_type_is_still_a_failure() {
        for mt in ["exception", "error"] {
            let raw = frame(&[(":message-type", mt)], b"{}");
            let mut r = EventStreamReader::new(std::io::Cursor::new(raw));
            let f = r.next_frame().await.unwrap().unwrap();
            assert_eq!(f.exception_type, mt, "message-type {mt}");
        }
        // `:error-code` is the other spelling.
        let raw = frame(&[(":error-code", "InternalFailure")], b"{}");
        let mut r = EventStreamReader::new(std::io::Cursor::new(raw));
        assert_eq!(
            r.next_frame().await.unwrap().unwrap().exception_type,
            "InternalFailure"
        );
    }

    #[tokio::test]
    async fn a_length_out_of_range_is_rejected() {
        // total < prelude + CRC
        let mut raw = 4u32.to_be_bytes().to_vec();
        raw.extend_from_slice(&0u32.to_be_bytes());
        raw.extend_from_slice(&0u32.to_be_bytes());
        let mut r = EventStreamReader::new(std::io::Cursor::new(raw));
        assert!(matches!(
            r.next_frame().await.unwrap().unwrap_err(),
            EventStreamError::FrameLength(4)
        ));

        // total > MAX_FRAME_LEN: rejected WITHOUT allocating 32 MiB.
        let mut raw = (MAX_FRAME_LEN + 1).to_be_bytes().to_vec();
        raw.extend_from_slice(&0u32.to_be_bytes());
        raw.extend_from_slice(&0u32.to_be_bytes());
        let mut r = EventStreamReader::new(std::io::Cursor::new(raw));
        assert!(matches!(
            r.next_frame().await.unwrap().unwrap_err(),
            EventStreamError::FrameLength(_)
        ));
    }

    #[tokio::test]
    async fn headers_longer_than_the_frame_are_rejected() {
        let mut raw = 20u32.to_be_bytes().to_vec();
        raw.extend_from_slice(&100u32.to_be_bytes()); // headers longer than the frame
        raw.extend_from_slice(&0u32.to_be_bytes());
        let mut r = EventStreamReader::new(std::io::Cursor::new(raw));
        assert!(matches!(
            r.next_frame().await.unwrap().unwrap_err(),
            EventStreamError::HeadersLength(100)
        ));
    }

    /// Several frames arriving in one read must all be decoded, and a metadata
    /// frame in the middle must not disturb the sequence.
    #[tokio::test]
    async fn consecutive_frames_decode_in_order() {
        let mut raw = chunk(r#"{"type":"message_start"}"#);
        raw.extend_from_slice(&frame(&[(":event-type", "metadata")], b"{}"));
        raw.extend_from_slice(&chunk(r#"{"type":"message_stop"}"#));

        let mut r = EventStreamReader::new(std::io::Cursor::new(raw));
        let mut kinds = Vec::new();
        while let Some(f) = r.next_frame().await {
            kinds.push(f.unwrap().event_type);
        }
        assert_eq!(kinds, vec!["chunk", "metadata", "chunk"]);
    }

    /// A frame split across reads must still assemble, since that is what a real
    /// socket does.
    #[tokio::test]
    async fn a_frame_split_across_reads_assembles() {
        let raw = chunk(r#"{"type":"content_block_delta","index":0}"#);
        let (mut client, mut server) = tokio::io::duplex(8);
        let writer = tokio::spawn(async move {
            use tokio::io::AsyncWriteExt;
            for byte in raw {
                server.write_all(&[byte]).await.unwrap();
            }
            server.shutdown().await.unwrap();
        });
        let mut r = EventStreamReader::new(&mut client);
        let f = r.next_frame().await.unwrap().unwrap();
        assert_eq!(f.event_type, "chunk");
        writer.await.unwrap();
    }

    #[test]
    fn header_types_without_a_string_value_are_skipped_by_length() {
        // A bool header (no value bytes) followed by a real string header.
        let mut b = Vec::new();
        b.push(4u8);
        b.extend_from_slice(b"bool");
        b.push(0); // true
        b.push(11u8);
        b.extend_from_slice(b":event-type");
        b.push(HEADER_TYPE_STRING);
        b.extend_from_slice(&5u16.to_be_bytes());
        b.extend_from_slice(b"chunk");

        let headers = parse_event_stream_headers(&b);
        assert_eq!(
            headers,
            vec![(":event-type".to_string(), "chunk".to_string())]
        );
    }

    #[test]
    fn a_malformed_header_block_yields_what_was_parsed() {
        // A name length that runs past the end.
        assert!(parse_event_stream_headers(&[9, b'a']).is_empty());
        // An unknown value type stops parsing rather than guessing a length.
        let mut b = vec![1u8, b'x', 200];
        b.extend_from_slice(b"junk");
        assert!(parse_event_stream_headers(&b).is_empty());
    }

    #[test]
    fn chunk_payload_errors_are_distinguished() {
        assert!(matches!(
            bedrock_chunk_event(b"not json").unwrap_err(),
            EventStreamError::ChunkNotJson(_)
        ));
        assert!(matches!(
            bedrock_chunk_event(br#"{"p":"abc"}"#).unwrap_err(),
            EventStreamError::EmptyChunk
        ));
        assert!(matches!(
            bedrock_chunk_event(br#"{"bytes":"!!!!"}"#).unwrap_err(),
            EventStreamError::ChunkNotJson(_)
        ));
    }
}
