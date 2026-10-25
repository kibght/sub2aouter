package migrations

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestBotBindingsMigrationKeepsSecretsHashedAndBindingsUnique(t *testing.T) {
	content, err := FS.ReadFile("192_bot_bindings.sql")
	require.NoError(t, err)
	sql := string(content)

	// 绑定码与令牌只能以摘要形式落库。
	require.Contains(t, sql, "code_hash VARCHAR(64) NOT NULL UNIQUE")
	require.Contains(t, sql, "token_hash VARCHAR(64) NOT NULL UNIQUE")
	require.NotContains(t, sql, "code VARCHAR(64)")
	require.NotContains(t, sql, "bot_token")

	// 同一聊天账号同时只能有一条生效绑定；重新绑定走吊销而不是软删除。
	require.Contains(t, sql, "CREATE UNIQUE INDEX IF NOT EXISTS uq_bot_bindings_active_external")
	require.Contains(t, sql, "WHERE revoked_at IS NULL")

	// 迁移必须可以在已安装的实例上重复执行。
	for _, statement := range strings.Split(sql, ";") {
		trimmed := strings.TrimSpace(statement)
		if strings.HasPrefix(trimmed, "CREATE TABLE") {
			require.Contains(t, trimmed, "IF NOT EXISTS")
		}
		if strings.HasPrefix(trimmed, "CREATE INDEX") || strings.HasPrefix(trimmed, "CREATE UNIQUE INDEX") {
			require.Contains(t, trimmed, "IF NOT EXISTS")
		}
	}
}

func TestBotBindingsScopeUniqueIndexToUser(t *testing.T) {
	content, err := FS.ReadFile("193_bot_bindings_scope_unique_to_user.sql")
	require.NoError(t, err)
	sql := string(content)

	// 兑换接口公开可调用，生效唯一索引必须按用户收敛，
	// 否则任何登录用户都能用别人的 external_id 吊销对方令牌。
	require.Contains(t, sql, "DROP INDEX IF EXISTS uq_bot_bindings_active_external")
	require.Contains(t, sql, "CREATE UNIQUE INDEX IF NOT EXISTS uq_bot_bindings_active_user_external")
	require.Contains(t, sql, "ON bot_bindings (user_id, platform, external_id)")
	require.Contains(t, sql, "WHERE revoked_at IS NULL")
}
