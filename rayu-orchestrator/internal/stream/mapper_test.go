package stream

import (
	"os"
	"path/filepath"
	"testing"
)

// want describes one expected mapped event: its kind plus a subset of payload
// fields that must be present and equal. Fields not listed are not asserted.
type want struct {
	kind   Kind
	fields map[string]any
}

func loadFixture(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", "streams", name))
	if err != nil {
		t.Fatalf("read fixture %s: %v", name, err)
	}
	return b
}

func assertMapped(t *testing.T, got []Mapped, wants []want) {
	t.Helper()
	if len(got) != len(wants) {
		t.Fatalf("mapped %d events, want %d\n got: %s", len(got), len(wants), formatMapped(got))
	}
	for i, w := range wants {
		if got[i].Kind != w.kind {
			t.Errorf("event %d kind = %q, want %q", i, got[i].Kind, w.kind)
		}
		for k, v := range w.fields {
			actual, ok := got[i].Payload[k]
			if !ok {
				t.Errorf("event %d (%s) missing payload field %q; payload=%v", i, got[i].Kind, k, got[i].Payload)
				continue
			}
			if !valueEqual(actual, v) {
				t.Errorf("event %d (%s) payload[%q] = %#v, want %#v", i, got[i].Kind, k, actual, v)
			}
		}
	}
}

// Req 8.2–8.6 — a full successful run maps to log, tool_use, file_change,
// phase, agent, tool_result, and result (the system/init line yields nothing).
func TestMapFullSuccess(t *testing.T) {
	got := NewMapper("/workspace").MapNDJSON(loadFixture(t, "full_success.ndjson"))
	assertMapped(t, got, []want{
		{KindLog, map[string]any{"text": "Scaffolding the booking app for Cambodia."}},
		{KindToolUse, map[string]any{"tool": "Bash", "toolUseId": "toolu_1"}},
		{KindFileChange, map[string]any{"path": "Dockerfile", "tool": "Write"}},
		{KindPhase, map[string]any{"phase": "scope", "path": ".rayu/swarm/shared.json"}},
		{KindAgent, map[string]any{"agent": "frontend", "description": "Build the booking UI"}},
		{KindToolResult, map[string]any{"toolUseId": "toolu_1", "summary": "added 1 package in 1s", "isError": false}},
		{KindResult, map[string]any{"subtype": "success", "isError": false, "result": "Done. App generated."}},
	})
}

// Req 8.1 — every swarm coordination artifact maps to a phase, and an explicit
// "phase" field in the written content overrides the name-based default.
func TestMapPhases(t *testing.T) {
	got := NewMapper("/workspace").MapNDJSON(loadFixture(t, "phases.ndjson"))
	assertMapped(t, got, []want{
		{KindPhase, map[string]any{"phase": "scope", "path": ".rayu/swarm/shared.json"}},
		{KindPhase, map[string]any{"phase": "plan", "path": ".rayu/swarm/PA.md"}},
		{KindPhase, map[string]any{"phase": "build", "path": ".rayu/swarm/FRONTEND.md"}},
		{KindPhase, map[string]any{"phase": "review", "path": ".rayu/swarm/REVIEW.md"}},
		{KindPhase, map[string]any{"phase": "deploy", "path": ".rayu/swarm/DEPLOY.md"}},
		{KindPhase, map[string]any{"phase": "build", "path": ".rayu/swarm/shared.json"}}, // explicit override
	})
}

// Req 8.7 — an unparseable stdout line maps to a log carrying the raw line, and
// mapping continues past it.
func TestMapUnparseableFallback(t *testing.T) {
	got := NewMapper("").MapNDJSON(loadFixture(t, "unparseable.ndjson"))
	assertMapped(t, got, []want{
		{KindLog, map[string]any{"text": "this is not json at all"}},
		{KindLog, map[string]any{"text": "recovered after the bad line"}},
		{KindLog, map[string]any{"text": "{not valid json{"}},
		{KindResult, map[string]any{"subtype": "success", "isError": false, "result": "ok"}},
	})
}

// Req 8.5 — Write/Edit/MultiEdit on workspace paths map to file_change carrying
// the workspace-relative path.
func TestMapFileChangePaths(t *testing.T) {
	got := NewMapper("/workspace").MapNDJSON(loadFixture(t, "file_change.ndjson"))
	assertMapped(t, got, []want{
		{KindFileChange, map[string]any{"path": "src/index.ts", "tool": "Write"}},
		{KindFileChange, map[string]any{"path": "app/api/bookings/route.ts", "tool": "Edit"}},
		{KindFileChange, map[string]any{"path": "package.json", "tool": "MultiEdit"}},
	})
}

// Req 8.6 — an error result carries its subtype, error flag, and error list.
func TestMapResultError(t *testing.T) {
	got := NewMapper("/workspace").MapNDJSON(loadFixture(t, "result_error.ndjson"))
	if len(got) != 1 {
		t.Fatalf("mapped %d events, want 1: %s", len(got), formatMapped(got))
	}
	if got[0].Kind != KindResult {
		t.Fatalf("kind = %q, want result", got[0].Kind)
	}
	if got[0].Payload["subtype"] != "error_during_execution" || got[0].Payload["isError"] != true {
		t.Errorf("payload = %v, want error_during_execution + isError true", got[0].Payload)
	}
	errs, ok := got[0].Payload["errors"].([]string)
	if !ok || len(errs) != 1 || errs[0] != "generation failed: boom" {
		t.Errorf("errors payload = %#v, want [generation failed: boom]", got[0].Payload["errors"])
	}
}

// A blank or whitespace-only line yields no event.
func TestMapBlankLine(t *testing.T) {
	m := NewMapper("/workspace")
	for _, line := range []string{"", "   ", "\t", "\n"} {
		if got := m.Map(line); got != nil {
			t.Errorf("Map(%q) = %v, want nil", line, got)
		}
	}
}

// A single assistant line carrying both text and a tool_use produces two events.
func TestMapMultipleBlocksPerLine(t *testing.T) {
	line := `{"type":"assistant","message":{"role":"assistant","content":[` +
		`{"type":"text","text":"Creating the entrypoint"},` +
		`{"type":"tool_use","id":"x","name":"Write","input":{"file_path":"/workspace/server.js","content":"x"}}` +
		`]}}`
	assertMapped(t, NewMapper("/workspace").Map(line), []want{
		{KindLog, map[string]any{"text": "Creating the entrypoint"}},
		{KindFileChange, map[string]any{"path": "server.js", "tool": "Write"}},
	})
}

// A recognized-but-unsurfaced message type yields no event.
func TestMapSystemAndControlIgnored(t *testing.T) {
	m := NewMapper("/workspace")
	for _, line := range []string{
		`{"type":"system","subtype":"init","tools":[]}`,
		`{"type":"control_request","request_id":"1","request":{"subtype":"interrupt"}}`,
		`{"type":"control_response","response":{"subtype":"success","request_id":"1"}}`,
		`{"type":"stream_event","event":{}}`,
		`{"type":"keep_alive"}`,
		`{}`,
		`null`,
	} {
		if got := m.Map(line); got != nil {
			t.Errorf("Map(%q) = %v, want nil", line, got)
		}
	}
}

// A JSON value that is not an object (string/number/array) is treated as an
// unparseable line → a single log event.
func TestMapNonObjectJSONIsLog(t *testing.T) {
	m := NewMapper("/workspace")
	for _, line := range []string{`"just a string"`, `12345`, `[1,2,3]`} {
		got := m.Map(line)
		if len(got) != 1 || got[0].Kind != KindLog || got[0].Payload["text"] != line {
			t.Errorf("Map(%q) = %v, want single log with raw text", line, got)
		}
	}
}

// Req 8.1 — an Agent spawn maps to agent carrying the collaborator type, and a
// non-file, non-agent tool maps to a plain tool_use.
func TestMapAgentAndGenericTool(t *testing.T) {
	m := NewMapper("/workspace")

	agentLine := `{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"a1","name":"Task","input":{"subagent_type":"backend","description":"wire the API"}}]}}`
	assertMapped(t, m.Map(agentLine), []want{
		{KindAgent, map[string]any{"tool": "Task", "agent": "backend", "description": "wire the API"}},
	})

	grepLine := `{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"g1","name":"Grep","input":{"pattern":"TODO"}}]}}`
	assertMapped(t, m.Map(grepLine), []want{
		{KindToolUse, map[string]any{"tool": "Grep", "toolUseId": "g1"}},
	})
}

// stderr lines and non-zero exits map to error events (Req 7.3, 5.8).
func TestMapStderrAndExit(t *testing.T) {
	m := NewMapper("/workspace")
	if e := m.MapStderr("npm ERR! missing script: build\n"); e.Kind != KindError || e.Payload["message"] != "npm ERR! missing script: build" {
		t.Errorf("MapStderr = %v, want error with trimmed message", e)
	}
	if e := ExitError(137); e.Kind != KindError || e.Payload["exitCode"] != 137 {
		t.Errorf("ExitError(137) = %v, want error with exitCode 137", e)
	}
}

func formatMapped(ms []Mapped) string {
	var b []byte
	for i, m := range ms {
		if i > 0 {
			b = append(b, '\n')
		}
		b = append(b, []byte(string(m.Kind)+" ")...)
		for k, v := range m.Payload {
			b = append(b, []byte(k+"=")...)
			b = append(b, []byte(stringify(v)+" ")...)
		}
	}
	return string(b)
}

func stringify(v any) string {
	switch x := v.(type) {
	case string:
		return x
	default:
		return ""
	}
}

// valueEqual compares an expected payload value against the actual, handling
// the []string vs []any shapes that arise from JSON decoding.
func valueEqual(actual, expected any) bool {
	if as, ok := actual.([]string); ok {
		es, ok2 := expected.([]string)
		if !ok2 || len(as) != len(es) {
			return false
		}
		for i := range as {
			if as[i] != es[i] {
				return false
			}
		}
		return true
	}
	return actual == expected
}
