package repository

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/stretchr/testify/require"
)

func TestCalculateBotCheckInRewardStartsCycleAfterSevenDays(t *testing.T) {
	tests := []struct {
		name           string
		previousReward float64
		previousStreak int
		hasPrevious    bool
		firstReward    float64
		increment      float64
		dailyCap       float64
		wantStreak     int
		wantReward     float64
		wantIncrement  float64
	}{
		{name: "first day", firstReward: 0.1, increment: 0.03, dailyCap: 1, wantStreak: 1, wantReward: 0.1},
		{name: "second day uses a new random amount", previousReward: 0.19, previousStreak: 1, hasPrevious: true, firstReward: 0.07, increment: 0.03, dailyCap: 1, wantStreak: 2, wantReward: 0.07},
		{name: "seventh day doubles today's random reward", previousReward: 0.28, previousStreak: 6, hasPrevious: true, firstReward: 0.1, increment: 0.03, dailyCap: 1, wantStreak: 7, wantReward: 0.2},
		{name: "eighth day resets", previousReward: 0.31, previousStreak: 7, hasPrevious: true, firstReward: 0.1, increment: 0.03, dailyCap: 1, wantStreak: 1, wantReward: 0.1},
		{name: "cap still applies", previousReward: 0.49, previousStreak: 6, hasPrevious: true, firstReward: 0.3, increment: 0.03, dailyCap: 0.5, wantStreak: 7, wantReward: 0.5},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			streak, reward, increment := calculateBotCheckInReward(
				tt.previousReward, tt.previousStreak, tt.firstReward, tt.increment, tt.dailyCap, tt.hasPrevious,
			)
			require.Equal(t, tt.wantStreak, streak)
			require.InDelta(t, tt.wantReward, reward, 1e-9)
			require.InDelta(t, tt.wantIncrement, increment, 1e-9)
		})
	}

	require.Equal(t, 7, service.BotCheckInStreakCycleDays)
}

func TestBotCheckInRollsBackWhenBalanceHistoryFails(t *testing.T) {
	db, mock, err := sqlmock.New()
	require.NoError(t, err)
	t.Cleanup(func() { _ = db.Close() })

	now := time.Date(2026, 11, 12, 4, 0, 0, 0, time.UTC)
	mock.ExpectBegin()
	mock.ExpectQuery(`SELECT balance, status FROM users .* FOR UPDATE`).
		WithArgs(int64(42)).
		WillReturnRows(sqlmock.NewRows([]string{"balance", "status"}).AddRow(1.0, service.StatusActive))
	mock.ExpectQuery(`SELECT today_tokens, today_amount,`).
		WithArgs(int64(42), sqlmock.AnyArg(), sqlmock.AnyArg(), int64(service.BillingTypeBalance),
			service.BotCheckInUsageTokens, int64(0), "0.00000000").
		WillReturnRows(sqlmock.NewRows([]string{"today_tokens", "today_amount", "eligible"}).AddRow(0, 0, true))
	mock.ExpectQuery(`SELECT reward_amount, streak_day, reward_date, created_at FROM bot_checkins`).
		WillReturnRows(sqlmock.NewRows([]string{"reward_amount", "streak_day", "reward_date", "created_at"}))
	mock.ExpectQuery(`SELECT reward_amount, streak_day FROM bot_checkins`).
		WillReturnRows(sqlmock.NewRows([]string{"reward_amount", "streak_day"}))
	mock.ExpectQuery(`UPDATE users SET balance = balance \+ \$2, updated_at = \$3`).
		WithArgs(int64(42), 0.1, now).
		WillReturnRows(sqlmock.NewRows([]string{"before", "after"}).AddRow(1.0, 1.1))
	mock.ExpectExec(`INSERT INTO bot_checkins`).WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectExec(`INSERT INTO redeem_codes`).WillReturnError(fmt.Errorf("history unavailable"))
	mock.ExpectRollback()

	result, err := NewBotCheckInRepository(db).CheckIn(context.Background(), service.BotCheckInParams{
		UserID: 42, RewardDate: "2026-11-12", UsageRequirement: service.BotCheckInUsageTokens,
		FirstReward: 0.1, DailyCap: 1, Now: now,
	})

	require.ErrorContains(t, err, "record bot check-in balance history")
	require.Nil(t, result)
	require.NoError(t, mock.ExpectationsWereMet())
}

func TestBotCheckInInactiveAccountReportsSelectedRequirement(t *testing.T) {
	db, mock, err := sqlmock.New()
	require.NoError(t, err)
	t.Cleanup(func() { _ = db.Close() })

	mock.ExpectBegin()
	mock.ExpectQuery(`SELECT balance, status FROM users .* FOR UPDATE`).
		WithArgs(int64(42)).
		WillReturnRows(sqlmock.NewRows([]string{"balance", "status"}).AddRow(5.0, "disabled"))
	mock.ExpectRollback()

	result, err := NewBotCheckInRepository(db).CheckIn(context.Background(), service.BotCheckInParams{
		UserID: 42, RewardDate: "2026-11-12", UsageRequirement: service.BotCheckInUsageAmount,
		RequiredTokens: 100, RequiredAmount: 0.07,
	})

	require.NoError(t, err)
	require.Equal(t, service.BotCheckInStatusInactive, result.Status)
	require.Equal(t, service.BotCheckInUsageAmount, result.UsageRequirement)
	require.Zero(t, result.RequiredTokens)
	require.Equal(t, 0.07, result.RequiredAmount)
	require.Equal(t, 5.0, result.Balance)
	require.NoError(t, mock.ExpectationsWereMet())
}
