package routes

import (
	"github.com/Wei-Shaw/sub2api/internal/handler"
	"github.com/Wei-Shaw/sub2api/internal/server/middleware"

	"github.com/gin-gonic/gin"
)

// RegisterBotRoutes 注册聊天机器人接口。
//
// 认证方式与面板完全不同：聊天插件携带 "Authorization: Bot <token>"，
// token 由网站个人中心生成的一次性绑定码兑换得到。所有 /bot/* 接口都以
// 绑定账号的身份执行，与用户端接口共享同一套归属校验。
func RegisterBotRoutes(
	v1 *gin.RouterGroup,
	h *handler.Handlers,
	botAuth middleware.BotAuthMiddleware,
	panelRateLimiter *middleware.PanelRateLimiter,
) {
	if h == nil || h.Bot == nil {
		return
	}

	// 绑定码兑换是公开接口：按客户端 IP 限流，降低绑定码被暴力枚举的风险。
	v1.POST("/bot-bindings/redeem", panelRateLimiter.PublicIP(), h.Bot.Redeem)

	bot := v1.Group("/bot")
	bot.Use(gin.HandlerFunc(botAuth))
	bot.Use(panelRateLimiter.Global())
	{
		bot.GET("/profile", h.Bot.Profile)
		bot.POST("/unbind", h.Bot.Unbind)
		bot.GET("/api-keys", h.Bot.APIKeys)
		// 聚合查询与用户端一致，叠加更严格的 Heavy 档限流。
		bot.GET("/usage/stats", panelRateLimiter.Heavy(), h.Bot.UsageStats)

		// 仪表盘与用量明细直接复用用户端实现，保证机器人看到的口径与网站页面一致。
		bot.GET("/usage/dashboard/stats", panelRateLimiter.Heavy(), h.Usage.DashboardStats)
		bot.POST("/usage/dashboard/api-keys-usage", panelRateLimiter.Heavy(), h.Usage.DashboardAPIKeysUsage)
		bot.GET("/user/api-keys/:id/usage/daily", panelRateLimiter.Heavy(), h.Usage.GetMyAPIKeyDailyUsage)
	}
}
