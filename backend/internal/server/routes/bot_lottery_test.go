package routes

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/handler"
	"github.com/Wei-Shaw/sub2api/internal/server/middleware"
	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

func TestBotLotteryRoutesRequireBothCredentialsAndBoundAdminRoleForGrants(t *testing.T) {
	gin.SetMode(gin.TestMode)
	engine := gin.New()
	adminAuth := middleware.AdminAuthMiddleware(func(c *gin.Context) {
		if c.GetHeader("x-api-key") == "" {
			c.AbortWithStatus(http.StatusUnauthorized)
			return
		}
		c.Set("auth_method", service.AuditAuthMethodAdminAPIKey)
		c.Set(string(middleware.ContextKeyUserRole), service.RoleAdmin)
		c.Next()
	})
	botAuth := middleware.BotAuthMiddleware(func(c *gin.Context) {
		if c.GetHeader("Authorization") != "Bot token" {
			c.AbortWithStatus(http.StatusUnauthorized)
			return
		}
		c.Set(string(middleware.ContextKeyUser), middleware.AuthSubject{UserID: 42})
		c.Set(string(middleware.ContextKeyUserRole), service.RoleUser)
		c.Next()
	})
	h := handler.NewBotLotteryHandler(service.NewBotLotteryService(nil, nil, nil))
	RegisterBotLotteryRoutes(engine.Group("/api/v1"), h, adminAuth, botAuth, middleware.NewPanelRateLimiter(nil, nil))
	for _, headers := range []map[string]string{{"Authorization": "Bot token"}, {"x-api-key": "yes"}} {
		req := httptest.NewRequest(http.MethodPost, "/api/v1/bot/lottery/grants", strings.NewReader(`{"target":"all","count":3,"request_id":"message"}`))
		req.Header.Set("Content-Type", "application/json")
		for key, value := range headers {
			req.Header.Set(key, value)
		}
		rec := httptest.NewRecorder()
		engine.ServeHTTP(rec, req)
		require.Equal(t, http.StatusUnauthorized, rec.Code)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/bot/lottery/grants", strings.NewReader(`{"target":"all","count":3,"request_id":"message"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bot token")
	req.Header.Set("x-api-key", "yes")
	rec := httptest.NewRecorder()
	engine.ServeHTTP(rec, req)
	require.Equal(t, http.StatusForbidden, rec.Code, "administrator transport key must not make a bound normal user an administrator")
}

func TestBotLotteryPublishesDocumentedRoutes(t *testing.T) {
	gin.SetMode(gin.TestMode)
	engine := gin.New()
	v1 := engine.Group("/api/v1")
	h := handler.NewBotLotteryHandler(nil)
	RegisterBotLotteryRoutes(v1, h, middleware.AdminAuthMiddleware(func(c *gin.Context) { c.Next() }), middleware.BotAuthMiddleware(func(c *gin.Context) { c.Next() }), middleware.NewPanelRateLimiter(nil, nil))
	registerAdminBotLotteryRoutes(v1.Group("/admin"), h)
	registered := map[string]bool{}
	for _, route := range engine.Routes() {
		registered[route.Method+" "+route.Path] = true
	}
	for _, path := range []string{"GET /api/v1/bot/lottery", "POST /api/v1/bot/lottery/draw", "GET /api/v1/bot/lottery/records", "POST /api/v1/bot/lottery/grants", "GET /api/v1/bot/lottery/grant-batches/:id", "GET /api/v1/admin/bot-lottery/config", "PUT /api/v1/admin/bot-lottery/config", "GET /api/v1/admin/users/:id/lottery", "POST /api/v1/admin/bot-lottery/grants", "GET /api/v1/admin/bot-lottery/grant-batches/:id"} {
		require.True(t, registered[path], path)
	}
}
