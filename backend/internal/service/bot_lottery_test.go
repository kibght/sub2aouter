package service

import (
	"context"
	"errors"
	"math"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

type lotteryRepoStub struct {
	config     *BotLotteryConfig
	prior      *BotLotteryDrawResult
	priorGrant *BotLotteryGrantResult
	drawn      int
	process    func(context.Context, int64) error
	pending    func(context.Context, int) ([]int64, error)
	create     func(context.Context, BotLotteryGrantBatchRequest) (int64, bool, error)
}

func (r *lotteryRepoStub) GetConfig(context.Context) (*BotLotteryConfig, error) { return r.config, nil }
func (r *lotteryRepoStub) SaveConfig(context.Context, BotLotteryConfig) error   { return nil }
func (r *lotteryRepoStub) GetRemaining(context.Context, int64) (int64, error)   { return 1, nil }
func (r *lotteryRepoStub) FindDraw(context.Context, int64, string) (*BotLotteryDrawResult, error) {
	return r.prior, nil
}
func (r *lotteryRepoStub) Draw(_ context.Context, _ int64, _ string, p BotLotteryPrize, _ string) (*BotLotteryDrawResult, error) {
	r.drawn++
	return &BotLotteryDrawResult{Status: "success", PrizeName: p.Name, Reward: p.Amount, Remaining: 0}, nil
}
func (r *lotteryRepoStub) ListRecords(context.Context, int64, int) ([]BotLotteryRecord, error) {
	return []BotLotteryRecord{}, nil
}
func (r *lotteryRepoStub) FindGrant(context.Context, string, string, int64, string) (*BotLotteryGrantResult, error) {
	return r.priorGrant, nil
}
func (r *lotteryRepoStub) Grant(context.Context, int64, int64, string, string, int64, string) (int64, bool, error) {
	return 3, false, nil
}
func (r *lotteryRepoStub) ResolveQQUser(context.Context, string) (int64, error) { return 42, nil }
func (r *lotteryRepoStub) CreateGrantBatch(ctx context.Context, request BotLotteryGrantBatchRequest) (int64, bool, error) {
	if r.create != nil {
		return r.create(ctx, request)
	}
	return 1, false, nil
}
func (r *lotteryRepoStub) ProcessGrantBatch(ctx context.Context, id int64) error {
	if r.process != nil {
		return r.process(ctx, id)
	}
	return nil
}
func (r *lotteryRepoStub) GetGrantBatch(context.Context, int64) (*BotLotteryGrantBatch, error) {
	return &BotLotteryGrantBatch{BotLotteryGrantResult: BotLotteryGrantResult{BatchID: 1, Total: 1, Pending: 1, Status: "pending"}}, nil
}
func (r *lotteryRepoStub) PendingGrantBatchIDs(ctx context.Context, limit int) ([]int64, error) {
	if r.pending != nil {
		return r.pending(ctx, limit)
	}
	return nil, nil
}

type lotteryCacheStub struct{ users []int64 }

func (c *lotteryCacheStub) InvalidateUserBalance(_ context.Context, id int64) error {
	c.users = append(c.users, id)
	return nil
}

func TestBotLotteryConfigValidationAndPrecision(t *testing.T) {
	valid := BotLotteryConfig{Enabled: true, Prizes: []BotLotteryPrize{{ID: "reward", Name: "余额奖励", Amount: 0.29, Weight: 9}, {ID: "none", Name: "未中奖", Amount: 0, Weight: 1}}}
	require.NoError(t, ValidateBotLotteryConfig(valid))
	for _, amount := range []float64{0.00000001, 1.23456789, 0.29} {
		copy := valid
		copy.Prizes = append([]BotLotteryPrize(nil), valid.Prizes...)
		copy.Prizes[0].Amount = amount
		require.NoError(t, ValidateBotLotteryConfig(copy))
	}
	for _, amount := range []float64{-1, math.NaN(), math.Inf(1), 0.123456789, 1_000_001} {
		copy := valid
		copy.Prizes = append([]BotLotteryPrize(nil), valid.Prizes...)
		copy.Prizes[0].Amount = amount
		require.ErrorIs(t, ValidateBotLotteryConfig(copy), ErrBotLotteryBadConfig)
	}
	duplicate := valid
	duplicate.Prizes = append([]BotLotteryPrize(nil), valid.Prizes...)
	duplicate.Prizes[1].ID = "reward"
	require.ErrorIs(t, ValidateBotLotteryConfig(duplicate), ErrBotLotteryBadConfig)
	missing := BotLotteryConfig{Enabled: true}
	require.ErrorIs(t, ValidateBotLotteryConfig(missing), ErrBotLotteryBadConfig)
	require.NoError(t, ValidateBotLotteryConfig(BotLotteryConfig{}))
	require.NotContains(t, BotLotteryConfigSnapshot(valid), "\x00")
}

func TestBotLotteryDrawReplaysAfterConfigDisabled(t *testing.T) {
	repo := &lotteryRepoStub{config: &BotLotteryConfig{}, prior: &BotLotteryDrawResult{Status: "success", PrizeName: "original", Reward: 0.29, Remaining: 0, Replayed: true}}
	svc := NewBotLotteryService(repo, nil, nil)
	result, err := svc.Draw(context.Background(), 42, "same-message")
	require.NoError(t, err)
	require.True(t, result.Replayed)
	require.Equal(t, "original", result.PrizeName)
	require.Zero(t, repo.drawn)
}

func TestBotLotteryQQGrantReplaysStoredWebsiteTargetAfterRebinding(t *testing.T) {
	repo := &lotteryRepoStub{priorGrant: &BotLotteryGrantResult{Status: "success", UserID: 99, Count: 3, Remaining: 5, Replayed: true}}
	svc := NewBotLotteryService(repo, nil, nil)
	result, err := svc.GrantToQQ(context.Background(), "123456", 3, "event", "same-message", 9)
	require.NoError(t, err)
	require.Equal(t, int64(99), result.UserID)
	require.True(t, result.Replayed)
}

func TestBotLotteryDrawCreditsChosenPrizeAndInvalidatesBalance(t *testing.T) {
	repo := &lotteryRepoStub{config: &BotLotteryConfig{Enabled: true, Prizes: []BotLotteryPrize{{ID: "fixed", Name: "fixed", Amount: 0.29, Weight: 1}}}}
	cache := &lotteryCacheStub{}
	svc := NewBotLotteryService(repo, cache, nil)
	result, err := svc.Draw(context.Background(), 42, "new-message")
	require.NoError(t, err)
	require.Equal(t, 0.29, result.Reward)
	require.Equal(t, []int64{42}, cache.users)
	require.Equal(t, 1, repo.drawn)
}

func TestBotLotteryDisabledAndRequestIDValidation(t *testing.T) {
	svc := NewBotLotteryService(&lotteryRepoStub{config: &BotLotteryConfig{}}, nil, nil)
	_, err := svc.Draw(context.Background(), 42, "new")
	require.ErrorIs(t, err, ErrBotLotteryDisabled)
	_, err = svc.Draw(context.Background(), 42, " ")
	require.ErrorIs(t, err, ErrBotLotteryRequestIDRequired)
	_, err = BotLotteryOperationID("draw", strings.Repeat("a", 201))
	require.ErrorIs(t, err, ErrBotLotteryRequestIDRequired)
	first, _ := BotLotteryOperationID("draw:42", "one")
	second, _ := BotLotteryOperationID("draw:43", "one")
	require.NotEqual(t, first, second)
}

func TestBotLotteryWorkerRecoversPersistedBatchesAndStops(t *testing.T) {
	processed := make(chan int64, 4)
	repo := &lotteryRepoStub{pending: func(context.Context, int) ([]int64, error) { return []int64{71, 72}, nil }, process: func(_ context.Context, id int64) error { processed <- id; return nil }}
	svc := NewBotLotteryService(repo, nil, nil)
	svc.Start()
	t.Cleanup(svc.Stop)
	for _, expected := range []int64{71, 72} {
		select {
		case id := <-processed:
			require.Equal(t, expected, id)
		case <-time.After(2 * time.Second):
			t.Fatal("worker did not recover a durable batch")
		}
	}
	svc.Stop()
	select {
	case <-svc.done:
	default:
		t.Fatal("worker did not stop")
	}
}

func TestBotLotteryWorkerKeepsProcessingOtherBatchesAfterFailure(t *testing.T) {
	var mu sync.Mutex
	var visited []int64
	expected := errors.New("temporary store error")
	repo := &lotteryRepoStub{pending: func(context.Context, int) ([]int64, error) { return []int64{11, 12}, nil }, process: func(_ context.Context, id int64) error {
		mu.Lock()
		visited = append(visited, id)
		mu.Unlock()
		if id == 11 {
			return expected
		}
		return nil
	}}
	svc := NewBotLotteryService(repo, nil, nil)
	require.ErrorIs(t, svc.ProcessPendingGrantBatches(context.Background()), expected)
	require.Equal(t, []int64{11, 12}, visited)
}

func TestBotLotteryGrantBatchStoresStableActorScopedRequest(t *testing.T) {
	var got BotLotteryGrantBatchRequest
	repo := &lotteryRepoStub{create: func(_ context.Context, request BotLotteryGrantBatchRequest) (int64, bool, error) {
		got = request
		return 1, true, nil
	}}
	svc := NewBotLotteryService(repo, nil, nil)
	batch, err := svc.GrantAll(context.Background(), BotLotteryGrantBatchRequest{ActorID: 9, Count: 3, Notes: "event", RequestID: "source-message"})
	require.NoError(t, err)
	require.True(t, batch.Replayed)
	require.Equal(t, int64(3), got.Count)
	require.Len(t, got.OperationID, 64)
	_, err = svc.GrantOne(context.Background(), 42, 0, "", "request", 9)
	require.ErrorIs(t, err, ErrBotLotteryBadConfig)
}
