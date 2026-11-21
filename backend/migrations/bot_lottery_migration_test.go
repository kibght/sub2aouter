package migrations

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestBotLotteryMigrationPersistsReplayResultsAndRecoverableBatchMembers(t *testing.T) {
	content, err := FS.ReadFile("254_bot_lottery.sql")
	require.NoError(t, err)
	sql := string(content)
	for _, required := range []string{"CREATE TABLE IF NOT EXISTS bot_lottery_config", "CREATE TABLE IF NOT EXISTS bot_lottery_accounts", "remaining >= 0", "operation_id VARCHAR(64) NOT NULL UNIQUE", "balance_before NUMERIC(20,8)", "balance_after NUMERIC(20,8)", "CREATE TABLE IF NOT EXISTS bot_lottery_grant_batches", "request_id VARCHAR(64) NOT NULL UNIQUE", "PRIMARY KEY (batch_id, user_id)", "'pending', 'success', 'failed', 'skipped'", "config_snapshot TEXT"} {
		require.Contains(t, sql, required)
	}
}
