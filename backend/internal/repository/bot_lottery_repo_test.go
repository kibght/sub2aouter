package repository

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"regexp"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/stretchr/testify/require"
)

func lotteryMockRepo(t *testing.T) (*botLotteryRepository, sqlmock.Sqlmock) {
	t.Helper()
	db, mock, err := sqlmock.New()
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, mock.ExpectationsWereMet()); _ = db.Close() })
	return &botLotteryRepository{db: db}, mock
}

func expectLotteryDrawStart(mock sqlmock.Sqlmock, remaining int64) {
	expectLotteryDrawLockedUser(mock, 7)
	mock.ExpectExec("INSERT INTO bot_lottery_accounts").WithArgs(int64(42)).WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectQuery("SELECT remaining FROM bot_lottery_accounts").WithArgs(int64(42)).WillReturnRows(sqlmock.NewRows([]string{"remaining"}).AddRow(remaining))
}

func expectLotteryDrawLockedUser(mock sqlmock.Sqlmock, balance float64) {
	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")).WithArgs("operation").WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectQuery(regexp.QuoteMeta("SELECT status, balance FROM users WHERE id = $1 AND deleted_at IS NULL FOR UPDATE")).WithArgs(int64(42)).WillReturnRows(sqlmock.NewRows([]string{"status", "balance"}).AddRow(service.StatusActive, balance))
	mock.ExpectQuery("SELECT user_id, action, count_delta, remaining_after").WithArgs("operation").WillReturnError(sql.ErrNoRows)
}

func lotteryPrizeSelector(prize service.BotLotteryPrize) service.BotLotteryPrizeSelector {
	return func() (service.BotLotteryPrize, error) { return prize, nil }
}

func TestBotLotteryRepositoryDrawCommitsCreditAttemptAndBothRecordsTogether(t *testing.T) {
	repo, mock := lotteryMockRepo(t)
	expectLotteryDrawStart(mock, 1)
	mock.ExpectQuery("UPDATE bot_lottery_accounts SET remaining = remaining - 1").WithArgs(int64(42)).WillReturnRows(sqlmock.NewRows([]string{"remaining"}).AddRow(0))
	mock.ExpectQuery("UPDATE users SET balance = balance").WithArgs(int64(42), 0.29, service.StatusActive).WillReturnRows(sqlmock.NewRows([]string{"before", "after"}).AddRow(7, 7.29))
	mock.ExpectExec("INSERT INTO redeem_codes").WithArgs(sqlmock.AnyArg(), 0.29, int64(42), sqlmock.AnyArg(), sqlmock.AnyArg()).WillReturnResult(sqlmock.NewResult(9, 1))
	mock.ExpectExec("INSERT INTO bot_lottery_operations").WithArgs("operation", int64(42), int64(0), "reward", "reward", 0.29, "snapshot", 7.0, 7.29, sqlmock.AnyArg()).WillReturnResult(sqlmock.NewResult(10, 1))
	mock.ExpectCommit()
	result, err := repo.Draw(context.Background(), 42, "operation", lotteryPrizeSelector(service.BotLotteryPrize{ID: "reward", Name: "reward", Amount: 0.29, Weight: 1}), "snapshot")
	require.NoError(t, err)
	require.Equal(t, 0.29, result.Reward)
	require.Zero(t, result.Remaining)
	require.False(t, result.Replayed)
}

func TestBotLotteryRepositoryDrawRollsBackCreditWhenHistoryWriteFails(t *testing.T) {
	repo, mock := lotteryMockRepo(t)
	expectLotteryDrawStart(mock, 1)
	mock.ExpectQuery("UPDATE bot_lottery_accounts SET remaining = remaining - 1").WithArgs(int64(42)).WillReturnRows(sqlmock.NewRows([]string{"remaining"}).AddRow(0))
	mock.ExpectQuery("UPDATE users SET balance = balance").WithArgs(int64(42), 0.29, service.StatusActive).WillReturnRows(sqlmock.NewRows([]string{"before", "after"}).AddRow(7, 7.29))
	mock.ExpectExec("INSERT INTO redeem_codes").WillReturnError(errors.New("temporary storage error"))
	mock.ExpectRollback()
	_, err := repo.Draw(context.Background(), 42, "operation", lotteryPrizeSelector(service.BotLotteryPrize{ID: "reward", Name: "reward", Amount: 0.29, Weight: 1}), "snapshot")
	require.ErrorContains(t, err, "balance history")
}

func TestBotLotteryRepositoryNoAttemptsDoesNotCreditBalance(t *testing.T) {
	repo, mock := lotteryMockRepo(t)
	expectLotteryDrawStart(mock, 0)
	mock.ExpectRollback()
	_, err := repo.Draw(context.Background(), 42, "operation", func() (service.BotLotteryPrize, error) {
		t.Fatal("a draw without attempts must not choose a prize")
		return service.BotLotteryPrize{}, nil
	}, "snapshot")
	require.ErrorIs(t, err, service.ErrBotLotteryNoTickets)
}

func TestBotLotteryRepositoryInsufficientBalanceDoesNotDraw(t *testing.T) {
	for _, tc := range []struct {
		name    string
		balance float64
	}{
		{name: "zero", balance: 0},
		{name: "negative", balance: -1},
		{name: "small_negative", balance: -0.00000001},
	} {
		t.Run(tc.name, func(t *testing.T) {
			repo, mock := lotteryMockRepo(t)
			expectLotteryDrawLockedUser(mock, tc.balance)
			mock.ExpectRollback()
			result, err := repo.Draw(context.Background(), 42, "operation", func() (service.BotLotteryPrize, error) {
				t.Fatal("an insufficient balance must not choose a prize")
				return service.BotLotteryPrize{}, nil
			}, "snapshot")
			require.ErrorIs(t, err, service.ErrBotLotteryInsufficientBalance)
			require.Nil(t, result)
		})
	}
}

func TestBotLotteryRepositorySmallPositiveBalanceCanDraw(t *testing.T) {
	repo, mock := lotteryMockRepo(t)
	expectLotteryDrawLockedUser(mock, 0.00000001)
	mock.ExpectExec("INSERT INTO bot_lottery_accounts").WithArgs(int64(42)).WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectQuery("SELECT remaining FROM bot_lottery_accounts").WithArgs(int64(42)).WillReturnRows(sqlmock.NewRows([]string{"remaining"}).AddRow(1))
	mock.ExpectQuery("UPDATE bot_lottery_accounts SET remaining = remaining - 1").WithArgs(int64(42)).WillReturnRows(sqlmock.NewRows([]string{"remaining"}).AddRow(0))
	mock.ExpectQuery("UPDATE users SET balance = balance").WithArgs(int64(42), 0.29, service.StatusActive).WillReturnRows(sqlmock.NewRows([]string{"before", "after"}).AddRow(0.00000001, 0.29000001))
	mock.ExpectExec("INSERT INTO redeem_codes").WithArgs(sqlmock.AnyArg(), 0.29, int64(42), sqlmock.AnyArg(), sqlmock.AnyArg()).WillReturnResult(sqlmock.NewResult(9, 1))
	mock.ExpectExec("INSERT INTO bot_lottery_operations").WithArgs("operation", int64(42), int64(0), "reward", "reward", 0.29, "snapshot", 0.00000001, 0.29000001, sqlmock.AnyArg()).WillReturnResult(sqlmock.NewResult(10, 1))
	mock.ExpectCommit()
	result, err := repo.Draw(context.Background(), 42, "operation", lotteryPrizeSelector(service.BotLotteryPrize{ID: "reward", Name: "reward", Amount: 0.29, Weight: 1}), "snapshot")
	require.NoError(t, err)
	require.Equal(t, 0.29, result.Reward)
	require.Zero(t, result.Remaining)
}

func TestBotLotteryRepositoryPrizeSelectionFailureRollsBack(t *testing.T) {
	repo, mock := lotteryMockRepo(t)
	expectLotteryDrawStart(mock, 1)
	mock.ExpectRollback()
	selectErr := errors.New("random source unavailable")
	result, err := repo.Draw(context.Background(), 42, "operation", func() (service.BotLotteryPrize, error) {
		return service.BotLotteryPrize{}, selectErr
	}, "snapshot")
	require.ErrorIs(t, err, selectErr)
	require.Nil(t, result)
}

func TestBotLotteryRepositoryDrawReplayDoesNotConsumeAttempt(t *testing.T) {
	repo, mock := lotteryMockRepo(t)
	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")).WithArgs("operation").WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectQuery("SELECT status, balance FROM users").WithArgs(int64(42)).WillReturnRows(sqlmock.NewRows([]string{"status", "balance"}).AddRow(service.StatusActive, 0))
	mock.ExpectQuery("SELECT user_id, action, count_delta, remaining_after").WithArgs("operation").WillReturnRows(sqlmock.NewRows([]string{"user_id", "action", "delta", "remaining", "prize", "reward"}).AddRow(42, "draw", -1, 3, "original", 0.29))
	mock.ExpectRollback()
	result, err := repo.Draw(context.Background(), 42, "operation", func() (service.BotLotteryPrize, error) {
		t.Fatal("a replay must not choose a prize")
		return service.BotLotteryPrize{}, nil
	}, "new snapshot")
	require.NoError(t, err)
	require.True(t, result.Replayed)
	require.Equal(t, "original", result.PrizeName)
	require.Equal(t, 0.29, result.Reward)
}

func TestBotLotteryRepositoryGrantRejectsChangedCountForSameOperation(t *testing.T) {
	repo, mock := lotteryMockRepo(t)
	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")).WithArgs("grant-operation").WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectQuery("SELECT status, balance FROM users").WithArgs(int64(42)).WillReturnRows(sqlmock.NewRows([]string{"status", "balance"}).AddRow(service.StatusActive, 0))
	mock.ExpectQuery("SELECT user_id, action, count_delta, remaining_after, notes").WithArgs("grant-operation").WillReturnRows(sqlmock.NewRows([]string{"user_id", "action", "delta", "remaining", "notes", "target"}).AddRow(42, "grant", 3, 7, "event", "user:42"))
	mock.ExpectRollback()
	_, _, err := repo.Grant(context.Background(), 42, 4, "event", "grant-operation", 9, "user:42")
	require.ErrorIs(t, err, service.ErrIdempotencyKeyConflict)
}

func TestBotLotteryRepositoryGrantAllowsNonPositiveBalance(t *testing.T) {
	for _, balance := range []float64{0, -1} {
		t.Run(fmt.Sprintf("balance_%g", balance), func(t *testing.T) {
			repo, mock := lotteryMockRepo(t)
			mock.ExpectBegin()
			mock.ExpectExec(regexp.QuoteMeta("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")).WithArgs("grant-operation").WillReturnResult(sqlmock.NewResult(0, 1))
			mock.ExpectQuery("SELECT status, balance FROM users").WithArgs(int64(42)).WillReturnRows(sqlmock.NewRows([]string{"status", "balance"}).AddRow(service.StatusActive, balance))
			mock.ExpectQuery("SELECT user_id, action, count_delta, remaining_after, notes").WithArgs("grant-operation").WillReturnError(sql.ErrNoRows)
			mock.ExpectQuery("INSERT INTO bot_lottery_accounts").WithArgs(int64(42), int64(3)).WillReturnRows(sqlmock.NewRows([]string{"remaining"}).AddRow(3))
			mock.ExpectExec("INSERT INTO bot_lottery_operations").WithArgs("grant-operation", int64(42), int64(3), int64(3), "event", int64(9), "user:42").WillReturnResult(sqlmock.NewResult(1, 1))
			mock.ExpectCommit()
			remaining, replayed, err := repo.Grant(context.Background(), 42, 3, "event", "grant-operation", 9, "user:42")
			require.NoError(t, err)
			require.Equal(t, int64(3), remaining)
			require.False(t, replayed)
		})
	}
}

func TestBotLotteryRepositoryBatchSnapshotDeduplicatesValidWebsiteUsers(t *testing.T) {
	repo, mock := lotteryMockRepo(t)
	version := service.BotBindingCredentialVersion("user@example.com", "password-hash")
	mock.ExpectBegin()
	mock.ExpectQuery("INSERT INTO bot_lottery_grant_batches").WithArgs("request", int64(9), int64(3), "event").WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(81))
	mock.ExpectQuery("SELECT b.user_id, b.user_token_version").WithArgs(service.StatusActive).WillReturnRows(sqlmock.NewRows([]string{"user_id", "version", "email", "password"}).AddRow(42, version, "user@example.com", "password-hash").AddRow(42, version, "user@example.com", "password-hash").AddRow(55, version+1, "other@example.com", "changed"))
	mock.ExpectExec("INSERT INTO bot_lottery_grant_batch_items").WithArgs(int64(81), int64(42)).WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec("UPDATE bot_lottery_grant_batches SET total").WithArgs(int64(81)).WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()
	id, replayed, err := repo.CreateGrantBatch(context.Background(), service.BotLotteryGrantBatchRequest{ActorID: 9, Count: 3, Notes: "event", OperationID: "request"})
	require.NoError(t, err)
	require.Equal(t, int64(81), id)
	require.False(t, replayed)
}

func TestBotLotteryRepositoryBatchSkipsUserDisabledAfterSnapshot(t *testing.T) {
	repo, mock := lotteryMockRepo(t)
	mock.ExpectBegin()
	mock.ExpectQuery("SELECT b.count, b.notes, b.actor_user_id, i.status").WithArgs(int64(81), int64(42)).WillReturnRows(sqlmock.NewRows([]string{"count", "notes", "actor", "status"}).AddRow(3, "event", 9, "pending"))
	mock.ExpectQuery("SELECT status, email").WithArgs(int64(42)).WillReturnRows(sqlmock.NewRows([]string{"status", "email", "password"}).AddRow("disabled", "user@example.com", "hash"))
	mock.ExpectExec("UPDATE bot_lottery_grant_batch_items SET status = 'skipped'").WithArgs(int64(81), int64(42), "user_inactive").WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()
	require.NoError(t, repo.processGrantBatchItem(context.Background(), 81, 42))
}

func TestBotLotteryRepositoryBatchSummaryKeepsSkippedSeparate(t *testing.T) {
	repo, mock := lotteryMockRepo(t)
	now := time.Now().UTC()
	mock.ExpectQuery("SELECT count, total, created_at").WithArgs(int64(81)).WillReturnRows(sqlmock.NewRows([]string{"count", "total", "created_at"}).AddRow(3, 3, now))
	mock.ExpectQuery("SELECT user_id, status").WithArgs(int64(81)).WillReturnRows(sqlmock.NewRows([]string{"user_id", "status", "error"}).AddRow(42, "success", "").AddRow(55, "skipped", "binding_inactive").AddRow(56, "pending", ""))
	batch, err := repo.GetGrantBatch(context.Background(), 81)
	require.NoError(t, err)
	require.Equal(t, int64(1), batch.Success)
	require.Equal(t, int64(1), batch.Skipped)
	require.Equal(t, int64(1), batch.Pending)
	require.Zero(t, batch.Failed)
	require.Equal(t, "pending", batch.Status)
}
