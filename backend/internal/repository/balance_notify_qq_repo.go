package repository

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/service"
)

const maxBalanceLowQQClaimLimit = 100

type balanceNotifyQQRepository struct {
	db *sql.DB
}

var _ service.BalanceNotifyQQRepository = (*balanceNotifyQQRepository)(nil)

// NewBalanceNotifyQQRepository creates storage for QQ balance alert deliveries.
func NewBalanceNotifyQQRepository(db *sql.DB) service.BalanceNotifyQQRepository {
	return &balanceNotifyQQRepository{db: db}
}

func (r *balanceNotifyQQRepository) EnqueueBalanceLow(ctx context.Context, userID int64, alert service.BalanceLowQQAlert) error {
	if userID <= 0 {
		return fmt.Errorf("user ID must be positive")
	}
	if alert.CreatedAt.IsZero() {
		alert.CreatedAt = time.Now().UTC()
	}
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin enqueue QQ balance alert: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	var enabled bool
	err = tx.QueryRowContext(ctx, `
		SELECT enabled FROM user_balance_notify_qq WHERE user_id = $1 FOR UPDATE
	`, userID).Scan(&enabled)
	if err == sql.ErrNoRows || (err == nil && !enabled) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("lock QQ balance notification preference: %w", err)
	}
	_, err = tx.ExecContext(ctx, `
		INSERT INTO balance_low_qq_deliveries
			(user_id, binding_id, current_balance, threshold, site_name, recharge_url, created_at)
		SELECT $1, b.id, $2, $3, $4, $5, $6
		FROM bot_bindings b
		JOIN users u ON u.id = b.user_id
		JOIN user_balance_notify_qq p ON p.user_id = u.id
		JOIN settings s ON s.key = 'balance_low_notify_enabled' AND s.value = 'true'
		WHERE b.user_id = $1
		  AND b.platform = 'qq'
		  AND b.revoked_at IS NULL
		  AND u.balance_notify_enabled = TRUE
		  AND p.enabled = TRUE
	`, userID, alert.Balance, alert.Threshold, alert.SiteName, alert.RechargeURL, alert.CreatedAt)
	if err != nil {
		return fmt.Errorf("enqueue QQ balance alert: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit QQ balance alert: %w", err)
	}
	return nil
}

func (r *balanceNotifyQQRepository) HasActiveQQBinding(ctx context.Context, userID int64) (bool, error) {
	var exists bool
	err := r.db.QueryRowContext(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM bot_bindings
			WHERE user_id = $1 AND platform = 'qq' AND revoked_at IS NULL
		)
	`, userID).Scan(&exists)
	if err != nil {
		return false, fmt.Errorf("check active QQ binding: %w", err)
	}
	return exists, nil
}

func (r *balanceNotifyQQRepository) GetQQBalanceNotifyEnabled(ctx context.Context, userID int64) (bool, error) {
	var enabled bool
	err := r.db.QueryRowContext(ctx, `
		SELECT enabled FROM user_balance_notify_qq WHERE user_id = $1
	`, userID).Scan(&enabled)
	if err == sql.ErrNoRows {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("get QQ balance notification preference: %w", err)
	}
	return enabled, nil
}

func (r *balanceNotifyQQRepository) SetQQBalanceNotifyEnabled(ctx context.Context, userID int64, enabled bool) error {
	if userID <= 0 {
		return fmt.Errorf("user ID must be positive")
	}
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin QQ balance notification preference update: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	if enabled {
		var bindingID int64
		err := tx.QueryRowContext(ctx, `
			SELECT id
			FROM bot_bindings
			WHERE user_id = $1 AND platform = 'qq' AND revoked_at IS NULL
			ORDER BY id
			LIMIT 1
			FOR UPDATE
		`, userID).Scan(&bindingID)
		if err == sql.ErrNoRows {
			return service.ErrQQBalanceNotificationBindingRequired
		}
		if err != nil {
			return fmt.Errorf("lock active QQ binding: %w", err)
		}
	}

	_, err = tx.ExecContext(ctx, `
		INSERT INTO user_balance_notify_qq (user_id, enabled, updated_at)
		VALUES ($1, $2, NOW())
		ON CONFLICT (user_id) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = EXCLUDED.updated_at
	`, userID, enabled)
	if err != nil {
		return fmt.Errorf("update QQ balance notification preference: %w", err)
	}
	if !enabled {
		if _, err := tx.ExecContext(ctx, `
			DELETE FROM balance_low_qq_deliveries WHERE user_id = $1
		`, userID); err != nil {
			return fmt.Errorf("clear pending QQ balance alerts: %w", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit QQ balance notification preference: %w", err)
	}
	return nil
}

func (r *balanceNotifyQQRepository) ClaimBalanceLow(
	ctx context.Context,
	userID, bindingID int64,
	now, leaseUntil time.Time,
	limit int,
) ([]service.BalanceLowQQAlert, error) {
	if userID <= 0 || bindingID <= 0 {
		return nil, fmt.Errorf("user ID and binding ID must be positive")
	}
	if !leaseUntil.After(now) {
		return nil, fmt.Errorf("claim lease must expire after now")
	}
	if limit <= 0 {
		return []service.BalanceLowQQAlert{}, nil
	}
	if limit > maxBalanceLowQQClaimLimit {
		limit = maxBalanceLowQQClaimLimit
	}

	rows, err := r.db.QueryContext(ctx, `
		WITH candidates AS (
			SELECT d.id
			FROM balance_low_qq_deliveries d
			JOIN bot_bindings b ON b.id = d.binding_id AND b.user_id = d.user_id
			JOIN users u ON u.id = d.user_id
			JOIN user_balance_notify_qq p ON p.user_id = d.user_id
			JOIN settings s ON s.key = 'balance_low_notify_enabled' AND s.value = 'true'
			WHERE d.user_id = $1
			  AND d.binding_id = $2
			  AND b.platform = 'qq'
			  AND b.revoked_at IS NULL
			  AND u.balance_notify_enabled = TRUE
			  AND p.enabled = TRUE
			  AND (d.claimed_until IS NULL OR d.claimed_until <= $3)
			ORDER BY d.created_at, d.id
			LIMIT $5
			FOR UPDATE OF d SKIP LOCKED
		)
		UPDATE balance_low_qq_deliveries d
		SET claimed_until = $4
		FROM candidates c
		WHERE d.id = c.id
		RETURNING d.id, d.user_id, d.current_balance, d.threshold,
		          d.site_name, d.recharge_url, d.created_at
	`, userID, bindingID, now, leaseUntil, limit)
	if err != nil {
		return nil, fmt.Errorf("claim QQ balance alerts: %w", err)
	}
	defer func() { _ = rows.Close() }()

	alerts := make([]service.BalanceLowQQAlert, 0)
	for rows.Next() {
		var alert service.BalanceLowQQAlert
		if err := rows.Scan(
			&alert.ID,
			&alert.UserID,
			&alert.Balance,
			&alert.Threshold,
			&alert.SiteName,
			&alert.RechargeURL,
			&alert.CreatedAt,
		); err != nil {
			return nil, fmt.Errorf("scan claimed QQ balance alert: %w", err)
		}
		alerts = append(alerts, alert)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate claimed QQ balance alerts: %w", err)
	}
	return alerts, nil
}

func (r *balanceNotifyQQRepository) AckBalanceLow(ctx context.Context, userID, bindingID, alertID int64) error {
	if userID <= 0 || bindingID <= 0 || alertID <= 0 {
		return fmt.Errorf("user ID, binding ID, and alert ID must be positive")
	}
	_, err := r.db.ExecContext(ctx, `
		DELETE FROM balance_low_qq_deliveries
		WHERE id = $1 AND user_id = $2 AND binding_id = $3
	`, alertID, userID, bindingID)
	if err != nil {
		return fmt.Errorf("acknowledge QQ balance alert: %w", err)
	}
	return nil
}
