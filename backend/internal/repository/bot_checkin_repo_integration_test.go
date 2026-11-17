//go:build bot_checkin_db && !integration

package repository

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/pkg/timezone"
	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/lib/pq"
	"github.com/stretchr/testify/require"
)

// Run against an explicitly supplied disposable PostgreSQL database:
// BOT_CHECKIN_TEST_DSN=postgres://... go test -tags bot_checkin_db ./internal/repository -run TestBotCheckInPostgres
// Each run owns a separate temporary schema and never uses application connection settings.
func TestBotCheckInPostgres(t *testing.T) {
	db := botCheckInPostgresDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	previousTimezone := timezone.Name()
	require.NoError(t, timezone.Init("Asia/Shanghai"))
	t.Cleanup(func() { require.NoError(t, timezone.Init(previousTimezone)) })
	dayStart, err := timezone.ParseInLocation("2006-01-02", "2026-11-12")
	require.NoError(t, err)
	now := dayStart.Add(12 * time.Hour).UTC()
	repo := NewBotCheckInRepository(db)

	createUser := func(t *testing.T) int64 {
		t.Helper()
		var id int64
		require.NoError(t, db.QueryRowContext(ctx, `INSERT INTO users (balance, status) VALUES (1, 'active') RETURNING id`).Scan(&id))
		return id
	}
	addUsage := func(t *testing.T, userID int64, when time.Time, tokens [4]int64, amount string, billingType int8) {
		t.Helper()
		_, err := db.ExecContext(ctx, `INSERT INTO usage_logs
			(user_id, created_at, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, actual_cost, billing_type)
			VALUES ($1, $2, $3, $4, $5, $6, $7::numeric, $8)`,
			userID, when, tokens[0], tokens[1], tokens[2], tokens[3], amount, billingType)
		require.NoError(t, err)
	}
	paramsFor := func(userID int64, mode string) service.BotCheckInParams {
		return service.BotCheckInParams{
			UserID: userID, RewardDate: "2026-11-12", Now: now,
			UsageRequirement: mode, RequiredTokens: 100, RequiredAmount: 0.3,
			FirstReward: 0.1, DailyCap: 0.5,
		}
	}
	assertWrites := func(t *testing.T, userID int64, count int, balance string) {
		t.Helper()
		var checkIns, histories int
		var balanceMatches bool
		require.NoError(t, db.QueryRowContext(ctx, `SELECT COUNT(*) FROM bot_checkins WHERE user_id = $1`, userID).Scan(&checkIns))
		require.NoError(t, db.QueryRowContext(ctx, `SELECT COUNT(*) FROM redeem_codes WHERE used_by = $1`, userID).Scan(&histories))
		require.NoError(t, db.QueryRowContext(ctx, `SELECT balance = $2::numeric FROM users WHERE id = $1`, userID, balance).Scan(&balanceMatches))
		require.Equal(t, count, checkIns)
		require.Equal(t, count, histories)
		require.True(t, balanceMatches)
	}

	for _, tc := range []struct {
		name   string
		mode   string
		tokens int64
		amount string
		pass   bool
	}{
		{name: "token below ignores high amount", mode: service.BotCheckInUsageTokens, tokens: 99, amount: "100", pass: false},
		{name: "token equal ignores low amount", mode: service.BotCheckInUsageTokens, tokens: 100, amount: "0", pass: true},
		{name: "token above", mode: service.BotCheckInUsageTokens, tokens: 101, amount: "0", pass: true},
		{name: "amount below ignores high tokens", mode: service.BotCheckInUsageAmount, tokens: 1000000, amount: "0.2999999999", pass: false},
		{name: "amount equal ignores low tokens", mode: service.BotCheckInUsageAmount, amount: "0.3", pass: true},
		{name: "amount above", mode: service.BotCheckInUsageAmount, amount: "0.3000000001", pass: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			id := createUser(t)
			addUsage(t, id, now, [4]int64{tc.tokens}, tc.amount, service.BillingTypeBalance)
			params := paramsFor(id, tc.mode)
			result, err := repo.CheckIn(ctx, params)
			require.NoError(t, err)
			require.Equal(t, tc.mode, result.UsageRequirement)
			require.Equal(t, tc.tokens, result.TodayTokens)
			require.Equal(t, tc.pass, result.CheckedIn)
			require.Equal(t, tc.pass, result.Eligible)
			if tc.mode == service.BotCheckInUsageTokens {
				require.Equal(t, params.RequiredTokens, result.RequiredTokens)
				require.Zero(t, result.RequiredAmount)
			} else {
				require.Zero(t, result.RequiredTokens)
				require.Equal(t, params.RequiredAmount, result.RequiredAmount)
			}
			if tc.pass {
				require.Equal(t, service.BotCheckInStatusSuccess, result.Status)
				assertWrites(t, id, 1, "1.1")
			} else {
				require.Equal(t, service.BotCheckInStatusInsufficientUsage, result.Status)
				assertWrites(t, id, 0, "1")
			}
		})
	}

	for _, mode := range []string{service.BotCheckInUsageTokens, service.BotCheckInUsageAmount} {
		t.Run(mode+" zero requires no usage", func(t *testing.T) {
			id := createUser(t)
			params := paramsFor(id, mode)
			params.RequiredTokens, params.RequiredAmount = 0, 0
			result, err := repo.CheckIn(ctx, params)
			require.NoError(t, err)
			require.True(t, result.CheckedIn)
			assertWrites(t, id, 1, "1.1")
		})
	}

	t.Run("balance only exact decimal sum and retry", func(t *testing.T) {
		id := createUser(t)
		params := paramsFor(id, service.BotCheckInUsageAmount)
		addUsage(t, id, now, [4]int64{}, "9.9", service.BillingTypeSubscription)
		addUsage(t, id, now, [4]int64{}, "0.1", service.BillingTypeBalance)
		first, err := repo.CheckIn(ctx, params)
		require.NoError(t, err)
		require.Equal(t, service.BotCheckInStatusInsufficientUsage, first.Status)
		require.Equal(t, 0.1, first.TodayAmount)
		assertWrites(t, id, 0, "1")
		addUsage(t, id, now, [4]int64{}, "0.2", service.BillingTypeBalance)
		retry, err := repo.CheckIn(ctx, params)
		require.NoError(t, err)
		require.True(t, retry.CheckedIn)
		require.Equal(t, 0.3, retry.TodayAmount)
		assertWrites(t, id, 1, "1.1")
		params.UsageRequirement = service.BotCheckInUsageTokens
		params.RequiredTokens = 9999999
		repeated, err := repo.CheckIn(ctx, params)
		require.NoError(t, err)
		require.Equal(t, service.BotCheckInStatusAlreadyCheckedIn, repeated.Status)
		require.False(t, repeated.CheckedIn)
		assertWrites(t, id, 1, "1.1")
	})

	t.Run("numeric eligibility does not compare display floats", func(t *testing.T) {
		id := createUser(t)
		params := paramsFor(id, service.BotCheckInUsageAmount)
		params.RequiredAmount = 10000000.00000002
		addUsage(t, id, now, [4]int64{}, "10000000.0000000199", service.BillingTypeBalance)
		result, err := repo.CheckIn(ctx, params)
		require.NoError(t, err)
		require.Equal(t, params.RequiredAmount, result.TodayAmount)
		require.Equal(t, service.BotCheckInStatusInsufficientUsage, result.Status)
		assertWrites(t, id, 0, "1")
	})

	t.Run("local day boundaries and all token categories", func(t *testing.T) {
		id := createUser(t)
		otherID := createUser(t)
		params := paramsFor(id, service.BotCheckInUsageTokens)
		addUsage(t, id, dayStart.Add(-time.Microsecond), [4]int64{1000}, "100", service.BillingTypeBalance)
		addUsage(t, id, dayStart, [4]int64{10, 20, 30, 40}, "0.1", service.BillingTypeBalance)
		addUsage(t, id, dayStart.AddDate(0, 0, 1), [4]int64{1000}, "100", service.BillingTypeBalance)
		addUsage(t, otherID, now, [4]int64{1000}, "100", service.BillingTypeBalance)
		result, err := repo.CheckIn(ctx, params)
		require.NoError(t, err)
		require.True(t, result.CheckedIn)
		require.Equal(t, int64(100), result.TodayTokens)
		require.Equal(t, 0.1, result.TodayAmount)
		assertWrites(t, id, 1, "1.1")
	})

	t.Run("concurrent requests grant one reward", func(t *testing.T) {
		id := createUser(t)
		params := paramsFor(id, service.BotCheckInUsageAmount)
		params.RequiredAmount = 0
		const requests = 8
		results := make(chan *service.BotCheckInResult, requests)
		errors := make(chan error, requests)
		start := make(chan struct{})
		var workers sync.WaitGroup
		for range requests {
			workers.Add(1)
			go func() {
				defer workers.Done()
				<-start
				result, err := repo.CheckIn(ctx, params)
				results <- result
				errors <- err
			}()
		}
		close(start)
		workers.Wait()
		close(results)
		close(errors)
		for err := range errors {
			require.NoError(t, err)
		}
		successes, repeats := 0, 0
		for result := range results {
			require.NotNil(t, result)
			switch result.Status {
			case service.BotCheckInStatusSuccess:
				successes++
			case service.BotCheckInStatusAlreadyCheckedIn:
				repeats++
			default:
				t.Fatalf("unexpected check-in status: %s", result.Status)
			}
		}
		require.Equal(t, 1, successes)
		require.Equal(t, requests-1, repeats)
		assertWrites(t, id, 1, "1.1")
	})

	t.Run("seventh day doubles and obeys cap", func(t *testing.T) {
		id := createUser(t)
		params := paramsFor(id, service.BotCheckInUsageAmount)
		params.RequiredAmount = 0
		params.FirstReward = 0.3
		_, err := db.ExecContext(ctx, `INSERT INTO bot_checkins
			(user_id, reward_date, streak_day, reward_amount, increment_amount, balance_before, balance_after, created_at)
			VALUES ($1, $2::date - 1, 6, 0.1, 0, 0.9, 1, $3)`, id, params.RewardDate, now.Add(-24*time.Hour))
		require.NoError(t, err)
		result, err := repo.CheckIn(ctx, params)
		require.NoError(t, err)
		require.True(t, result.CheckedIn)
		require.Equal(t, 7, result.StreakDay)
		require.Equal(t, 0.5, result.Reward)
		require.Equal(t, 1.5, result.Balance)
	})
}

func botCheckInPostgresDB(t *testing.T) *sql.DB {
	t.Helper()
	dsn := strings.TrimSpace(os.Getenv("BOT_CHECKIN_TEST_DSN"))
	if dsn == "" {
		t.Skip("set BOT_CHECKIN_TEST_DSN to run isolated PostgreSQL check-in tests")
	}
	admin, err := sql.Open("postgres", dsn)
	require.NoError(t, err)
	t.Cleanup(func() { _ = admin.Close() })
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	require.NoError(t, admin.PingContext(ctx))
	schema := fmt.Sprintf("bot_checkin_test_%d", time.Now().UnixNano())
	_, err = admin.ExecContext(ctx, "CREATE SCHEMA "+pq.QuoteIdentifier(schema))
	require.NoError(t, err)
	t.Cleanup(func() {
		_, err := admin.ExecContext(context.Background(), "DROP SCHEMA "+pq.QuoteIdentifier(schema)+" CASCADE")
		require.NoError(t, err)
	})
	if strings.HasPrefix(dsn, "postgres://") || strings.HasPrefix(dsn, "postgresql://") {
		parsed, err := url.Parse(dsn)
		require.NoError(t, err)
		query := parsed.Query()
		query.Set("search_path", schema)
		parsed.RawQuery = query.Encode()
		dsn = parsed.String()
	} else {
		dsn += " search_path=" + schema
	}
	db, err := sql.Open("postgres", dsn)
	require.NoError(t, err)
	db.SetMaxOpenConns(8)
	t.Cleanup(func() { _ = db.Close() })
	_, err = db.ExecContext(ctx, `
		CREATE TABLE users (
			id BIGSERIAL PRIMARY KEY, balance NUMERIC(20,8) NOT NULL,
			status TEXT NOT NULL, deleted_at TIMESTAMPTZ, updated_at TIMESTAMPTZ
		);
		CREATE TABLE usage_logs (
			id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES users(id),
			input_tokens BIGINT NOT NULL DEFAULT 0, output_tokens BIGINT NOT NULL DEFAULT 0,
			cache_creation_tokens BIGINT NOT NULL DEFAULT 0, cache_read_tokens BIGINT NOT NULL DEFAULT 0,
			actual_cost NUMERIC(20,10) NOT NULL DEFAULT 0, billing_type SMALLINT NOT NULL DEFAULT 0,
			created_at TIMESTAMPTZ NOT NULL
		);
		CREATE TABLE bot_checkins (
			id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES users(id),
			reward_date DATE NOT NULL, streak_day INT NOT NULL,
			reward_amount NUMERIC(20,8) NOT NULL, increment_amount NUMERIC(20,8) NOT NULL DEFAULT 0,
			balance_before NUMERIC(20,8) NOT NULL, balance_after NUMERIC(20,8) NOT NULL,
			created_at TIMESTAMPTZ NOT NULL, UNIQUE (user_id, reward_date)
		);
		CREATE TABLE redeem_codes (
			id BIGSERIAL PRIMARY KEY, code TEXT NOT NULL UNIQUE, type TEXT NOT NULL,
			value NUMERIC(20,8) NOT NULL, status TEXT NOT NULL,
			used_by BIGINT REFERENCES users(id), used_at TIMESTAMPTZ, notes TEXT, created_at TIMESTAMPTZ
		);
	`)
	require.NoError(t, err)
	return db
}
