//go:build integration

package repository

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/stretchr/testify/require"
)

func TestBotLotteryConcurrentLastAttemptCreditsExactlyOnePrize(t *testing.T) {
	ctx := context.Background()
	client := testEntClient(t)
	actor := mustCreateBotBindingUser(t, client, &service.User{Email: fmt.Sprintf("lottery-admin-%d@example.com", time.Now().UnixNano()), Role: service.RoleAdmin, Status: service.StatusActive})
	user := mustCreateBotBindingUser(t, client, &service.User{Email: fmt.Sprintf("lottery-draw-%d@example.com", time.Now().UnixNano()), Balance: 10, Status: service.StatusActive})
	repo := NewBotLotteryRepository(integrationDB)
	_, _, err := repo.Grant(ctx, user.ID, 1, "event", fmt.Sprintf("grant-%d", user.ID), actor.ID, fmt.Sprintf("user:%d", user.ID))
	require.NoError(t, err)
	var succeeded atomic.Int64
	var wg sync.WaitGroup
	errs := make(chan error, 16)
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func(index int) {
			defer wg.Done()
			_, err := repo.Draw(ctx, user.ID, fmt.Sprintf("draw-%d-%d", user.ID, index), service.BotLotteryPrize{ID: "fixed", Name: "fixed", Amount: 0.29, Weight: 1}, "snapshot")
			if err == nil {
				succeeded.Add(1)
			} else if err != service.ErrBotLotteryNoTickets {
				errs <- err
			}
		}(i)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		require.NoError(t, err)
	}
	require.Equal(t, int64(1), succeeded.Load())
	remaining, err := repo.GetRemaining(ctx, user.ID)
	require.NoError(t, err)
	require.Zero(t, remaining)
	var balance float64
	require.NoError(t, integrationDB.QueryRowContext(ctx, "SELECT balance FROM users WHERE id = $1", user.ID).Scan(&balance))
	require.InDelta(t, 10.29, balance, 1e-8)
	var draws int
	require.NoError(t, integrationDB.QueryRowContext(ctx, "SELECT COUNT(*) FROM bot_lottery_operations WHERE user_id = $1 AND action = 'draw'", user.ID).Scan(&draws))
	require.Equal(t, 1, draws)
}

func TestBotLotteryConcurrentSameMessageReplaysOriginalPrize(t *testing.T) {
	ctx := context.Background()
	client := testEntClient(t)
	actor := mustCreateBotBindingUser(t, client, &service.User{Email: fmt.Sprintf("lottery-replay-admin-%d@example.com", time.Now().UnixNano()), Role: service.RoleAdmin, Status: service.StatusActive})
	user := mustCreateBotBindingUser(t, client, &service.User{Email: fmt.Sprintf("lottery-replay-%d@example.com", time.Now().UnixNano()), Balance: 10, Status: service.StatusActive})
	repo := NewBotLotteryRepository(integrationDB)
	_, _, err := repo.Grant(ctx, user.ID, 5, "event", fmt.Sprintf("grant-%d", user.ID), actor.ID, fmt.Sprintf("user:%d", user.ID))
	require.NoError(t, err)
	var fresh atomic.Int64
	var wg sync.WaitGroup
	errs := make(chan error, 16)
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			result, err := repo.Draw(ctx, user.ID, fmt.Sprintf("same-%d", user.ID), service.BotLotteryPrize{ID: "fixed", Name: "fixed", Amount: 0.29, Weight: 1}, "snapshot")
			if err != nil {
				errs <- err
				return
			}
			if !result.Replayed {
				fresh.Add(1)
			}
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		require.NoError(t, err)
	}
	require.Equal(t, int64(1), fresh.Load())
	remaining, err := repo.GetRemaining(ctx, user.ID)
	require.NoError(t, err)
	require.Equal(t, int64(4), remaining)
	var balance float64
	require.NoError(t, integrationDB.QueryRowContext(ctx, "SELECT balance FROM users WHERE id = $1", user.ID).Scan(&balance))
	require.InDelta(t, 10.29, balance, 1e-8)
}

func TestBotLotteryBatchResumesSnapshotAndSkipsInvalidatedRecipients(t *testing.T) {
	ctx := context.Background()
	client := testEntClient(t)
	now := time.Now().UnixNano()
	actor := mustCreateBotBindingUser(t, client, &service.User{Email: fmt.Sprintf("lottery-batch-admin-%d@example.com", now), Role: service.RoleAdmin, Status: service.StatusActive})
	first := mustCreateBotBindingUser(t, client, &service.User{Email: fmt.Sprintf("lottery-batch-first-%d@example.com", now), Status: service.StatusActive})
	second := mustCreateBotBindingUser(t, client, &service.User{Email: fmt.Sprintf("lottery-batch-second-%d@example.com", now), Status: service.StatusActive})
	third := mustCreateBotBindingUser(t, client, &service.User{Email: fmt.Sprintf("lottery-batch-third-%d@example.com", now), Status: service.StatusActive})
	for i, user := range []*service.User{first, first, second, third} {
		_, err := integrationDB.ExecContext(ctx, `INSERT INTO bot_bindings (user_id,platform,external_id,token_hash,token_prefix,user_token_version) VALUES ($1,'qq',$2,$3,'test',$4)`, user.ID, fmt.Sprintf("%d-%d", now, i), service.HashBotBindingSecret(fmt.Sprintf("lottery-%d-%d", now, i)), service.BotBindingCredentialVersion(user.Email, user.PasswordHash))
		require.NoError(t, err)
	}
	repo := NewBotLotteryRepository(integrationDB)
	batchID, _, err := repo.CreateGrantBatch(ctx, service.BotLotteryGrantBatchRequest{ActorID: actor.ID, Count: 3, Notes: "event", OperationID: fmt.Sprintf("batch-%d", now)})
	require.NoError(t, err)
	t.Cleanup(func() {
		_, err := integrationDB.ExecContext(ctx, "DELETE FROM bot_lottery_grant_batches WHERE id = $1", batchID)
		require.NoError(t, err)
	})
	_, err = integrationDB.ExecContext(ctx, "UPDATE users SET status = 'disabled' WHERE id = $1", second.ID)
	require.NoError(t, err)
	_, err = integrationDB.ExecContext(ctx, "UPDATE bot_bindings SET revoked_at = NOW() WHERE user_id = $1", third.ID)
	require.NoError(t, err)
	// Recreate the repository to emulate a restarted process after the durable snapshot.
	recovered := NewBotLotteryRepository(integrationDB)
	require.NoError(t, recovered.ProcessGrantBatch(ctx, batchID))
	require.NoError(t, recovered.ProcessGrantBatch(ctx, batchID))
	batch, err := recovered.GetGrantBatch(ctx, batchID)
	require.NoError(t, err)
	require.Equal(t, "completed", batch.Status)
	require.Equal(t, int64(1), batch.Success)
	require.Equal(t, int64(2), batch.Skipped)
	require.Equal(t, int64(3), batch.Total)
	remaining, err := recovered.GetRemaining(ctx, first.ID)
	require.NoError(t, err)
	require.Equal(t, int64(3), remaining)
	for _, user := range []*service.User{second, third} {
		remaining, err := recovered.GetRemaining(ctx, user.ID)
		require.NoError(t, err)
		require.Zero(t, remaining)
	}
}
