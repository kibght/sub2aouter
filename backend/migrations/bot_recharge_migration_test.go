package migrations

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestBotRechargeMigrationKeepsDurableOrderKeysAndBindingSnapshots(t *testing.T) {
	content, err := FS.ReadFile("253_bot_recharge.sql")
	require.NoError(t, err)
	sql := string(content)
	require.Contains(t, sql, "CREATE TABLE IF NOT EXISTS bot_recharge_requests")
	require.Contains(t, sql, "UNIQUE (user_id, request_id)")
	require.Contains(t, sql, "payment_order_id BIGINT NOT NULL UNIQUE REFERENCES payment_orders(id)")
	require.Contains(t, sql, "binding_id BIGINT NOT NULL")
	// Removing an old binding must not erase a committed idempotency record.
	require.NotContains(t, sql, "REFERENCES bot_bindings(id) ON DELETE CASCADE")
	require.Contains(t, sql, "CREATE TABLE IF NOT EXISTS bot_recharge_notifications")
	require.Contains(t, sql, "lease_until TIMESTAMPTZ")
	require.Contains(t, sql, "acked_at TIMESTAMPTZ")
	require.Contains(t, sql, "WHERE acked_at IS NULL")
}
