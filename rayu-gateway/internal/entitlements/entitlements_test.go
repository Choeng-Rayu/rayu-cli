package entitlements

import (
	"testing"

	"github.com/choeng-rayu/rayu-gateway/internal/store"
)

func TestAllowedModels(t *testing.T) {
	models := []store.HostedModel{
		{Code: "deepseek-v4-flash", Enabled: true, AllowedPlanCodes: []string{"pro", "pro_plus", "max"}},
		{Code: "deepseek-v4-pro", Enabled: true, AllowedPlanCodes: []string{"pro", "pro_plus", "max"}},
		{Code: "disabled-model", Enabled: false, AllowedPlanCodes: []string{"pro"}},
		{Code: "ultra-only", Enabled: true, AllowedPlanCodes: []string{"max"}},
	}

	pro := AllowedModels(models, "pro")
	if len(pro) != 2 {
		t.Fatalf("pro should see 2 models, got %d", len(pro))
	}

	free := AllowedModels(models, "free")
	if len(free) != 0 {
		t.Fatalf("free should see 0 models, got %d", len(free))
	}

	max := AllowedModels(models, "max")
	if len(max) != 3 {
		t.Fatalf("max should see 3 models (flash, pro, ultra-only), got %d", len(max))
	}

	// All three paid plan codes (matching MODEL_SEED.allowedPlanCodes) must see
	// the shared hosted models.
	proPlus := AllowedModels(models, "pro_plus")
	if len(proPlus) != 2 {
		t.Fatalf("pro_plus should see 2 models (flash, pro), got %d", len(proPlus))
	}
}
