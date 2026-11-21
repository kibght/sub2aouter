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
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

func TestRegisterBotRechargeRoutesContractAndAuthentication(t *testing.T) {
	gin.SetMode(gin.TestMode)
	engine := gin.New()
	adminAuth := middleware.AdminAuthMiddleware(func(c *gin.Context) {
		if c.GetHeader("x-api-key") != "authorized" {
			c.AbortWithStatus(http.StatusUnauthorized)
			return
		}
		c.Set("auth_method", service.AuditAuthMethodAdminAPIKey)
		c.Next()
	})
	botAuth := middleware.BotAuthMiddleware(func(c *gin.Context) {
		if c.GetHeader("Authorization") != "Bot test-token" {
			c.AbortWithStatus(http.StatusUnauthorized)
			return
		}
		c.Next()
	})
	RegisterBotRechargeRoutes(engine.Group("/api/v1"), handler.NewBotRechargeHandler(nil), adminAuth, botAuth, nil, middleware.NewPanelRateLimiter(nil, nil))
	routes := map[string]bool{}
	for _, route := range engine.Routes() {
		routes[route.Method+" "+route.Path] = true
	}
	for _, route := range []string{
		"GET /api/v1/bot/recharge/options",
		"POST /api/v1/bot/recharge/orders",
		"GET /api/v1/bot/recharge/orders/latest",
		"GET /api/v1/bot/recharge/orders/:id",
		"GET /api/v1/bot/recharge/notifications",
		"POST /api/v1/bot/recharge/notifications/:id/ack",
	} {
		require.True(t, routes[route], route)
	}
	for _, header := range []string{"admin", "bot"} {
		req := httptest.NewRequest(http.MethodGet, "/api/v1/bot/recharge/options", nil)
		if header == "admin" {
			req.Header.Set("x-api-key", "authorized")
		} else {
			req.Header.Set("Authorization", "Bot test-token")
		}
		rec := httptest.NewRecorder()
		engine.ServeHTTP(rec, req)
		require.Equal(t, http.StatusUnauthorized, rec.Code)
	}
}

type botRechargeModeSettings struct{ values map[string]string }

func (s *botRechargeModeSettings) Get(context.Context, string) (*service.Setting, error) {
	return nil, service.ErrSettingNotFound
}
func (s *botRechargeModeSettings) GetValue(_ context.Context, key string) (string, error) {
	return s.values[key], nil
}
func (s *botRechargeModeSettings) Set(_ context.Context, key, value string) error {
	s.values[key] = value
	return nil
}
func (s *botRechargeModeSettings) GetMultiple(context.Context, []string) (map[string]string, error) {
	return s.values, nil
}
func (s *botRechargeModeSettings) SetMultiple(_ context.Context, values map[string]string) error {
	for key, value := range values {
		s.values[key] = value
	}
	return nil
}
func (s *botRechargeModeSettings) GetAll(context.Context) (map[string]string, error) {
	return s.values, nil
}
func (s *botRechargeModeSettings) Delete(_ context.Context, key string) error {
	delete(s.values, key)
	return nil
}

func TestBotRechargeRoutesPreserveBackendModeUserGuard(t *testing.T) {
	gin.SetMode(gin.TestMode)
	repo := &botRechargeModeSettings{values: map[string]string{service.SettingKeyBackendModeEnabled: "true"}}
	settings := service.NewSettingService(repo, &config.Config{})
	require.NoError(t, settings.UpdateSettings(context.Background(), &service.SystemSettings{BackendModeEnabled: true}))
	t.Cleanup(func() {
		_ = settings.UpdateSettings(context.Background(), &service.SystemSettings{BackendModeEnabled: false})
	})
	engine := gin.New()
	RegisterBotRechargeRoutes(engine.Group("/api/v1"), handler.NewBotRechargeHandler(nil),
		middleware.AdminAuthMiddleware(func(c *gin.Context) { c.Set("auth_method", service.AuditAuthMethodAdminAPIKey); c.Next() }),
		middleware.BotAuthMiddleware(func(c *gin.Context) { c.Set(string(middleware.ContextKeyUserRole), "user"); c.Next() }),
		settings, middleware.NewPanelRateLimiter(nil, nil))
	for _, path := range []string{"/api/v1/bot/recharge/options", "/api/v1/bot/recharge/orders/latest", "/api/v1/bot/recharge/notifications"} {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, path, nil)
		req.Header.Set("x-api-key", "authorized")
		engine.ServeHTTP(rec, req)
		require.Equal(t, http.StatusForbidden, rec.Code, path)
	}
}
