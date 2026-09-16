package repository

import (
	"context"
	"math"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
	dbent "github.com/Wei-Shaw/sub2api/ent"
	"github.com/stretchr/testify/require"

	"entgo.io/ent/dialect"
	entsql "entgo.io/ent/dialect/sql"
)

func TestInvalidBalanceValueRejectsNegativeAndNonFiniteNumbers(t *testing.T) {
	for _, tt := range []struct {
		name  string
		value float64
		want  bool
	}{
		{name: "negative", value: -1, want: true},
		{name: "nan", value: math.NaN(), want: true},
		{name: "positive infinity", value: math.Inf(1), want: true},
		{name: "negative infinity", value: math.Inf(-1), want: true},
		{name: "zero", value: 0, want: false},
		{name: "positive", value: 1.5, want: false},
	} {
		t.Run(tt.name, func(t *testing.T) {
			require.Equal(t, tt.want, invalidNonNegativeBalance(tt.value))
		})
	}
}

func TestInvalidBalanceDeltaRejectsOnlyNonFiniteNumbers(t *testing.T) {
	for _, tt := range []struct {
		name  string
		delta float64
		want  bool
	}{
		{name: "negative", delta: -1, want: false},
		{name: "nan", delta: math.NaN(), want: true},
		{name: "positive infinity", delta: math.Inf(1), want: true},
		{name: "negative infinity", delta: math.Inf(-1), want: true},
		{name: "zero", delta: 0, want: false},
	} {
		t.Run(tt.name, func(t *testing.T) {
			require.Equal(t, tt.want, invalidBalanceDelta(tt.delta))
		})
	}
}

func TestCreditBalanceDoesNotUpdateTotalRecharged(t *testing.T) {
	db, mock, err := sqlmock.New()
	require.NoError(t, err)
	t.Cleanup(func() { _ = db.Close() })
	driver := entsql.OpenDB(dialect.Postgres, db)
	client := dbent.NewClient(dbent.Driver(driver))
	t.Cleanup(func() { _ = client.Close() })
	repo := newUserRepositoryWithSQL(client, db)

	mock.ExpectExec(`UPDATE "users" SET "updated_at" = \$1, "balance" = COALESCE\("users"\."balance", 0\) \+ \$2 WHERE "users"\."id" = \$3`).
		WithArgs(sqlmock.AnyArg(), 12.5, int64(42)).
		WillReturnResult(sqlmock.NewResult(0, 1))

	require.NoError(t, repo.CreditBalance(context.Background(), 42, 12.5))
	require.NoError(t, mock.ExpectationsWereMet())
}
