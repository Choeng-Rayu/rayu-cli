package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/choeng-rayu/rayu-gateway/internal/auth"
	"github.com/choeng-rayu/rayu-gateway/internal/httpx"
	"github.com/choeng-rayu/rayu-gateway/internal/providercfg"
	"github.com/choeng-rayu/rayu-gateway/internal/providerkeys"
	"github.com/choeng-rayu/rayu-gateway/internal/proxy"
	"github.com/choeng-rayu/rayu-gateway/internal/secretbox"
	"github.com/choeng-rayu/rayu-gateway/internal/store"
	"github.com/choeng-rayu/rayu-gateway/internal/translate"
)

// Provider test: "does this provider + this key + this model actually work?"
//
// WHY IT LIVES IN THE GATEWAY
//
// The admin dashboard cannot answer that question itself. It has no provider key
// (by design — keys are encrypted and only the gateway can open them), no
// wire-format adapters, and no view of per-key health. Any test written in the
// backend or the browser would be a SECOND, slightly-different implementation of
// the request path, so a "pass" would not prove the real path works.
//
// This endpoint therefore performs a genuine 1-token request through the SAME
// adapter, route validation, and key rotation that serve production traffic. The
// only difference is that it charges nothing: no credit reserve, no daily turn,
// no ledger row.
//
// A failure is CLASSIFIED rather than relayed, because an admin needs to know
// which field to fix. "HTTP 404" is not actionable; "unknown_model: the provider
// does not have `deepseek-chat`; did you mean `deepseek-v4-pro`?" is.

// providerTestClassification names the actionable cause of a test result. These
// values are a contract with the dashboard, which maps them to the field an admin
// has to correct.
const (
	testOK             = "ok"              // the model answered
	testBadAPIKey      = "bad_api_key"     // 401/403 — key wrong, revoked, or lacks access
	testUnknownModel   = "unknown_model"   // provider does not know this upstream model id
	testBadBaseURL     = "bad_base_url"    // host/path wrong: DNS, refused, TLS, or 404 route
	testFormatMismatch = "format_mismatch" // 200, but not the shape this format promises
	testRateLimited    = "rate_limited"    // 429/402 — key is live but throttled/out of quota
	testUpstreamError  = "upstream_error"  // provider-side failure (5xx, timeout)
)

type providerTestRequest struct {
	ProviderID int64  `json:"providerId"`
	ModelCode  string `json:"modelCode"`
	// APIKeyID targets ONE key. Omit to test whichever key would serve a real
	// request right now. A targeted test deliberately ignores health so an admin
	// can re-check a key that was marked invalid or is cooling down.
	APIKeyID int64 `json:"apiKeyId"`
}

// providerTestChecks reports which STAGE of the handshake succeeded. A single
// classification says what broke; this says what worked, which is what an admin
// actually needs: "the endpoint answered and took my key, only the model id was
// refused" points at one field, whereas a bare failure invites re-checking the
// key, the URL, and the format all at once.
//
// nil = not reached / not determinable (the key cannot be judged when the host
// never answered) and serializes as null.
type providerTestChecks struct {
	// Reachable: the base URL + endpoint path produced an HTTP response.
	Reachable *bool `json:"reachable"`
	// KeyAccepted: the upstream did not reject the credential (no 401/403).
	KeyAccepted *bool `json:"keyAccepted"`
	// ModelAccepted: the upstream recognised the model id.
	ModelAccepted *bool `json:"modelAccepted"`
}

type providerTestResult struct {
	OK             bool               `json:"ok"`
	Classification string             `json:"classification"`
	Message        string             `json:"message"`
	Checks         providerTestChecks `json:"checks"`
	// Suggestion is a concrete next step when one can be inferred (e.g. the
	// nearest model id the provider is already configured with).
	Suggestion string `json:"suggestion,omitempty"`
	HTTPStatus int    `json:"httpStatus,omitempty"`
	LatencyMs  int64  `json:"latencyMs"`
	// Which provider/model/key was exercised. The key is identified by id and
	// MASK only — a test never echoes a secret, not even to an admin.
	ProviderName    string `json:"providerName"`
	Format          string `json:"format"`
	Endpoint        string `json:"endpoint"`
	ModelCode       string `json:"modelCode,omitempty"`
	UpstreamModelID string `json:"upstreamModelId,omitempty"`
	KeyID           int64  `json:"keyId,omitempty"`
	MaskedKey       string `json:"maskedKey,omitempty"`
}

// Test budget per admin. A test is a real upstream call with a real key, so it is
// rate limited: without a cap, a loop in the dashboard (or an impatient admin
// holding a button) could trip a provider's abuse detection and rate-limit every
// key for actual users.
const (
	providerTestWindow   = time.Minute
	providerTestPerAdmin = 20
	providerTestTimeout  = 25 * time.Second
)

// testLimiter is a per-caller sliding window. In-process on purpose: the limit
// exists to protect UPSTREAMS from one operator's clicking, and a gateway replica
// only ever serves the admin currently talking to it.
type testLimiter struct {
	window time.Duration
	max    int

	mu   sync.Mutex
	hits map[int64][]time.Time
}

func newTestLimiter() *testLimiter {
	return newSlidingLimiter(providerTestWindow, providerTestPerAdmin)
}

// newSlidingLimiter is the same window with caller-chosen bounds, so a cheap admin
// action (a config refresh) is not held to the budget of an expensive one (a real
// upstream call).
func newSlidingLimiter(window time.Duration, max int) *testLimiter {
	return &testLimiter{window: window, max: max, hits: map[int64][]time.Time{}}
}

// allow records an attempt and reports whether it fits in the window, plus how
// long to wait when it does not.
func (l *testLimiter) allow(userID int64, now time.Time) (bool, time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()
	cutoff := now.Add(-l.window)
	kept := l.hits[userID][:0]
	for _, t := range l.hits[userID] {
		if t.After(cutoff) {
			kept = append(kept, t)
		}
	}
	if len(kept) >= l.max {
		l.hits[userID] = kept
		return false, l.window - now.Sub(kept[0])
	}
	l.hits[userID] = append(kept, now)
	return true, 0
}

// withRefreshNote appends WHY a lookup may have missed when the up-front config
// refresh failed. Without it the admin is told "model X does not belong to this
// provider" about a model they can see saved in the dashboard, and the real cause
// (the gateway cannot reach the database) is only in the server log.
func withRefreshNote(msg string, refreshErr error) string {
	if refreshErr == nil {
		return msg
	}
	return msg + " — note: the gateway could not refresh its configuration (" +
		refreshErr.Error() + "), so it answered from its last snapshot"
}

// handleProviderTest runs one real, unbilled request against a provider.
func (s *Server) handleProviderTest(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())
	if claims.Role != "admin" && claims.Role != "superadmin" {
		httpx.WriteError(w, http.StatusForbidden, "admin only")
		return
	}
	if ok, wait := s.testLim.allow(claims.UserID, time.Now()); !ok {
		w.Header().Set("Retry-After", strconv.Itoa(int(wait.Seconds())+1))
		httpx.WriteError(w, http.StatusTooManyRequests,
			"too many provider tests — each one is a real upstream call; try again shortly")
		return
	}

	var body providerTestRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, 4<<10)).Decode(&body); err != nil {
		httpx.WriteError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if body.ProviderID == 0 {
		httpx.WriteError(w, http.StatusBadRequest, "providerId is required")
		return
	}

	// The admin saved this provider/key/model a moment ago, and the config snapshot
	// only refreshes every CONFIG_REFRESH_SECONDS — so refresh FIRST, before the
	// route, model and key are resolved from it.
	//
	// This used to refresh only when a lookup MISSED, which cannot see an EDIT: a
	// changed upstream model id, base URL, endpoint path or auth scheme still
	// resolves under the same code, so nothing missed, nothing refreshed, and the
	// test exercised the configuration the admin had just replaced — then reported
	// it as the truth. ("I save, I test, it still uses the old config until I wait.")
	//
	// The cost is a handful of queries plus key decryption on a human-triggered
	// action that is already capped at 20/min per admin, and concurrent tests share
	// one refresh (see configReloader). Correctness over the saved round-trips: a
	// test that reports on stale configuration is worse than no test at all.
	var reloadErr error
	if err := s.reloader.Reload(r.Context()); err != nil {
		reloadErr = err
		log.Printf("provider test: config refresh failed, answering from the last snapshot: %v", err)
	}

	pr, ok := s.ent.Route(body.ProviderID)
	if !ok {
		httpx.WriteError(w, http.StatusNotFound, withRefreshNote("unknown provider", reloadErr))
		return
	}
	result := providerTestResult{
		ProviderName: pr.Route.Name,
		Format:       pr.Route.Format,
		Endpoint:     pr.Route.Endpoint(),
	}

	// A row that fails validation never reaches an upstream: report the reason
	// verbatim, since it is the gateway's own message and names the bad field.
	if pr.Err != nil {
		result.Classification = testBadBaseURL
		result.Message = pr.Err.Error()
		result.Suggestion = "Fix the provider's base URL / endpoint path, then test again."
		// Nothing was attempted, so only "not reachable" is known.
		result.Checks = providerTestChecks{Reachable: boolPtr(false)}
		httpx.WriteJSON(w, http.StatusOK, result)
		return
	}

	// The snapshot was refreshed above, so a miss here is a real miss: the model or
	// key genuinely is not in the database (or the refresh failed and said so).
	model, err := s.testModel(body.ProviderID, body.ModelCode)
	if err != nil {
		httpx.WriteError(w, http.StatusBadRequest, withRefreshNote(err.Error(), reloadErr))
		return
	}
	result.ModelCode = model.Code
	result.UpstreamModelID = model.UpstreamModelID

	key, keySkipped, err := s.testKey(body.ProviderID, body.APIKeyID)
	if err != nil {
		httpx.WriteError(w, http.StatusBadRequest, withRefreshNote(err.Error(), reloadErr))
		return
	}
	result.KeyID = key.ID
	result.MaskedKey = key.Masked

	adapter, err := translate.For(pr.Route.Format)
	if err != nil {
		result.Classification = testUpstreamError
		result.Message = err.Error()
		result.Suggestion = "This build has no adapter for that wire format — pick a supported format."
		httpx.WriteJSON(w, http.StatusOK, result)
		return
	}

	// The smallest possible real request: one token, no streaming. Enough to prove
	// auth + routing + the model id, cheap enough to run from a UI button.
	ctx, cancel := context.WithTimeout(r.Context(), providerTestTimeout)
	defer cancel()
	req := translate.Request{
		Route:           pr.Route,
		Keys:            []proxy.APIKey{{ID: key.ID, Secret: key.Secret}},
		UpstreamModelID: model.UpstreamModelID,
		Anthropic: map[string]any{
			"model":      model.UpstreamModelID,
			"max_tokens": 1,
			"messages":   []any{map[string]any{"role": "user", "content": "ping"}},
		},
		// A test observes real per-key health, but only for verdicts that are ABOUT
		// the key: a 429 is the provider itself saying "later", and its cooldown
		// expires on its own. A 401/403 is deliberately NOT recorded here — during
		// onboarding the configuration is unproven, so it is at least as likely to
		// mean a wrong URL, a wrong auth scheme or a web page as a wrong credential.
		// Condemning the key on it stranded the provider: with its only key out of
		// rotation, every later per-model test refused to run, so the admin could
		// never verify the fix. Real traffic still records auth failures, because
		// there the configuration has already been proven.
		OnKeyFailure: func(f proxy.KeyFailure) { s.recordTestKeyFailure(body.ProviderID, f) },
	}

	started := time.Now()
	_, status, respBody, err := adapter.Complete(ctx, req)
	result.LatencyMs = time.Since(started).Milliseconds()
	result.HTTPStatus = status

	classification, message := classifyProviderTest(status, respBody, err)
	result.Classification = classification
	result.OK = classification == testOK
	result.Checks = checksFor(classification, status, err)
	// Redact defensively: an upstream error body can echo the request, and some
	// providers include the presented credential in it.
	result.Message = redactSecret(message, key.Secret)
	if result.OK {
		// Success clears an earlier rate limit, so a recovered key returns to
		// rotation immediately instead of waiting out its cooldown.
		s.ent.Keys().MarkUsed(body.ProviderID, key.ID)
	}
	result.Suggestion = s.suggestFix(classification, pr.Route, model, body.ProviderID, respBody)
	if keySkipped != "" {
		// The test used a key rotation would have skipped. Say so, or a pass reads as
		// "the provider is healthy" when live traffic still has no key to use.
		note := "Note: key #" + strconv.FormatInt(key.ID, 10) + " was used even though " + keySkipped + "."
		if result.OK {
			note += " The test passed, so it has been returned to rotation."
		} else {
			note += " Fix the cause and test again — a passing test puts it back in rotation."
		}
		if result.Suggestion == "" {
			result.Suggestion = note
		} else {
			result.Suggestion += " " + note
		}
	}

	log.Printf("provider test: admin=%d provider=%q model=%q key=#%d result=%s http=%d latency=%dms",
		claims.UserID, pr.Route.Name, model.Code, key.ID, classification, status, result.LatencyMs)
	httpx.WriteJSON(w, http.StatusOK, result)
}

func boolPtr(b bool) *bool { return &b }

// checksFor derives the per-stage checklist from what the upstream actually did.
func checksFor(classification string, status int, err error) providerTestChecks {
	if err != nil {
		// No HTTP response at all: the key and the model were never judged.
		return providerTestChecks{Reachable: boolPtr(false)}
	}
	c := providerTestChecks{Reachable: boolPtr(true)}
	switch classification {
	case testBadAPIKey:
		// The endpoint answered, so it exists; the credential is what it refused.
		c.KeyAccepted = boolPtr(false)
	case testUnknownModel:
		c.KeyAccepted = boolPtr(true)
		c.ModelAccepted = boolPtr(false)
	case testOK:
		c.KeyAccepted = boolPtr(true)
		c.ModelAccepted = boolPtr(true)
	case testRateLimited, testFormatMismatch:
		// Throttling and a wrong response shape both prove the credential passed.
		c.KeyAccepted = boolPtr(true)
	}
	return c
}

// testModel resolves which model to exercise: the requested one, or the
// provider's first enabled model when the caller just wants a connectivity check.
func (s *Server) testModel(providerID int64, code string) (store.HostedModel, error) {
	var firstEnabled *store.HostedModel
	for _, m := range s.ent.Models() {
		if m.ProviderID != providerID {
			continue
		}
		if code != "" {
			if m.Code == code {
				return m, nil
			}
			continue
		}
		if m.Enabled && firstEnabled == nil {
			model := m
			firstEnabled = &model
		}
	}
	if code != "" {
		return store.HostedModel{}, errors.New("model " + code + " does not belong to this provider")
	}
	if firstEnabled == nil {
		return store.HostedModel{}, errors.New(
			"this provider has no enabled model to test — add one, or pass modelCode explicitly")
	}
	return *firstEnabled, nil
}

// testKey resolves which key to use, and why.
//
// A targeted id is honoured even when the key is disabled, invalid, or cooling
// down: re-testing a key an admin just replaced (or believes is fixed) is the whole
// point.
//
// With no id, a key that PICK would skip is used as a fallback rather than refusing
// the test. Refusing was a dead end: one 401 against a half-configured provider
// takes its only key out of rotation, and from then on every per-model test answered
// "no usable API key" without calling anything — so fixing the actual mistake could
// never be verified, and a successful test is exactly what puts the key back
// (Registry.MarkUsed). skipped reports that state so the answer can say so.
func (s *Server) testKey(providerID, keyID int64) (key providerkeys.Key, skipped string, err error) {
	if keyID != 0 {
		k, ok := s.ent.Keys().Find(providerID, keyID)
		if !ok {
			return providerkeys.Key{}, "", errors.New("unknown API key for this provider")
		}
		if k.Secret == "" {
			return providerkeys.Key{}, "", errors.New(
				"this key cannot be decrypted — check that the gateway and backend share the same RAYU_PROVIDER_SECRET")
		}
		return k, "", nil
	}
	if usable := s.ent.Keys().Pick(providerID); len(usable) > 0 {
		return usable[0], "", nil
	}

	// Nothing in rotation: fall back to the healthiest key there is, so the test can
	// still prove (or disprove) the configuration.
	for _, snap := range s.ent.Keys().SnapshotFor(providerID) {
		k, ok := s.ent.Keys().Find(providerID, snap.ID)
		if !ok || k.Secret == "" {
			continue
		}
		return k, keySkipReason(snap), nil
	}
	if len(s.ent.Keys().SnapshotFor(providerID)) > 0 {
		return providerkeys.Key{}, "", errors.New(
			"this provider's API key(s) cannot be decrypted — check that the gateway and backend " +
				"share the same RAYU_PROVIDER_SECRET")
	}
	return providerkeys.Key{}, "", errors.New(
		"this provider has no API key — add one, then test again")
}

// keySkipReason explains, in an admin's terms, why a key is not in rotation.
func keySkipReason(s providerkeys.Snapshot) string {
	switch {
	case !s.Enabled:
		return "it is disabled"
	case s.Status == providerkeys.StatusInvalid:
		return "it is out of rotation after an earlier auth failure"
	case s.Status == providerkeys.StatusRateLimited && s.CooldownUntil != nil:
		return "it is cooling down until " + s.CooldownUntil.UTC().Format("15:04:05") + " UTC"
	case s.Status == providerkeys.StatusRateLimited:
		return "it is cooling down after a rate limit"
	case s.Status == providerkeys.StatusDisabled:
		return "it is disabled"
	default:
		return "it is not in rotation"
	}
}

// classifyProviderTest turns a transport error or upstream status into the cause
// an admin can act on, plus a short human message.
func classifyProviderTest(status int, body []byte, err error) (string, string) {
	// A web page is decisive and comes first, whatever the status and whatever the
	// adapter made of the body: an API endpoint does not serve HTML. This is what a
	// provider returns for a path it does not have (its single-page app, with 200),
	// or from a CDN/WAF in front of it — neither says anything about the format, the
	// credential or the model, so blaming any of those sends the admin the wrong way.
	if looksLikeHTML(body) {
		return testBadBaseURL,
			"The URL answered with a web page, not an API response (HTTP " + itoa(status) + "). " +
				"The base URL or endpoint path is pointing at the provider's website " +
				"rather than its API. Response started: " + bodySnippet(body)
	}
	if err != nil {
		return classifyTransportError(err)
	}
	snippet := bodySnippet(body)
	switch {
	case status == http.StatusOK:
		// A 200 that is not Anthropic-shaped means the provider's format is not
		// the one configured — the most confusing failure to debug by hand,
		// because auth and routing both "worked".
		if !looksLikeAnthropicMessage(body) {
			if spoken := detectResponseFormat(body); spoken != "" {
				return testFormatMismatch,
					"The provider answered 200 in the " + spoken + " format, not the one configured. " +
						"Response started: " + snippet
			}
			return testFormatMismatch,
				"The provider answered 200 but not in the expected shape for this wire format. " +
					"Check the provider's format setting. Response started: " + snippet
		}
		return testOK, "Model responded successfully."
	case status == http.StatusUnauthorized || status == http.StatusForbidden:
		return testBadAPIKey,
			"The provider rejected this API key (HTTP " + itoa(status) + "). " +
				"Replace the key, or check that it is allowed to use this model. " + snippet
	case status == http.StatusTooManyRequests || status == http.StatusPaymentRequired:
		return testRateLimited,
			"The key is valid but throttled or out of quota (HTTP " + itoa(status) + "). " + snippet
	case status == http.StatusNotFound, status == http.StatusBadRequest, status == http.StatusUnprocessableEntity:
		// Both "wrong model" and "wrong path" land here; the body is what
		// distinguishes them.
		if mentionsModel(snippet) {
			return testUnknownModel,
				"The provider does not recognise this model id (HTTP " + itoa(status) + "). " + snippet
		}
		if status == http.StatusNotFound {
			return testBadBaseURL,
				"The provider returned 404 for this endpoint — the base URL or endpoint path is wrong. " + snippet
		}
		return testUpstreamError, "The provider rejected the request (HTTP " + itoa(status) + "). " + snippet
	default:
		return testUpstreamError, "Provider error (HTTP " + itoa(status) + "). " + snippet
	}
}

// classifyTransportError separates "the address is wrong" from "the provider is
// having a bad day" — the first is an admin's typo, the second is not.
func classifyTransportError(err error) (string, string) {
	msg := err.Error()
	lower := strings.ToLower(msg)
	var dnsErr *net.DNSError
	switch {
	case errors.As(err, &dnsErr),
		strings.Contains(lower, "no such host"),
		strings.Contains(lower, "connection refused"),
		strings.Contains(lower, "certificate"),
		strings.Contains(lower, "tls"),
		strings.Contains(lower, "server misbehaving"):
		return testBadBaseURL, "Could not reach the provider: " + msg
	case errors.Is(err, context.DeadlineExceeded),
		strings.Contains(lower, "timeout"),
		strings.Contains(lower, "deadline exceeded"):
		return testUpstreamError, "The provider did not respond in time: " + msg
	default:
		return testUpstreamError, "Request failed: " + msg
	}
}

// mentionsModel reports whether an upstream error blames the model id. Providers
// phrase this a dozen ways ("model not found", "invalid model", "unknown model",
// "does not exist"), so match on the noun plus a negative.
func mentionsModel(s string) bool {
	l := strings.ToLower(s)
	if !strings.Contains(l, "model") {
		return false
	}
	for _, hint := range []string{"not found", "not exist", "unknown", "invalid", "unsupported", "no such", "not available"} {
		if strings.Contains(l, hint) {
			return true
		}
	}
	return false
}

// suggestModelID offers the closest upstream model id already configured for this
// provider. A rejected id is usually a typo or a stale version of a sibling model
// that is known to work, so the nearest configured id is a better hint than a
// generic "check the provider's docs".
// suggestFix turns a classification into the next concrete thing to change. Every
// branch is derived from the FORMAT and from what the upstream actually sent, so a
// provider nobody has seen before is diagnosed the same way as a familiar one.
func (s *Server) suggestFix(
	classification string,
	route providercfg.Route,
	model store.HostedModel,
	providerID int64,
	respBody []byte,
) string {
	switch classification {
	case testUnknownModel:
		return s.suggestModelID(providerID, model.UpstreamModelID)

	case testBadBaseURL:
		// The URL is admin input and any path is legitimate, so the only honest thing
		// to report is what was actually called — plus, when the field was blank, the
		// fact that a fallback path was substituted.
		return describeConfiguredEndpoint(route) +
			" A URL that answers with a web page (or 404s) is not this provider's " +
			formatLabel(route.Format) + " endpoint."

	case testFormatMismatch:
		if spoken := detectResponseFormat(respBody); spoken != "" && spoken != route.Format {
			return "This provider answered in the " + spoken + " format. Set the provider's wire " +
				"format to " + spoken + " (it is currently " + formatLabel(route.Format) + "). " +
				authHint(spoken)
		}
		// JSON, but nothing recognisable: either the format is wrong, or this URL is
		// some other endpoint of the same provider.
		return "The body is JSON but not a completion in any format the gateway knows. " +
			"Confirm the provider's wire format, and that this URL is its completions " +
			"endpoint. " + describeConfiguredEndpoint(route)

	case testBadAPIKey:
		// Before blaming the credential, name the other setting that produces the same
		// 401: an auth scheme the provider does not use.
		return "Check the key itself, then the auth scheme. " + authHint(route.Format)

	case testRateLimited:
		return "The credential is accepted — this is a quota or throughput limit. " +
			"Add a second key to this provider so requests rotate instead of queueing."
	}
	return ""
}

// recordTestKeyFailure is the ADMIN-TEST half of recordKeyFailure: it honours a
// provider's own "later" (429/402, which self-heals when the cooldown elapses) but
// never takes a key out of rotation for a 401/403.
//
// The difference is what the configuration has proven. On the request path the route
// is known to work, so a 401 is genuinely the credential. During a test nothing is
// proven — a misspelled path, an auth scheme the provider does not use, or a login
// page all answer 401/403 — and condemning the key there is a trap: it removes the
// only key, after which the per-model test refuses to run at all and the admin has
// no way left to verify the real fix.
func (s *Server) recordTestKeyFailure(providerID int64, f proxy.KeyFailure) {
	if f.KeyID == 0 {
		return
	}
	if f.RateLimited() {
		s.ent.Keys().MarkRateLimited(providerID, f.KeyID, f.RetryAfter)
		log.Printf("provider test: key #%d rate limited (HTTP %d) — cooling down", f.KeyID, f.Status)
		return
	}
	log.Printf("provider test: key #%d got HTTP %d — left in rotation (a test cannot tell a bad key "+
		"from a bad URL or a wrong auth scheme)", f.KeyID, f.Status)
}

// suggestModelID names the closest configured upstream model id when the provider
// rejects the one that was sent.
func (s *Server) suggestModelID(providerID int64, attempted string) string {
	best, bestDist := "", 1<<31-1
	for _, m := range s.ent.Models() {
		if m.ProviderID != providerID || m.UpstreamModelID == attempted {
			continue
		}
		if d := editDistance(strings.ToLower(attempted), strings.ToLower(m.UpstreamModelID)); d < bestDist {
			best, bestDist = m.UpstreamModelID, d
		}
	}
	// Only suggest a genuinely similar id; an unrelated model is noise.
	if best != "" && bestDist <= maxInt(3, len(attempted)/3) {
		return "Did you mean \"" + best + "\"? Model ids must match the provider's own catalog exactly. " +
			endpointDoubtHint
	}
	return "Check the exact model id in the provider's documentation — it must match their catalog exactly. " +
		endpointDoubtHint
}

// endpointDoubtHint is the second thing to suspect after a model id, and the one
// admins never think of: an endpoint that is not this provider's Anthropic Messages
// URL answers "no such model" for EVERY id, so the failure looks like a typo no
// matter what is typed.
const endpointDoubtHint = "If every model id you try is rejected, the base URL / endpoint path is " +
	"probably not this provider's Messages endpoint — check the Connection section."

// editDistance is Levenshtein distance, used only for the typo suggestion above.
func editDistance(a, b string) int {
	if a == b {
		return 0
	}
	prev := make([]int, len(b)+1)
	cur := make([]int, len(b)+1)
	for j := range prev {
		prev[j] = j
	}
	for i := 1; i <= len(a); i++ {
		cur[0] = i
		for j := 1; j <= len(b); j++ {
			cost := 1
			if a[i-1] == b[j-1] {
				cost = 0
			}
			cur[j] = minInt(minInt(cur[j-1]+1, prev[j]+1), prev[j-1]+cost)
		}
		prev, cur = cur, prev
	}
	return prev[len(b)]
}

// bodySnippet trims an upstream body to something loggable/displayable. Upstream
// errors can be large HTML pages; an admin needs the first line, not the page.
func bodySnippet(body []byte) string {
	const max = 300
	s := strings.TrimSpace(string(body))
	s = strings.Join(strings.Fields(s), " ")
	if s == "" {
		return ""
	}
	if len(s) > max {
		s = s[:max] + "…"
	}
	return s
}

// redactSecret removes the presented key from any text on its way to a client.
// Some providers echo the Authorization header back inside their error payload.
func redactSecret(s, secret string) string {
	if secret == "" {
		return s
	}
	masked := secretbox.Mask(secret)
	out := strings.ReplaceAll(s, secret, masked)
	// Long keys often appear truncated in upstream messages; drop the prefix too.
	if len(secret) > 12 {
		out = strings.ReplaceAll(out, secret[:12], masked)
	}
	return out
}

func itoa(n int) string { return strconv.Itoa(n) }

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}
