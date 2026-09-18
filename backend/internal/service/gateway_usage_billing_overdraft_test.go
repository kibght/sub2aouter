//go:build unit

package service

import (
	"context"
	"errors"
	"testing"

	"github.com/stretchr/testify/require"
)

type overdraftCacheOrderingStub struct {
	BillingCache
	request              context.Context
	invalidations        int
	invalidatedCancelled bool
	invalidationCtxErr   error
}

type legacyOverdraftUserRepoStub struct {
	UserRepository
	balance         float64
	readErr         error
	deducted        bool
	readAfterDeduct bool
}

func (s *legacyOverdraftUserRepoStub) DeductBalance(context.Context, int64, float64) error {
	s.deducted = true
	return nil
}

func (s *legacyOverdraftUserRepoStub) GetByID(_ context.Context, id int64) (*User, error) {
	s.readAfterDeduct = s.deducted
	if s.readErr != nil {
		return nil, s.readErr
	}
	return &User{ID: id, Balance: s.balance}, nil
}

func TestLegacyUsageBillingUsesCommittedBalanceForCancellation(t *testing.T) {
	for _, tc := range []struct {
		name          string
		balance       float64
		readErr       error
		wantOverdraft bool
	}{
		{name: "concurrent_deduction", balance: -0.25, wantOverdraft: true},
		{name: "recharge_after_snapshot", balance: 2},
		{name: "read_failure", readErr: errors.New("database read failed")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			const userID = 90281
			request, unregister := RegisterGatewayRequest(context.Background(), userID)
			defer unregister()
			repo := &legacyOverdraftUserRepoStub{balance: tc.balance, readErr: tc.readErr}
			params := &postUsageBillingParams{
				Cost:   &CostBreakdown{ActualCost: 0.75, TotalCost: 0.75},
				User:   &User{ID: userID, Balance: 100},
				APIKey: &APIKey{ID: 90282}, Account: &Account{ID: 90283},
			}
			postUsageBilling(request, params, &billingDeps{userRepo: repo})
			require.True(t, repo.readAfterDeduct)
			require.Equal(t, tc.wantOverdraft, IsGatewayBalanceOverdraft(request))
		})
	}
}

func (s *overdraftCacheOrderingStub) InvalidateUserBalance(ctx context.Context, _ int64) error {
	s.invalidations++
	s.invalidatedCancelled = s.request.Err() != nil
	s.invalidationCtxErr = ctx.Err()
	return nil
}

func TestApplyUsageBillingInvalidatesBeforeOverdraftCancellation(t *testing.T) {
	const userID = 90271
	request, unregister := RegisterGatewayRequest(context.Background(), userID)
	defer unregister()
	cache := &overdraftCacheOrderingStub{request: request}
	newBalance := -0.25
	repo := &openAIRecordUsageBillingRepoStub{result: &UsageBillingApplyResult{
		Applied: true, NewBalance: &newBalance, BalanceOverdrafted: true,
	}}
	params := &postUsageBillingParams{
		Cost: &CostBreakdown{ActualCost: 0.75, TotalCost: 0.75},
		User: &User{ID: userID}, APIKey: &APIKey{ID: 90272}, Account: &Account{ID: 90273},
	}
	deps := &billingDeps{
		billingCacheService: &BillingCacheService{cache: cache},
		deferredService:     &DeferredService{},
	}

	applied, err := applyUsageBilling(request, "overdraft-cache-ordering", nil, params, deps, repo)
	require.NoError(t, err)
	require.True(t, applied)
	require.Equal(t, 1, cache.invalidations, "finalization must not invalidate an overdraft twice")
	require.False(t, cache.invalidatedCancelled, "stale positive cache must be cleared before request slots are released")
	require.NoError(t, cache.invalidationCtxErr)
	require.True(t, IsGatewayBalanceOverdraft(request))
	require.NoError(t, repo.lastCtxErr, "committed usage settlement must not use a cancelled context")

	// A duplicate billing result neither invalidates nor broadcasts again.
	repo.result = &UsageBillingApplyResult{Applied: false, NewBalance: &newBalance}
	nextRequest, unregisterNext := RegisterGatewayRequest(context.Background(), userID)
	defer unregisterNext()
	applied, err = applyUsageBilling(request, "overdraft-cache-ordering", nil, params, deps, repo)
	require.NoError(t, err)
	require.False(t, applied)
	require.Equal(t, 1, cache.invalidations)
	require.NoError(t, nextRequest.Err())
}
