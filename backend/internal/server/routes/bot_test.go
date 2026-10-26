package routes

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/handler"
	"github.com/Wei-Shaw/sub2api/internal/server/middleware"
	"github.com/gin-gonic/gin"
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

	req := httptest.NewRequest(http.MethodGet, "/api/v1/bot/profile", nil)
	req.Header.Set("X-Test-Admin", "authorized")
	req.Header.Set("Authorization", "Bot test-token")
	rec := httptest.NewRecorder()
	engine.ServeHTTP(rec, req)
	require.Equal(t, http.StatusInternalServerError, rec.Code, "request with both credentials should reach the handler")
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
