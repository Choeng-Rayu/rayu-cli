// Package obs provides the orchestrator's observability scaffolding: a
// structured JSON logger whose every emitted line is routed through a pluggable
// redactor hook, and a Prometheus registry with the build metrics declared.
//
// The redactor hook is an identity no-op for now; the central BYOK/secret
// Redact function is wired in as the hook in a later task, making the logger a
// single choke point through which no secret can escape (Req 21.4). The metric
// collectors are declared and registered here but not yet recorded — recording
// is added when the build lifecycle reaches its terminal paths (Req 21.2).
package obs

import (
	"encoding/json"
	"io"
	"os"
	"sync"
	"time"
)

// Redactor transforms a serialized log line before it is written. Task 19 swaps
// the identity hook for the real secret redactor.
type Redactor func(string) string

func identityRedactor(s string) string { return s }

// Logger is a minimal structured JSON logger that passes every serialized entry
// through its redactor before writing.
type Logger struct {
	mu      sync.Mutex
	out     io.Writer
	redact  Redactor
	nowFunc func() time.Time
}

// NewLogger returns a Logger writing to out (defaults to os.Stdout) with an
// identity redactor.
func NewLogger(out io.Writer) *Logger {
	if out == nil {
		out = os.Stdout
	}
	return &Logger{out: out, redact: identityRedactor, nowFunc: time.Now}
}

// SetRedactor installs the redaction hook every entry is routed through. Wiring
// the real Redact here (task 19) guarantees no log path can bypass redaction.
func (l *Logger) SetRedactor(r Redactor) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if r == nil {
		r = identityRedactor
	}
	l.redact = r
}

// Info emits a structured entry at info level. Variadic kv pairs are interpreted
// as alternating string keys and values; an odd trailing argument is ignored.
func (l *Logger) Info(msg string, kv ...any) { l.log("info", msg, kv...) }

// Error emits a structured entry at error level.
func (l *Logger) Error(msg string, kv ...any) { l.log("error", msg, kv...) }

func (l *Logger) log(level, msg string, kv ...any) {
	entry := map[string]any{
		"ts":    l.now().UTC().Format(time.RFC3339Nano),
		"level": level,
		"msg":   msg,
	}
	for i := 0; i+1 < len(kv); i += 2 {
		key, ok := kv[i].(string)
		if !ok {
			continue
		}
		entry[key] = kv[i+1]
	}
	line, err := json.Marshal(entry)
	if err != nil {
		line = []byte(`{"level":"error","msg":"log marshal failed"}`)
	}

	l.mu.Lock()
	redact := l.redact
	l.mu.Unlock()
	if redact == nil {
		redact = identityRedactor
	}

	out := redact(string(line)) + "\n"
	l.mu.Lock()
	_, _ = io.WriteString(l.out, out)
	l.mu.Unlock()
}

func (l *Logger) now() time.Time {
	if l.nowFunc != nil {
		return l.nowFunc()
	}
	return time.Now()
}
