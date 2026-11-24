package handler

import (
	"context"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/pkg/response"
	middleware2 "github.com/Wei-Shaw/sub2api/internal/server/middleware"
	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/gin-gonic/gin"
)

type botRechargeOperations interface {
	Options(ctx context.Context) (*service.BotRechargeOptions, error)
	CreateOrder(ctx context.Context, params service.BotRechargeCreateParams) (*service.BotRechargeOrder, error)
	Order(ctx context.Context, userID, orderID int64) (*service.BotRechargeOrder, error)
	LatestOrder(ctx context.Context, userID int64) (*service.BotRechargeOrder, error)
	Notifications(ctx context.Context, userID, bindingID int64, platform, externalID string) ([]service.BotRechargeNotification, error)
	AckNotification(ctx context.Context, userID, bindingID, notificationID int64) (bool, error)
}

type BotRechargeHandler struct {
	recharge botRechargeOperations
}

func NewBotRechargeHandler(recharge *service.BotRechargeService) *BotRechargeHandler {
	return &BotRechargeHandler{recharge: recharge}
}

func (h *BotRechargeHandler) Options(c *gin.Context) {
	options, err := h.recharge.Options(c.Request.Context())
	if err != nil {
		response.ErrorFrom(c, err)
		return
	}
	response.Success(c, options)
}

type createBotRechargeOrderRequest struct {
	Amount      float64 `json:"amount"`
	PaymentType string  `json:"payment_type" binding:"required"`
	RequestID   string  `json:"request_id" binding:"required"`
}

func (h *BotRechargeHandler) CreateOrder(c *gin.Context) {
	subject, ok := middleware2.GetAuthSubjectFromContext(c)
	if !ok || subject.UserID <= 0 {
		response.Unauthorized(c, "authentication required")
		return
	}
	binding, ok := middleware2.GetBotBindingFromContext(c)
	if !ok || binding == nil || binding.UserID != subject.UserID {
		response.Unauthorized(c, "bot binding context is unavailable")
		return
	}
	var req createBotRechargeOrderRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.BadRequest(c, "invalid recharge request")
		return
	}
	order, err := h.recharge.CreateOrder(c.Request.Context(), service.BotRechargeCreateParams{
		UserID: subject.UserID, BindingID: binding.ID, Platform: binding.Platform,
		ExternalID: binding.ExternalID, RequestID: strings.TrimSpace(req.RequestID),
		Amount: req.Amount, PaymentType: req.PaymentType, ClientIP: c.ClientIP(),
	})
	if err != nil {
		response.ErrorFrom(c, err)
		return
	}
	response.Created(c, order)
}

func (h *BotRechargeHandler) LatestOrder(c *gin.Context) {
	subject, ok := middleware2.GetAuthSubjectFromContext(c)
	if !ok || subject.UserID <= 0 {
		response.Unauthorized(c, "authentication required")
		return
	}
	order, err := h.recharge.LatestOrder(c.Request.Context(), subject.UserID)
	if err != nil {
		response.ErrorFrom(c, err)
		return
	}
	response.Success(c, order)
}

func (h *BotRechargeHandler) GetOrder(c *gin.Context) {
	subject, ok := middleware2.GetAuthSubjectFromContext(c)
	if !ok || subject.UserID <= 0 {
		response.Unauthorized(c, "authentication required")
		return
	}
	orderID, err := strconv.ParseInt(strings.TrimSpace(c.Param("id")), 10, 64)
	if err != nil || orderID <= 0 {
		response.BadRequest(c, "invalid order id")
		return
	}
	order, err := h.recharge.Order(c.Request.Context(), subject.UserID, orderID)
	if err != nil {
		response.ErrorFrom(c, err)
		return
	}
	response.Success(c, order)
}

type botRechargeNotificationItem struct {
	ID             int64     `json:"id"`
	OrderID        int64     `json:"order_id"`
	CreditedAmount float64   `json:"credited_amount"`
	Currency       string    `json:"currency"`
	CreatedAt      time.Time `json:"created_at"`
}

func (h *BotRechargeHandler) Notifications(c *gin.Context) {
	subject, ok := middleware2.GetAuthSubjectFromContext(c)
	if !ok || subject.UserID <= 0 {
		response.Unauthorized(c, "authentication required")
		return
	}
	binding, ok := middleware2.GetBotBindingFromContext(c)
	if !ok || binding == nil || binding.UserID != subject.UserID {
		response.Unauthorized(c, "bot binding context is unavailable")
		return
	}
	items, err := h.recharge.Notifications(c.Request.Context(), subject.UserID, binding.ID, binding.Platform, binding.ExternalID)
	if err != nil {
		response.ErrorFrom(c, err)
		return
	}
	result := make([]botRechargeNotificationItem, 0, len(items))
	for _, item := range items {
		result = append(result, botRechargeNotificationItem{
			ID: item.ID, OrderID: item.OrderID, CreditedAmount: item.CreditedAmount,
			Currency: item.Currency, CreatedAt: item.CreatedAt.UTC(),
		})
	}
	response.Success(c, gin.H{"items": result})
}

func (h *BotRechargeHandler) AckNotification(c *gin.Context) {
	subject, ok := middleware2.GetAuthSubjectFromContext(c)
	if !ok || subject.UserID <= 0 {
		response.Unauthorized(c, "authentication required")
		return
	}
	binding, ok := middleware2.GetBotBindingFromContext(c)
	if !ok || binding == nil || binding.UserID != subject.UserID {
		response.Unauthorized(c, "bot binding context is unavailable")
		return
	}
	notificationID, err := strconv.ParseInt(strings.TrimSpace(c.Param("id")), 10, 64)
	if err != nil || notificationID <= 0 {
		response.BadRequest(c, "invalid notification id")
		return
	}
	acked, err := h.recharge.AckNotification(c.Request.Context(), subject.UserID, binding.ID, notificationID)
	if err != nil {
		response.ErrorFrom(c, err)
		return
	}
	if !acked {
		response.Error(c, http.StatusNotFound, "notification not found")
		return
	}
	response.Success(c, gin.H{"acked": true})
}
