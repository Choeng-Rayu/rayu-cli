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

// HostedModel mirrors a row in hosted_models. CacheReadCreditMultiplier/
// CacheWriteCreditMultiplier are nil when the admin hasn't configured a
// model-specific override; the gateway then falls back to its own defaults
// (see credits.DeriveModelRates) so every model that predates these columns
// bills identically to before they existed.
type HostedModel struct {
	Code                       string   `json:"code"`
	Label                      string   `json:"label"`
	Provider                   string   `json:"provider"`
	UpstreamBaseURL            string   `json:"-"`
	UpstreamModelID            string   `json:"-"`
	InputPricePer1MCents       int      `json:"-"`
	OutputPricePer1MCents      int      `json:"-"`
	CreditMultiplier           float64  `json:"creditMultiplier"`
	CacheReadCreditMultiplier  *float64 `json:"-"`
	CacheWriteCreditMultiplier *float64 `json:"-"`
	AllowedPlanCodes           []string `json:"-"`
	Enabled                    bool     `json:"-"`
}

// AppSettings mirrors the singleton app_settings row.
type AppSettings struct {
	BaselineCreditsPer1M   int
	MaxConcurrentStreams   int
	MaxTokensPerRequest    int
	MaxRequestsPer5h       int
	TopupCentsPer1kCredits int
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

// LoadModels returns all hosted_models rows.
func (s *Store) LoadModels(ctx context.Context) ([]HostedModel, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT code,label,provider,upstreamBaseUrl,upstreamModelId,inputPricePer1MCents,outputPricePer1MCents,creditMultiplier,cacheReadCreditMultiplier,cacheWriteCreditMultiplier,allowedPlanCodes,enabled FROM hosted_models`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []HostedModel
	for rows.Next() {
		var m HostedModel
		var allowed []byte
		var cacheRead, cacheWrite sql.NullFloat64
		if err := rows.Scan(&m.Code, &m.Label, &m.Provider, &m.UpstreamBaseURL, &m.UpstreamModelID, &m.InputPricePer1MCents, &m.OutputPricePer1MCents, &m.CreditMultiplier, &cacheRead, &cacheWrite, &allowed, &m.Enabled); err != nil {
			return nil, err
		}
		if cacheRead.Valid {
			v := cacheRead.Float64
			m.CacheReadCreditMultiplier = &v
		}
		if cacheWrite.Valid {
			v := cacheWrite.Float64
			m.CacheWriteCreditMultiplier = &v
		}
		if len(allowed) > 0 {
			_ = json.Unmarshal(allowed, &m.AllowedPlanCodes)
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// LoadSettings returns the singleton app_settings row (id=1).
func (s *Store) LoadSettings(ctx context.Context) (AppSettings, error) {
	var a AppSettings
	err := s.db.QueryRowContext(ctx, `SELECT baselineCreditsPer1M,maxConcurrentStreams,maxTokensPerRequest,maxRequestsPer5h,topupCentsPer1kCredits FROM app_settings WHERE id=1`).
		Scan(&a.BaselineCreditsPer1M, &a.MaxConcurrentStreams, &a.MaxTokensPerRequest, &a.MaxRequestsPer5h, &a.TopupCentsPer1kCredits)
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
