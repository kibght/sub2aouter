package routes

import (
	"net/http"
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

func TestRegisterBotRoutesSkipsWhenHandlerMissing(t *testing.T) {
	gin.SetMode(gin.TestMode)

	engine := gin.New()
	v1 := engine.Group("/api/v1")
	RegisterBotRoutes(
		v1,
		&handler.Handlers{},
		middleware.BotAuthMiddleware(func(c *gin.Context) { c.Next() }),
		middleware.NewPanelRateLimiter(nil, nil),
	)

	require.Empty(t, engine.Routes())
}
