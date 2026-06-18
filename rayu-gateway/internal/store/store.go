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

// HostedModel mirrors a row in hosted_models.
type HostedModel struct {
	Code                  string   `json:"code"`
	Label                 string   `json:"label"`
	Provider              string   `json:"provider"`
	UpstreamBaseURL       string   `json:"-"`
	UpstreamModelID       string   `json:"-"`
	InputPricePer1MCents  int      `json:"-"`
	OutputPricePer1MCents int      `json:"-"`
	CreditMultiplier      float64  `json:"creditMultiplier"`
	AllowedPlanCodes      []string `json:"-"`
	Enabled               bool     `json:"-"`
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
	ID             int64  `json:"-"`
	Code           string `json:"code"`
	Name           string `json:"name"`
	PriceCents     int    `json:"priceCents"`
	CreditsPerWeek *int64 `json:"creditsPerWeek"` // nil = unlimited
	CreditsPer5h   *int64 `json:"creditsPer5h"`
	TopUpEnabled   bool   `json:"topUpEnabled"`
}

// Store wraps the database handle.
type Store struct{ db *sql.DB }

// Open connects to MySQL with a small pool and verifies connectivity.
func Open(dsn string) (*Store, error) {
	db, err := sql.Open("mysql", dsn)
	if err != nil {
		return nil, err
	}
	db.SetConnMaxLifetime(3 * time.Minute)
	db.SetMaxOpenConns(10)
	db.SetMaxIdleConns(5)
	if err := db.Ping(); err != nil {
		return nil, err
	}
	return &Store{db: db}, nil
}

// Close releases the connection pool.
func (s *Store) Close() error { return s.db.Close() }

// DB exposes the underlying handle (used by the ledger writer).
func (s *Store) DB() *sql.DB { return s.db }

// parseLimits decodes the credit fields from a plan's limits JSON.
func parseLimits(raw []byte) (cpw, cp5h *int64, topup bool) {
	if len(raw) == 0 {
		return nil, nil, false
	}
	var l struct {
		CreditsPerWeek *float64 `json:"creditsPerWeek"`
		CreditsPer5h   *float64 `json:"creditsPer5h"`
		TopUpEnabled   bool     `json:"topUpEnabled"`
	}
	if json.Unmarshal(raw, &l) != nil {
		return nil, nil, false
	}
	toI := func(f *float64) *int64 {
		if f == nil {
			return nil
		}
		v := int64(*f)
		return &v
	}
	return toI(l.CreditsPerWeek), toI(l.CreditsPer5h), l.TopUpEnabled
}

// LoadModels returns all hosted_models rows.
func (s *Store) LoadModels(ctx context.Context) ([]HostedModel, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT code,label,provider,upstreamBaseUrl,upstreamModelId,inputPricePer1MCents,outputPricePer1MCents,creditMultiplier,allowedPlanCodes,enabled FROM hosted_models`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []HostedModel
	for rows.Next() {
		var m HostedModel
		var allowed []byte
		if err := rows.Scan(&m.Code, &m.Label, &m.Provider, &m.UpstreamBaseURL, &m.UpstreamModelID, &m.InputPricePer1MCents, &m.OutputPricePer1MCents, &m.CreditMultiplier, &allowed, &m.Enabled); err != nil {
			return nil, err
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
	p.CreditsPerWeek, p.CreditsPer5h, p.TopUpEnabled = parseLimits(limits)
	return &p, nil
}

// ActivePlan returns the user's active, non-expired plan, falling back to the
// free plan when there is no active subscription or it has expired.
func (s *Store) ActivePlan(ctx context.Context, userID int64, now time.Time) (*Plan, error) {
	var p Plan
	var limits []byte
	var periodEnd sql.NullTime
	err := s.db.QueryRowContext(ctx, `SELECT p.id,p.code,p.name,p.priceCents,p.limits,s.currentPeriodEnd FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.user_id=? AND s.status='active' ORDER BY s.startedAt DESC LIMIT 1`, userID).
		Scan(&p.ID, &p.Code, &p.Name, &p.PriceCents, &limits, &periodEnd)
	if err == sql.ErrNoRows {
		return s.PlanByCode(ctx, "free")
	}
	if err != nil {
		return nil, err
	}
	// 30-day expiry: a paid period that has lapsed reverts to free.
	if periodEnd.Valid && periodEnd.Time.Before(now) {
		return s.PlanByCode(ctx, "free")
	}
	p.CreditsPerWeek, p.CreditsPer5h, p.TopUpEnabled = parseLimits(limits)
	return &p, nil
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

// InsertLedger writes a durable credit consumption row (source = "plan"|"topup").
func (s *Store) InsertLedger(ctx context.Context, userID int64, modelCode string, inTok, outTok int, creditsConsumed int64, realCostCents int, source string) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO credit_ledger (user_id, modelCode, inTokens, outTokens, credits, realCostCents, source, createdAt) VALUES (?,?,?,?,?,?,?,NOW())`,
		userID, modelCode, inTok, outTok, creditsConsumed, realCostCents, source,
	)
	return err
}
