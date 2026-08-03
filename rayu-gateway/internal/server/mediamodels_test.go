package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/choeng-rayu/rayu-gateway/internal/entitlements"
	"github.com/choeng-rayu/rayu-gateway/internal/store"
)

// mediaCatalogFixture is a small stand-in for the media_models table: one image
// model on every plan, one image model restricted to max, and one video model
// that declares BOTH capabilities (the cosmos-predict1-5b case).
func mediaCatalogFixture() []store.MediaModel {
	est := 120
	return []store.MediaModel{
		{
			Code: "black-forest-labs/flux.1-schnell", Label: "FLUX.1 Schnell",
			MediaType: "image", Capabilities: []string{"generate"},
			Backend: "nvidia", Family: "flux",
			DefaultParams: json.RawMessage(`{"cfg_scale":0,"steps":4}`),
			IsDefault:     true, Enabled: true,
		},
		{
			Code: "imagen-4.0-ultra-generate-001", Label: "Imagen 4 Ultra",
			MediaType: "image", Capabilities: []string{"generate"},
			Backend: "vertex", Family: "imagen",
			// Plan-restricted: a pro caller must not see this one.
			AllowedPlanCodes: []string{"max"}, Enabled: true,
		},
		{
			Code: "nvidia/cosmos-predict1-5b", Label: "Cosmos Predict1 5B",
			MediaType: "video", Capabilities: []string{"text2video", "image2video"},
			Backend: "nvcf", Family: "cosmos-predict1",
			NvcfFunctionID:   "eef816a3-3940-413b-93c9-513ae29f34f9",
			EstimatedSeconds: &est, IsDefault: true, Enabled: true,
		},
		{
			// Disabled rows must never be served.
			Code: "nvidia/retired-model", Label: "Retired",
			MediaType: "video", Capabilities: []string{"text2video"},
			Backend: "nvcf", Family: "cosmos3-nano", Enabled: false,
		},
	}
}

func mediaFakeEnt() *fakeEnt {
	return &fakeEnt{
		ent: entitlements.Entitlement{
			UserID: 31, Status: "active",
			Plan: store.Plan{Code: "pro", Name: "Pro"},
			AllowedModels: []store.HostedModel{
				{Code: "deepseek-v4-pro", Label: "DeepSeek V4 Pro", Enabled: true},
			},
		},
		settings:     store.AppSettings{BaselineCreditsPer1M: 1000},
		mediaCatalog: mediaCatalogFixture(),
	}
}

type mediaListResponse struct {
	Object string `json:"object"`
	Media  string `json:"media"`
	Data   []struct {
		ID               string          `json:"id"`
		Label            string          `json:"label"`
		MediaType        string          `json:"mediaType"`
		Capabilities     []string        `json:"capabilities"`
		Backend          string          `json:"backend"`
		Family           string          `json:"family"`
		DefaultParams    json.RawMessage `json:"defaultParams"`
		NvcfFunctionID   *string         `json:"nvcfFunctionId"`
		EstimatedSeconds *int            `json:"estimatedSeconds"`
		Default          bool            `json:"default"`
	} `json:"data"`
}

func getMedia(t *testing.T, h http.Handler, query string) (*httptest.ResponseRecorder, mediaListResponse) {
	t.Helper()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/models"+query, nil)
	req.Header.Set("Authorization", "Bearer "+accessToken(t, 31))
	h.ServeHTTP(rec, req)
	var body mediaListResponse
	if rec.Code == http.StatusOK {
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatalf("decode: %v (body=%s)", err, rec.Body.String())
		}
	}
	return rec, body
}

// The image filter returns image models only, with everything the CLI needs to
// build an upstream request — and nothing the caller's plan may not use.
func TestHandleModelsMediaImage(t *testing.T) {
	h, _ := chatHarness(t, mediaFakeEnt())
	rec, body := getMedia(t, h, "?media=image")
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	if body.Media != "image" {
		t.Fatalf("media echo=%q, want image", body.Media)
	}
	if len(body.Data) != 1 {
		t.Fatalf("expected only the unrestricted image model for pro, got %+v", body.Data)
	}
	m := body.Data[0]
	if m.ID != "black-forest-labs/flux.1-schnell" {
		t.Fatalf("id=%q", m.ID)
	}
	if m.MediaType != "image" || m.Backend != "nvidia" || m.Family != "flux" {
		t.Fatalf("media metadata missing: %+v", m)
	}
	if len(m.Capabilities) != 1 || m.Capabilities[0] != "generate" {
		t.Fatalf("capabilities=%v", m.Capabilities)
	}
	if !m.Default {
		t.Fatal("expected the seeded default flag to survive")
	}
	// Per-model request defaults are what let two models share one family, so they
	// must reach the client verbatim.
	var defaults map[string]float64
	if err := json.Unmarshal(m.DefaultParams, &defaults); err != nil {
		t.Fatalf("defaultParams: %v", err)
	}
	if defaults["steps"] != 4 || defaults["cfg_scale"] != 0 {
		t.Fatalf("defaultParams=%v", defaults)
	}
	if m.NvcfFunctionID != nil {
		t.Fatalf("image model should carry no NVCF function id, got %v", *m.NvcfFunctionID)
	}
}

// Video models carry the NVCF function id + duration estimate the CLI needs, and
// a model that does both text2video and image2video reports both.
func TestHandleModelsMediaVideo(t *testing.T) {
	h, _ := chatHarness(t, mediaFakeEnt())
	rec, body := getMedia(t, h, "?media=video")
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	if len(body.Data) != 1 {
		t.Fatalf("expected 1 enabled video model, got %+v", body.Data)
	}
	m := body.Data[0]
	if m.NvcfFunctionID == nil || *m.NvcfFunctionID != "eef816a3-3940-413b-93c9-513ae29f34f9" {
		t.Fatalf("nvcfFunctionId=%v", m.NvcfFunctionID)
	}
	if m.EstimatedSeconds == nil || *m.EstimatedSeconds != 120 {
		t.Fatalf("estimatedSeconds=%v", m.EstimatedSeconds)
	}
	if len(m.Capabilities) != 2 {
		t.Fatalf("expected both video capabilities, got %v", m.Capabilities)
	}
}

// media=all returns both catalogs in one response, each item tagged so the client
// can split them without a second request.
func TestHandleModelsMediaAll(t *testing.T) {
	h, _ := chatHarness(t, mediaFakeEnt())
	rec, body := getMedia(t, h, "?media=all")
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d, want 200", rec.Code)
	}
	var images, videos int
	for _, m := range body.Data {
		switch m.MediaType {
		case "image":
			images++
		case "video":
			videos++
		}
	}
	if images != 1 || videos != 1 {
		t.Fatalf("images=%d videos=%d, want 1/1 (body=%s)", images, videos, rec.Body.String())
	}
}

// The default (no media param) response is the CHAT catalog, unchanged: media
// models must never leak into a chat client's model list.
func TestHandleModelsWithoutMediaParamStaysChatOnly(t *testing.T) {
	h, _ := chatHarness(t, mediaFakeEnt())
	rec, _ := getMedia(t, h, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d, want 200", rec.Code)
	}
	var body struct {
		Data []struct {
			ID        string `json:"id"`
			MediaType string `json:"mediaType"`
		} `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(body.Data) != 1 || body.Data[0].ID != "deepseek-v4-pro" {
		t.Fatalf("chat catalog changed: %+v", body.Data)
	}
	if body.Data[0].MediaType != "" {
		t.Fatalf("chat item gained a mediaType: %+v", body.Data[0])
	}
}

// An unknown filter is a client bug; it must be reported, not silently treated
// as "give me the chat models" (which would look like the media catalog is empty).
func TestHandleModelsRejectsUnknownMediaFilter(t *testing.T) {
	h, _ := chatHarness(t, mediaFakeEnt())
	rec, _ := getMedia(t, h, "?media=audio")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status=%d, want 400; body=%s", rec.Code, rec.Body.String())
	}
}

// A database that predates the media_models migration has no catalog at all. The
// endpoint must answer with an empty list (so the CLI can fall back cleanly)
// rather than a 500 or a null `data`.
func TestHandleModelsMediaEmptyCatalog(t *testing.T) {
	fe := mediaFakeEnt()
	fe.mediaCatalog = nil
	h, _ := chatHarness(t, fe)
	rec, body := getMedia(t, h, "?media=image")
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d, want 200", rec.Code)
	}
	if body.Data == nil {
		t.Fatal("data must be an empty array, not null")
	}
	if len(body.Data) != 0 {
		t.Fatalf("expected empty catalog, got %+v", body.Data)
	}
}

// A plan-restricted model becomes visible once the caller is on that plan —
// proving the per-plan filter is applied from the live catalog, not baked in.
func TestHandleModelsMediaPlanFilter(t *testing.T) {
	fe := mediaFakeEnt()
	fe.ent.Plan = store.Plan{Code: "max", Name: "Max"}
	h, _ := chatHarness(t, fe)
	_, body := getMedia(t, h, "?media=image")
	if len(body.Data) != 2 {
		t.Fatalf("expected both image models on max, got %+v", body.Data)
	}
}
