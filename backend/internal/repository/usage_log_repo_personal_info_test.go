package repository

import (
	"context"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/Wei-Shaw/sub2api/internal/pkg/usagestats"
	"github.com/stretchr/testify/require"
)

func TestUsageLogRepositoryPersonalInfoRPMUsesUserAndHalfOpenWindow(t *testing.T) {
	db, mock := newSQLMock(t)
	repo := &usageLogRepository{sql: db}
	end := time.Date(2026, 11, 8, 9, 0, 0, 0, time.UTC)
	start := end.Add(-time.Minute)

	mock.ExpectQuery(`(?s)FROM usage_logs\s+WHERE user_id = \$1 AND created_at >= \$2 AND created_at < \$3\s+\).*COUNT\(\*\) AS requests.*GROUP BY GROUPING SETS`).
		WithArgs(int64(7), start, end).
		WillReturnRows(sqlmock.NewRows([]string{
			"inbound_grouped", "upstream_grouped", "inbound_endpoint", "upstream_endpoint",
			"requests", "input_tokens", "output_tokens", "cache_creation_tokens", "cache_read_tokens",
			"cost", "actual_cost", "account_cost", "avg_duration_ms",
		}).AddRow(1, 1, nil, nil, int64(6), 0, 0, 0, 0, 0, 0, 0, 0))

	stats, err := repo.GetStatsWithFilters(context.Background(), usagestats.UsageLogFilters{
		UserID: 7, StartTime: &start, EndTime: &end,
	})
	require.NoError(t, err)
	require.Equal(t, int64(6), stats.TotalRequests)
	require.NoError(t, mock.ExpectationsWereMet())
}
