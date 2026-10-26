package repository

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/service"
)

type botBindingRepository struct {
	db *sql.DB
}

// NewBotBindingRepository 创建机器人绑定仓储。
func NewBotBindingRepository(db *sql.DB) service.BotBindingRepository {
	return &botBindingRepository{db: db}
}

func (r *botBindingRepository) CreateCode(ctx context.Context, record *service.BotBindingCodeRecord) error {
	if record == nil {
		return fmt.Errorf("bot binding code record is required")
	}
	now := record.Now
	if now.IsZero() {
		now = time.Now().UTC()
	}
	// 同一用户只保留最新一个绑定码：重新生成时旧码立即失效，同时避免表无限增长。
	if _, err := r.db.ExecContext(ctx, `
		DELETE FROM bot_binding_codes WHERE user_id = $1
	`, record.UserID); err != nil {
		return fmt.Errorf("cleanup bot binding codes: %w", err)
	}
	if _, err := r.db.ExecContext(ctx, `
		INSERT INTO bot_binding_codes (user_id, code_hash, expires_at, created_at)
		VALUES ($1, $2, $3, $4)
	`, record.UserID, record.CodeHash, record.ExpiresAt, now); err != nil {
		return fmt.Errorf("create bot binding code: %w", err)
	}
	return nil
}

func (r *botBindingRepository) RedeemCode(ctx context.Context, params service.BotBindingRedeemParams) (*service.BotBinding, error) {
	now := params.Now
	if now.IsZero() {
		now = time.Now().UTC()
	}

	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("begin bot binding redeem: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	var userID int64
	err = tx.QueryRowContext(ctx, `
		UPDATE bot_binding_codes
		SET used_at = $2, platform = $3, external_id = $4
		WHERE code_hash = $1 AND used_at IS NULL AND expires_at > $2
		RETURNING user_id
	`, params.CodeHash, now, params.Platform, params.ExternalID).Scan(&userID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, service.ErrBotBindingCodeInvalid
	}
	if err != nil {
		return nil, fmt.Errorf("consume bot binding code: %w", err)
	}

	var status, email, passwordHash string
	if err := tx.QueryRowContext(ctx, `
		SELECT status, email, COALESCE(password_hash, '')
		FROM users
		WHERE id = $1
	`, userID).Scan(&status, &email, &passwordHash); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, service.ErrBotBindingCodeInvalid
		}
		return nil, fmt.Errorf("load bot binding user: %w", err)
	}
	if !isActiveUserStatus(status) {
		return nil, service.ErrBotBindingInactive
	}
	// 记录绑定时的凭据指纹：密码变更后指纹变化，旧绑定令牌随即失效。
	userTokenVersion := service.BotBindingCredentialVersion(email, passwordHash)

	// 只吊销"同一用户 + 同一聊天账号"的旧绑定：兑换接口是公开的，
	// external_id 由调用方提供，若按 external_id 全局吊销，任何登录用户都能
	// 用别人的聊天账号 ID 让对方的令牌失效。
	if _, err := tx.ExecContext(ctx, `
		UPDATE bot_bindings
		SET revoked_at = $3, updated_at = $3
		WHERE user_id = $1 AND platform = $2 AND external_id = $4 AND revoked_at IS NULL
	`, userID, params.Platform, now, params.ExternalID); err != nil {
		return nil, fmt.Errorf("revoke previous bot binding: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
		DELETE FROM balance_low_qq_deliveries
		WHERE user_id = $1
		  AND binding_id IN (
			SELECT id FROM bot_bindings
			WHERE user_id = $1 AND platform = $2 AND external_id = $3 AND revoked_at = $4
		  )
	`, userID, params.Platform, params.ExternalID, now); err != nil {
		return nil, fmt.Errorf("clear alerts for replaced bot binding: %w", err)
	}

	var activeCount int64
	if err := tx.QueryRowContext(ctx, `
		SELECT COUNT(1) FROM bot_bindings WHERE user_id = $1 AND revoked_at IS NULL
	`, userID).Scan(&activeCount); err != nil {
		return nil, fmt.Errorf("count active bot bindings: %w", err)
	}
	if activeCount >= service.BotBindingMaxActivePerUser {
		return nil, service.ErrBotBindingLimitReached
	}

	binding := &service.BotBinding{
		UserID:     userID,
		Platform:   params.Platform,
		ExternalID: params.ExternalID,
	}
	err = tx.QueryRowContext(ctx, `
		INSERT INTO bot_bindings
			(user_id, platform, external_id, token_hash, token_prefix, user_token_version, bound_at, created_at, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $7)
		RETURNING id, token_prefix, user_token_version, bound_at, created_at
	`, userID, params.Platform, params.ExternalID, params.TokenHash, params.TokenPrefix, userTokenVersion, now).
		Scan(&binding.ID, &binding.TokenPrefix, &binding.UserTokenVersion, &binding.BoundAt, &binding.CreatedAt)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, service.ErrBotBindingCodeInvalid
		}
		return nil, fmt.Errorf("create bot binding: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit bot binding redeem: %w", err)
	}
	return binding, nil
}

func (r *botBindingRepository) GetByTokenHash(ctx context.Context, tokenHash string) (*service.BotBinding, error) {
	row := r.db.QueryRowContext(ctx, `
		SELECT id, user_id, platform, external_id, token_prefix, user_token_version,
		       bound_at, last_used_at, created_at
		FROM bot_bindings
		WHERE token_hash = $1 AND revoked_at IS NULL
	`, tokenHash)
	binding, err := scanBotBinding(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, service.ErrBotBindingInvalid
	}
	if err != nil {
		return nil, fmt.Errorf("get bot binding: %w", err)
	}
	return binding, nil
}

func (r *botBindingRepository) TouchLastUsed(ctx context.Context, id int64, at time.Time) error {
	// 每分钟最多写一次，避免每个请求都产生一次 UPDATE。
	if _, err := r.db.ExecContext(ctx, `
		UPDATE bot_bindings
		SET last_used_at = $2
		WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < $2 - INTERVAL '1 minute')
	`, id, at); err != nil {
		return fmt.Errorf("touch bot binding: %w", err)
	}
	return nil
}

func (r *botBindingRepository) ListByUserID(ctx context.Context, userID int64) ([]service.BotBinding, error) {
	rows, err := r.db.QueryContext(ctx, `
		SELECT id, user_id, platform, external_id, token_prefix, user_token_version,
		       bound_at, last_used_at, created_at
		FROM bot_bindings
		WHERE user_id = $1 AND revoked_at IS NULL
		ORDER BY bound_at DESC, id DESC
	`, userID)
	if err != nil {
		return nil, fmt.Errorf("list bot bindings: %w", err)
	}
	defer func() { _ = rows.Close() }()

	bindings := make([]service.BotBinding, 0)
	for rows.Next() {
		binding, scanErr := scanBotBinding(rows)
		if scanErr != nil {
			return nil, fmt.Errorf("scan bot binding: %w", scanErr)
		}
		bindings = append(bindings, *binding)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list bot bindings: %w", err)
	}
	return bindings, nil
}

func (r *botBindingRepository) RevokeByID(ctx context.Context, userID, bindingID int64, revokedAt time.Time) error {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin revoke bot binding: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	result, err := tx.ExecContext(ctx, `
		UPDATE bot_bindings
		SET revoked_at = $3, updated_at = $3
		WHERE id = $2 AND user_id = $1 AND revoked_at IS NULL
	`, userID, bindingID, revokedAt)
	if err != nil {
		return fmt.Errorf("revoke bot binding: %w", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("revoke bot binding: %w", err)
	}
	if affected == 0 {
		return service.ErrBotBindingNotFound
	}
	if _, err := tx.ExecContext(ctx, `
		DELETE FROM balance_low_qq_deliveries WHERE user_id = $1 AND binding_id = $2
	`, userID, bindingID); err != nil {
		return fmt.Errorf("clear alerts for revoked bot binding: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE user_balance_notify_qq
		SET enabled = FALSE, updated_at = $2
		WHERE user_id = $1
		  AND enabled = TRUE
		  AND NOT EXISTS (
			SELECT 1 FROM bot_bindings
			WHERE user_id = $1 AND platform = 'qq' AND revoked_at IS NULL
		  )
	`, userID, revokedAt); err != nil {
		return fmt.Errorf("disable QQ alerts after last QQ binding is revoked: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit revoke bot binding: %w", err)
	}
	return nil
}

type botBindingScanner interface {
	Scan(dest ...any) error
}

func scanBotBinding(scanner botBindingScanner) (*service.BotBinding, error) {
	var binding service.BotBinding
	if err := scanner.Scan(
		&binding.ID,
		&binding.UserID,
		&binding.Platform,
		&binding.ExternalID,
		&binding.TokenPrefix,
		&binding.UserTokenVersion,
		&binding.BoundAt,
		&binding.LastUsedAt,
		&binding.CreatedAt,
	); err != nil {
		return nil, err
	}
	return &binding, nil
}

func isActiveUserStatus(status string) bool {
	return status == service.StatusActive
}
