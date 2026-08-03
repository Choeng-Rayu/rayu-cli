// Package store provides read access to the shared MySQL database. It mirrors
// the Prisma schema's table/column names and applies the same active-plan
// resolution (most-recent active subscription, free fallback) plus 30-day
// expiry handling.
package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"time"

	_ "github.com/go-sql-driver/mysql"
)

// Provider mirrors a row in `providers`: the admin-managed registry that tells
// the gateway HOW to talk to an upstream (wire format, URL, auth scheme). It
// replaced the RAYU_PROVIDERS / RAYU_DISABLED_PROVIDERS / OLLAMA_PROVIDER_NAME
// env registry.
//
// SECURITY: no credential lives on this row. A provider's keys are separate
// provider_api_keys rows, encrypted at rest (see LoadProviderKeys). Fields are
// json:"-" except the ones safe to expose, because HostedModel is serialized to
// clients.
type Provider struct {
	ID           int64  `json:"-"`
	Name         string `json:"name"`
	Label        string `json:"-"`
	Format       string `json:"-"`
	BaseURL      string `json:"-"`
	EndpointPath string `json:"-"`
	AuthScheme   string `json:"-"`
	Enabled      bool   `json:"-"`
}

// HostedModel mirrors a row in hosted_models. The four credit charges
// (CreditMultiplier = input, OutputCreditMultiplier, CacheRead…, CacheWrite…) are
// ADMIN-ENTERED and used verbatim by credits.ModelRatesFor — nothing is derived
// from the cost prices, which feed only the internal cost ledger.
//
// Routing lives entirely on Provider: a model contributes only its upstream
// model id. SupportsReasoning/SupportsImage are the per-model capability flags
// the gateway enforces (before charging credits) and exposes to the CLI.
type HostedModel struct {
	Code                       string   `json:"code"`
	Label                      string   `json:"label"`
	ProviderID                 int64    `json:"-"`
	Provider                   Provider `json:"provider"`
	UpstreamModelID            string   `json:"-"`
	InputPricePer1MCents       int      `json:"-"`
	OutputPricePer1MCents      int      `json:"-"`
	CreditMultiplier           float64  `json:"creditMultiplier"`
	OutputCreditMultiplier     float64  `json:"-"`
	CacheReadCreditMultiplier  float64  `json:"-"`
	CacheWriteCreditMultiplier float64  `json:"-"`
	AllowedPlanCodes           []string `json:"-"`
	// ContextWindow is the admin-set window in TOKENS, or nil when the admin has
	// not set one (the client then keeps its own default for the model).
	ContextWindow     *int `json:"contextWindow"`
	SupportsReasoning bool `json:"supportsReasoning"`
	SupportsImage     bool `json:"supportsImage"`
	SupportsTools     bool `json:"supportsTools"`
	Enabled           bool `json:"-"`
}

// ProviderName is the provider slug this model routes through (used in logs and
// per-provider key rotation).
func (m HostedModel) ProviderName() string { return m.Provider.Name }

// AppSettings mirrors the singleton app_settings row.
type AppSettings struct {
	BaselineCreditsPer1M int
	MaxConcurrentStreams int
	MaxTokensPerRequest  int
	MaxRequestsPer5h     int
	// Credit top-up pricing, as the admin set it: how many credits $1 buys
	// (0 = top-up unavailable) and the smallest purchase in cents. Reported to
	// clients so the CLI can quote a price without calling the backend.
	CreditsPerDollar int
	MinTopupCents    int
}

// Plan mirrors a plan, with the credit fields decoded from its limits JSON.
type Plan struct {
	ID               int64  `json:"-"`
	Code             string `json:"code"`
	Name             string `json:"name"`
	PriceCents       int    `json:"priceCents"`
	CreditsPerPeriod *int64 `json:"creditsPerPeriod"` // per-billing-period balance; nil = none
	TopUpEnabled     bool   `json:"topUpEnabled"`
	MaxDailyTurns    *int64 `json:"maxDailyTurns"` // per-day turn cap; nil = unlimited
}

// Store wraps the database handle.
type Store struct{ db *sql.DB }

// Pool sizing for a gateway that serves concurrent streaming chat/proxy
// traffic. The prior defaults (10 open / 5 idle) starved under load: once
// concurrent requests exceeded 10, QueryContext/ExecContext calls queued
// waiting for a free connection with no explicit acquire timeout, so the
// gateway appeared to hang instead of failing fast — which is what turns
// into a client-visible 502 once the reverse proxy in front of it times out.
//
// 64 open / 16 idle gives the gateway headroom for concurrent entitlement
// lookups (cache-miss path: 3 sequential queries) plus the async ledger/
// usage-event writer, while staying well under MySQL's default
// max_connections (151) even with the backend's own Prisma pool sharing the
// same instance. Tune via env if a deployment's MySQL is sized differently.
const (
	defaultMaxOpenConns    = 64
	defaultMaxIdleConns    = 16
	defaultConnMaxLifetime = 3 * time.Minute
	// Idle connections older than this are closed even if MaxIdleConns has
	// room, so a load spike's connections get reaped afterward instead of
	// sitting open indefinitely.
	defaultConnMaxIdleTime = 90 * time.Second
)

// Open connects to MySQL with a pool sized for concurrent gateway traffic and
// verifies connectivity.
func Open(dsn string) (*Store, error) {
	db, err := sql.Open("mysql", dsn)
	if err != nil {
		return nil, err
	}
	db.SetConnMaxLifetime(defaultConnMaxLifetime)
	db.SetConnMaxIdleTime(defaultConnMaxIdleTime)
	db.SetMaxOpenConns(defaultMaxOpenConns)
	db.SetMaxIdleConns(defaultMaxIdleConns)
	if err := db.Ping(); err != nil {
		return nil, err
	}
	return &Store{db: db}, nil
}

// Close releases the connection pool.
func (s *Store) Close() error { return s.db.Close() }

// DB exposes the underlying handle (used by the ledger writer).
func (s *Store) DB() *sql.DB { return s.db }

// planLimits holds the gateway-relevant fields decoded from a plan's limits JSON.
type planLimits struct {
	creditsPerPeriod *int64
	maxDailyTurns    *int64
	topUpEnabled     bool
}

// parseLimits decodes the gateway-relevant fields from a plan's limits JSON.
// All fields are optional; a missing/invalid blob yields the zero value
// (nil caps = unlimited, top-up disabled).
func parseLimits(raw []byte) planLimits {
	out := planLimits{}
	if len(raw) == 0 {
		return out
	}
	var l struct {
		CreditsPerPeriod *float64 `json:"creditsPerPeriod"`
		MaxDailyTurns    *float64 `json:"maxDailyTurns"`
		TopUpEnabled     bool     `json:"topUpEnabled"`
	}
	if json.Unmarshal(raw, &l) != nil {
		return out
	}
	out.topUpEnabled = l.TopUpEnabled
	if l.CreditsPerPeriod != nil {
		v := int64(*l.CreditsPerPeriod)
		out.creditsPerPeriod = &v
	}
	if l.MaxDailyTurns != nil {
		v := int64(*l.MaxDailyTurns)
		out.maxDailyTurns = &v
	}
	return out
}

// loadModelsQuery joins hosted_models to its provider registry row in ONE query.
// A join (not a second lookup per model) keeps the periodic config refresh to a
// single round-trip regardless of catalog size — the whole catalog is then served
// from memory, so no request ever pays for this.
const loadModelsQuery = `SELECT
	m.code, m.label, m.provider_id, m.upstreamModelId,
	m.inputPricePer1MCents, m.outputPricePer1MCents, m.creditMultiplier,
	m.outputCreditMultiplier, m.cacheReadCreditMultiplier, m.cacheWriteCreditMultiplier,
	m.allowedPlanCodes, m.contextWindow,
	m.supportsReasoning, m.supportsImage, m.supportsTools, m.enabled,
	p.name, p.label, p.format, p.baseUrl, p.endpointPath, p.authScheme, p.enabled
FROM hosted_models m
JOIN providers p ON p.id = m.provider_id`

// LoadModels returns all hosted_models rows with their provider registry row
// attached (the gateway needs both to route: provider = where/how, model = which
// upstream model id).
func (s *Store) LoadModels(ctx context.Context) ([]HostedModel, error) {
	rows, err := s.db.QueryContext(ctx, loadModelsQuery)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []HostedModel
	for rows.Next() {
		var m HostedModel
		var allowed []byte
		var contextWindow sql.NullInt64
		var endpointPath sql.NullString
		if err := rows.Scan(
			&m.Code, &m.Label, &m.ProviderID, &m.UpstreamModelID,
			&m.InputPricePer1MCents, &m.OutputPricePer1MCents, &m.CreditMultiplier,
			&m.OutputCreditMultiplier, &m.CacheReadCreditMultiplier, &m.CacheWriteCreditMultiplier,
			&allowed, &contextWindow,
			&m.SupportsReasoning, &m.SupportsImage, &m.SupportsTools, &m.Enabled,
			&m.Provider.Name, &m.Provider.Label, &m.Provider.Format, &m.Provider.BaseURL,
			&endpointPath, &m.Provider.AuthScheme, &m.Provider.Enabled,
		); err != nil {
			return nil, err
		}
		m.Provider.ID = m.ProviderID
		if contextWindow.Valid && contextWindow.Int64 > 0 {
			v := int(contextWindow.Int64)
			m.ContextWindow = &v
		}
		if endpointPath.Valid {
			m.Provider.EndpointPath = endpointPath.String
		}
		if len(allowed) > 0 {
			_ = json.Unmarshal(allowed, &m.AllowedPlanCodes)
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// MediaModel mirrors a row in media_models: the admin-owned catalog of IMAGE-
// and VIDEO-generation models the CLI offers.
//
// Unlike HostedModel this is NOT a routing record. Media generation is not
// proxied by the gateway — the CLI calls NVIDIA / Vertex / fal directly with the
// user's own key — so there is no provider, wire format, or credential here. The
// gateway serves it purely so the CLI has a single, plan-filtered, server-owned
// catalog instead of a hardcoded registry.
//
// Every field is exposed to the client (no json:"-"): the CLI needs all of it to
// build a request without hardcoding anything.
type MediaModel struct {
	Code  string `json:"id"`
	Label string `json:"label"`
	// "image" | "video".
	MediaType string `json:"mediaType"`
	// image: generate/edit; video: text2video/image2video. An array because some
	// models do both (cosmos-predict1-5b takes an optional input image).
	Capabilities []string `json:"capabilities"`
	// Upstream that serves it: nvidia | vertex | nvcf | nvidia-svd | fal.
	Backend string `json:"backend"`
	// Request-SHAPE family. The CLI keys its body builder off this string, so a
	// new model reusing a known shape needs no client release.
	Family string `json:"family"`
	// NVCF function UUID; empty for models that don't need one.
	NvcfFunctionID string `json:"nvcfFunctionId,omitempty"`
	// Rough generation seconds for the client's wait message; nil = unknown.
	EstimatedSeconds *int `json:"estimatedSeconds"`
	// Per-model request defaults merged into the family body builder, kept as raw
	// JSON: the gateway has no business interpreting upstream request params, it
	// just carries what the admin configured.
	DefaultParams json.RawMessage `json:"defaultParams,omitempty"`
	// Plans allowed to use it. EMPTY = every plan (media generation is gated by
	// the image_generation/video_generation feature flags, not per model).
	AllowedPlanCodes []string `json:"-"`
	// Preferred pick for its (mediaType, backend) pair.
	IsDefault bool `json:"default"`
	SortOrder int  `json:"-"`
	Enabled   bool `json:"-"`
}

const loadMediaModelsQuery = `SELECT
	code, label, mediaType, capabilities, backend, family,
	nvcfFunctionId, estimatedSeconds, defaultParams, allowedPlanCodes,
	isDefault, sortOrder, enabled
FROM media_models
ORDER BY mediaType, sortOrder, id`

// LoadMediaModels returns the whole media_models catalog in display order.
//
// A MISSING TABLE is not an error here: the gateway must keep serving chat
// traffic on a database that predates this migration, so the caller treats an
// empty media catalog as "no media models configured" rather than failing its
// config refresh (which would take the whole gateway down).
func (s *Store) LoadMediaModels(ctx context.Context) ([]MediaModel, error) {
	rows, err := s.db.QueryContext(ctx, loadMediaModelsQuery)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []MediaModel
	for rows.Next() {
		var m MediaModel
		var caps, allowed, defaults []byte
		var fnID sql.NullString
		var estimated sql.NullInt64
		if err := rows.Scan(
			&m.Code, &m.Label, &m.MediaType, &caps, &m.Backend, &m.Family,
			&fnID, &estimated, &defaults, &allowed,
			&m.IsDefault, &m.SortOrder, &m.Enabled,
		); err != nil {
			return nil, err
		}
		if fnID.Valid {
			m.NvcfFunctionID = fnID.String
		}
		if estimated.Valid && estimated.Int64 > 0 {
			v := int(estimated.Int64)
			m.EstimatedSeconds = &v
		}
		if len(caps) > 0 {
			_ = json.Unmarshal(caps, &m.Capabilities)
		}
		if len(allowed) > 0 {
			_ = json.Unmarshal(allowed, &m.AllowedPlanCodes)
		}
		// Carried through verbatim; only kept when it is valid JSON so a corrupt
		// column can never make the client's response unparseable.
		if len(defaults) > 0 && json.Valid(defaults) {
			m.DefaultParams = json.RawMessage(defaults)
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// HasCapability reports whether the model declares the given capability.
func (m MediaModel) HasCapability(c string) bool {
	for _, have := range m.Capabilities {
		if have == c {
			return true
		}
	}
	return false
}

// ProviderKey mirrors a row in provider_api_keys. EncryptedKey is an AES-256-GCM
// envelope the gateway opens with RAYU_PROVIDER_SECRET (see internal/secretbox);
// the plaintext exists only in gateway memory. MaskedKey is what may be logged.
type ProviderKey struct {
	ID            int64
	ProviderID    int64
	Label         string
	EncryptedKey  string
	MaskedKey     string
	Priority      int
	Enabled       bool
	Status        string
	CooldownUntil *time.Time
}

// LoadProviderKeys returns every provider API key, in the order the gateway
// should try them. One query for all providers keeps the periodic config refresh
// to a fixed number of round-trips regardless of how many providers exist.
func (s *Store) LoadProviderKeys(ctx context.Context) ([]ProviderKey, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, provider_id, label, encryptedKey, maskedKey, priority, enabled, status, cooldownUntil
		 FROM provider_api_keys
		 ORDER BY provider_id, priority, id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ProviderKey
	for rows.Next() {
		var k ProviderKey
		var cooldown sql.NullTime
		if err := rows.Scan(&k.ID, &k.ProviderID, &k.Label, &k.EncryptedKey,
			&k.MaskedKey, &k.Priority, &k.Enabled, &k.Status, &cooldown); err != nil {
			return nil, err
		}
		if cooldown.Valid {
			t := cooldown.Time
			k.CooldownUntil = &t
		}
		out = append(out, k)
	}
	return out, rows.Err()
}

// UpdateProviderKeyState persists what the gateway observed about a key (health,
// cooldown, last use). Called from the bounded write queue, never on the request
// path — a billing/health write must not add latency to a completion.
func (s *Store) UpdateProviderKeyState(
	ctx context.Context,
	keyID int64,
	status string,
	cooldownUntil *time.Time,
	lastError string,
	usedAt time.Time,
) error {
	var errArg any
	if lastError != "" {
		errArg = lastError
	}
	var coolArg any
	if cooldownUntil != nil && !cooldownUntil.IsZero() {
		coolArg = *cooldownUntil
	}
	_, err := s.db.ExecContext(ctx,
		`UPDATE provider_api_keys
		    SET status = ?, cooldownUntil = ?, lastError = ?, lastUsedAt = ?, updatedAt = NOW(3)
		  WHERE id = ?`,
		status, coolArg, errArg, usedAt, keyID)
	return err
}

// LoadProviders returns the full provider registry, including providers that
// currently have no models (the admin health view needs those too).
func (s *Store) LoadProviders(ctx context.Context) ([]Provider, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, name, label, format, baseUrl, endpointPath, authScheme, enabled FROM providers ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Provider
	for rows.Next() {
		var p Provider
		var endpointPath sql.NullString
		if err := rows.Scan(&p.ID, &p.Name, &p.Label, &p.Format, &p.BaseURL,
			&endpointPath, &p.AuthScheme, &p.Enabled); err != nil {
			return nil, err
		}
		if endpointPath.Valid {
			p.EndpointPath = endpointPath.String
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// LoadSettings returns the singleton app_settings row (id=1).
func (s *Store) LoadSettings(ctx context.Context) (AppSettings, error) {
	var a AppSettings
	err := s.db.QueryRowContext(ctx, `SELECT baselineCreditsPer1M,maxConcurrentStreams,maxTokensPerRequest,maxRequestsPer5h,creditsPerDollar,minTopupCents FROM app_settings WHERE id=1`).
		Scan(&a.BaselineCreditsPer1M, &a.MaxConcurrentStreams, &a.MaxTokensPerRequest,
			&a.MaxRequestsPer5h, &a.CreditsPerDollar, &a.MinTopupCents)
	if err == sql.ErrNoRows {
		return AppSettings{BaselineCreditsPer1M: 1000, MaxConcurrentStreams: 3}, nil
	}
	return a, err
}

// UserStatus returns the user's status ("active"/"suspended"/"banned"), or ""
// when the user does not exist.
func (s *Store) UserStatus(ctx context.Context, userID int64) (string, error) {
	var status string
	err := s.db.QueryRowContext(ctx, `SELECT status FROM users WHERE id=?`, userID).Scan(&status)
	if err == sql.ErrNoRows {
		return "", nil
	}
	return status, err
}

// PlanByCode loads a single plan by its code.
func (s *Store) PlanByCode(ctx context.Context, code string) (*Plan, error) {
	var p Plan
	var limits []byte
	err := s.db.QueryRowContext(ctx, `SELECT id,code,name,priceCents,limits FROM plans WHERE code=?`, code).
		Scan(&p.ID, &p.Code, &p.Name, &p.PriceCents, &limits)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	lim := parseLimits(limits)
	p.CreditsPerPeriod, p.TopUpEnabled, p.MaxDailyTurns = lim.creditsPerPeriod, lim.topUpEnabled, lim.maxDailyTurns
	return &p, nil
}

// ActivePlan returns the user's active, non-expired plan plus the period end,
// falling back to the free plan (periodEnd nil) when there is no active
// subscription or it has expired.
func (s *Store) ActivePlan(ctx context.Context, userID int64, now time.Time) (*Plan, *time.Time, error) {
	var p Plan
	var limits []byte
	var periodEnd sql.NullTime
	err := s.db.QueryRowContext(ctx, `SELECT p.id,p.code,p.name,p.priceCents,p.limits,s.currentPeriodEnd FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.user_id=? AND s.status='active' ORDER BY s.startedAt DESC LIMIT 1`, userID).
		Scan(&p.ID, &p.Code, &p.Name, &p.PriceCents, &limits, &periodEnd)
	if err == sql.ErrNoRows {
		pl, e := s.PlanByCode(ctx, "free")
		return pl, nil, e
	}
	if err != nil {
		return nil, nil, err
	}
	// 30-day expiry: a paid period that has lapsed reverts to free.
	if periodEnd.Valid && periodEnd.Time.Before(now) {
		pl, e := s.PlanByCode(ctx, "free")
		return pl, nil, e
	}
	lim := parseLimits(limits)
	p.CreditsPerPeriod, p.TopUpEnabled, p.MaxDailyTurns = lim.creditsPerPeriod, lim.topUpEnabled, lim.maxDailyTurns
	var pe *time.Time
	if periodEnd.Valid {
		t := periodEnd.Time
		pe = &t
	}
	return &p, pe, nil
}

// TopupBalance returns remaining pay-as-you-go credits: granted (paid topups)
// minus consumed (ledger rows with source='topup'). Never negative.
func (s *Store) TopupBalance(ctx context.Context, userID int64) (int64, error) {
	var granted, consumed sql.NullInt64
	if err := s.db.QueryRowContext(ctx, `SELECT COALESCE(SUM(credits),0) FROM credit_topups WHERE user_id=? AND status='paid'`, userID).Scan(&granted); err != nil {
		return 0, err
	}
	if err := s.db.QueryRowContext(ctx, `SELECT COALESCE(SUM(credits),0) FROM credit_ledger WHERE user_id=? AND source='topup'`, userID).Scan(&consumed); err != nil {
		return 0, err
	}
	bal := granted.Int64 - consumed.Int64
	if bal < 0 {
		bal = 0
	}
	return bal, nil
}

// InsertUsageEvent records a tracking row for a BYO-key request routed through
// the gateway proxy and bumps the user's lastActiveAt. This mirrors the backend
// /usage endpoint (table usage_events) but is written server-side so it cannot
// be skipped by the client. No credits are charged on this path. source is
// typically "gateway"; model may be empty (stored as NULL).
func (s *Store) InsertUsageEvent(ctx context.Context, userID int64, provider, model, source string) error {
	var modelArg any
	if model != "" {
		modelArg = model
	}
	if _, err := s.db.ExecContext(ctx,
		`INSERT INTO usage_events (user_id, provider, model, source) VALUES (?,?,?,?)`,
		userID, provider, modelArg, source,
	); err != nil {
		return err
	}
	_, err := s.db.ExecContext(ctx, `UPDATE users SET lastActiveAt=NOW(3) WHERE id=?`, userID)
	return err
}

// InsertLedger writes a durable credit consumption row (source = "plan"|"topup").
func (s *Store) InsertLedger(ctx context.Context, userID int64, modelCode string, inTok, outTok int, creditsConsumed int64, realCostCents int, source string) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO credit_ledger (user_id, modelCode, inTokens, outTokens, credits, realCostCents, source, createdAt) VALUES (?,?,?,?,?,?,?,NOW())`,
		userID, modelCode, inTok, outTok, creditsConsumed, realCostCents, source,
	)
	return err
}

// --- Teams (organization-owned subscription + shared credit pool) ------------
//
// A team member's request is billed to the ORG, not to the member's own
// subscription: the org owns the plan, a shared pool caps total team usage, and
// each member holds a bucket carved out of that pool. None of the per-user
// queries above change — a member with no org claim in their JWT never reaches
// any of the code below.

// OrgMemberState is everything the gateway needs to bill one team member: the
// org and seat status, the ORG's plan, and both credit tiers (the member's own
// bucket and the shared pool).
type OrgMemberState struct {
	OrgID        int64
	OrgStatus    string // organizations.status:        active | suspended
	MemberStatus string // organization_members.status: active | removed
	MemberRole   string
	// SubStatus is "" when the team never bought a plan.
	SubStatus     string
	Plan          Plan
	HasPlan       bool
	PeriodEnd     *time.Time
	BucketQuota   int64
	BucketCredits int64
	PoolTotal     int64
	PoolUsed      int64
	// PoolExtra is what the team BOUGHT for this period (credit_pools.
	// extra_credits), on top of the plan's allowance. It is part of the hard cap,
	// so it has to be read on the request path — a team that bought credits and
	// could not spend them would be the worst possible outcome of this feature.
	PoolExtra int64
}

// PoolRemaining is the team's unspent allowance — the HARD cap on team usage.
// Purchased credits count: the plan's allowance is spent first only because
// PoolUsed is one counter across both tiers.
func (o OrgMemberState) PoolRemaining() int64 {
	rem := o.PoolTotal + o.PoolExtra - o.PoolUsed
	if rem < 0 {
		return 0
	}
	return rem
}

// PurchasedRemaining is how much of the PURCHASED credits is left, which is what
// an admin needs to see to decide whether to buy more. Spending fills the plan's
// allowance first, so purchased credits are only touched once PoolUsed passes
// PoolTotal.
func (o OrgMemberState) PurchasedRemaining() int64 {
	if o.PoolExtra <= 0 {
		return 0
	}
	intoExtra := o.PoolUsed - o.PoolTotal
	if intoExtra < 0 {
		intoExtra = 0
	}
	rem := o.PoolExtra - intoExtra
	if rem < 0 {
		return 0
	}
	return rem
}

// Usable reports whether this member may spend the team's credits right now, and
// why not when they may not. The reason strings are stable so the HTTP layer can
// map them to a message without re-deriving the logic.
func (o OrgMemberState) Usable(now time.Time) (bool, string) {
	switch {
	case o.OrgStatus != "active":
		return false, "team_suspended"
	case o.MemberStatus != "active":
		return false, "membership_removed"
	case !o.HasPlan || o.SubStatus == "":
		return false, "team_no_plan"
	case o.SubStatus != "active":
		return false, "team_" + o.SubStatus // e.g. team_past_due, team_canceled
	case o.PeriodEnd != nil && o.PeriodEnd.Before(now):
		return false, "team_period_ended"
	}
	return true, ""
}

// orgMemberStateQuery resolves the seat, the org, its subscription/plan and its
// pool in ONE round trip. LEFT JOINs keep a team that has not paid yet
// resolvable (it comes back with HasPlan=false) instead of looking like a
// missing membership.
const orgMemberStateQuery = `SELECT
	o.status, m.status, m.role, m.bucket_quota, m.bucket_credits,
	s.status, s.currentPeriodEnd,
	p.id, p.code, p.name, p.priceCents, p.limits,
	cp.total_credits, cp.used_credits, cp.extra_credits
FROM organization_members m
JOIN organizations o ON o.id = m.organization_id
LEFT JOIN organization_subscriptions s ON s.organization_id = m.organization_id
LEFT JOIN plans p ON p.id = s.plan_id
LEFT JOIN credit_pools cp ON cp.organization_id = m.organization_id
WHERE m.organization_id = ? AND m.user_id = ?`

// OrgMemberState loads a team member's billing state. Returns (nil, nil) when the
// user holds no seat in that org — a stale org claim then falls back to
// individual billing rather than failing the request.
func (s *Store) OrgMemberState(ctx context.Context, orgID, userID int64) (*OrgMemberState, error) {
	var (
		st         OrgMemberState
		subStatus  sql.NullString
		periodEnd  sql.NullTime
		planID     sql.NullInt64
		planCode   sql.NullString
		planName   sql.NullString
		planPrice  sql.NullInt64
		planLimits []byte
		poolTotal  sql.NullInt64
		poolUsed   sql.NullInt64
		poolExtra  sql.NullInt64
	)
	err := s.db.QueryRowContext(ctx, orgMemberStateQuery, orgID, userID).Scan(
		&st.OrgStatus, &st.MemberStatus, &st.MemberRole, &st.BucketQuota, &st.BucketCredits,
		&subStatus, &periodEnd,
		&planID, &planCode, &planName, &planPrice, &planLimits,
		&poolTotal, &poolUsed, &poolExtra,
	)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	st.OrgID = orgID
	if subStatus.Valid {
		st.SubStatus = subStatus.String
	}
	if periodEnd.Valid {
		t := periodEnd.Time
		st.PeriodEnd = &t
	}
	if planID.Valid && planCode.Valid {
		st.HasPlan = true
		st.Plan = Plan{
			ID:         planID.Int64,
			Code:       planCode.String,
			Name:       planName.String,
			PriceCents: int(planPrice.Int64),
		}
		lim := parseLimits(planLimits)
		st.Plan.CreditsPerPeriod = lim.creditsPerPeriod
		st.Plan.TopUpEnabled = lim.topUpEnabled
		st.Plan.MaxDailyTurns = lim.maxDailyTurns
	}
	st.PoolTotal = poolTotal.Int64
	st.PoolUsed = poolUsed.Int64
	st.PoolExtra = poolExtra.Int64
	return &st, nil
}

// DebitOrgMember persists one settled team charge: the member's bucket goes down
// (floored at 0 — an overflow was served by the pool, not by a negative bucket)
// and the pool's used counter goes up. Both in one transaction, because a bucket
// debit without the matching pool debit would let the team exceed its cap.
//
// Called from the gateway's bounded write queue, never on the request path.
func (s *Store) DebitOrgMember(ctx context.Context, orgID, userID, creditsConsumed int64) error {
	if creditsConsumed <= 0 {
		return nil
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx,
		`UPDATE organization_members
		    SET bucket_credits = GREATEST(0, bucket_credits - ?), updatedAt = NOW(3)
		  WHERE organization_id = ? AND user_id = ?`,
		creditsConsumed, orgID, userID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE credit_pools
		    SET used_credits = used_credits + ?, updatedAt = NOW(3)
		  WHERE organization_id = ?`,
		creditsConsumed, orgID); err != nil {
		return err
	}
	return tx.Commit()
}

// InsertOrgLedger writes a team consumption row: attributed to the ORG and to the
// MEMBER who spent it. user_id is still written (equal to memberUserID) so the
// member's personal credit history keeps working with no query change, and
// organization_id is what makes the team's own reporting possible.
func (s *Store) InsertOrgLedger(
	ctx context.Context,
	orgID, memberUserID int64,
	modelCode string,
	inTok, outTok int,
	creditsConsumed int64,
	realCostCents int,
	source string,
) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO credit_ledger
		   (user_id, organization_id, member_user_id, modelCode, inTokens, outTokens, credits, realCostCents, source, createdAt)
		 VALUES (?,?,?,?,?,?,?,?,?,NOW())`,
		memberUserID, orgID, memberUserID, modelCode, inTok, outTok, creditsConsumed, realCostCents, source,
	)
	return err
}
