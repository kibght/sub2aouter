package repository

import (
	"context"
	"regexp"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/stretchr/testify/require"
)

func TestBotRechargeNotificationClaimOnlyCompletedOriginalBinding(t *testing.T) {
	db, mock, err := sqlmock.New()
	require.NoError(t, err)
	t.Cleanup(func() { _ = db.Close() })
	repo := &botRechargeRepository{db: db}
	now := time.Now().UTC()
	mock.ExpectBegin()
	// The query must retain both COMPLETED and the original binding identity.
	mock.ExpectExec(`(?s)INSERT INTO bot_recharge_notifications.*rr\.binding_id = \$2.*rr\.platform = \$3 AND rr\.external_id = \$4.*o\.status = 'COMPLETED'.*ON CONFLICT`).
		WithArgs(int64(7), int64(9), "qq", "42").
		WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectQuery(`(?s)SELECT id, payment_order_id, credited_amount, currency, created_at.*binding_id = \$2 AND platform = \$3 AND external_id = \$4.*FOR UPDATE SKIP LOCKED`).
		WithArgs(int64(7), int64(9), "qq", "42", sqlmock.AnyArg(), 20).
		WillReturnRows(sqlmock.NewRows([]string{"id", "payment_order_id", "credited_amount", "currency", "created_at"}).AddRow(1, 51, 12.0, "USD", now))
	mock.ExpectExec(regexp.QuoteMeta("UPDATE bot_recharge_notifications SET lease_until = $2")).
		WithArgs(int64(1), sqlmock.AnyArg()).WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()
	items, err := repo.ClaimCompletedNotifications(context.Background(), 7, 9, "qq", "42", 20)
	require.NoError(t, err)
	require.Len(t, items, 1)
	require.Equal(t, int64(51), items[0].OrderID)
	require.Equal(t, "USD", items[0].Currency)
	require.NoError(t, mock.ExpectationsWereMet())
}

func TestBotRechargeNotificationAckCannotAcknowledgeOtherBinding(t *testing.T) {
	db, mock, err := sqlmock.New()
	require.NoError(t, err)
	t.Cleanup(func() { _ = db.Close() })
	repo := &botRechargeRepository{db: db}
	mock.ExpectExec(`(?s)UPDATE bot_recharge_notifications.*WHERE id = \$1 AND user_id = \$2 AND binding_id = \$3`).
		WithArgs(int64(1), int64(7), int64(10)).WillReturnResult(sqlmock.NewResult(0, 0))
	acked, err := repo.AckNotification(context.Background(), 7, 10, 1)
	require.NoError(t, err)
	require.False(t, acked)
	require.NoError(t, mock.ExpectationsWereMet())
}

func TestBotRechargeFindOrderAlwaysScopesUser(t *testing.T) {
	db, mock, err := sqlmock.New()
	require.NoError(t, err)
	t.Cleanup(func() { _ = db.Close() })
	repo := &botRechargeRepository{db: db}
	mock.ExpectQuery(`(?s)FROM bot_recharge_requests WHERE user_id = \$1 AND payment_order_id = \$2`).
		WithArgs(int64(7), int64(51)).WillReturnRows(sqlmock.NewRows([]string{"payment_order_id", "binding_id", "platform", "external_id", "payment_type", "requested_amount"}))
	record, err := repo.FindOrderRequest(context.Background(), 7, 51)
	require.NoError(t, err)
	require.Nil(t, record)
	require.NoError(t, mock.ExpectationsWereMet())
}
