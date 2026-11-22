package repository

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/service"
)

type balanceNotificationRepository struct{ db *sql.DB }

func NewBalanceNotificationRepository(db *sql.DB) service.BalanceNotificationRepository {
	return &balanceNotificationRepository{db: db}
}

func (r *balanceNotificationRepository) ReconcileBatch(ctx context.Context, afterID int64, limit int) (int64, int, error) {
	if limit <= 0 || limit > 200 {
		limit = 200
	}
	var next int64
	var count int
	err := r.db.QueryRowContext(ctx, `
		WITH scan_lock AS MATERIALIZED (
			SELECT pg_try_advisory_xact_lock(27631,255) acquired
		), batch AS MATERIALIZED (
			SELECT id FROM users WHERE id>$1 AND (SELECT acquired FROM scan_lock) ORDER BY id LIMIT $2
		), reconciled AS MATERIALIZED (
			SELECT id,reconcile_balance_notification(id) FROM batch ORDER BY id
		)
		SELECT COALESCE(MAX(id),0),COUNT(*) FROM reconciled
	`, afterID, limit).Scan(&next, &count)
	if err != nil {
		return 0, 0, fmt.Errorf("reconcile balance notification batch: %w", err)
	}
	return next, count, nil
}

func (r *balanceNotificationRepository) ClaimEmails(ctx context.Context, now, leaseUntil time.Time, limit int) ([]service.BalanceEmailDelivery, error) {
	if limit <= 0 || limit > 20 {
		limit = 20
	}
	rows, err := r.db.QueryContext(ctx, `
		WITH candidates AS (
			SELECT id FROM balance_notification_emails
			WHERE status='pending' AND next_attempt_at<=$1 AND (lease_until IS NULL OR lease_until<=$1)
			ORDER BY next_attempt_at,id LIMIT $3 FOR UPDATE SKIP LOCKED
		), claimed AS (
			UPDATE balance_notification_emails d SET lease_until=$2,attempts=attempts+1
			FROM candidates c WHERE d.id=c.id RETURNING d.*
		)
		SELECT d.id,d.event_id,e.user_id,d.recipient,COALESCE(NULLIF(u.username,''),u.email),
		       u.balance,balance_notification_threshold(u),
		       COALESCE((SELECT value FROM settings WHERE key='balance_low_notify_recharge_url'),''),d.attempts,
		       e.closed_at IS NULL AND u.deleted_at IS NULL AND u.status='active' AND u.balance_notify_enabled
		       AND balance_notification_threshold(u)>0 AND u.balance<balance_notification_threshold(u)
		       AND EXISTS(SELECT 1 FROM settings WHERE key='balance_low_notify_enabled' AND value='true')
		       AND EXISTS(SELECT 1 FROM balance_notification_recipients(u.balance_notify_extra_emails) r WHERE r.email=d.recipient)
		FROM claimed d JOIN balance_notification_events e ON e.id=d.event_id JOIN users u ON u.id=e.user_id
	`, now, leaseUntil, limit)
	if err != nil {
		return nil, fmt.Errorf("claim balance notification emails: %w", err)
	}
	defer func() { _ = rows.Close() }()
	var deliveries []service.BalanceEmailDelivery
	for rows.Next() {
		var d service.BalanceEmailDelivery
		if err := rows.Scan(&d.ID, &d.EventID, &d.UserID, &d.Recipient, &d.Name, &d.Balance, &d.Threshold, &d.RechargeURL, &d.Attempts, &d.Eligible); err != nil {
			return nil, err
		}
		deliveries = append(deliveries, d)
	}
	return deliveries, rows.Err()
}

func (r *balanceNotificationRepository) FinishEmail(ctx context.Context, d service.BalanceEmailDelivery, status string, retryAt time.Time, errorCode string) error {
	switch status {
	case "pending", "sent", "cancelled", "suppressed":
	default:
		return fmt.Errorf("invalid balance notification status")
	}
	_, err := r.db.ExecContext(ctx, `
		UPDATE balance_notification_emails
		SET status=$3,lease_until=NULL,next_attempt_at=$4,last_error=$5,
		    completed_at=CASE WHEN $3='pending' THEN NULL ELSE NOW() END
		WHERE id=$1 AND attempts=$2 AND status='pending'
	`, d.ID, d.Attempts, status, retryAt, errorCode)
	if err != nil {
		return fmt.Errorf("finish balance notification email: %w", err)
	}
	return nil
}
