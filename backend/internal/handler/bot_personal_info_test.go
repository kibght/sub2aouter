package handler

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/pkg/usagestats"
	middleware2 "github.com/Wei-Shaw/sub2api/internal/server/middleware"
	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

type personalInfoUserReader func(context.Context, int64) (*service.User, error)

func (f personalInfoUserReader) GetByID(ctx context.Context, id int64) (*service.User, error) {
	return f(ctx, id)
}

type personalInfoConcurrencyReader func(context.Context, int64) (int, error)

func (f personalInfoConcurrencyReader) GetUserConcurrency(ctx context.Context, id int64) (int, error) {
	return f(ctx, id)
}

type personalInfoUsageReader func(context.Context, usagestats.UsageLogFilters) (*usagestats.UsageStats, error)

func (f personalInfoUsageReader) GetStatsWithFilters(ctx context.Context, filters usagestats.UsageLogFilters) (*usagestats.UsageStats, error) {
	return f(ctx, filters)
}

func personalInfoRouter(h *BotHandler, userID *int64) *gin.Engine {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.GET("/bot/personal-info", func(c *gin.Context) {
		if userID != nil {
			c.Set(string(middleware2.ContextKeyUser), middleware2.AuthSubject{UserID: *userID})
		}
		c.Next()
	}, h.PersonalInfo)
	return router
}

func requirePersonalInfoMetricDeadline(t *testing.T, ctx context.Context) {
	t.Helper()
	deadline, ok := ctx.Deadline()
	require.True(t, ok, "metric reads must have a deadline")
	require.Positive(t, time.Until(deadline))
	require.LessOrEqual(t, time.Until(deadline), 2*time.Second)
}

func TestBotHandlerPersonalInfoContractAndUserScope(t *testing.T) {
	userID := int64(7)
	var filters usagestats.UsageLogFilters
	var concurrencyContext context.Context
	usage := personalInfoUsageReader(func(ctx context.Context, got usagestats.UsageLogFilters) (*usagestats.UsageStats, error) {
		requirePersonalInfoMetricDeadline(t, ctx)
		if concurrencyContext != nil {
			require.NotEqual(t, concurrencyContext, ctx, "metrics need independent timeout contexts")
		}
		filters = got
		return &usagestats.UsageStats{TotalRequests: 23, TotalActualCost: 999}, nil
	})
	users := personalInfoUserReader(func(_ context.Context, id int64) (*service.User, error) {
		require.Equal(t, userID, id)
		return &service.User{
			ID: userID, Username: "alice", Balance: 12.5, Concurrency: 8,
			Email: "alice@example.com", FrozenBalance: 3.5, PasswordHash: "private-hash",
		}, nil
	})
	h := NewBotHandler(nil, usage, nil, users)
	h.SetConcurrencyReader(personalInfoConcurrencyReader(func(ctx context.Context, id int64) (int, error) {
		requirePersonalInfoMetricDeadline(t, ctx)
		require.Equal(t, userID, id)
		concurrencyContext = ctx
		return 2, nil
	}))
	router := personalInfoRouter(h, &userID)
	rec := httptest.NewRecorder()
	before := time.Now().UTC()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/bot/personal-info?user_id=99&api_key_id=88&period=all&start_time=2000-01-01&end_time=2100-01-01", nil))
	after := time.Now().UTC()

	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.Equal(t, map[string]any{
		"id": float64(userID), "username": "alice", "balance": 12.5, "concurrency": float64(8),
		"current_concurrency": float64(2), "current_rpm": float64(23), "rpm_window_seconds": float64(60),
	}, decodeBotData(t, rec))
	require.NotNil(t, filters.StartTime)
	require.NotNil(t, filters.EndTime)
	require.Equal(t, time.Minute, filters.EndTime.Sub(*filters.StartTime))
	require.False(t, filters.EndTime.Before(before))
	require.False(t, filters.EndTime.After(after))
	require.Equal(t, time.UTC, filters.StartTime.Location())
	require.Equal(t, time.UTC, filters.EndTime.Location())
	require.Equal(t, usagestats.UsageLogFilters{
		UserID: userID, StartTime: filters.StartTime, EndTime: filters.EndTime,
	}, filters)
}

func TestBotHandlerPersonalInfoPreservesEmptyUsernameAndZeroBalance(t *testing.T) {
	userID := int64(7)
	h := NewBotHandler(nil, &stubBotUsage{}, nil, &stubBotUsers{user: &service.User{
		ID: userID, Concurrency: 8,
	}})
	h.SetConcurrencyReader(personalInfoConcurrencyReader(func(context.Context, int64) (int, error) {
		return 0, nil
	}))
	rec := httptest.NewRecorder()
	personalInfoRouter(h, &userID).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/bot/personal-info", nil))

	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.Equal(t, map[string]any{
		"id": float64(userID), "username": "", "balance": float64(0), "concurrency": float64(8),
		"current_concurrency": float64(0), "current_rpm": float64(0), "rpm_window_seconds": float64(60),
	}, decodeBotData(t, rec))
}

func TestBotHandlerPersonalInfoMetricsDegradeIndependently(t *testing.T) {
	for _, test := range []struct {
		name                string
		limit               int
		concurrencyErr      error
		usageErr            error
		missingConcurrency  bool
		missingUsage        bool
		nilStats            bool
		wantConcurrency     any
		wantRPM             any
		wantConcurrencyRead bool
	}{
		{name: "real zero", limit: 8, wantConcurrency: float64(0), wantRPM: float64(0), wantConcurrencyRead: true},
		{name: "unlimited", limit: 0, wantRPM: float64(0)},
		{name: "negative limit", limit: -1, wantRPM: float64(0)},
		{name: "cache failure", limit: 8, concurrencyErr: errors.New("cache down"), wantRPM: float64(0), wantConcurrencyRead: true},
		{name: "cache timeout", limit: 8, concurrencyErr: context.DeadlineExceeded, wantRPM: float64(0), wantConcurrencyRead: true},
		{name: "usage failure", limit: 8, usageErr: errors.New("database down"), wantConcurrency: float64(0), wantConcurrencyRead: true},
		{name: "usage timeout", limit: 8, usageErr: context.DeadlineExceeded, wantConcurrency: float64(0), wantConcurrencyRead: true},
		{name: "both fail", limit: 8, concurrencyErr: context.DeadlineExceeded, usageErr: context.DeadlineExceeded, wantConcurrencyRead: true},
		{name: "no cache", limit: 8, missingConcurrency: true, wantRPM: float64(0)},
		{name: "no usage", limit: 8, missingUsage: true, wantConcurrency: float64(0), wantConcurrencyRead: true},
		{name: "nil stats", limit: 8, nilStats: true, wantConcurrency: float64(0), wantConcurrencyRead: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			userID := int64(7)
			concurrencyRead := false
			usageRead := false
			var metricContexts []context.Context
			var usage botUsageReader
			if !test.missingUsage {
				usage = personalInfoUsageReader(func(ctx context.Context, filters usagestats.UsageLogFilters) (*usagestats.UsageStats, error) {
					requirePersonalInfoMetricDeadline(t, ctx)
					require.NoError(t, ctx.Err())
					require.Equal(t, userID, filters.UserID)
					metricContexts = append(metricContexts, ctx)
					usageRead = true
					if test.nilStats {
						return nil, nil
					}
					return &usagestats.UsageStats{}, test.usageErr
				})
			}
			h := NewBotHandler(nil, usage, nil, &stubBotUsers{user: &service.User{
				ID: userID, Username: "alice", Balance: 12.5, Concurrency: test.limit,
			}})
			if !test.missingConcurrency {
				h.SetConcurrencyReader(personalInfoConcurrencyReader(func(ctx context.Context, id int64) (int, error) {
					requirePersonalInfoMetricDeadline(t, ctx)
					require.NoError(t, ctx.Err())
					require.Equal(t, userID, id)
					metricContexts = append(metricContexts, ctx)
					concurrencyRead = true
					return 0, test.concurrencyErr
				}))
			}
			rec := httptest.NewRecorder()
			personalInfoRouter(h, &userID).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/bot/personal-info", nil))

			require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
			require.Equal(t, test.wantConcurrencyRead, concurrencyRead)
			require.Equal(t, !test.missingUsage, usageRead)
			require.Equal(t, map[string]any{
				"id": float64(userID), "username": "alice", "balance": 12.5, "concurrency": float64(test.limit),
				"current_concurrency": test.wantConcurrency, "current_rpm": test.wantRPM, "rpm_window_seconds": float64(60),
			}, decodeBotData(t, rec))
			for _, ctx := range metricContexts {
				require.ErrorIs(t, ctx.Err(), context.Canceled, "metric contexts must be released before returning")
			}
		})
	}
}

func TestBotHandlerPersonalInfoRejectsMissingIdentityAndUserFailures(t *testing.T) {
	for _, test := range []struct {
		name        string
		withAuth    bool
		userID      int64
		missingUser bool
		user        *service.User
		err         error
		status      int
		wantRead    bool
	}{
		{name: "unauthenticated", status: http.StatusUnauthorized},
		{name: "zero subject", withAuth: true, status: http.StatusUnauthorized},
		{name: "negative subject", withAuth: true, userID: -1, status: http.StatusUnauthorized},
		{name: "missing user service", withAuth: true, userID: 7, missingUser: true, status: http.StatusInternalServerError},
		{name: "nil user", withAuth: true, userID: 7, status: http.StatusNotFound, wantRead: true},
		{name: "user not found", withAuth: true, userID: 7, err: service.ErrUserNotFound, status: http.StatusNotFound, wantRead: true},
		{name: "user storage failure", withAuth: true, userID: 7, err: errors.New("database down"), status: http.StatusInternalServerError, wantRead: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			userRead := false
			var users botUserReader
			if !test.missingUser {
				users = personalInfoUserReader(func(_ context.Context, id int64) (*service.User, error) {
					userRead = true
					require.Equal(t, test.userID, id)
					return test.user, test.err
				})
			}
			h := NewBotHandler(nil, personalInfoUsageReader(func(context.Context, usagestats.UsageLogFilters) (*usagestats.UsageStats, error) {
				t.Fatal("usage must not be read without a valid user")
				return nil, nil
			}), nil, users)
			h.SetConcurrencyReader(personalInfoConcurrencyReader(func(context.Context, int64) (int, error) {
				t.Fatal("concurrency must not be read without a valid user")
				return 0, nil
			}))
			var subject *int64
			if test.withAuth {
				subject = &test.userID
			}
			rec := httptest.NewRecorder()
			personalInfoRouter(h, subject).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/bot/personal-info", nil))

			require.Equal(t, test.status, rec.Code, rec.Body.String())
			require.Equal(t, test.wantRead, userRead)
			require.NotContains(t, rec.Body.String(), "current_rpm")
			require.NotContains(t, rec.Body.String(), "database down")
		})
	}
}
