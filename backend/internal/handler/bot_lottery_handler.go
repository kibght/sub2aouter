package handler

import (
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/Wei-Shaw/sub2api/internal/pkg/response"
	middleware2 "github.com/Wei-Shaw/sub2api/internal/server/middleware"
	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/gin-gonic/gin"
)

type BotLotteryHandler struct{ lottery *service.BotLotteryService }

func NewBotLotteryHandler(lottery *service.BotLotteryService) *BotLotteryHandler {
	return &BotLotteryHandler{lottery: lottery}
}

type botLotteryDrawRequest struct {
	RequestID string `json:"request_id"`
}
type botLotteryGrantRequest struct {
	Target    string `json:"target"`
	UserID    int64  `json:"user_id"`
	Count     int64  `json:"count"`
	Notes     string `json:"notes"`
	RequestID string `json:"request_id"`
}

func (h *BotLotteryHandler) BotConfig(c *gin.Context) {
	if !h.available(c) {
		return
	}
	subject, ok := requireBotLotterySubject(c)
	if !ok {
		return
	}
	config, err := h.lottery.Config(c.Request.Context())
	if err != nil {
		response.ErrorFrom(c, err)
		return
	}
	remaining, err := h.lottery.Remaining(c.Request.Context(), subject.UserID)
	if err != nil {
		response.ErrorFrom(c, err)
		return
	}
	response.Success(c, gin.H{"enabled": config.Enabled, "remaining": remaining, "prizes": config.Prizes})
}

func (h *BotLotteryHandler) Draw(c *gin.Context) {
	if !h.available(c) {
		return
	}
	subject, ok := requireBotLotterySubject(c)
	if !ok {
		return
	}
	var req botLotteryDrawRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.BadRequest(c, "Invalid request: "+err.Error())
		return
	}
	result, err := h.lottery.Draw(c.Request.Context(), subject.UserID, req.RequestID)
	if err != nil {
		response.ErrorFrom(c, err)
		return
	}
	response.Success(c, result)
}

func (h *BotLotteryHandler) BotRecords(c *gin.Context) {
	if !h.available(c) {
		return
	}
	subject, ok := requireBotLotterySubject(c)
	if !ok {
		return
	}
	records, err := h.lottery.Records(c.Request.Context(), subject.UserID, 50)
	if err != nil {
		response.ErrorFrom(c, err)
		return
	}
	response.Success(c, gin.H{"items": records})
}

func (h *BotLotteryHandler) BotGrant(c *gin.Context) {
	if !h.available(c) {
		return
	}
	if !requireBotLotteryAdmin(c) {
		return
	}
	actor, ok := requireBotLotterySubject(c)
	if !ok {
		return
	}
	var req botLotteryGrantRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.BadRequest(c, "Invalid request: "+err.Error())
		return
	}
	target := strings.TrimSpace(req.Target)
	if strings.EqualFold(target, "all") {
		batch, err := h.lottery.GrantAll(c.Request.Context(), service.BotLotteryGrantBatchRequest{ActorID: actor.UserID, Count: req.Count, Notes: req.Notes, RequestID: req.RequestID})
		if err != nil {
			response.ErrorFrom(c, err)
			return
		}
		response.Success(c, batch)
		return
	}
	if target == "" {
		response.BadRequest(c, "target is required")
		return
	}
	result, err := h.lottery.GrantToQQ(c.Request.Context(), target, req.Count, req.Notes, req.RequestID, actor.UserID)
	if err != nil {
		response.ErrorFrom(c, err)
		return
	}
	response.Success(c, result)
}

func (h *BotLotteryHandler) BotGrantBatch(c *gin.Context) {
	if !h.available(c) {
		return
	}
	if !requireBotLotteryAdmin(c) {
		return
	}
	if _, ok := requireBotLotterySubject(c); !ok {
		return
	}
	batchID, err := parseBotLotteryBatchID(c)
	if err != nil {
		response.BadRequest(c, "Invalid batch ID")
		return
	}
	batch, err := h.lottery.GrantBatch(c.Request.Context(), batchID)
	if err != nil {
		response.ErrorFrom(c, err)
		return
	}
	response.Success(c, batch)
}

func (h *BotLotteryHandler) AdminConfig(c *gin.Context) {
	if !h.available(c) {
		return
	}
	if c.Request.Method == http.MethodGet {
		config, err := h.lottery.Config(c.Request.Context())
		if err != nil {
			response.ErrorFrom(c, err)
			return
		}
		response.Success(c, config)
		return
	}
	var config service.BotLotteryConfig
	if err := c.ShouldBindJSON(&config); err != nil {
		response.BadRequest(c, "Invalid request: "+err.Error())
		return
	}
	if err := h.lottery.UpdateConfig(c.Request.Context(), config); err != nil {
		response.ErrorFrom(c, err)
		return
	}
	response.Success(c, config)
}

func (h *BotLotteryHandler) AdminUserRecords(c *gin.Context) {
	if !h.available(c) {
		return
	}
	userID, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil || userID <= 0 {
		response.BadRequest(c, "Invalid user ID")
		return
	}
	remaining, records, err := h.lottery.AdminHistory(c.Request.Context(), userID, 100)
	if err != nil {
		response.ErrorFrom(c, err)
		return
	}
	response.Success(c, gin.H{"user_id": userID, "remaining": remaining, "records": records})
}

func (h *BotLotteryHandler) AdminGrant(c *gin.Context) {
	if !h.available(c) {
		return
	}
	actor, ok := requireBotLotterySubject(c)
	if !ok {
		return
	}
	var req botLotteryGrantRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.BadRequest(c, "Invalid request: "+err.Error())
		return
	}
	if strings.EqualFold(strings.TrimSpace(req.Target), "all") {
		batch, err := h.lottery.CreateAdminGrantBatch(c.Request.Context(), service.BotLotteryGrantBatchRequest{ActorID: actor.UserID, Count: req.Count, Notes: req.Notes, RequestID: req.RequestID})
		if err != nil {
			response.ErrorFrom(c, err)
			return
		}
		response.Success(c, batch)
		return
	}
	if req.UserID <= 0 {
		response.BadRequest(c, "user_id is required")
		return
	}
	result, err := h.lottery.AdminGrant(c.Request.Context(), req.UserID, req.Count, req.Notes, req.RequestID, actor.UserID)
	if err != nil {
		response.ErrorFrom(c, err)
		return
	}
	response.Success(c, result)
}

func (h *BotLotteryHandler) AdminGrantBatch(c *gin.Context) {
	if !h.available(c) {
		return
	}
	batchID, err := parseBotLotteryBatchID(c)
	if err != nil {
		response.BadRequest(c, "Invalid batch ID")
		return
	}
	batch, err := h.lottery.GrantBatch(c.Request.Context(), batchID)
	if err != nil {
		response.ErrorFrom(c, err)
		return
	}
	response.Success(c, batch)
}

func (h *BotLotteryHandler) available(c *gin.Context) bool {
	if h == nil || h.lottery == nil {
		response.InternalError(c, "Bot lottery service is not available")
		return false
	}
	return true
}

func requireBotLotterySubject(c *gin.Context) (middleware2.AuthSubject, bool) {
	subject, ok := middleware2.GetAuthSubjectFromContext(c)
	if !ok {
		response.Unauthorized(c, "User not authenticated")
		return middleware2.AuthSubject{}, false
	}
	return subject, true
}

func requireBotLotteryAdmin(c *gin.Context) bool {
	role, ok := middleware2.GetUserRoleFromContext(c)
	if !ok || role != service.RoleAdmin {
		response.ErrorFrom(c, service.ErrBotLotteryAdminRequired)
		return false
	}
	return true
}

func parseBotLotteryBatchID(c *gin.Context) (int64, error) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil || id <= 0 {
		return 0, fmt.Errorf("invalid batch ID")
	}
	return id, nil
}
