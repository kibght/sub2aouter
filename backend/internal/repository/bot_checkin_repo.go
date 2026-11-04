package repository

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/service"
)

type botCheckInRepository struct {
	db *sql.DB
}

func NewBotCheckInRepository(db *sql.DB) service.BotCheckInRepository {
	return &botCheckInRepository{db: db}
}

func (r *botCheckInRepository) CheckIn(ctx context.Context, params service.BotCheckInParams) (*service.BotCheckInResult, error) {
	if r == nil || r.db == nil || params.UserID <= 0 {
		return nil, fmt.Errorf("bot check-in repository is unavailable")
	}
	rewardDate, err := time.Parse("2006-01-02", params.RewardDate)
	if err != nil {
		return nil, fmt.Errorf("invalid check-in date: %w", err)
	}
	if params.Now.IsZero() {
		params.Now = time.Now().UTC()
	}

	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("begin bot check-in: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	var balance float64
	var status string
	err = tx.QueryRowContext(ctx, `
		SELECT balance, status
		FROM users
		WHERE id = $1 AND deleted_at IS NULL
		FOR UPDATE
	`, params.UserID).Scan(&balance, &status)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, service.ErrUserNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("lock bot check-in user: %w", err)
	}
	if status != service.StatusActive {
		return nil, service.ErrBotBindingInactive
	}

	var existing service.BotCheckInResult
	err = tx.QueryRowContext(ctx, `
		SELECT reward_amount, streak_day, reward_date, created_at
		FROM bot_checkins
		WHERE user_id = $1 AND reward_date = $2
	`, params.UserID, rewardDate).Scan(&existing.Reward, &existing.StreakDay, &existing.RewardDate, &existing.CreatedAt)
	if err == nil {
		existing.Balance = balance
		existing.CheckedIn = false
		return &existing, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return nil, fmt.Errorf("load existing bot check-in: %w", err)
	}

	var previousReward float64
	var previousStreak int
	err = tx.QueryRowContext(ctx, `
		SELECT reward_amount, streak_day
		FROM bot_checkins
		WHERE user_id = $1 AND reward_date = $2::date - 1
	`, params.UserID, rewardDate).Scan(&previousReward, &previousStreak)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return nil, fmt.Errorf("load previous bot check-in: %w", err)
	}

	streakDay, reward, increment := calculateBotCheckInReward(
		previousReward, previousStreak, params.FirstReward, params.Increment, params.DailyCap, err == nil,
	)

	updated := tx.QueryRowContext(ctx, `
		UPDATE users
		SET balance = balance + $2, updated_at = $3
		WHERE id = $1 AND deleted_at IS NULL
		RETURNING balance - $2, balance
	`, params.UserID, reward, params.Now)
	var balanceBefore, balanceAfter float64
	if err := updated.Scan(&balanceBefore, &balanceAfter); err != nil {
		return nil, fmt.Errorf("credit bot check-in reward: %w", err)
	}

	_, err = tx.ExecContext(ctx, `
		INSERT INTO bot_checkins
			(user_id, reward_date, streak_day, reward_amount, increment_amount, balance_before, balance_after, created_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
	`, params.UserID, rewardDate, streakDay, reward, increment, balanceBefore, balanceAfter, params.Now)
	if err != nil {
		return nil, fmt.Errorf("record bot check-in: %w", err)
	}

	code, err := service.GenerateRedeemCode()
	if err != nil {
		return nil, fmt.Errorf("generate bot check-in history record: %w", err)
	}
	notes := fmt.Sprintf("签到赠送金额：$%s（连续签到第%d天）", formatBotCheckInAmount(reward), streakDay)
	_, err = tx.ExecContext(ctx, `
		INSERT INTO redeem_codes (code, type, value, status, used_by, used_at, notes, created_at)
		VALUES ($1, 'bot_checkin', $2, 'used', $3, $4, $5, $4)
	`, code, reward, params.UserID, params.Now, notes)
	if err != nil {
		return nil, fmt.Errorf("record bot check-in balance history: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit bot check-in: %w", err)
	}
	return &service.BotCheckInResult{
		CheckedIn: true, Reward: reward, Balance: balanceAfter,
		StreakDay: streakDay, RewardDate: rewardDate, CreatedAt: params.Now,
	}, nil
}

func formatBotCheckInAmount(amount float64) string {
	formatted := strconv.FormatFloat(amount, 'f', 8, 64)
	formatted = strings.TrimRight(formatted, "0")
	return strings.TrimRight(formatted, ".")
}

func calculateBotCheckInReward(
	previousReward float64,
	previousStreak int,
	firstReward float64,
	increment float64,
	dailyCap float64,
	hasPrevious bool,
) (streakDay int, reward float64, appliedIncrement float64) {
	streakDay = 1
	rewardUnits := service.BotCheckInUnits(firstReward)
	incrementUnits := int64(0)
	if hasPrevious && previousStreak > 0 && previousStreak < service.BotCheckInStreakCycleDays {
		streakDay = previousStreak + 1
		incrementUnits = service.BotCheckInUnits(increment)
		rewardUnits = service.BotCheckInUnits(previousReward) + incrementUnits
	}
	capUnits := service.BotCheckInUnits(dailyCap)
	if rewardUnits > capUnits {
		rewardUnits = capUnits
	}
	return streakDay,
		float64(rewardUnits) / 100_000_000,
		float64(incrementUnits) / 100_000_000
}
