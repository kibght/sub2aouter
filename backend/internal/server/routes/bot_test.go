package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/config"
	"github.com/Wei-Shaw/sub2api/internal/handler"
	"github.com/Wei-Shaw/sub2api/internal/server/middleware"
	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/alicebob/miniredis/v2"
	"github.com/gin-gonic/gin"
	"github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/require"
)

// 机器人接口路径是与聊天插件（kinght_status_plugin）约定的外部契约，
// 路径或方法变化会让线上机器人直接失效，因此这里做显式断言。
func TestRegisterBotRoutesPublishesPluginContract(t *testing.T) {
	gin.SetMode(gin.TestMode)

	engine := gin.New()
	v1 := engine.Group("/api/v1")
	RegisterBotRoutes(
		v1,
		&handler.Handlers{Bot: handler.NewBotHandler(nil, nil, nil, nil)},
		middleware.AdminAuthMiddleware(func(c *gin.Context) { c.Next() }),
		middleware.BotAuthMiddleware(func(c *gin.Context) { c.Next() }),
		middleware.NewPanelRateLimiter(nil, nil),
	)

	registered := make(map[string]struct{})
	for _, route := range engine.Routes() {
		registered[route.Method+" "+route.Path] = struct{}{}
	}

	expected := []string{
		http.MethodPost + " /api/v1/bot-bindings/redeem",
		http.MethodGet + " /api/v1/bot/profile",
		http.MethodGet + " /api/v1/bot/personal-info",
		http.MethodPost + " /api/v1/bot/unbind",
		http.MethodGet + " /api/v1/bot/balance-alerts",
		http.MethodPost + " /api/v1/bot/balance-alerts/:id/ack",
		http.MethodGet + " /api/v1/bot/api-keys",
		http.MethodGet + " /api/v1/bot/usage/stats",
		http.MethodGet + " /api/v1/bot/usage/dashboard/stats",
		http.MethodPost + " /api/v1/bot/usage/dashboard/api-keys-usage",
		http.MethodGet + " /api/v1/bot/user/api-keys/:id/usage/daily",
	}
	for _, route := range expected {
		require.Contains(t, registered, route, "missing bot route: %s", route)
	}
}

func TestRegisterBotRoutesRequireAdminAndBotAuthentication(t *testing.T) {
	gin.SetMode(gin.TestMode)

	adminAuth := middleware.AdminAuthMiddleware(func(c *gin.Context) {
		if c.GetHeader("X-Test-Admin") != "authorized" {
			c.AbortWithStatus(http.StatusUnauthorized)
			return
		}
		c.Next()
	})
	botAuth := middleware.BotAuthMiddleware(func(c *gin.Context) {
		if c.GetHeader("Authorization") != "Bot test-token" {
			c.AbortWithStatus(http.StatusUnauthorized)
			return
		}
		c.Next()
	})

	engine := gin.New()
	RegisterBotRoutes(
		engine.Group("/api/v1"),
		&handler.Handlers{Bot: handler.NewBotHandler(nil, nil, nil, nil)},
		adminAuth,
		botAuth,
		middleware.NewPanelRateLimiter(nil, nil),
	)

	requests := []struct {
		method string
		path   string
	}{
		{method: http.MethodPost, path: "/api/v1/bot-bindings/redeem"},
		{method: http.MethodGet, path: "/api/v1/bot/profile"},
		{method: http.MethodGet, path: "/api/v1/bot/personal-info"},
		{method: http.MethodPost, path: "/api/v1/bot/unbind"},
		{method: http.MethodGet, path: "/api/v1/bot/balance-alerts"},
		{method: http.MethodPost, path: "/api/v1/bot/balance-alerts/1/ack"},
		{method: http.MethodGet, path: "/api/v1/bot/api-keys"},
		{method: http.MethodGet, path: "/api/v1/bot/usage/stats"},
		{method: http.MethodGet, path: "/api/v1/bot/usage/dashboard/stats"},
		{method: http.MethodPost, path: "/api/v1/bot/usage/dashboard/api-keys-usage"},
		{method: http.MethodGet, path: "/api/v1/bot/user/api-keys/1/usage/daily"},
	}

	for _, test := range requests {
		t.Run(test.method+" "+test.path, func(t *testing.T) {
			req := httptest.NewRequest(test.method, test.path, nil)
			rec := httptest.NewRecorder()
			engine.ServeHTTP(rec, req)
			require.Equal(t, http.StatusUnauthorized, rec.Code, "admin authentication must be required")

			req = httptest.NewRequest(test.method, test.path, nil)
			req.Header.Set("Authorization", "Bot test-token")
			rec = httptest.NewRecorder()
			engine.ServeHTTP(rec, req)
			require.Equal(t, http.StatusUnauthorized, rec.Code, "bot token alone must not bypass admin authentication")

			req = httptest.NewRequest(test.method, test.path, nil)
			req.Header.Set("X-Test-Admin", "authorized")
			rec = httptest.NewRecorder()
			engine.ServeHTTP(rec, req)
			if test.path == "/api/v1/bot-bindings/redeem" {
				require.Equal(t, http.StatusInternalServerError, rec.Code, "redeem handler should receive authenticated request")
			} else {
				require.Equal(t, http.StatusUnauthorized, rec.Code, "bot binding authentication must remain required")
			}
		})
	}

	for _, path := range []string{"/api/v1/bot/profile", "/api/v1/bot/personal-info"} {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		req.Header.Set("X-Test-Admin", "authorized")
		req.Header.Set("Authorization", "Bot test-token")
		rec := httptest.NewRecorder()
		engine.ServeHTTP(rec, req)
		require.Equal(t, http.StatusInternalServerError, rec.Code, "request with both credentials should reach the handler")
	}
}

type botPersonalInfoRateLimitSettings struct {
	service.SettingRepository
}

func (botPersonalInfoRateLimitSettings) GetValue(_ context.Context, key string) (string, error) {
	if key == service.SettingKeyPanelRateLimitSettings {
		return `{"enabled":true,"user_rpm":10,"heavy_rpm":1,"exempt_admin":true}`, nil
	}
	return "", service.ErrSettingNotFound
}

func TestRegisterBotRoutesPersonalInfoUsesHeavyRateLimit(t *testing.T) {
	gin.SetMode(gin.TestMode)
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { _ = rdb.Close() })
	settings := service.NewSettingService(botPersonalInfoRateLimitSettings{}, &config.Config{})
	engine := gin.New()
	RegisterBotRoutes(
		engine.Group("/api/v1"),
		&handler.Handlers{Bot: handler.NewBotHandler(nil, nil, nil, nil)},
		middleware.AdminAuthMiddleware(func(c *gin.Context) {
			c.Set(string(middleware.ContextKeyUser), middleware.AuthSubject{UserID: 99})
			c.Set(string(middleware.ContextKeyUserRole), service.RoleAdmin)
			c.Next()
		}),
		middleware.BotAuthMiddleware(func(c *gin.Context) {
			c.Set(string(middleware.ContextKeyUser), middleware.AuthSubject{UserID: 7})
			c.Set(string(middleware.ContextKeyUserRole), service.RoleUser)
			c.Next()
		}),
		middleware.NewPanelRateLimiter(rdb, settings),
	)

	first := httptest.NewRecorder()
	engine.ServeHTTP(first, httptest.NewRequest(http.MethodGet, "/api/v1/bot/personal-info", nil))
	require.Equal(t, http.StatusInternalServerError, first.Code, "first request should reach the handler")

	second := httptest.NewRecorder()
	engine.ServeHTTP(second, httptest.NewRequest(http.MethodGet, "/api/v1/bot/personal-info", nil))
	require.Equal(t, http.StatusTooManyRequests, second.Code, second.Body.String())
	require.NotEmpty(t, second.Header().Get("Retry-After"))

	profile := httptest.NewRecorder()
	engine.ServeHTTP(profile, httptest.NewRequest(http.MethodGet, "/api/v1/bot/profile", nil))
	require.Equal(t, http.StatusInternalServerError, profile.Code, "global quota should still allow a lightweight route")
	count, err := mr.Get("rate_limit:panel:heavy:user:7")
	require.NoError(t, err)
	require.Equal(t, "2", count)
	require.False(t, mr.Exists("rate_limit:panel:heavy:user:99"), "admin identity must not own the bot user's quota")
}

func TestRegisterBotRoutesSkipsWhenHandlerMissing(t *testing.T) {
	gin.SetMode(gin.TestMode)

	engine := gin.New()
	v1 := engine.Group("/api/v1")
	RegisterBotRoutes(
		v1,
		&handler.Handlers{},
		middleware.AdminAuthMiddleware(func(c *gin.Context) { c.Next() }),
		middleware.BotAuthMiddleware(func(c *gin.Context) { c.Next() }),
		middleware.NewPanelRateLimiter(nil, nil),
	)

	require.Empty(t, engine.Routes())
}
