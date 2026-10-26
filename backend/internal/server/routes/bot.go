package routes

import (
	"github.com/Wei-Shaw/sub2api/internal/handler"
	"github.com/Wei-Shaw/sub2api/internal/server/middleware"

	"github.com/gin-gonic/gin"
)

// RegisterBotRoutes 注册聊天机器人接口。
//
// 机器人接口同时要求管理员认证和绑定令牌认证：管理员凭据限制接口访问权限，
// 聊天插件的 "Authorization: Bot <token>" 继续用于绑定账号归属校验。
func RegisterBotRoutes(
	v1 *gin.RouterGroup,
	h *handler.Handlers,
	adminAuth middleware.AdminAuthMiddleware,
	botAuth middleware.BotAuthMiddleware,
	panelRateLimiter *middleware.PanelRateLimiter,
) {
	if h == nil || h.Bot == nil {
		return
	}

	// 绑定码兑换也属于机器人接口，要求管理员认证并按客户端 IP 限流。
	v1.POST("/bot-bindings/redeem", gin.HandlerFunc(adminAuth), panelRateLimiter.PublicIP(), h.Bot.Redeem)

	bot := v1.Group("/bot")
	bot.Use(gin.HandlerFunc(adminAuth))
	bot.Use(gin.HandlerFunc(botAuth))
	bot.Use(panelRateLimiter.Global())
	{
		bot.GET("/profile", h.Bot.Profile)
		bot.POST("/unbind", h.Bot.Unbind)
		bot.GET("/balance-alerts", h.Bot.BalanceLowAlerts)
		bot.POST("/balance-alerts/:id/ack", h.Bot.AckBalanceLowAlert)
		bot.GET("/api-keys", h.Bot.APIKeys)
		// 聚合查询与用户端一致，叠加更严格的 Heavy 档限流。
		bot.GET("/usage/stats", panelRateLimiter.Heavy(), h.Bot.UsageStats)

		// 仪表盘与用量明细直接复用用户端实现，保证机器人看到的口径与网站页面一致。
		bot.GET("/usage/dashboard/stats", panelRateLimiter.Heavy(), h.Usage.DashboardStats)
		bot.POST("/usage/dashboard/api-keys-usage", panelRateLimiter.Heavy(), h.Usage.DashboardAPIKeysUsage)
		bot.GET("/user/api-keys/:id/usage/daily", panelRateLimiter.Heavy(), h.Usage.GetMyAPIKeyDailyUsage)
	}
}
