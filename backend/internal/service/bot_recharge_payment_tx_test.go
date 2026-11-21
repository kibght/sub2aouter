//go:build unit

package service

import (
	"context"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/payment"
	"github.com/stretchr/testify/require"
)

func TestBotRechargePaymentOrderAndRequestCommitAtomically(t *testing.T) {
	ctx := context.Background()
	client := newPaymentConfigServiceTestClient(t)
	_, err := client.ExecContext(ctx, `CREATE TABLE bot_recharge_requests (
		user_id BIGINT, request_id TEXT, binding_id BIGINT, platform TEXT, external_id TEXT,
		payment_order_id BIGINT UNIQUE, payment_type TEXT, requested_amount NUMERIC,
		UNIQUE(user_id, request_id))`)
	require.NoError(t, err)
	user, err := client.User.Create().SetEmail("bot-recharge@example.com").SetPasswordHash("hash").SetUsername("bot-recharge").Save(ctx)
	require.NoError(t, err)
	svc := &PaymentService{entClient: client}
	params := CreateOrderRequest{
		UserID: user.ID, Amount: 10, PaymentType: payment.TypeAlipay,
		OrderType: payment.OrderTypeBalance, ClientIP: "127.0.0.1", SrcHost: "bot",
		BotRequestID: "message-1", BotBindingID: 9, BotPlatform: "qq", BotExternalID: "42", BotPaymentRequired: true,
	}
	create := func() error {
		_, err := svc.createOrderInTx(ctx, params, &User{ID: user.ID, Email: user.Email, Username: user.Username}, nil,
			&PaymentConfig{MaxPendingOrders: 10}, 12, 10, 0, 10, 2,
			&payment.InstanceSelection{ProviderKey: payment.TypeAlipay, Config: map[string]string{}})
		return err
	}
	require.NoError(t, create())
	count, err := client.PaymentOrder.Query().Count(ctx)
	require.NoError(t, err)
	require.Equal(t, 1, count)
	// A duplicate key aborts the transaction, including the second order row.
	require.Error(t, create())
	count, err = client.PaymentOrder.Query().Count(ctx)
	require.NoError(t, err)
	require.Equal(t, 1, count)
}
