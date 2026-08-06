package stream

import (
	"encoding/json"
	"testing"
	"time"
)

// Req 8.1 — exactly the ten allowed kinds exist, are distinct, and validate.
func TestAllKindsEnumeration(t *testing.T) {
	kinds := AllKinds()
	if len(kinds) != 10 {
		t.Fatalf("AllKinds() returned %d kinds, want 10", len(kinds))
	}

	want := map[Kind]bool{
		KindStatus: true, KindPhase: true, KindAgent: true, KindToolUse: true,
		KindToolResult: true, KindFileChange: true, KindLog: true,
		KindDeploy: true, KindResult: true, KindError: true,
	}
	seen := map[Kind]bool{}
	for _, k := range kinds {
		if seen[k] {
			t.Errorf("kind %q appears more than once", k)
		}
		seen[k] = true
		if !want[k] {
			t.Errorf("unexpected kind %q", k)
		}
		if !k.Valid() {
			t.Errorf("kind %q reports Valid()=false", k)
		}
	}
	for k := range want {
		if !seen[k] {
			t.Errorf("expected kind %q missing from AllKinds()", k)
		}
	}
}

// The exact wire strings are part of the contract with the gateway/panel.
func TestKindWireValues(t *testing.T) {
	cases := map[Kind]string{
		KindStatus: "status", KindPhase: "phase", KindAgent: "agent",
		KindToolUse: "tool_use", KindToolResult: "tool_result",
		KindFileChange: "file_change", KindLog: "log", KindDeploy: "deploy",
		KindResult: "result", KindError: "error",
	}
	for k, s := range cases {
		if k.String() != s {
			t.Errorf("kind %v String() = %q, want %q", k, k.String(), s)
		}
	}
}

func TestKindValidRejectsUnknown(t *testing.T) {
	for _, bad := range []Kind{"", "Status", "STATUS", "unknown", "tooluse", "file-change"} {
		if bad.Valid() {
			t.Errorf("kind %q reports Valid()=true, want false", bad)
		}
	}
}

// AllKinds returns a copy: mutating it must not corrupt the canonical list.
func TestAllKindsReturnsCopy(t *testing.T) {
	first := AllKinds()
	first[0] = "mutated"
	second := AllKinds()
	if second[0] != KindStatus {
		t.Fatalf("AllKinds() not defensively copied: got %q", second[0])
	}
}

// Req 8.1, 8.8 — the JSON shape is exactly {buildId, seq, kind, payload, ts}.
func TestProgressEventJSONShape(t *testing.T) {
	ev := ProgressEvent{
		BuildID: "bld_7f3k2a",
		Seq:     42,
		Kind:    KindFileChange,
		Payload: map[string]any{"path": "src/app.ts", "tool": "Write"},
		Ts:      time.Date(2025, 1, 1, 0, 0, 0, 0, time.UTC),
	}

	b, err := json.Marshal(ev)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}

	var generic map[string]json.RawMessage
	if err := json.Unmarshal(b, &generic); err != nil {
		t.Fatalf("Unmarshal to generic: %v", err)
	}
	wantKeys := []string{"buildId", "seq", "kind", "payload", "ts"}
	if len(generic) != len(wantKeys) {
		t.Fatalf("event has %d top-level keys (%v), want %d", len(generic), keysOf(generic), len(wantKeys))
	}
	for _, k := range wantKeys {
		if _, ok := generic[k]; !ok {
			t.Errorf("missing top-level key %q in %s", k, b)
		}
	}

	// Field values survive a round-trip.
	var got ProgressEvent
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatalf("Unmarshal to ProgressEvent: %v", err)
	}
	if got.BuildID != ev.BuildID || got.Seq != ev.Seq || got.Kind != ev.Kind {
		t.Errorf("round-trip mismatch: got %+v, want %+v", got, ev)
	}
	if !got.Ts.Equal(ev.Ts) {
		t.Errorf("ts round-trip: got %v, want %v", got.Ts, ev.Ts)
	}
	if got.Payload["path"] != "src/app.ts" || got.Payload["tool"] != "Write" {
		t.Errorf("payload round-trip: got %+v", got.Payload)
	}
}

// kind serializes as its bare wire string (not a wrapped object).
func TestProgressEventKindSerializesAsString(t *testing.T) {
	b, err := json.Marshal(ProgressEvent{Kind: KindStatus})
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	var generic map[string]json.RawMessage
	if err := json.Unmarshal(b, &generic); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if string(generic["kind"]) != `"status"` {
		t.Errorf("kind serialized as %s, want \"status\"", generic["kind"])
	}
}

func keysOf(m map[string]json.RawMessage) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}
