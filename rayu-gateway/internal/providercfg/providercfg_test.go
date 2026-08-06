package providercfg

import "testing"

func validRow() Row {
	return Row{
		Name:         "openrouter",
		Format:       FormatOpenAIChat,
		BaseURL:      "https://openrouter.ai/api",
		EndpointPath: "/v1/chat/completions",
		AuthScheme:   AuthBearer,
		Enabled:      true,
		KeyCount:     1,
	}
}

func TestBuildResolvesEndpointAndKeyPresence(t *testing.T) {
	row := validRow()
	r, err := Build(row, Options{})
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	if got, want := r.Endpoint(), "https://openrouter.ai/api/v1/chat/completions"; got != want {
		t.Errorf("Endpoint = %q, want %q", got, want)
	}
	if r.KeyCount != 1 {
		t.Errorf("KeyCount = %d, want 1", r.KeyCount)
	}
	if !r.Bearer() {
		t.Error("Bearer() = false, want true for bearer auth")
	}
	if !r.HasKey() {
		t.Error("HasKey() = false, want true")
	}
}

func TestBuildFallsBackToFormatDefaultPath(t *testing.T) {
	cases := map[string]string{
		FormatAnthropicMessages: "https://api.deepseek.com/anthropic/v1/messages",
		FormatOpenAIChat:        "https://api.deepseek.com/v1/chat/completions",
		FormatOpenAIResponses:   "https://api.deepseek.com/v1/responses",
		// genai has no fixed path — its adapter builds a model-specific URL.
		FormatGenAI: "https://api.deepseek.com",
	}
	for format, want := range cases {
		row := validRow()
		row.Format = format
		row.EndpointPath = ""
		row.AuthScheme = AuthXAPIKey
		row.BaseURL = "https://api.deepseek.com"
		r, err := Build(row, Options{})
		if err != nil {
			t.Fatalf("Build(%s): %v", format, err)
		}
		if got := r.Endpoint(); got != want {
			t.Errorf("format %s: Endpoint = %q, want %q", format, got, want)
		}
	}
}

// A provider whose base URL carries a path prefix must keep it.
func TestURLPreservesBasePathPrefix(t *testing.T) {
	r := Route{BaseURL: "https://gw.example/openai/", EndpointPath: "/v1/responses", Format: FormatOpenAIResponses}
	if got, want := r.Endpoint(), "https://gw.example/openai/v1/responses"; got != want {
		t.Errorf("Endpoint = %q, want %q", got, want)
	}
}

// A bad row must be REFUSED, not silently repaired — the gateway would otherwise
// send a provider key somewhere the admin never configured.
func TestBuildRejectsUnsafeRows(t *testing.T) {
	cases := map[string]func(*Row){
		"http upstream":     func(r *Row) { r.BaseURL = "http://openrouter.ai" },
		"loopback":          func(r *Row) { r.BaseURL = "https://127.0.0.1:8080" },
		"localhost name":    func(r *Row) { r.BaseURL = "https://localhost" },
		"cloud metadata ip": func(r *Row) { r.BaseURL = "https://169.254.169.254" },
		"metadata name":     func(r *Row) { r.BaseURL = "https://metadata.google.internal" },
		"private class A":   func(r *Row) { r.BaseURL = "https://10.0.0.5" },
		"private class B":   func(r *Row) { r.BaseURL = "https://172.16.9.9" },
		"private class C":   func(r *Row) { r.BaseURL = "https://192.168.1.10" },
		"cgnat":             func(r *Row) { r.BaseURL = "https://100.100.1.1" },
		"ipv6 loopback":     func(r *Row) { r.BaseURL = "https://[::1]:443" },
		"ipv6 ula":          func(r *Row) { r.BaseURL = "https://[fd00::1]" },
		"embedded creds":    func(r *Row) { r.BaseURL = "https://u:p@openrouter.ai" },
		"query string":      func(r *Row) { r.BaseURL = "https://openrouter.ai?x=1" },
		"non-http scheme":   func(r *Row) { r.BaseURL = "ftp://openrouter.ai" },
		"unknown format":    func(r *Row) { r.Format = "grpc_magic" },
		"unknown auth":      func(r *Row) { r.AuthScheme = "hmac" },
		"relative path":     func(r *Row) { r.EndpointPath = "v1/messages" },
		"path traversal":    func(r *Row) { r.EndpointPath = "/../secrets" },
		"absolute path url": func(r *Row) { r.EndpointPath = "https://evil.example/v1" },
	}
	for name, mutate := range cases {
		row := validRow()
		mutate(&row)
		if _, err := Build(row, Options{}); err == nil {
			t.Errorf("Build with %s = nil error, want refusal", name)
		}
	}
}

func TestBuildAllowsPrivateHTTPOnlyWhenExplicitlyEnabled(t *testing.T) {
	row := validRow()
	row.BaseURL = "http://127.0.0.1:11434"
	if _, err := Build(row, Options{}); err == nil {
		t.Fatal("private http accepted without AllowInsecure")
	}
	if _, err := Build(row, Options{AllowInsecure: true}); err != nil {
		t.Fatalf("private http refused with AllowInsecure: %v", err)
	}
	// Even with the dev flag, a PUBLIC http host stays refused: that would send
	// the key over plaintext to the internet.
	row.BaseURL = "http://openrouter.ai"
	if _, err := Build(row, Options{AllowInsecure: true}); err == nil {
		t.Fatal("public http accepted with AllowInsecure")
	}
}

func TestBuildSucceedsWithoutAnyKey(t *testing.T) {
	// A valid row with zero keys must still BUILD (so health output can report
	// keyPresent=false); it is the request path that refuses to route it.
	row := validRow()
	row.KeyCount = 0
	r, err := Build(row, Options{})
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	if r.HasKey() {
		t.Error("HasKey() = true with zero keys")
	}
}

func TestMaskKeyNeverRevealsTheSecret(t *testing.T) {
	const secret = "sk-abcdef0123456789abcdef"
	masked := MaskKey(secret)
	if masked == secret {
		t.Fatal("MaskKey returned the raw key")
	}
	if got, want := MaskKey(""), "<unset>"; got != want {
		t.Errorf("MaskKey(\"\") = %q, want %q", got, want)
	}
	if got, want := MaskKey("short"), "***(5)"; got != want {
		t.Errorf("MaskKey(short) = %q, want %q", got, want)
	}
}
