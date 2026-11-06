package repository

import (
	"context"
	"regexp"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/stretchr/testify/require"
)

func newBalanceNotifyQQRepositoryForTest(t *testing.T) (*balanceNotifyQQRepository, sqlmock.Sqlmock) {
	t.Helper()
	db, mock, err := sqlmock.New()
	require.NoError(t, err)
	t.Cleanup(func() { _ = db.Close() })
	return &balanceNotifyQQRepository{db: db}, mock
}

func TestBalanceNotifyQQRepositoryEnqueueCreatesDeliveriesForEnabledQQBindings(t *testing.T) {
	repo, mock := newBalanceNotifyQQRepositoryForTest(t)
	createdAt := time.Date(2026, 10, 26, 1, 2, 3, 0, time.UTC)
	mock.ExpectBegin()
	mock.ExpectQuery(regexp.QuoteMeta("SELECT enabled FROM user_balance_notify_qq")).
		WithArgs(int64(7)).
		WillReturnRows(sqlmock.NewRows([]string{"enabled"}).AddRow(true))
	mock.ExpectExec(`(?s)INSERT INTO balance_low_qq_deliveries.*JOIN settings s ON s.key = 'balance_low_notify_enabled' AND s.value = 'true'.*b.platform = 'qq'.*b.revoked_at IS NULL.*u.balance_notify_enabled = TRUE.*p.enabled = TRUE`).
		WillReturnResult(sqlmock.NewResult(0, 2))
	mock.ExpectCommit()

	err := repo.EnqueueBalanceLow(context.Background(), 7, service.BalanceLowQQAlert{
		Balance: 3.25, Threshold: 5, SiteName: "Example", RechargeURL: "https://example.test/topup", CreatedAt: createdAt,
	})
	require.NoError(t, err)
	require.NoError(t, mock.ExpectationsWereMet())
}

func TestBalanceNotifyQQRepositoryHasActiveQQBinding(t *testing.T) {
	repo, mock := newBalanceNotifyQQRepositoryForTest(t)
	mock.ExpectQuery(regexp.QuoteMeta("SELECT EXISTS (")).
		WithArgs(int64(7)).
		WillReturnRows(sqlmock.NewRows([]string{"exists"}).AddRow(true))

	exists, err := repo.HasActiveQQBinding(context.Background(), 7)
	require.NoError(t, err)
	require.True(t, exists)
	require.NoError(t, mock.ExpectationsWereMet())
}

func TestBalanceNotifyQQRepositoryGetsMissingPreferenceAsDisabled(t *testing.T) {
	repo, mock := newBalanceNotifyQQRepositoryForTest(t)
	mock.ExpectQuery(regexp.QuoteMeta("SELECT enabled FROM user_balance_notify_qq")).
		WithArgs(int64(7)).
		WillReturnRows(sqlmock.NewRows([]string{"enabled"}))

	enabled, err := repo.GetQQBalanceNotifyEnabled(context.Background(), 7)
	require.NoError(t, err)
	require.False(t, enabled)
	require.NoError(t, mock.ExpectationsWereMet())
}

func TestBalanceNotifyQQRepositoryEnablingRequiresActiveQQBinding(t *testing.T) {
	repo, mock := newBalanceNotifyQQRepositoryForTest(t)
	mock.ExpectBegin()
	mock.ExpectQuery(regexp.QuoteMeta("SELECT id\n\t\t\tFROM bot_bindings")).
		WithArgs(int64(7)).
		WillReturnRows(sqlmock.NewRows([]string{"id"}))
	mock.ExpectRollback()

	err := repo.SetQQBalanceNotifyEnabled(context.Background(), 7, true)
	require.ErrorIs(t, err, service.ErrQQBalanceNotificationBindingRequired)
	require.NoError(t, mock.ExpectationsWereMet())
}

func TestBalanceNotifyQQRepositoryEnablingLocksQQBinding(t *testing.T) {
	repo, mock := newBalanceNotifyQQRepositoryForTest(t)
	mock.ExpectBegin()
	mock.ExpectQuery(`(?s)SELECT id.*FROM bot_bindings.*platform = 'qq'.*revoked_at IS NULL.*FOR UPDATE`).
		WithArgs(int64(7)).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(int64(11)))
	mock.ExpectExec(regexp.QuoteMeta("INSERT INTO user_balance_notify_qq")).
		WithArgs(int64(7), true).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()

	err := repo.SetQQBalanceNotifyEnabled(context.Background(), 7, true)
	require.NoError(t, err)
	require.NoError(t, mock.ExpectationsWereMet())
}

func TestBalanceNotifyQQRepositoryDisablingClearsPendingDeliveries(t *testing.T) {
	repo, mock := newBalanceNotifyQQRepositoryForTest(t)
	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta("INSERT INTO user_balance_notify_qq")).
		WithArgs(int64(7), false).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(regexp.QuoteMeta("DELETE FROM balance_low_qq_deliveries WHERE user_id = $1")).
		WithArgs(int64(7)).
		WillReturnResult(sqlmock.NewResult(0, 2))
	mock.ExpectCommit()

	err := repo.SetQQBalanceNotifyEnabled(context.Background(), 7, false)
	require.NoError(t, err)
	require.NoError(t, mock.ExpectationsWereMet())
}

func TestBalanceNotifyQQRepositoryClaimScopesBindingAndSetsLease(t *testing.T) {
	repo, mock := newBalanceNotifyQQRepositoryForTest(t)
	now := time.Date(2026, 10, 26, 1, 0, 0, 0, time.UTC)
	leaseUntil := now.Add(time.Minute)
	mock.ExpectQuery(`(?s)WITH candidates AS \(.*d.user_id = \$1.*d.binding_id = \$2.*b.platform = 'qq'.*b.revoked_at IS NULL.*u.balance_notify_enabled = TRUE.*p.enabled = TRUE.*FOR UPDATE OF d SKIP LOCKED.*UPDATE balance_low_qq_deliveries`).
		WithArgs(int64(7), int64(11), now, leaseUntil, 10).
		WillReturnRows(sqlmock.NewRows([]string{"id", "user_id", "current_balance", "threshold", "site_name", "recharge_url", "created_at"}).
			AddRow(int64(99), int64(7), 3.25, 5.0, "Example", "https://example.test/topup", now))

	alerts, err := repo.ClaimBalanceLow(context.Background(), 7, 11, now, leaseUntil, 10)
	require.NoError(t, err)
	require.Equal(t, []service.BalanceLowQQAlert{{
		ID: 99, UserID: 7, Balance: 3.25, Threshold: 5, SiteName: "Example", RechargeURL: "https://example.test/topup", CreatedAt: now,
	}}, alerts)
	require.NoError(t, mock.ExpectationsWereMet())
}

func TestBalanceNotifyQQRepositoryClaimClampsLimitAndSkipsInvalidLease(t *testing.T) {
	repo, mock := newBalanceNotifyQQRepositoryForTest(t)
	now := time.Now().UTC()
	leaseUntil := now.Add(time.Minute)
	mock.ExpectQuery(`(?s)WITH candidates AS \(.*d.user_id = \$1.*d.binding_id = \$2.*FOR UPDATE OF d SKIP LOCKED.*UPDATE balance_low_qq_deliveries`).
		WithArgs(int64(7), int64(11), now, leaseUntil, maxBalanceLowQQClaimLimit).
		WillReturnRows(sqlmock.NewRows([]string{"id", "user_id", "current_balance", "threshold", "site_name", "recharge_url", "created_at"}))

	alerts, err := repo.ClaimBalanceLow(context.Background(), 7, 11, now, leaseUntil, maxBalanceLowQQClaimLimit+1)
	require.NoError(t, err)
	require.Empty(t, alerts)

	_, err = repo.ClaimBalanceLow(context.Background(), 7, 11, now, now, 10)
	require.Error(t, err)
	require.NoError(t, mock.ExpectationsWereMet())
}

func TestBalanceNotifyQQRepositoryAckScopesToAlertUserAndBinding(t *testing.T) {
	repo, mock := newBalanceNotifyQQRepositoryForTest(t)
	mock.ExpectExec(regexp.QuoteMeta("DELETE FROM balance_low_qq_deliveries")).
		WithArgs(int64(99), int64(7), int64(11)).
		WillReturnResult(sqlmock.NewResult(0, 1))

	err := repo.AckBalanceLow(context.Background(), 7, 11, 99)
	require.NoError(t, err)
	require.NoError(t, mock.ExpectationsWereMet())
}
