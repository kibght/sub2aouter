//go:build unit

package repository

import (
	"context"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/require"
)

func TestBillingBalanceGeneration_StaleFillCannotUndoInvalidation(t *testing.T) {
	cache, _ := newMiniRedisCache(t)
	ctx := context.Background()
	oldGeneration, err := cache.UserBalanceGeneration(ctx, 7)
	require.NoError(t, err)

	// A positive DB snapshot was queued before a debit committed and invalidated.
	require.NoError(t, cache.InvalidateUserBalance(ctx, 7))
	require.NoError(t, cache.SetUserBalanceIfGeneration(ctx, 7, 20, oldGeneration))
	_, err = cache.GetUserBalance(ctx, 7)
	require.ErrorIs(t, err, redis.Nil)

	currentGeneration, err := cache.UserBalanceGeneration(ctx, 7)
	require.NoError(t, err)
	require.NotEqual(t, oldGeneration, currentGeneration)
	require.NoError(t, cache.SetUserBalanceIfGeneration(ctx, 7, -0.25, currentGeneration))
	require.NoError(t, cache.SetUserBalanceIfGeneration(ctx, 7, 20, oldGeneration))
	balance, err := cache.GetUserBalance(ctx, 7)
	require.NoError(t, err)
	require.Equal(t, -0.25, balance)

	// A legitimate recharge invalidates the negative snapshot and can refill.
	require.NoError(t, cache.InvalidateUserBalance(ctx, 7))
	rechargedGeneration, err := cache.UserBalanceGeneration(ctx, 7)
	require.NoError(t, err)
	require.NoError(t, cache.SetUserBalanceIfGeneration(ctx, 7, 10, rechargedGeneration))
	balance, err = cache.GetUserBalance(ctx, 7)
	require.NoError(t, err)
	require.Equal(t, float64(10), balance)
}

func TestBillingBalanceGeneration_StaleFillCannotUndoDeduction(t *testing.T) {
	for _, cachePresent := range []bool{false, true} {
		t.Run(map[bool]string{false: "cache_miss", true: "cache_hit"}[cachePresent], func(t *testing.T) {
			cache, _ := newMiniRedisCache(t)
			ctx := context.Background()
			if cachePresent {
				require.NoError(t, cache.SetUserBalance(ctx, 7, 0.5))
			}
			generation, err := cache.UserBalanceGeneration(ctx, 7)
			require.NoError(t, err)
			require.NoError(t, cache.DeductUserBalance(ctx, 7, 0.75))
			require.NoError(t, cache.SetUserBalanceIfGeneration(ctx, 7, 0.5, generation))
			balance, err := cache.GetUserBalance(ctx, 7)
			if cachePresent {
				require.NoError(t, err)
				require.Equal(t, -0.25, balance)
			} else {
				require.ErrorIs(t, err, redis.Nil)
			}
		})
	}
}

func TestBillingBalanceGeneration_ExpiredFenceCannotBeReused(t *testing.T) {
	cache, server := newMiniRedisCache(t)
	ctx := context.Background()
	generation, err := cache.UserBalanceGeneration(ctx, 7)
	require.NoError(t, err)
	server.FastForward(2*billingCacheTTL + time.Second)
	require.NoError(t, cache.SetUserBalanceIfGeneration(ctx, 7, 20, generation))
	_, err = cache.GetUserBalance(ctx, 7)
	require.ErrorIs(t, err, redis.Nil)
	newGeneration, err := cache.UserBalanceGeneration(ctx, 7)
	require.NoError(t, err)
	require.NotEqual(t, generation, newGeneration)
	require.NoError(t, cache.SetUserBalanceIfGeneration(ctx, 7, 20, generation))
	_, err = cache.GetUserBalance(ctx, 7)
	require.ErrorIs(t, err, redis.Nil)
}
