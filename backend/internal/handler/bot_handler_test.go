package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/Wei-Shaw/sub2api/internal/pkg/pagination"
	"github.com/Wei-Shaw/sub2api/internal/pkg/usagestats"
	middleware2 "github.com/Wei-Shaw/sub2api/internal/server/middleware"
	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

type stubBotBindings struct {
	code       *service.BotBindingCode
	codeErr    error
	claim      *service.BotBindingClaim
	redeemErr  error
	items      []service.BotBinding
	listErr    error
	revokedID  int64
	revokedFor int64
	revokeErr  error
	current    *service.BotBinding
}

func (s *stubBotBindings) CreateCode(_ context.Context, _ int64) (*service.BotBindingCode, error) {
	return s.code, s.codeErr
}

func (s *stubBotBindings) Redeem(_ context.Context, _, _, _ string) (*service.BotBindingClaim, error) {
	return s.claim, s.redeemErr
}

func (s *stubBotBindings) ListBindings(_ context.Context, _ int64) ([]service.BotBinding, error) {
	return s.items, s.listErr
}

func (s *stubBotBindings) RevokeBinding(_ context.Context, userID, bindingID int64) error {
	s.revokedFor = userID
	s.revokedID = bindingID
	return s.revokeErr
}

func (s *stubBotBindings) RevokeCurrentBinding(_ context.Context, binding *service.BotBinding) error {
	s.current = binding
	return s.revokeErr
}

type stubBotUsage struct {
	stats   *usagestats.UsageStats
	err     error
	filters usagestats.UsageLogFilters
}

func (s *stubBotUsage) GetStatsWithFilters(_ context.Context, filters usagestats.UsageLogFilters) (*usagestats.UsageStats, error) {
	s.filters = filters
	if s.err != nil {
		return nil, s.err
	}
	if s.stats != nil {
		return s.stats, nil
	}
	return &usagestats.UsageStats{}, nil
}

type stubBotAPIKeys struct {
	keys   []service.APIKey
	result *pagination.PaginationResult
	err    error
}

func (s *stubBotAPIKeys) List(_ context.Context, _ int64, params pagination.PaginationParams, _ service.APIKeyListFilters) ([]service.APIKey, *pagination.PaginationResult, error) {
	if s.err != nil {
		return nil, nil, s.err
	}
	result := s.result
	if result == nil {
		result = &pagination.PaginationResult{Total: int64(len(s.keys)), Page: params.Page, PageSize: params.PageSize}
	}
	return s.keys, result, nil
}

type stubBotUsers struct {
	user *service.User
	err  error
}

type stubBalanceNotifyQQRepo struct {
	alerts       []service.BalanceLowQQAlert
	claimUserID  int64
	claimBinding int64
	claimErr     error
	ackUserID    int64
	ackBinding   int64
	ackAlertID   int64
	ackErr       error
}

func (s *stubBalanceNotifyQQRepo) EnqueueBalanceLow(context.Context, int64, service.BalanceLowQQAlert) error {
	return nil
}
func (s *stubBalanceNotifyQQRepo) HasActiveQQBinding(context.Context, int64) (bool, error) {
	return true, nil
}
func (s *stubBalanceNotifyQQRepo) GetQQBalanceNotifyEnabled(context.Context, int64) (bool, error) {
	return false, nil
}
func (s *stubBalanceNotifyQQRepo) SetQQBalanceNotifyEnabled(context.Context, int64, bool) error {
	return nil
}
func (s *stubBalanceNotifyQQRepo) ClaimBalanceLow(_ context.Context, userID, bindingID int64, _, _ time.Time, _ int) ([]service.BalanceLowQQAlert, error) {
	s.claimUserID = userID
	s.claimBinding = bindingID
	return s.alerts, s.claimErr
}
func (s *stubBalanceNotifyQQRepo) AckBalanceLow(_ context.Context, userID, bindingID, alertID int64) error {
	s.ackUserID = userID
	s.ackBinding = bindingID
	s.ackAlertID = alertID
	return s.ackErr
}

func (s *stubBotUsers) GetByID(_ context.Context, _ int64) (*service.User, error) {
	if s.err != nil {
		return nil, s.err
	}
	return s.user, nil
}

type botTestRouterOptions struct {
	handler  *BotHandler
	userID   int64
	binding  *service.BotBinding
	withAuth bool
}

func newBotTestRouter(opts botTestRouterOptions) *gin.Engine {
	gin.SetMode(gin.TestMode)
	router := gin.New()

	attachAuth := func(c *gin.Context) {
		if !opts.withAuth {
			c.Next()
			return
		}
		c.Set(string(middleware2.ContextKeyUser), middleware2.AuthSubject{UserID: opts.userID, Concurrency: 1})
		if opts.binding != nil {
			c.Set(string(middleware2.ContextKeyBotBinding), opts.binding)
		}
		c.Next()
	}

	user := router.Group("/user", attachAuth)
	user.POST("/bot-bindings/code", opts.handler.CreateBindingCode)
	user.GET("/bot-bindings", opts.handler.ListBindings)
	user.DELETE("/bot-bindings/:id", opts.handler.RevokeBinding)

	bot := router.Group("/bot", attachAuth)
	bot.GET("/profile", opts.handler.Profile)
	bot.POST("/unbind", opts.handler.Unbind)
	bot.GET("/api-keys", opts.handler.APIKeys)
	bot.GET("/usage/stats", opts.handler.UsageStats)
	bot.GET("/balance-alerts", opts.handler.BalanceLowAlerts)
	bot.POST("/balance-alerts/:id/ack", opts.handler.AckBalanceLowAlert)

	router.POST("/bot-bindings/redeem", opts.handler.Redeem)
	return router
}

func TestBotHandlerClaimsQQBalanceAlertsForAuthenticatedBinding(t *testing.T) {
	queue := &stubBalanceNotifyQQRepo{alerts: []service.BalanceLowQQAlert{{ID: 8, Balance: 2, Threshold: 5, SiteName: "Example"}}}
	h := NewBotHandler(&stubBotBindings{}, &stubBotUsage{}, &stubBotAPIKeys{}, &stubBotUsers{})
	h.SetBalanceNotifyQQRepository(queue)
	router := newBotTestRouter(botTestRouterOptions{
		handler: h, userID: 7, binding: &service.BotBinding{ID: 11, UserID: 7, Platform: "qq"}, withAuth: true,
	})

	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/bot/balance-alerts", nil))

	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.Equal(t, int64(7), queue.claimUserID)
	require.Equal(t, int64(11), queue.claimBinding)
	data := decodeBotData(t, rec)
	items, ok := data["items"].([]any)
	require.True(t, ok)
	require.Len(t, items, 1)
	item, ok := items[0].(map[string]any)
	require.True(t, ok)
	require.Equal(t, float64(8), item["id"])
	require.Equal(t, float64(2), item["current_balance"])
}

func TestBotHandlerAckScopesAlertToAuthenticatedQQBinding(t *testing.T) {
	queue := &stubBalanceNotifyQQRepo{}
	h := NewBotHandler(&stubBotBindings{}, &stubBotUsage{}, &stubBotAPIKeys{}, &stubBotUsers{})
	h.SetBalanceNotifyQQRepository(queue)
	router := newBotTestRouter(botTestRouterOptions{
		handler: h, userID: 7, binding: &service.BotBinding{ID: 11, UserID: 7, Platform: "qq"}, withAuth: true,
	})

	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/bot/balance-alerts/8/ack", nil))

	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.Equal(t, int64(7), queue.ackUserID)
	require.Equal(t, int64(11), queue.ackBinding)
	require.Equal(t, int64(8), queue.ackAlertID)
}

func TestBotHandlerBalanceAlertsRejectsNonQQBinding(t *testing.T) {
	queue := &stubBalanceNotifyQQRepo{}
	h := NewBotHandler(&stubBotBindings{}, &stubBotUsage{}, &stubBotAPIKeys{}, &stubBotUsers{})
	h.SetBalanceNotifyQQRepository(queue)
	router := newBotTestRouter(botTestRouterOptions{
		handler: h, userID: 7, binding: &service.BotBinding{ID: 11, UserID: 7, Platform: "telegram"}, withAuth: true,
	})

	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/bot/balance-alerts", nil))
	require.Equal(t, http.StatusForbidden, rec.Code)
	require.Zero(t, queue.claimBinding)
}

func decodeBotData(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var payload map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &payload), rec.Body.String())
	data, ok := payload["data"].(map[string]any)
	require.True(t, ok, rec.Body.String())
	return data
}

func TestBotHandlerCreateBindingCode(t *testing.T) {
	expiresAt := time.Now().UTC().Add(9 * time.Minute)
	h := NewBotHandler(
		&stubBotBindings{code: &service.BotBindingCode{Code: "ABCD-EFGH", ExpiresAt: expiresAt}},
		&stubBotUsage{}, &stubBotAPIKeys{}, &stubBotUsers{},
	)
	router := newBotTestRouter(botTestRouterOptions{handler: h, userID: 7, withAuth: true})

	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/user/bot-bindings/code", nil))

	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	data := decodeBotData(t, rec)
	require.Equal(t, "ABCD-EFGH", data["code"])
	require.Equal(t, "/绑定账号 ABCD-EFGH", data["command"])
	expiresIn, ok := data["expires_in_seconds"].(float64)
	require.True(t, ok)
	require.Greater(t, expiresIn, float64(0))
}

func TestBotHandlerCreateBindingCodeRequiresLogin(t *testing.T) {
	h := NewBotHandler(&stubBotBindings{}, &stubBotUsage{}, &stubBotAPIKeys{}, &stubBotUsers{})
	router := newBotTestRouter(botTestRouterOptions{handler: h})

	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/user/bot-bindings/code", nil))
	require.Equal(t, http.StatusUnauthorized, rec.Code)
}

func TestBotHandlerListBindingsReturnsItems(t *testing.T) {
	boundAt := time.Now().UTC().Add(-time.Hour)
	h := NewBotHandler(
		&stubBotBindings{items: []service.BotBinding{{
			ID: 3, UserID: 7, Platform: "qq", ExternalID: "123456", TokenPrefix: "bt_abcdef",
			BoundAt: boundAt, CreatedAt: boundAt,
		}}},
		&stubBotUsage{}, &stubBotAPIKeys{}, &stubBotUsers{},
	)
	router := newBotTestRouter(botTestRouterOptions{handler: h, userID: 7, withAuth: true})

	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/user/bot-bindings", nil))

	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	data := decodeBotData(t, rec)
	items, ok := data["items"].([]any)
	require.True(t, ok)
	require.Len(t, items, 1)
	item, ok := items[0].(map[string]any)
	require.True(t, ok)
	require.Equal(t, "qq", item["platform"])
	require.Equal(t, "123456", item["external_id"])
}

func TestBotHandlerRevokeBindingValidatesID(t *testing.T) {
	stub := &stubBotBindings{}
	h := NewBotHandler(stub, &stubBotUsage{}, &stubBotAPIKeys{}, &stubBotUsers{})
	router := newBotTestRouter(botTestRouterOptions{handler: h, userID: 7, withAuth: true})

	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodDelete, "/user/bot-bindings/abc", nil))
	require.Equal(t, http.StatusBadRequest, rec.Code)
	require.Zero(t, stub.revokedID)

	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodDelete, "/user/bot-bindings/12", nil))
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.Equal(t, int64(12), stub.revokedID)
	require.Equal(t, int64(7), stub.revokedFor)
}

func TestBotHandlerRedeemMasksUserEmail(t *testing.T) {
	boundAt := time.Now().UTC()
	h := NewBotHandler(
		&stubBotBindings{claim: &service.BotBindingClaim{
			BotBinding: service.BotBinding{ID: 4, UserID: 7, Platform: "qq", ExternalID: "123456", TokenPrefix: "bt_abcdefgh", BoundAt: boundAt},
			Token:      "bt_abcdefgh_secret",
		}},
		&stubBotUsage{}, &stubBotAPIKeys{},
		&stubBotUsers{user: &service.User{ID: 7, Email: "alice@example.com", Username: "alice"}},
	)
	router := newBotTestRouter(botTestRouterOptions{handler: h})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/bot-bindings/redeem", strings.NewReader(`{"code":"ABCD-EFGH","platform":"qq","external_id":"123456"}`))
	req.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(rec, req)

	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	data := decodeBotData(t, rec)
	require.Equal(t, "bot", data["token_type"])
	require.Equal(t, "bt_abcdefgh_secret", data["bot_token"])
	require.NotContains(t, rec.Body.String(), "alice@example.com")
	user, ok := data["user"].(map[string]any)
	require.True(t, ok)
	require.Equal(t, "a***@example.com", user["email"])
}

func TestBotHandlerRedeemRejectsInvalidPayload(t *testing.T) {
	h := NewBotHandler(&stubBotBindings{}, &stubBotUsage{}, &stubBotAPIKeys{}, &stubBotUsers{})
	router := newBotTestRouter(botTestRouterOptions{handler: h})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/bot-bindings/redeem", strings.NewReader(`{"code":""}`))
	req.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(rec, req)
	require.Equal(t, http.StatusBadRequest, rec.Code)
}

func TestBotHandlerUnbindRequiresBoundToken(t *testing.T) {
	stub := &stubBotBindings{}
	h := NewBotHandler(stub, &stubBotUsage{}, &stubBotAPIKeys{}, &stubBotUsers{})
	router := newBotTestRouter(botTestRouterOptions{handler: h, userID: 7, withAuth: true})

	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/bot/unbind", nil))
	require.Equal(t, http.StatusUnauthorized, rec.Code)
	require.Nil(t, stub.current)

	binding := &service.BotBinding{ID: 5, UserID: 7}
	router = newBotTestRouter(botTestRouterOptions{handler: h, userID: 7, binding: binding, withAuth: true})
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/bot/unbind", nil))
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.Equal(t, binding, stub.current)
}

func TestBotHandlerProfileMasksEmailAndHidesBalance(t *testing.T) {
	h := NewBotHandler(&stubBotBindings{}, &stubBotUsage{}, &stubBotAPIKeys{}, &stubBotUsers{
		user: &service.User{ID: 7, Email: "bob@example.com", Username: "bob", Balance: 12.5, FrozenBalance: 1.25, Status: service.StatusActive},
	})
	router := newBotTestRouter(botTestRouterOptions{handler: h, userID: 7, withAuth: true})

	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/bot/profile", nil))

	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	data := decodeBotData(t, rec)
	require.Equal(t, "b***@example.com", data["email"])
	require.NotContains(t, rec.Body.String(), "bob@example.com")
	// Bot 接口面向外部聊天插件，不应暴露账户余额。
	require.NotContains(t, rec.Body.String(), "balance")
	require.NotContains(t, rec.Body.String(), "frozen_balance")
	require.NotContains(t, rec.Body.String(), "12.5")
}

func TestBotHandlerAPIKeysNeverExposeFullKey(t *testing.T) {
	fullKey := "sk-test-1234567890abcdefghijklmnop"
	h := NewBotHandler(&stubBotBindings{}, &stubBotUsage{}, &stubBotAPIKeys{
		keys: []service.APIKey{{ID: 1, UserID: 7, Key: fullKey, Name: "default", Status: service.StatusActive}},
	}, &stubBotUsers{})
	router := newBotTestRouter(botTestRouterOptions{handler: h, userID: 7, withAuth: true})

	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/bot/api-keys?page=1&page_size=100", nil))

	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.NotContains(t, rec.Body.String(), fullKey)
	data := decodeBotData(t, rec)
	items, ok := data["items"].([]any)
	require.True(t, ok)
	require.Len(t, items, 1)
	item, ok := items[0].(map[string]any)
	require.True(t, ok)
	require.Contains(t, item["key_masked"], "***")
	require.NotContains(t, item["key_masked"], fullKey)
}

func TestMaskBotEmailKeepsUTF8Intact(t *testing.T) {
	require.Equal(t, "a***@example.com", maskBotEmail("alice@example.com"))
	require.Equal(t, "张***@example.com", maskBotEmail("张三@example.com"))
	require.Equal(t, "测***@例子.中国", maskBotEmail("测试用户@例子.中国"))
	require.True(t, utf8.ValidString(maskBotEmail("测试用户@例子.中国")))
	require.Equal(t, "***", maskBotEmail("no-at-sign"))
	require.Equal(t, "", maskBotEmail("   "))
}

func TestMaskBotAPIKeyNeverLeaksWholeSecret(t *testing.T) {
	full := "sk-test-1234567890abcdefghijklmnop"
	masked, prefix := maskBotAPIKey(full)
	require.NotContains(t, masked, full)
	require.Contains(t, masked, "***")
	require.Less(t, len(masked), len(full))
	require.NotContains(t, prefix, full[len(full)-4:])

	shortMasked, shortPrefix := maskBotAPIKey("sk-short")
	require.Equal(t, "***", shortMasked)
	require.Equal(t, "***", shortPrefix)

	emptyMasked, emptyPrefix := maskBotAPIKey("  ")
	require.Empty(t, emptyMasked)
	require.Empty(t, emptyPrefix)
}

func TestBotHandlerUsageStatsValidatesPeriod(t *testing.T) {
	usage := &stubBotUsage{}
	h := NewBotHandler(&stubBotBindings{}, usage, &stubBotAPIKeys{}, &stubBotUsers{})
	router := newBotTestRouter(botTestRouterOptions{handler: h, userID: 7, withAuth: true})

	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/bot/usage/stats?period=century", nil))
	require.Equal(t, http.StatusBadRequest, rec.Code)

	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/bot/usage/stats?period=month&timezone=Asia/Shanghai", nil))
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.Equal(t, int64(7), usage.filters.UserID)
	require.NotNil(t, usage.filters.StartTime)
	require.NotNil(t, usage.filters.EndTime)
	require.True(t, usage.filters.EndTime.After(*usage.filters.StartTime))
}
