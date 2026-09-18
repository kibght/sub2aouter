//go:build unit

package service

import (
	"context"
	"errors"
	"sync"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/config"
	"github.com/stretchr/testify/require"
)

type fencedBalanceCacheStub struct {
	billingCacheWorkerStub
	mu         sync.Mutex
	generation string
	balance    *float64
}

func (s *fencedBalanceCacheStub) GetUserBalance(context.Context, int64) (float64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.balance == nil {
		return 0, errors.New("cache miss")
	}
	return *s.balance, nil
}

func (s *fencedBalanceCacheStub) UserBalanceGeneration(context.Context, int64) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.generation, nil
}

func (s *fencedBalanceCacheStub) SetUserBalanceIfGeneration(_ context.Context, _ int64, balance float64, generation string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if generation == s.generation {
		s.balance = &balance
	}
	return nil
}

func (s *fencedBalanceCacheStub) InvalidateUserBalance(context.Context, int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.generation = "after-debit"
	s.balance = nil
	return nil
}

func TestBillingCacheService_QueuedPositiveSnapshotCannotReviveExhaustedBalance(t *testing.T) {
	cache := &fencedBalanceCacheStub{generation: "before-debit"}
	userRepo := &balanceLoadUserRepoStub{balance: 0.5}
	svc := &BillingCacheService{
		cache: cache, userRepo: userRepo, cfg: &config.Config{},
		cacheWriteChan: make(chan cacheWriteTask, 1),
	}
	ctx := context.Background()
	balance, err := svc.GetUserBalance(ctx, 7)
	require.NoError(t, err)
	require.Equal(t, 0.5, balance)
	require.Len(t, svc.cacheWriteChan, 1)

	// Commit a debit and invalidate before allowing the queued fill to run.
	userRepo.balance = -0.25
	require.NoError(t, svc.InvalidateUserBalance(ctx, 7))
	svc.cacheWriteWg.Add(1)
	go svc.cacheWriteWorker(svc.cacheWriteChan)
	svc.Stop()

	_, err = cache.GetUserBalance(ctx, 7)
	require.Error(t, err)
	err = svc.CheckBillingEligibility(ctx, &User{ID: 7}, nil, nil, nil, "")
	require.ErrorIs(t, err, ErrInsufficientBalance)
}
