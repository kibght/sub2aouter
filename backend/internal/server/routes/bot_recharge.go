package routes

import (
	"github.com/Wei-Shaw/sub2api/internal/handler"
	"github.com/Wei-Shaw/sub2api/internal/server/middleware"
	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/gin-gonic/gin"
)

// RegisterBotRechargeRoutes 注册机器人充值、订单查询与到账提醒接口。
func RegisterBotRechargeRoutes(
	v1 *gin.RouterGroup,
	h *handler.BotRechargeHandler,
	adminAuth middleware.AdminAuthMiddleware,
	botAuth middleware.BotAuthMiddleware,
	settingService *service.SettingService,
	panelRateLimiter *middleware.PanelRateLimiter,
) {
	if v1 == nil || h == nil {
		return
	}
	bot := v1.Group("/bot")
	bot.Use(gin.HandlerFunc(adminAuth))
	bot.Use(gin.HandlerFunc(botAuth))
	bot.Use(middleware.BackendModeUserGuard(settingService))
	bot.Use(panelRateLimiter.Global())
	{
		bot.GET("/recharge/options", h.Options)
		bot.POST("/recharge/orders", h.CreateOrder)
		bot.GET("/recharge/orders/latest", h.LatestOrder)
		bot.GET("/recharge/orders/:id", h.GetOrder)
		bot.GET("/recharge/notifications", h.Notifications)
		bot.POST("/recharge/notifications/:id/ack", h.AckNotification)
	}
}
