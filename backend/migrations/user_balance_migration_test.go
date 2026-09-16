package migrations

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestMigration192EnforcesNonNegativeUserBalance(t *testing.T) {
	content, err := FS.ReadFile("192_enforce_non_negative_user_balance.sql")
	require.NoError(t, err)

	sql := string(content)
	require.NotContains(t, sql, "UPDATE users")
	require.NotContains(t, sql, "WHERE balance < 0")
	require.NotContains(t, sql, "SET balance = 0")
	require.Contains(t, sql, "CREATE OR REPLACE FUNCTION public.enforce_non_negative_user_balance()")
	require.Contains(t, sql, "IF TG_OP = 'INSERT' OR NEW.balance IS DISTINCT FROM OLD.balance")
	require.Contains(t, sql, "RAISE EXCEPTION")
	require.Contains(t, sql, "DROP TRIGGER IF EXISTS users_enforce_non_negative_balance ON users")
	require.Contains(t, sql, "CREATE TRIGGER users_enforce_non_negative_balance")
	require.Contains(t, sql, "BEFORE INSERT OR UPDATE OF balance ON users")
	require.NotContains(t, sql, "NOT VALID")
}
