package translate

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
)

// AWS event-stream decoding, for Bedrock's invoke-with-response-stream.
//
// WHY THIS IS HERE
//
// Bedrock returns a streaming Anthropic response, but NOT as SSE: it wraps each
// event in an `application/vnd.amazon.eventstream` frame. The CLI only speaks
// Anthropic SSE, so the frames have to be unwrapped and re-emitted. There is no
// way around it — this is the only streaming shape Bedrock offers.
//
// FRAME LAYOUT (all integers big-endian)
//
//	 0..3   total length (including this prelude and the trailing CRC)
//	 4..7   headers length
//	 8..11  prelude CRC32
//	12..    headers, then payload, then a 4-byte message CRC32
//
// Each header is: name length (1 byte), name, value type (1 byte), value.
// Only the string type (7) is read; the rest are skipped by length, because the
// headers this decoder cares about (`:event-type`, `:exception-type`) are strings.
//
// The payload of a Bedrock chunk is `{"bytes":"<base64>"}`, and the decoded bytes
// are one standard Anthropic streaming event (`message_start`,
// `content_block_delta`, …). CRCs are not verified: this is a TLS connection to a
// known host, so a corrupt frame is not a threat model, and a mismatched CRC
// would leave nothing better to do than fail the stream — which malformed JSON
// already does.

const (
	eventStreamPreludeLen = 12
	eventStreamCRCLen     = 4
	// maxFrameLen caps a single frame so a malformed length cannot make the
	// gateway allocate unbounded memory on an upstream's say-so.
	maxFrameLen = 16 << 20 // 16 MiB
	// headerTypeString is the AWS event-stream header value type for a string.
	headerTypeString = 7
)

// eventStreamFrame is one decoded frame.
type eventStreamFrame struct {
	// EventType is the `:event-type` header ("chunk" for payload events).
	EventType string
	// ExceptionType names the failure when the upstream reports one mid-stream
	// (throttling, model timeout, …). Bedrock signals these as a frame with
	// `:message-type: exception`, NOT as an HTTP status, so a reader that only
	// looks at event types would treat an error as a clean end of stream.
	ExceptionType string
	// Payload is the raw frame payload (for a chunk: {"bytes": "..."}).
	Payload []byte
}

// errEventStreamTruncated means the connection ended mid-frame — normal when a
// client disconnects, a genuine upstream failure otherwise.
var errEventStreamTruncated = errors.New("event stream ended mid-frame")

// readEventStreamFrame reads exactly one frame. It returns io.EOF at a clean end
// of stream.
func readEventStreamFrame(r io.Reader) (eventStreamFrame, error) {
	var prelude [eventStreamPreludeLen]byte
	if _, err := io.ReadFull(r, prelude[:]); err != nil {
		if errors.Is(err, io.ErrUnexpectedEOF) {
			return eventStreamFrame{}, errEventStreamTruncated
		}
		return eventStreamFrame{}, err // includes a clean io.EOF
	}
	total := binary.BigEndian.Uint32(prelude[0:4])
	headersLen := binary.BigEndian.Uint32(prelude[4:8])

	if total < eventStreamPreludeLen+eventStreamCRCLen || total > maxFrameLen {
		return eventStreamFrame{}, fmt.Errorf("event stream frame length %d out of range", total)
	}
	rest := int(total) - eventStreamPreludeLen
	if int(headersLen) > rest-eventStreamCRCLen {
		return eventStreamFrame{}, fmt.Errorf("event stream headers length %d exceeds frame", headersLen)
	}
	buf := make([]byte, rest)
	if _, err := io.ReadFull(r, buf); err != nil {
		return eventStreamFrame{}, errEventStreamTruncated
	}

	frame := eventStreamFrame{
		Payload: buf[headersLen : len(buf)-eventStreamCRCLen],
	}
	messageType := ""
	for _, h := range parseEventStreamHeaders(buf[:headersLen]) {
		switch h.name {
		case ":event-type":
			frame.EventType = h.value
		case ":message-type":
			messageType = h.value
		case ":exception-type", ":error-code":
			frame.ExceptionType = h.value
		}
	}
	// An exception/error message is a failure even when the specific type header is
	// missing — falling through as a normal frame would hide an upstream outage.
	if frame.ExceptionType == "" && (messageType == "exception" || messageType == "error") {
		frame.ExceptionType = messageType
	}
	return frame, nil
}

type eventStreamHeader struct{ name, value string }

// parseEventStreamHeaders reads the header block, skipping value types it does
// not need. A malformed block yields the headers parsed so far rather than an
// error: the payload is what matters, and headers are only used for routing.
func parseEventStreamHeaders(b []byte) []eventStreamHeader {
	var out []eventStreamHeader
	for i := 0; i < len(b); {
		nameLen := int(b[i])
		i++
		if i+nameLen > len(b) {
			return out
		}
		name := string(b[i : i+nameLen])
		i += nameLen
		if i >= len(b) {
			return out
		}
		valueType := b[i]
		i++
		switch valueType {
		case headerTypeString, 6: // 7 = string, 6 = byte array (both length-prefixed)
			if i+2 > len(b) {
				return out
			}
			n := int(binary.BigEndian.Uint16(b[i : i+2]))
			i += 2
			if i+n > len(b) {
				return out
			}
			out = append(out, eventStreamHeader{name: name, value: string(b[i : i+n])})
			i += n
		case 0, 1: // true / false: no value bytes
		case 2: // byte
			i++
		case 3: // int16
			i += 2
		case 4: // int32
			i += 4
		case 5, 8: // int64 / timestamp
			i += 8
		case 9: // uuid
			i += 16
		default:
			return out // unknown type: cannot know its length, stop here
		}
	}
	return out
}

// bedrockChunkEvent extracts the Anthropic event JSON carried by a chunk frame.
// Bedrock base64-encodes it in a `bytes` field.
func bedrockChunkEvent(payload []byte) ([]byte, error) {
	var wrapper struct {
		Bytes []byte `json:"bytes"` // encoding/json base64-decodes []byte
	}
	if err := json.Unmarshal(payload, &wrapper); err != nil {
		return nil, fmt.Errorf("bedrock chunk is not JSON: %w", err)
	}
	if len(wrapper.Bytes) == 0 {
		return nil, errors.New("bedrock chunk carried no bytes")
	}
	return wrapper.Bytes, nil
}
