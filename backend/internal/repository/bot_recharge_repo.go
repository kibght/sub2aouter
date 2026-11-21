package repository

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/service"
)

type botRechargeRepository struct {
	db *sql.DB
}

func NewBotRechargeRepository(db *sql.DB) service.BotRechargeRepository {
	return &botRechargeRepository{db: db}
}

func (r *botRechargeRepository) FindRequest(ctx context.Context, userID int64, requestID string) (*service.BotRechargeRequestRecord, error) {
	if r == nil || r.db == nil || userID <= 0 || strings.TrimSpace(requestID) == "" {
		return nil, fmt.Errorf("bot recharge repository is unavailable")
	}
	var record service.BotRechargeRequestRecord
	err := r.db.QueryRowContext(ctx, `
		SELECT payment_order_id, binding_id, platform, external_id, payment_type, requested_amount
		FROM bot_recharge_requests WHERE user_id = $1 AND request_id = $2
	`, userID, strings.TrimSpace(requestID)).Scan(
		&record.PaymentOrderID, &record.BindingID, &record.Platform, &record.ExternalID,
		&record.PaymentType, &record.Amount,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("find bot recharge request: %w", err)
	}
	return &record, nil
}

func (r *botRechargeRepository) FindOrderRequest(ctx context.Context, userID, orderID int64) (*service.BotRechargeRequestRecord, error) {
	if r == nil || r.db == nil || userID <= 0 || orderID <= 0 {
		return nil, fmt.Errorf("bot recharge repository is unavailable")
	}
	var record service.BotRechargeRequestRecord
	err := r.db.QueryRowContext(ctx, `
		SELECT payment_order_id, binding_id, platform, external_id, payment_type, requested_amount
		FROM bot_recharge_requests WHERE user_id = $1 AND payment_order_id = $2
	`, userID, orderID).Scan(
		&record.PaymentOrderID, &record.BindingID, &record.Platform, &record.ExternalID,
		&record.PaymentType, &record.Amount,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("find bot recharge order: %w", err)
	}
	return &record, nil
}

func (r *botRechargeRepository) LatestOrderID(ctx context.Context, userID int64) (int64, error) {
	if r == nil || r.db == nil || userID <= 0 {
		return 0, fmt.Errorf("bot recharge repository is unavailable")
	}
	var orderID int64
	err := r.db.QueryRowContext(ctx, `
		SELECT payment_order_id FROM bot_recharge_requests
		WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1
	`, userID).Scan(&orderID)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil
	}
	if err != nil {
		return 0, fmt.Errorf("find latest bot recharge order: %w", err)
	}
	return orderID, nil
}

func (r *botRechargeRepository) ClaimCompletedNotifications(
	ctx context.Context,
	userID, bindingID int64,
	platform, externalID string,
	limit int,
) ([]service.BotRechargeNotification, error) {
	if r == nil || r.db == nil || userID <= 0 || bindingID <= 0 || strings.TrimSpace(platform) == "" || strings.TrimSpace(externalID) == "" {
		return nil, fmt.Errorf("bot recharge repository is unavailable")
	}
	if limit <= 0 || limit > 50 {
		limit = 20
	}
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("begin bot recharge notification claim: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	_, err = tx.ExecContext(ctx, `
		INSERT INTO bot_recharge_notifications
			(user_id, binding_id, external_id, platform, payment_order_id, credited_amount, currency)
		SELECT rr.user_id, rr.binding_id, rr.external_id, rr.platform, o.id, o.amount, 'USD'
		FROM bot_recharge_requests rr
		JOIN payment_orders o ON o.id = rr.payment_order_id
		LEFT JOIN bot_recharge_notifications n ON n.payment_order_id = o.id
		WHERE rr.user_id = $1 AND rr.binding_id = $2
		  AND rr.platform = $3 AND rr.external_id = $4
		  AND o.order_type = 'balance' AND o.status = 'COMPLETED' AND n.id IS NULL
		ON CONFLICT (payment_order_id) DO NOTHING
	`, userID, bindingID, strings.TrimSpace(platform), strings.TrimSpace(externalID))
	if err != nil {
		return nil, fmt.Errorf("backfill completed bot recharge notifications: %w", err)
	}

	now := time.Now().UTC()
	leaseUntil := now.Add(2 * time.Minute)
	rows, err := tx.QueryContext(ctx, `
		SELECT id, payment_order_id, credited_amount, currency, created_at
		FROM bot_recharge_notifications
		WHERE user_id = $1 AND binding_id = $2 AND platform = $3 AND external_id = $4
		  AND acked_at IS NULL AND (lease_until IS NULL OR lease_until <= $5)
		ORDER BY id
		LIMIT $6
		FOR UPDATE SKIP LOCKED
	`, userID, bindingID, strings.TrimSpace(platform), strings.TrimSpace(externalID), now, limit)
	if err != nil {
		return nil, fmt.Errorf("load pending bot recharge notifications: %w", err)
	}
	claimed := make([]service.BotRechargeNotification, 0, limit)
	for rows.Next() {
		var item service.BotRechargeNotification
		if err := rows.Scan(&item.ID, &item.OrderID, &item.CreditedAmount, &item.Currency, &item.CreatedAt); err != nil {
			_ = rows.Close()
			return nil, fmt.Errorf("scan bot recharge notification: %w", err)
		}
		claimed = append(claimed, item)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return nil, fmt.Errorf("iterate bot recharge notifications: %w", err)
	}
	if err := rows.Close(); err != nil {
		return nil, fmt.Errorf("close bot recharge notification rows: %w", err)
	}
	for _, item := range claimed {
		if _, err := tx.ExecContext(ctx, `
			UPDATE bot_recharge_notifications SET lease_until = $2
			WHERE id = $1 AND acked_at IS NULL
		`, item.ID, leaseUntil); err != nil {
			return nil, fmt.Errorf("lease bot recharge notification: %w", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit bot recharge notification claim: %w", err)
	}
	return claimed, nil
}

func (r *botRechargeRepository) AckNotification(ctx context.Context, userID, bindingID, notificationID int64) (bool, error) {
	if r == nil || r.db == nil || userID <= 0 || bindingID <= 0 || notificationID <= 0 {
		return false, fmt.Errorf("bot recharge repository is unavailable")
	}
	result, err := r.db.ExecContext(ctx, `
		UPDATE bot_recharge_notifications
		SET acked_at = COALESCE(acked_at, NOW()), lease_until = NULL
		WHERE id = $1 AND user_id = $2 AND binding_id = $3
	`, notificationID, userID, bindingID)
	if err != nil {
		return false, fmt.Errorf("ack bot recharge notification: %w", err)
	}
	count, err := result.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("count acknowledged bot recharge notifications: %w", err)
	}
	return count > 0, nil
}
