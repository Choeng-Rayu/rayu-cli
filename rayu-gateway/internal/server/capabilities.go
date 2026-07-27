package server

// Per-model capability enforcement for the rayu-hosted path.
//
// A hosted model declares whether it accepts image content and whether it
// supports extended thinking (hosted_models.supportsImage /
// supportsReasoning, admin-managed). Enforcing that HERE — before the upstream
// call, and before any turn or credit is reserved — buys three things:
//
//  1. The user gets an accurate, actionable message ("this model can't read
//     images — pick another model") instead of whatever the upstream happens to
//     say, or worse, a silently ignored attachment.
//  2. No credits are spent discovering the limitation.
//  3. The reason is machine-readable (`error.rayu_code`), so the CLI can warn
//     and offer to switch models without string-matching provider prose.
//
// The request is inspected in its canonical Anthropic Messages shape, which is
// what every hosted request arrives as regardless of the upstream's wire format.

// requestHasImage reports whether an Anthropic Messages request carries image
// content. Anthropic puts images in a message's content blocks as
// {"type":"image", ...}; a plain string content can never hold one. Tool results
// may also nest content blocks, so those are inspected too.
func requestHasImage(req map[string]any) bool {
	msgs, ok := req["messages"].([]any)
	if !ok {
		return false
	}
	for _, m := range msgs {
		msg, ok := m.(map[string]any)
		if !ok {
			continue
		}
		if contentHasImage(msg["content"]) {
			return true
		}
	}
	return false
}

// contentHasImage walks a content value (string, block, or block list) looking
// for an image block, including blocks nested inside a tool_result.
func contentHasImage(content any) bool {
	switch v := content.(type) {
	case []any:
		for _, item := range v {
			if contentHasImage(item) {
				return true
			}
		}
	case map[string]any:
		if t, _ := v["type"].(string); t == "image" {
			return true
		}
		// tool_result carries its own nested content blocks, which may include an
		// image (e.g. a screenshot returned by a tool).
		if nested, ok := v["content"]; ok {
			return contentHasImage(nested)
		}
	}
	return false
}

// requestWantsThinking reports whether an Anthropic Messages request asks for
// extended thinking. Anthropic's shape is {"thinking":{"type":"enabled",...}};
// an explicit "disabled" is NOT a request for thinking, so a client that always
// sends the field with type=disabled is unaffected by the reasoning gate.
func requestWantsThinking(req map[string]any) bool {
	thinking, ok := req["thinking"].(map[string]any)
	if !ok {
		// A non-object `thinking` (or none) is not a thinking request.
		return false
	}
	switch t, _ := thinking["type"].(string); t {
	case "disabled":
		return false
	case "enabled":
		return true
	default:
		// Unknown/absent type but a thinking object present: treat as a request,
		// so an unsupported model fails loudly rather than silently ignoring it.
		return true
	}
}
