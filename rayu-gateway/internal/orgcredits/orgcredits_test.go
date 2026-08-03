package orgcredits

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/choeng-rayu/rayu-gateway/internal/store"
)

type fakeSource struct {
	calls int
	state *store.OrgMemberState
	err   error
}

func (f *fakeSource) OrgMemberState(context.Context, int64, int64) (*store.OrgMemberState, error) {
	f.calls++
	return f.state, f.err
}

func activeState() *store.OrgMemberState {
	end := time.Now().Add(24 * time.Hour)
	return &store.OrgMemberState{
		OrgID:         21,
		OrgStatus:     "active",
		MemberStatus:  "active",
		MemberRole:    "member",
		SubStatus:     "active",
		HasPlan:       true,
		PeriodEnd:     &end,
		BucketQuota:   250,
		BucketCredits: 250,
		PoolTotal:     1000,
		PoolUsed:      0,
	}
}

func TestResolveCachesWithinTTL(t *testing.T) {
	src := &fakeSource{state: activeState()}
	r := New(src, time.Minute)
	ctx := context.Background()

	for i := 0; i < 5; i++ {
		st, err := r.Resolve(ctx, 21, 7)
		if err != nil {
			t.Fatalf("Resolve: %v", err)
		}
		if st == nil || st.OrgID != 21 {
			t.Fatalf("Resolve returned %+v", st)
		}
	}
	if src.calls != 1 {
		t.Errorf("database reads = %d, want 1 (burst must share one read)", src.calls)
	}
}

func TestInvalidateForcesReread(t *testing.T) {
	src := &fakeSource{state: activeState()}
	r := New(src, time.Minute)
	ctx := context.Background()

	if _, err := r.Resolve(ctx, 21, 7); err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	r.Invalidate(21, 7)
	if _, err := r.Resolve(ctx, 21, 7); err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if src.calls != 2 {
		t.Errorf("database reads = %d, want 2 (invalidate must force a re-read)", src.calls)
	}
}

func TestResolveWithoutOrgClaimNeverTouchesTheDatabase(t *testing.T) {
	src := &fakeSource{state: activeState()}
	r := New(src, time.Minute)
	st, err := r.Resolve(context.Background(), 0, 7)
	if err != nil || st != nil {
		t.Fatalf("got (%v, %v), want (nil, nil)", st, err)
	}
	if src.calls != 0 {
		t.Errorf("database reads = %d, want 0 for an individual user", src.calls)
	}
}

func TestResolveNilStateForMissingSeat(t *testing.T) {
	src := &fakeSource{state: nil}
	r := New(src, time.Minute)
	st, err := r.Resolve(context.Background(), 21, 7)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if st != nil {
		t.Fatalf("want nil state for a stale org claim, got %+v", st)
	}
}

func TestResolvePropagatesError(t *testing.T) {
	src := &fakeSource{err: errors.New("boom")}
	r := New(src, time.Minute)
	if _, err := r.Resolve(context.Background(), 21, 7); err == nil {
		t.Fatal("expected the database error to surface")
	}
}

func TestUsableReasons(t *testing.T) {
	now := time.Now()
	past := now.Add(-time.Hour)

	cases := []struct {
		name    string
		mutate  func(*store.OrgMemberState)
		wantOK  bool
		wantWhy string
	}{
		{"healthy team", func(*store.OrgMemberState) {}, true, ""},
		{
			"suspended team",
			func(s *store.OrgMemberState) { s.OrgStatus = "suspended" },
			false, "team_suspended",
		},
		{
			"removed member",
			func(s *store.OrgMemberState) { s.MemberStatus = "removed" },
			false, "membership_removed",
		},
		{
			"team never bought a plan",
			func(s *store.OrgMemberState) { s.HasPlan = false; s.SubStatus = "" },
			false, "team_no_plan",
		},
		{
			"past due subscription",
			func(s *store.OrgMemberState) { s.SubStatus = "past_due" },
			false, "team_past_due",
		},
		{
			"lapsed period",
			func(s *store.OrgMemberState) { s.PeriodEnd = &past },
			false, "team_period_ended",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			st := activeState()
			c.mutate(st)
			ok, why := st.Usable(now)
			if ok != c.wantOK || why != c.wantWhy {
				t.Errorf("Usable() = (%v, %q), want (%v, %q)", ok, why, c.wantOK, c.wantWhy)
			}
		})
	}
}

func TestPoolRemainingNeverNegative(t *testing.T) {
	st := activeState()
	st.PoolUsed = 1500
	if got := st.PoolRemaining(); got != 0 {
		t.Errorf("PoolRemaining() = %d, want 0", got)
	}
	st.PoolUsed = 400
	if got := st.PoolRemaining(); got != 600 {
		t.Errorf("PoolRemaining() = %d, want 600", got)
	}
}
