package handler

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/server/middleware"
	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

type botRechargeHandlerStub struct {
	created     service.BotRechargeCreateParams
	userID      int64
	orderID     int64
	createCalls int
}

func (s *botRechargeHandlerStub) Options(context.Context) (*service.BotRechargeOptions, error) {
	return &service.BotRechargeOptions{}, nil
}
func (s *botRechargeHandlerStub) CreateOrder(_ context.Context, p service.BotRechargeCreateParams) (*service.BotRechargeOrder, error) {
	s.created = p
	s.createCalls++
	return &service.BotRechargeOrder{OrderID: 51}, nil
}
func (s *botRechargeHandlerStub) Order(_ context.Context, u, o int64) (*service.BotRechargeOrder, error) {
	s.userID = u
	s.orderID = o
	return &service.BotRechargeOrder{OrderID: o}, nil
}
func (s *botRechargeHandlerStub) LatestOrder(_ context.Context, u int64) (*service.BotRechargeOrder, error) {
	s.userID = u
	return &service.BotRechargeOrder{OrderID: 51}, nil
}
func (s *botRechargeHandlerStub) Notifications(context.Context, int64, int64, string, string) ([]service.BotRechargeNotification, error) {
	return nil, nil
}
func (s *botRechargeHandlerStub) AckNotification(context.Context, int64, int64, int64) (bool, error) {
	return true, nil
}

func TestBotRechargeHandlerIgnoresBodyUserAndBindingIDs(t *testing.T) {
	gin.SetMode(gin.TestMode)
	stub := &botRechargeHandlerStub{}
	h := &BotRechargeHandler{recharge: stub}
	router := gin.New()
	router.Use(func(c *gin.Context) {
		c.Set(string(middleware.ContextKeyUser), middleware.AuthSubject{UserID: 7})
		c.Set(string(middleware.ContextKeyBotBinding), &service.BotBinding{ID: 9, UserID: 7, Platform: "qq", ExternalID: "42"})
		c.Next()
	})
	router.POST("/orders", h.CreateOrder)
	req := httptest.NewRequest(http.MethodPost, "/orders", strings.NewReader(`{"amount":10,"payment_type":"alipay","request_id":"message-1","user_id":123,"binding_id":456}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	require.Equal(t, http.StatusCreated, rec.Code)
	require.Equal(t, int64(7), stub.created.UserID)
	require.Equal(t, int64(9), stub.created.BindingID)
	require.Equal(t, "42", stub.created.ExternalID)
}

func TestBotRechargeHandlerRequiresMatchingBindingContext(t *testing.T) {
	gin.SetMode(gin.TestMode)
	stub := &botRechargeHandlerStub{}
	h := &BotRechargeHandler{recharge: stub}
	router := gin.New()
	router.Use(func(c *gin.Context) {
		c.Set(string(middleware.ContextKeyUser), middleware.AuthSubject{UserID: 7})
		c.Set(string(middleware.ContextKeyBotBinding), &service.BotBinding{ID: 9, UserID: 8, Platform: "qq", ExternalID: "42"})
		c.Next()
	})
	router.POST("/orders", h.CreateOrder)
	req := httptest.NewRequest(http.MethodPost, "/orders", strings.NewReader(`{"amount":10,"payment_type":"alipay","request_id":"message-1"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	require.Equal(t, http.StatusUnauthorized, rec.Code)
	require.Zero(t, stub.createCalls)
}

func TestBotRechargeHandlerQueriesOnlyAuthenticatedUser(t *testing.T) {
	gin.SetMode(gin.TestMode)
	stub := &botRechargeHandlerStub{}
	h := &BotRechargeHandler{recharge: stub}
	router := gin.New()
	router.Use(func(c *gin.Context) {
		c.Set(string(middleware.ContextKeyUser), middleware.AuthSubject{UserID: 7})
		c.Next()
	})
	router.GET("/orders/:id", h.GetOrder)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/orders/51?user_id=123", nil))
	require.Equal(t, http.StatusOK, rec.Code)
	require.Equal(t, int64(7), stub.userID)
	require.Equal(t, int64(51), stub.orderID)
}
