package routes

import (
	"github.com/Wei-Shaw/sub2api/internal/handler"
	"github.com/Wei-Shaw/sub2api/internal/server/middleware"
	"github.com/gin-gonic/gin"
)

func RegisterBotLotteryRoutes(v1 *gin.RouterGroup, h *handler.BotLotteryHandler, adminAuth middleware.AdminAuthMiddleware, botAuth middleware.BotAuthMiddleware, panelRateLimiter *middleware.PanelRateLimiter) {
	if h == nil {
		return
	}
	bot := v1.Group("/admin/bot")
	bot.Use(gin.HandlerFunc(adminAuth), gin.HandlerFunc(botAuth), panelRateLimiter.Global())
	{
		bot.GET("/lottery", h.BotConfig)
		bot.POST("/lottery/draw", h.Draw)
		bot.GET("/lottery/records", h.BotRecords)
		bot.POST("/lottery/grants", h.BotGrant)
		bot.GET("/lottery/grant-batches/:id", h.BotGrantBatch)
	}
}

func registerAdminBotLotteryRoutes(admin *gin.RouterGroup, h *handler.BotLotteryHandler) {
	if h == nil {
		return
	}
	lottery := admin.Group("/bot-lottery")
	{
		lottery.GET("/config", h.AdminConfig)
		lottery.PUT("/config", h.AdminConfig)
		lottery.POST("/grants", h.AdminGrant)
		lottery.GET("/grant-batches/:id", h.AdminGrantBatch)
	}
	users := admin.Group("/users")
	users.GET("/:id/lottery", h.AdminUserRecords)
}
