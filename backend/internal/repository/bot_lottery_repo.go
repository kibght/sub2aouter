package repository

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/service"
)

type botLotteryRepository struct{ db *sql.DB }

func NewBotLotteryRepository(db *sql.DB) service.BotLotteryRepository {
	return &botLotteryRepository{db: db}
}

func (r *botLotteryRepository) GetConfig(ctx context.Context) (*service.BotLotteryConfig, error) {
	if r == nil || r.db == nil {
		return nil, service.ErrBotLotteryRepository
	}
	var enabled bool
	var raw []byte
	err := r.db.QueryRowContext(ctx, `SELECT enabled, prizes FROM bot_lottery_config WHERE id = 1`).Scan(&enabled, &raw)
	if errors.Is(err, sql.ErrNoRows) {
		return &service.BotLotteryConfig{Prizes: []service.BotLotteryPrize{}}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("load bot lottery config: %w", err)
	}
	config := &service.BotLotteryConfig{Enabled: enabled, Prizes: []service.BotLotteryPrize{}}
	if len(raw) != 0 {
		if err := json.Unmarshal(raw, &config.Prizes); err != nil {
			return nil, fmt.Errorf("decode bot lottery prizes: %w", err)
		}
	}
	if config.Prizes == nil {
		config.Prizes = []service.BotLotteryPrize{}
	}
	return config, nil
}

func (r *botLotteryRepository) SaveConfig(ctx context.Context, config service.BotLotteryConfig) error {
	if r == nil || r.db == nil {
		return service.ErrBotLotteryRepository
	}
	raw, err := json.Marshal(config.Prizes)
	if err != nil {
		return err
	}
	_, err = r.db.ExecContext(ctx, `
		INSERT INTO bot_lottery_config (id, enabled, prizes, updated_at)
		VALUES (1, $1, $2::jsonb, NOW())
		ON CONFLICT (id) DO UPDATE SET enabled = EXCLUDED.enabled, prizes = EXCLUDED.prizes, updated_at = NOW()
	`, config.Enabled, string(raw))
	if err != nil {
		return fmt.Errorf("save bot lottery config: %w", err)
	}
	return nil
}

func (r *botLotteryRepository) GetRemaining(ctx context.Context, userID int64) (int64, error) {
	if r == nil || r.db == nil {
		return 0, service.ErrBotLotteryRepository
	}
	var remaining int64
	err := r.db.QueryRowContext(ctx, `SELECT remaining FROM bot_lottery_accounts WHERE user_id = $1`, userID).Scan(&remaining)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil
	}
	if err != nil {
		return 0, fmt.Errorf("load bot lottery balance: %w", err)
	}
	return remaining, nil
}

func (r *botLotteryRepository) FindDraw(ctx context.Context, userID int64, operationID string) (*service.BotLotteryDrawResult, error) {
	if r == nil || r.db == nil {
		return nil, service.ErrBotLotteryRepository
	}
	var storedUser int64
	var action, prizeName string
	var countDelta, remaining int64
	var reward float64
	err := r.db.QueryRowContext(ctx, `SELECT user_id, action, count_delta, remaining_after, COALESCE(prize_name, ''), COALESCE(reward_amount, 0)::double precision FROM bot_lottery_operations WHERE operation_id = $1`, operationID).Scan(&storedUser, &action, &countDelta, &remaining, &prizeName, &reward)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("load bot lottery draw replay: %w", err)
	}
	if storedUser != userID || action != service.BotLotteryActionDraw || countDelta != -1 {
		return nil, service.ErrIdempotencyKeyConflict
	}
	return &service.BotLotteryDrawResult{Status: "success", PrizeName: prizeName, Reward: reward, Remaining: remaining, Replayed: true}, nil
}

func (r *botLotteryRepository) Draw(ctx context.Context, userID int64, operationID string, prize service.BotLotteryPrize, configSnapshot string) (*service.BotLotteryDrawResult, error) {
	if r == nil || r.db == nil {
		return nil, service.ErrBotLotteryRepository
	}
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("begin bot lottery draw: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, operationID); err != nil {
		return nil, err
	}
	if _, err = lockLotteryUser(ctx, tx, userID); err != nil {
		return nil, err
	}
	if prior, found, err := loadLotteryOperation(ctx, tx, operationID, userID, service.BotLotteryActionDraw); err != nil {
		return nil, err
	} else if found {
		return prior, nil
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO bot_lottery_accounts (user_id, remaining, updated_at) VALUES ($1, 0, NOW()) ON CONFLICT (user_id) DO NOTHING`, userID); err != nil {
		return nil, fmt.Errorf("create bot lottery account: %w", err)
	}
	var remaining int64
	if err := tx.QueryRowContext(ctx, `SELECT remaining FROM bot_lottery_accounts WHERE user_id = $1 FOR UPDATE`, userID).Scan(&remaining); err != nil {
		return nil, fmt.Errorf("lock bot lottery attempts: %w", err)
	}
	if remaining <= 0 {
		return nil, service.ErrBotLotteryNoTickets
	}
	var nextRemaining int64
	if err := tx.QueryRowContext(ctx, `UPDATE bot_lottery_accounts SET remaining = remaining - 1, updated_at = NOW() WHERE user_id = $1 RETURNING remaining`, userID).Scan(&nextRemaining); err != nil {
		return nil, fmt.Errorf("consume bot lottery attempt: %w", err)
	}
	var balanceBefore, balanceAfter float64
	if err := tx.QueryRowContext(ctx, `UPDATE users SET balance = balance + $2, updated_at = NOW() WHERE id = $1 AND deleted_at IS NULL AND status = $3 RETURNING balance - $2, balance`, userID, prize.Amount, service.StatusActive).Scan(&balanceBefore, &balanceAfter); errors.Is(err, sql.ErrNoRows) {
		return nil, service.ErrBotBindingInactive
	} else if err != nil {
		return nil, fmt.Errorf("credit bot lottery prize: %w", err)
	}
	now := time.Now().UTC()
	redeemCode, err := service.GenerateRedeemCode()
	if err != nil {
		return nil, fmt.Errorf("generate bot lottery history record: %w", err)
	}
	notes := fmt.Sprintf("抽奖奖励：%s（$%.8f）", prize.Name, prize.Amount)
	if _, err := tx.ExecContext(ctx, `INSERT INTO redeem_codes (code, type, value, status, used_by, used_at, notes, created_at) VALUES ($1, 'bot_lottery', $2, 'used', $3, $4, $5, $4)`, redeemCode, prize.Amount, userID, now, notes); err != nil {
		return nil, fmt.Errorf("record bot lottery balance history: %w", err)
	}
	_, err = tx.ExecContext(ctx, `
		INSERT INTO bot_lottery_operations (operation_id, user_id, action, count_delta, remaining_after, prize_id, prize_name, reward_amount, config_snapshot, balance_before, balance_after, created_at)
		VALUES ($1, $2, 'draw', -1, $3, $4, $5, $6, $7, $8, $9, $10)
	`, operationID, userID, nextRemaining, prize.ID, prize.Name, prize.Amount, configSnapshot, balanceBefore, balanceAfter, now)
	if err != nil {
		return nil, fmt.Errorf("record bot lottery draw: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit bot lottery draw: %w", err)
	}
	return &service.BotLotteryDrawResult{Status: "success", PrizeName: prize.Name, Reward: prize.Amount, Remaining: nextRemaining}, nil
}

func lockLotteryUser(ctx context.Context, tx *sql.Tx, userID int64) (string, error) {
	var status, role string
	err := tx.QueryRowContext(ctx, `SELECT status, role FROM users WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, userID).Scan(&status, &role)
	if errors.Is(err, sql.ErrNoRows) {
		return "", service.ErrUserNotFound
	}
	if err != nil {
		return "", fmt.Errorf("lock bot lottery user: %w", err)
	}
	if status != service.StatusActive {
		return "", service.ErrBotBindingInactive
	}
	return role, nil
}

func loadLotteryOperation(ctx context.Context, tx *sql.Tx, operationID string, userID int64, action string) (*service.BotLotteryDrawResult, bool, error) {
	var storedUser int64
	var storedAction, prizeName string
	var countDelta int64
	var remaining int64
	var reward float64
	err := tx.QueryRowContext(ctx, `SELECT user_id, action, count_delta, remaining_after, COALESCE(prize_name, ''), COALESCE(reward_amount, 0)::double precision FROM bot_lottery_operations WHERE operation_id = $1`, operationID).Scan(&storedUser, &storedAction, &countDelta, &remaining, &prizeName, &reward)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, fmt.Errorf("read bot lottery idempotency record: %w", err)
	}
	if storedUser != userID || storedAction != action || action == service.BotLotteryActionDraw && countDelta != -1 {
		return nil, false, service.ErrIdempotencyKeyConflict
	}
	return &service.BotLotteryDrawResult{Status: "success", PrizeName: prizeName, Reward: reward, Remaining: remaining, Replayed: true}, true, nil
}

func (r *botLotteryRepository) ListRecords(ctx context.Context, userID int64, limit int) ([]service.BotLotteryRecord, error) {
	if r == nil || r.db == nil {
		return nil, service.ErrBotLotteryRepository
	}
	if limit <= 0 || limit > 100 {
		limit = 50
	}
	rows, err := r.db.QueryContext(ctx, `
		SELECT id, action, count_delta, remaining_after, COALESCE(prize_name, ''), COALESCE(reward_amount, 0)::double precision, COALESCE(notes, ''), created_at
		FROM bot_lottery_operations WHERE user_id = $1 ORDER BY id DESC LIMIT $2
	`, userID, limit)
	if err != nil {
		return nil, fmt.Errorf("list bot lottery records: %w", err)
	}
	defer func() { _ = rows.Close() }()
	items := make([]service.BotLotteryRecord, 0)
	for rows.Next() {
		var item service.BotLotteryRecord
		var delta int64
		if err := rows.Scan(&item.ID, &item.Action, &delta, &item.Remaining, &item.PrizeName, &item.Reward, &item.Notes, &item.CreatedAt); err != nil {
			return nil, err
		}
		item.Count = delta
		if item.Count < 0 {
			item.Count = -item.Count
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (r *botLotteryRepository) FindGrant(ctx context.Context, operationID, target string, count int64, notes string) (*service.BotLotteryGrantResult, error) {
	if r == nil || r.db == nil {
		return nil, service.ErrBotLotteryRepository
	}
	var userID, storedCount, remaining int64
	var action, storedNotes, storedTarget string
	err := r.db.QueryRowContext(ctx, `SELECT user_id, action, count_delta, remaining_after, notes, target_identity FROM bot_lottery_operations WHERE operation_id = $1`, operationID).Scan(&userID, &action, &storedCount, &remaining, &storedNotes, &storedTarget)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("load bot lottery grant replay: %w", err)
	}
	if action != service.BotLotteryActionGrant || storedCount != count || storedNotes != strings.TrimSpace(notes) || storedTarget != target {
		return nil, service.ErrIdempotencyKeyConflict
	}
	return &service.BotLotteryGrantResult{Status: "success", UserID: userID, Count: storedCount, Remaining: remaining, Replayed: true}, nil
}

func (r *botLotteryRepository) Grant(ctx context.Context, userID, count int64, notes, operationID string, actorID int64, target string) (int64, bool, error) {
	if r == nil || r.db == nil {
		return 0, false, service.ErrBotLotteryRepository
	}
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, false, fmt.Errorf("begin bot lottery grant: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, operationID); err != nil {
		return 0, false, err
	}
	if _, err := lockLotteryUser(ctx, tx, userID); err != nil {
		return 0, false, err
	}
	var storedUser int64
	var storedAction, storedNotes, storedTarget string
	var storedDelta, storedRemaining int64
	err = tx.QueryRowContext(ctx, `SELECT user_id, action, count_delta, remaining_after, notes, target_identity FROM bot_lottery_operations WHERE operation_id = $1`, operationID).Scan(&storedUser, &storedAction, &storedDelta, &storedRemaining, &storedNotes, &storedTarget)
	if err == nil {
		if storedUser != userID || storedAction != service.BotLotteryActionGrant || storedDelta != count || storedNotes != strings.TrimSpace(notes) || storedTarget != target {
			return 0, false, service.ErrIdempotencyKeyConflict
		}
		return storedRemaining, true, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return 0, false, fmt.Errorf("read bot lottery grant idempotency: %w", err)
	}
	var remaining int64
	err = tx.QueryRowContext(ctx, `INSERT INTO bot_lottery_accounts (user_id, remaining, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (user_id) DO UPDATE SET remaining = bot_lottery_accounts.remaining + EXCLUDED.remaining, updated_at = NOW() RETURNING remaining`, userID, count).Scan(&remaining)
	if err != nil {
		return 0, false, fmt.Errorf("add bot lottery attempts: %w", err)
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO bot_lottery_operations (operation_id, user_id, action, count_delta, remaining_after, notes, actor_user_id, target_identity, created_at) VALUES ($1, $2, 'grant', $3, $4, $5, $6, $7, NOW())`, operationID, userID, count, remaining, strings.TrimSpace(notes), actorID, target)
	if err != nil {
		return 0, false, fmt.Errorf("record bot lottery grant: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return 0, false, fmt.Errorf("commit bot lottery grant: %w", err)
	}
	return remaining, false, nil
}

func (r *botLotteryRepository) ResolveQQUser(ctx context.Context, qq string) (int64, error) {
	if r == nil || r.db == nil {
		return 0, service.ErrBotLotteryRepository
	}
	rows, err := r.db.QueryContext(ctx, `SELECT b.user_id, b.user_token_version, u.email, COALESCE(u.password_hash, '') FROM bot_bindings b JOIN users u ON u.id = b.user_id WHERE b.platform = 'qq' AND b.external_id = $1 AND b.revoked_at IS NULL AND u.deleted_at IS NULL AND u.status = $2`, strings.TrimSpace(qq), service.StatusActive)
	if err != nil {
		return 0, fmt.Errorf("resolve QQ lottery user: %w", err)
	}
	defer func() { _ = rows.Close() }()
	var matchedUser int64
	for rows.Next() {
		var userID, tokenVersion int64
		var email, passwordHash string
		if err := rows.Scan(&userID, &tokenVersion, &email, &passwordHash); err != nil {
			return 0, err
		}
		if tokenVersion != service.BotBindingCredentialVersion(email, passwordHash) {
			continue
		}
		if matchedUser > 0 && matchedUser != userID {
			return 0, service.ErrBotLotteryTargetAmbiguous
		}
		matchedUser = userID
	}
	if err := rows.Err(); err != nil {
		return 0, err
	}
	if matchedUser <= 0 {
		return 0, service.ErrBotLotteryTargetNotFound
	}
	return matchedUser, nil
}

func (r *botLotteryRepository) CreateGrantBatch(ctx context.Context, request service.BotLotteryGrantBatchRequest) (int64, bool, error) {
	if r == nil || r.db == nil {
		return 0, false, service.ErrBotLotteryRepository
	}
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, false, fmt.Errorf("begin bot lottery grant batch: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	var batchID int64
	err = tx.QueryRowContext(ctx, `INSERT INTO bot_lottery_grant_batches (request_id, actor_user_id, count, notes, total, created_at) VALUES ($1, $2, $3, $4, 0, NOW()) ON CONFLICT (request_id) DO NOTHING RETURNING id`, request.OperationID, request.ActorID, request.Count, strings.TrimSpace(request.Notes)).Scan(&batchID)
	if errors.Is(err, sql.ErrNoRows) {
		var actorID, count int64
		var notes string
		if err := tx.QueryRowContext(ctx, `SELECT id, actor_user_id, count, notes FROM bot_lottery_grant_batches WHERE request_id = $1`, request.OperationID).Scan(&batchID, &actorID, &count, &notes); err != nil {
			return 0, false, fmt.Errorf("load existing bot lottery grant batch: %w", err)
		}
		if actorID != request.ActorID || count != request.Count || notes != strings.TrimSpace(request.Notes) {
			return 0, false, service.ErrIdempotencyKeyConflict
		}
		return batchID, true, nil
	}
	if err != nil {
		return 0, false, fmt.Errorf("create bot lottery grant batch: %w", err)
	}
	rows, err := tx.QueryContext(ctx, `SELECT b.user_id, b.user_token_version, u.email, COALESCE(u.password_hash, '') FROM bot_bindings b JOIN users u ON u.id = b.user_id WHERE b.platform = 'qq' AND b.revoked_at IS NULL AND u.deleted_at IS NULL AND u.status = $1 ORDER BY b.user_id`, service.StatusActive)
	if err != nil {
		return 0, false, fmt.Errorf("load eligible bot lottery users: %w", err)
	}
	eligible := make(map[int64]struct{})
	for rows.Next() {
		var userID, version int64
		var email, passwordHash string
		if err := rows.Scan(&userID, &version, &email, &passwordHash); err != nil {
			_ = rows.Close()
			return 0, false, err
		}
		if version == service.BotBindingCredentialVersion(email, passwordHash) {
			eligible[userID] = struct{}{}
		}
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return 0, false, err
	}
	_ = rows.Close()
	for userID := range eligible {
		if _, err := tx.ExecContext(ctx, `INSERT INTO bot_lottery_grant_batch_items (batch_id, user_id, status) VALUES ($1, $2, 'pending') ON CONFLICT (batch_id, user_id) DO NOTHING`, batchID, userID); err != nil {
			return 0, false, fmt.Errorf("snapshot bot lottery batch member: %w", err)
		}
	}
	if _, err := tx.ExecContext(ctx, `UPDATE bot_lottery_grant_batches SET total = (SELECT COUNT(*) FROM bot_lottery_grant_batch_items WHERE batch_id = $1) WHERE id = $1`, batchID); err != nil {
		return 0, false, err
	}
	if err := tx.Commit(); err != nil {
		return 0, false, fmt.Errorf("commit bot lottery grant batch: %w", err)
	}
	return batchID, false, nil
}

func (r *botLotteryRepository) ProcessGrantBatch(ctx context.Context, batchID int64) error {
	if r == nil || r.db == nil {
		return service.ErrBotLotteryRepository
	}
	rows, err := r.db.QueryContext(ctx, `SELECT user_id FROM bot_lottery_grant_batch_items WHERE batch_id = $1 AND status = 'pending' ORDER BY user_id LIMIT 100`, batchID)
	if err != nil {
		return fmt.Errorf("list pending bot lottery grants: %w", err)
	}
	ids := make([]int64, 0)
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			_ = rows.Close()
			return err
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return err
	}
	_ = rows.Close()
	var firstErr error
	for _, userID := range ids {
		if err := r.processGrantBatchItem(ctx, batchID, userID); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

func (r *botLotteryRepository) processGrantBatchItem(ctx context.Context, batchID, userID int64) error {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	var count int64
	var notes string
	var actorID int64
	var status string
	err = tx.QueryRowContext(ctx, `SELECT b.count, b.notes, b.actor_user_id, i.status FROM bot_lottery_grant_batches b JOIN bot_lottery_grant_batch_items i ON i.batch_id = b.id WHERE b.id = $1 AND i.user_id = $2 FOR UPDATE OF i`, batchID, userID).Scan(&count, &notes, &actorID, &status)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("lock bot lottery grant member: %w", err)
	}
	if status != "pending" {
		return nil
	}
	var userStatus, email, passwordHash string
	err = tx.QueryRowContext(ctx, `SELECT status, email, COALESCE(password_hash, '') FROM users WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, userID).Scan(&userStatus, &email, &passwordHash)
	if errors.Is(err, sql.ErrNoRows) || err == nil && userStatus != service.StatusActive {
		return skipLotteryBatchItem(ctx, tx, batchID, userID, "user_inactive")
	}
	if err != nil {
		return fmt.Errorf("load bot lottery grant user: %w", err)
	}
	bindings, err := tx.QueryContext(ctx, `SELECT user_token_version FROM bot_bindings WHERE user_id = $1 AND platform = 'qq' AND revoked_at IS NULL`, userID)
	if err != nil {
		return fmt.Errorf("check bot lottery grant binding: %w", err)
	}
	validBinding := false
	credentialVersion := service.BotBindingCredentialVersion(email, passwordHash)
	for bindings.Next() {
		var version int64
		if err := bindings.Scan(&version); err != nil {
			_ = bindings.Close()
			return err
		}
		if version == credentialVersion {
			validBinding = true
		}
	}
	if err := bindings.Err(); err != nil {
		_ = bindings.Close()
		return err
	}
	_ = bindings.Close()
	if !validBinding {
		return skipLotteryBatchItem(ctx, tx, batchID, userID, "binding_inactive")
	}
	operationID := fmt.Sprintf("batch-%d-user-%d", batchID, userID)
	var oldUser int64
	var oldAction string
	var oldDelta, remaining int64
	err = tx.QueryRowContext(ctx, `SELECT user_id, action, count_delta, remaining_after FROM bot_lottery_operations WHERE operation_id = $1`, operationID).Scan(&oldUser, &oldAction, &oldDelta, &remaining)
	if errors.Is(err, sql.ErrNoRows) {
		err = tx.QueryRowContext(ctx, `INSERT INTO bot_lottery_accounts (user_id, remaining, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (user_id) DO UPDATE SET remaining = bot_lottery_accounts.remaining + EXCLUDED.remaining, updated_at = NOW() RETURNING remaining`, userID, count).Scan(&remaining)
		if err != nil {
			return fmt.Errorf("apply bot lottery batch grant: %w", err)
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO bot_lottery_operations (operation_id, user_id, action, count_delta, remaining_after, notes, actor_user_id, batch_id, created_at) VALUES ($1, $2, 'grant', $3, $4, $5, $6, $7, NOW())`, operationID, userID, count, remaining, strings.TrimSpace(notes), actorID, batchID)
		if err != nil {
			return fmt.Errorf("record bot lottery batch grant: %w", err)
		}
	} else if err != nil {
		return fmt.Errorf("check bot lottery batch idempotency: %w", err)
	} else if oldUser != userID || oldAction != service.BotLotteryActionGrant || oldDelta != count {
		return service.ErrIdempotencyKeyConflict
	}
	if _, err := tx.ExecContext(ctx, `UPDATE bot_lottery_grant_batch_items SET status = 'success', remaining_after = $3, updated_at = NOW() WHERE batch_id = $1 AND user_id = $2`, batchID, userID, remaining); err != nil {
		return err
	}
	return tx.Commit()
}

func skipLotteryBatchItem(ctx context.Context, tx *sql.Tx, batchID, userID int64, reason string) error {
	if _, err := tx.ExecContext(ctx, `UPDATE bot_lottery_grant_batch_items SET status = 'skipped', error_message = $3, updated_at = NOW() WHERE batch_id = $1 AND user_id = $2`, batchID, userID, reason); err != nil {
		return err
	}
	return tx.Commit()
}

func (r *botLotteryRepository) GetGrantBatch(ctx context.Context, batchID int64) (*service.BotLotteryGrantBatch, error) {
	if r == nil || r.db == nil {
		return nil, service.ErrBotLotteryRepository
	}
	batch := &service.BotLotteryGrantBatch{BotLotteryGrantResult: service.BotLotteryGrantResult{BatchID: batchID}}
	err := r.db.QueryRowContext(ctx, `SELECT count, total, created_at FROM bot_lottery_grant_batches WHERE id = $1`, batchID).Scan(&batch.Count, &batch.Total, &batch.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, service.ErrBotLotteryBatchNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("load bot lottery grant batch: %w", err)
	}
	rows, err := r.db.QueryContext(ctx, `SELECT user_id, status, COALESCE(error_message, '') FROM bot_lottery_grant_batch_items WHERE batch_id = $1 ORDER BY user_id`, batchID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	batch.Items = make([]service.BotLotteryGrantBatchItem, 0)
	for rows.Next() {
		var item service.BotLotteryGrantBatchItem
		if err := rows.Scan(&item.UserID, &item.Status, &item.Error); err != nil {
			return nil, err
		}
		if item.Error == "" {
			item.Error = ""
		}
		batch.Items = append(batch.Items, item)
		switch item.Status {
		case "success":
			batch.Success++
		case "failed":
			batch.Failed++
		case "skipped":
			batch.Skipped++
		default:
			batch.Pending++
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	batch.Status = "pending"
	if batch.Pending == 0 {
		batch.Status = "completed"
	}
	return batch, nil
}

func (r *botLotteryRepository) PendingGrantBatchIDs(ctx context.Context, limit int) ([]int64, error) {
	if r == nil || r.db == nil {
		return nil, service.ErrBotLotteryRepository
	}
	if limit <= 0 || limit > 100 {
		limit = 10
	}
	rows, err := r.db.QueryContext(ctx, `SELECT b.id FROM bot_lottery_grant_batches b WHERE EXISTS (SELECT 1 FROM bot_lottery_grant_batch_items i WHERE i.batch_id = b.id AND i.status = 'pending') ORDER BY b.id LIMIT $1`, limit)
	if err != nil {
		return nil, fmt.Errorf("load pending bot lottery batches: %w", err)
	}
	defer func() { _ = rows.Close() }()
	ids := make([]int64, 0)
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}
