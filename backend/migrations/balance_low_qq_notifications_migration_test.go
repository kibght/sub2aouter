package migrations

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestBalanceLowQQNotificationsMigrationCreatesPreferenceAndDeliveryQueue(t *testing.T) {
	content, err := FS.ReadFile("249_balance_low_qq_notifications.sql")
	require.NoError(t, err)
	sql := string(content)

	require.Contains(t, sql, "CREATE TABLE IF NOT EXISTS user_balance_notify_qq")
	require.Contains(t, sql, "user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE")
	require.Contains(t, sql, "enabled BOOLEAN NOT NULL DEFAULT FALSE")
	require.Contains(t, sql, "CREATE TABLE IF NOT EXISTS balance_low_qq_deliveries")
	require.Contains(t, sql, "binding_id BIGINT NOT NULL REFERENCES bot_bindings(id) ON DELETE CASCADE")
	require.Contains(t, sql, "current_balance NUMERIC(20, 8) NOT NULL")
	require.Contains(t, sql, "threshold NUMERIC(20, 8) NOT NULL")
	require.Contains(t, sql, "claimed_until TIMESTAMPTZ NULL")
	require.Contains(t, sql, "idx_balance_low_qq_deliveries_claim")
	require.Contains(t, sql, "idx_balance_low_qq_deliveries_user")

	for _, statement := range strings.Split(sql, ";") {
		trimmed := strings.TrimSpace(statement)
		if strings.HasPrefix(trimmed, "CREATE TABLE") || strings.HasPrefix(trimmed, "CREATE INDEX") {
			require.Contains(t, trimmed, "IF NOT EXISTS")
		}
	}
}
