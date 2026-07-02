package stream

import (
	"bufio"
	"bytes"
	"encoding/json"
	"path"
	"regexp"
	"strings"
)

// defaultWorkspaceRoot is the in-sandbox path the workspace is bind-mounted at
// (see the SandboxRunner RunSpec). File paths reported by the swarm's
// Write/Edit tools are absolute under this root; the mapper strips it to
// produce a workspace-relative path (Req 8.5).
const defaultWorkspaceRoot = "/workspace"

// Bounds on free-text carried in payloads, so a single huge assistant turn or
// tool result cannot bloat an event. Redaction (Req 18.3/18.5) runs on the raw
// line before mapping; truncation here is only a size guard.
const (
	maxResultLen  = 4000
	maxSummaryLen = 2000
)

// Mapped is a kind+payload pair produced by the mapper, before the Emitter/Hub
// assigns the BuildID, gap-free Seq, and timestamp and persists it. Keeping the
// mapper's output free of Seq/BuildID/Ts is what makes it a pure function of
// its input line.
type Mapped struct {
	Kind    Kind
	Payload map[string]any
}

// Mapper turns the swarm's stream-json NDJSON stdout (and stderr) into
// Progress_Events per the design's mapping table (Req 8.1–8.7). It is
// stateless apart from the configured workspace root.
type Mapper struct {
	workspaceRoot string
}

// NewMapper returns a Mapper that resolves workspace-relative file paths
// against workspaceRoot (defaults to /workspace when empty).
func NewMapper(workspaceRoot string) *Mapper {
	root := strings.TrimRight(path.Clean(filepathToSlash(workspaceRoot)), "/")
	if root == "" || root == "." {
		root = defaultWorkspaceRoot
	}
	return &Mapper{workspaceRoot: root}
}

// envelope captures the outer stream-json message fields the mapper inspects.
// Heterogeneous nested bodies are deferred to json.RawMessage and decoded only
// for the message types that produce events.
type envelope struct {
	Type    string          `json:"type"`
	Subtype string          `json:"subtype"`
	Message json.RawMessage `json:"message"`
	IsError bool            `json:"is_error"`
	Result  string          `json:"result"`
	Errors  []string        `json:"errors"`
}

// apiMessage is the Anthropic-style message carried by assistant/user lines.
// Content is either a JSON string or an array of content blocks.
type apiMessage struct {
	Role    string          `json:"role"`
	Content json.RawMessage `json:"content"`
}

// contentBlock is one element of a message's content array. The fields are a
// superset across the block types the mapper handles (text, tool_use,
// tool_result); only the relevant ones are populated per block.
type contentBlock struct {
	Type      string          `json:"type"`
	Text      string          `json:"text"`        // text
	ID        string          `json:"id"`          // tool_use
	Name      string          `json:"name"`        // tool_use
	Input     json.RawMessage `json:"input"`       // tool_use
	ToolUseID string          `json:"tool_use_id"` // tool_result
	Content   json.RawMessage `json:"content"`     // tool_result (string or blocks)
	IsError   bool            `json:"is_error"`    // tool_result
}

// Map parses one stdout NDJSON line into zero or more Progress_Events.
//
//   - A blank/whitespace-only line yields nothing.
//   - An unparseable (non-JSON, or non-object JSON) line yields a single `log`
//     event carrying the raw line, then the caller continues (Req 8.7).
//   - assistant text → log; tool invocation → tool_use; Write/Edit on a
//     workspace path → file_change (or phase, for a swarm coordination
//     artifact); an Agent/subagent spawn → agent (Req 8.1–8.5).
//   - A user message's tool_result blocks → tool_result (Req 8.4).
//   - result → result (Req 8.6).
//   - Any other valid, recognized-but-unsurfaced message type (system/init,
//     control_*, stream_event, keep_alive, …) yields nothing.
//
// A single assistant line may carry several content blocks, so Map can return
// multiple events for one line.
func (m *Mapper) Map(line string) []Mapped {
	if strings.TrimSpace(line) == "" {
		return nil
	}
	var env envelope
	if err := json.Unmarshal([]byte(line), &env); err != nil {
		return []Mapped{logFrom(line)}
	}
	switch env.Type {
	case "assistant":
		return m.mapAssistant(env.Message)
	case "user":
		return mapUser(env.Message)
	case "result":
		return []Mapped{mapResult(env)}
	default:
		return nil
	}
}

// MapNDJSON maps an entire NDJSON blob line by line, concatenating the events.
// It is a convenience for fixture-driven tests and trace replay.
func (m *Mapper) MapNDJSON(data []byte) []Mapped {
	var out []Mapped
	sc := bufio.NewScanner(bytes.NewReader(data))
	sc.Buffer(make([]byte, 0, 64*1024), 8*1024*1024)
	for sc.Scan() {
		out = append(out, m.Map(sc.Text())...)
	}
	return out
}

// MapStderr maps a sandbox stderr line to a single error event (Req 7.3).
func (m *Mapper) MapStderr(line string) Mapped {
	return Mapped{Kind: KindError, Payload: map[string]any{
		"message": strings.TrimRight(line, "\r\n"),
	}}
}

// ExitError builds the error event for a non-zero sandbox exit (Req 5.8, 7.3).
func ExitError(code int) Mapped {
	return Mapped{Kind: KindError, Payload: map[string]any{
		"message":  "sandbox exited with non-zero status",
		"exitCode": code,
	}}
}

func (m *Mapper) mapAssistant(raw json.RawMessage) []Mapped {
	blocks, str, isString, ok := decodeContent(asMessageContent(raw))
	if !ok {
		return nil
	}
	if isString {
		if strings.TrimSpace(str) == "" {
			return nil
		}
		return []Mapped{logFrom(str)}
	}
	var out []Mapped
	for _, b := range blocks {
		switch b.Type {
		case "text":
			if strings.TrimSpace(b.Text) != "" {
				out = append(out, logFrom(b.Text))
			}
		case "tool_use":
			out = append(out, m.mapToolUse(b))
		}
		// thinking / redacted_thinking / other blocks carry no progress event.
	}
	return out
}

func mapUser(raw json.RawMessage) []Mapped {
	blocks, _, isString, ok := decodeContent(asMessageContent(raw))
	if !ok || isString {
		// A string-content user message is the prompt echo/replay, not progress.
		return nil
	}
	var out []Mapped
	for _, b := range blocks {
		if b.Type != "tool_result" {
			continue
		}
		payload := map[string]any{"isError": b.IsError}
		if b.ToolUseID != "" {
			payload["toolUseId"] = b.ToolUseID
		}
		if summary := summarizeToolResult(b.Content); summary != "" {
			payload["summary"] = summary
		}
		out = append(out, Mapped{Kind: KindToolResult, Payload: payload})
	}
	return out
}

func mapResult(env envelope) Mapped {
	payload := map[string]any{"isError": env.IsError}
	if env.Subtype != "" {
		payload["subtype"] = env.Subtype
	}
	if env.Result != "" {
		payload["result"] = truncate(env.Result, maxResultLen)
	}
	if len(env.Errors) > 0 {
		payload["errors"] = env.Errors
	}
	return Mapped{Kind: KindResult, Payload: payload}
}

func (m *Mapper) mapToolUse(b contentBlock) Mapped {
	// Agent/collaborator spawn (Req 8.1, 24.2). The Agent tool (legacy "Task")
	// carries the collaborator type in its subagent_type input.
	if isAgentTool(b.Name) {
		payload := map[string]any{"tool": b.Name}
		if b.ID != "" {
			payload["toolUseId"] = b.ID
		}
		if agent := stringField(b.Input, "subagent_type"); agent != "" {
			payload["agent"] = agent
		}
		if desc := stringField(b.Input, "description"); desc != "" {
			payload["description"] = desc
		}
		return Mapped{Kind: KindAgent, Payload: payload}
	}

	// File write/edit (Req 8.5). A write to a swarm coordination artifact is a
	// phase marker (Req 8.1) rather than an ordinary file change.
	if isFileTool(b.Name) {
		if target := fileTargetPath(b.Input); target != "" {
			rel := m.relPath(target)
			if phase, ok := detectPhase(rel, b.Input); ok {
				return Mapped{Kind: KindPhase, Payload: map[string]any{
					"phase": phase,
					"path":  rel,
					"tool":  b.Name,
				}}
			}
			payload := map[string]any{"path": rel, "tool": b.Name}
			if b.ID != "" {
				payload["toolUseId"] = b.ID
			}
			return Mapped{Kind: KindFileChange, Payload: payload}
		}
	}

	// Generic tool invocation (Req 8.3) — carry the tool name.
	payload := map[string]any{"tool": b.Name}
	if b.ID != "" {
		payload["toolUseId"] = b.ID
	}
	return Mapped{Kind: KindToolUse, Payload: payload}
}

// --- swarm phase detection (Req 8.1, 24.2) ---------------------------------

var (
	sharedJSONRe = regexp.MustCompile(`(^|/)\.rayu/swarm/shared\.json$`)
	domainMdRe   = regexp.MustCompile(`(^|/)\.rayu/swarm/[A-Z][A-Z0-9_]*\.md$`)
)

// isSwarmArtifact reports whether a workspace-relative path is one of the
// swarm's coordination artifacts: .rayu/swarm/shared.json or an upper-case
// per-domain <DOMAIN>.md directly under .rayu/swarm/.
func isSwarmArtifact(relPath string) bool {
	p := filepathToSlash(relPath)
	return sharedJSONRe.MatchString(p) || domainMdRe.MatchString(p)
}

// detectPhase classifies a write to a swarm coordination artifact into one of
// the five lifecycle phases. The mapping is deterministic:
//
//  1. An explicit, valid "phase" field in the written JSON content wins
//     (forward-compatible with the swarm emitting an explicit phase).
//  2. Otherwise the artifact name decides: shared.json → scope (the PA's
//     initial goal/stack/constraints), PA.md → plan, a *REVIEW*.md → review,
//     a *DEPLOY*.md → deploy, and any other <DOMAIN>.md → build (a collaborator
//     working a domain).
//
// It returns ("", false) for any path that is not a swarm artifact.
func detectPhase(relPath string, input json.RawMessage) (string, bool) {
	if !isSwarmArtifact(relPath) {
		return "", false
	}
	if content := stringField(input, "content"); content != "" {
		if p := explicitPhase(content); p != "" {
			return p, true
		}
	}
	base := strings.ToUpper(path.Base(filepathToSlash(relPath)))
	switch {
	case base == "SHARED.JSON":
		return "scope", true
	case base == "PA.MD":
		return "plan", true
	case strings.Contains(base, "REVIEW"):
		return "review", true
	case strings.Contains(base, "DEPLOY"):
		return "deploy", true
	default:
		return "build", true
	}
}

func explicitPhase(content string) string {
	var probe struct {
		Phase string `json:"phase"`
	}
	if err := json.Unmarshal([]byte(content), &probe); err != nil {
		return ""
	}
	switch strings.ToLower(probe.Phase) {
	case "scope", "plan", "build", "review", "deploy":
		return strings.ToLower(probe.Phase)
	}
	return ""
}

// --- helpers ---------------------------------------------------------------

func isAgentTool(name string) bool {
	return name == "Agent" || name == "Task"
}

func isFileTool(name string) bool {
	switch name {
	case "Write", "Edit", "MultiEdit", "NotebookEdit":
		return true
	}
	return false
}

func fileTargetPath(input json.RawMessage) string {
	for _, key := range []string{"file_path", "notebook_path", "path"} {
		if v := stringField(input, key); v != "" {
			return v
		}
	}
	return ""
}

// relPath strips the configured workspace root, yielding a workspace-relative
// path. Paths already relative (or outside the workspace) are returned cleaned,
// with any leading "./" removed.
func (m *Mapper) relPath(p string) string {
	p = filepathToSlash(p)
	if p == m.workspaceRoot {
		return ""
	}
	if strings.HasPrefix(p, m.workspaceRoot+"/") {
		return p[len(m.workspaceRoot)+1:]
	}
	return strings.TrimPrefix(p, "./")
}

// asMessageContent decodes an assistant/user line's "message" object and
// returns its raw "content" field (string or array). Returns nil if the
// message can't be decoded.
func asMessageContent(raw json.RawMessage) json.RawMessage {
	if len(raw) == 0 {
		return nil
	}
	var msg apiMessage
	if err := json.Unmarshal(raw, &msg); err != nil {
		return nil
	}
	return msg.Content
}

// decodeContent interprets a message/tool_result content value that may be
// either a JSON string or an array of content blocks.
func decodeContent(raw json.RawMessage) (blocks []contentBlock, str string, isString bool, ok bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return nil, "", false, false
	}
	switch trimmed[0] {
	case '"':
		if err := json.Unmarshal(trimmed, &str); err != nil {
			return nil, "", false, false
		}
		return nil, str, true, true
	case '[':
		if err := json.Unmarshal(trimmed, &blocks); err != nil {
			return nil, "", false, false
		}
		return blocks, "", false, true
	default:
		return nil, "", false, false
	}
}

func summarizeToolResult(raw json.RawMessage) string {
	blocks, str, isString, ok := decodeContent(raw)
	if !ok {
		return ""
	}
	if isString {
		return truncate(str, maxSummaryLen)
	}
	var sb strings.Builder
	for _, b := range blocks {
		if b.Type == "text" && b.Text != "" {
			if sb.Len() > 0 {
				sb.WriteByte('\n')
			}
			sb.WriteString(b.Text)
		}
	}
	return truncate(sb.String(), maxSummaryLen)
}

// stringField pulls a top-level string field out of a JSON object, returning ""
// if the input is absent, not an object, or the field is missing/non-string.
func stringField(raw json.RawMessage, key string) string {
	if len(raw) == 0 {
		return ""
	}
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(raw, &obj); err != nil {
		return ""
	}
	v, present := obj[key]
	if !present {
		return ""
	}
	var s string
	if err := json.Unmarshal(v, &s); err != nil {
		return ""
	}
	return s
}

func logFrom(text string) Mapped {
	return Mapped{Kind: KindLog, Payload: map[string]any{
		"text": strings.TrimRight(text, "\r\n"),
	}}
}

func truncate(s string, max int) string {
	if max <= 0 || len(s) <= max {
		return s
	}
	// Truncate on a rune boundary so the payload stays valid UTF-8.
	cut := max
	for cut > 0 && !utf8RuneStart(s[cut]) {
		cut--
	}
	if cut == 0 {
		cut = max
	}
	return s[:cut] + "…"
}

func utf8RuneStart(b byte) bool { return b&0xC0 != 0x80 }

// filepathToSlash normalizes Windows-style separators without importing
// path/filepath (the orchestrator runs on Linux; sandbox paths are POSIX).
func filepathToSlash(p string) string { return strings.ReplaceAll(p, "\\", "/") }
