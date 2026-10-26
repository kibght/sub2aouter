package repository

import (
	"context"
	"regexp"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/stretchr/testify/require"
)

func TestBotBindingRevokeClearsAlertsAndDisablesLastQQChannel(t *testing.T) {
	db, mock, err := sqlmock.New()
	require.NoError(t, err)
	t.Cleanup(func() { _ = db.Close() })
	repo := &botBindingRepository{db: db}
	revokedAt := time.Date(2026, 10, 26, 5, 0, 0, 0, time.UTC)

	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta("UPDATE bot_bindings")).
		WithArgs(int64(7), int64(11), revokedAt).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(regexp.QuoteMeta("DELETE FROM balance_low_qq_deliveries WHERE user_id = $1 AND binding_id = $2")).
		WithArgs(int64(7), int64(11)).
		WillReturnResult(sqlmock.NewResult(0, 2))
	mock.ExpectExec(`(?s)UPDATE user_balance_notify_qq.*NOT EXISTS.*platform = 'qq'.*revoked_at IS NULL`).
		WithArgs(int64(7), revokedAt).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()

	err = repo.RevokeByID(context.Background(), 7, 11, revokedAt)

	require.NoError(t, err)
	require.NoError(t, mock.ExpectationsWereMet())
}
