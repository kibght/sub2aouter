package handler

import (
	"context"
	"strconv"
	"strings"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/pkg/pagination"
	"github.com/Wei-Shaw/sub2api/internal/pkg/response"
	"github.com/Wei-Shaw/sub2api/internal/pkg/timezone"
	"github.com/Wei-Shaw/sub2api/internal/pkg/usagestats"
	middleware2 "github.com/Wei-Shaw/sub2api/internal/server/middleware"
	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/gin-gonic/gin"
)

// 机器人接口面向聊天插件，返回体刻意收窄：只给出插件展示所需的字段，
// 且绝不回显 API Key、密码等完整凭据。

type botBindingManager interface {
	CreateCode(ctx context.Context, userID int64) (*service.BotBindingCode, error)
	Redeem(ctx context.Context, code, platform, externalID string) (*service.BotBindingClaim, error)
	ListBindings(ctx context.Context, userID int64) ([]service.BotBinding, error)
	RevokeBinding(ctx context.Context, userID, bindingID int64) error
	RevokeCurrentBinding(ctx context.Context, binding *service.BotBinding) error
}

type botUsageReader interface {
	GetStatsWithFilters(ctx context.Context, filters usagestats.UsageLogFilters) (*usagestats.UsageStats, error)
}

type botAPIKeyReader interface {
	List(ctx context.Context, userID int64, params pagination.PaginationParams, filters service.APIKeyListFilters) ([]service.APIKey, *pagination.PaginationResult, error)
}

type botUserReader interface {
	GetByID(ctx context.Context, id int64) (*service.User, error)
}

// BotHandler 处理网站侧绑定码管理接口与聊天机器人的只读接口。
type BotHandler struct {
	bindings            botBindingManager
	balanceNotifyQQRepo service.BalanceNotifyQQRepository
	usage               botUsageReader
	apiKeys             botAPIKeyReader
	users               botUserReader
}

func (h *BotHandler) SetBalanceNotifyQQRepository(repo service.BalanceNotifyQQRepository) {
	h.balanceNotifyQQRepo = repo
}

// NewBotHandler 创建机器人接口处理器。
func NewBotHandler(
	bindings botBindingManager,
	usage botUsageReader,
	apiKeys botAPIKeyReader,
	users botUserReader,
) *BotHandler {
	return &BotHandler{bindings: bindings, usage: usage, apiKeys: apiKeys, users: users}
}

type botBindingCodeResponse struct {
	Code             string    `json:"code"`
	ExpiresAt        time.Time `json:"expires_at"`
	ExpiresInSeconds int64     `json:"expires_in_seconds"`
	Command          string    `json:"command"`
}

type botBindingItem struct {
	ID          int64      `json:"id"`
	Platform    string     `json:"platform"`
	ExternalID  string     `json:"external_id"`
	TokenPrefix string     `json:"token_prefix"`
	BoundAt     time.Time  `json:"bound_at"`
	LastUsedAt  *time.Time `json:"last_used_at"`
	CreatedAt   time.Time  `json:"created_at"`
}

type botBindingClaimUser struct {
	ID       int64  `json:"id"`
	Email    string `json:"email"`
	Username string `json:"username"`
}

type botBindingClaimResponse struct {
	TokenType   string              `json:"token_type"`
	BotToken    string              `json:"bot_token"`
	TokenPrefix string              `json:"token_prefix"`
	Platform    string              `json:"platform"`
	ExternalID  string              `json:"external_id"`
	BoundAt     time.Time           `json:"bound_at"`
	User        botBindingClaimUser `json:"user"`
}

type botProfileResponse struct {
	ID          int64     `json:"id"`
	Email       string    `json:"email"`
	Username    string    `json:"username"`
	Concurrency int       `json:"concurrency"`
	Status      string    `json:"status"`
	CreatedAt   time.Time `json:"created_at"`
}

type botAPIKeyItem struct {
	ID          int64      `json:"id"`
	Name        string     `json:"name"`
	KeyMasked   string     `json:"key_masked"`
	KeyPrefix   string     `json:"key_prefix"`
	Status      string     `json:"status"`
	GroupID     *int64     `json:"group_id"`
	Quota       float64    `json:"quota"`
	QuotaUsed   float64    `json:"quota_used"`
	ExpiresAt   *time.Time `json:"expires_at"`
	LastUsedAt  *time.Time `json:"last_used_at"`
	CreatedAt   time.Time  `json:"created_at"`
	RateLimit5h float64    `json:"rate_limit_5h"`
	RateLimit1d float64    `json:"rate_limit_1d"`
	RateLimit7d float64    `json:"rate_limit_7d"`
	Usage5h     float64    `json:"usage_5h"`
	Usage1d     float64    `json:"usage_1d"`
	Usage7d     float64    `json:"usage_7d"`
}

type redeemBotBindingRequest struct {
	Code       string `json:"code" binding:"required"`
	Platform   string `json:"platform" binding:"required"`
	ExternalID string `json:"external_id" binding:"required"`
}

// CreateBindingCode 生成网站机器人绑定码。
// POST /api/v1/user/bot-bindings/code
func (h *BotHandler) CreateBindingCode(c *gin.Context) {
	if h == nil || h.bindings == nil {
		response.InternalError(c, "Bot binding service is not available")
		return
	}
	subject, ok := middleware2.GetAuthSubjectFromContext(c)
	if !ok {
		response.Unauthorized(c, "User not authenticated")
		return
	}

	code, err := h.bindings.CreateCode(c.Request.Context(), subject.UserID)
	if err != nil {
		response.ErrorFrom(c, err)
		return
	}

	expiresIn := int64(time.Until(code.ExpiresAt).Seconds())
	if expiresIn < 0 {
		expiresIn = 0
	}
	response.Success(c, botBindingCodeResponse{
		Code:             code.Code,
		ExpiresAt:        code.ExpiresAt.UTC(),
		ExpiresInSeconds: expiresIn,
		Command:          "/绑定账号 " + code.Code,
	})
}

// ListBindings 列出当前用户生效的机器人绑定。
// GET /api/v1/user/bot-bindings
func (h *BotHandler) ListBindings(c *gin.Context) {
	if h == nil || h.bindings == nil {
		response.InternalError(c, "Bot binding service is not available")
		return
	}
	subject, ok := middleware2.GetAuthSubjectFromContext(c)
	if !ok {
		response.Unauthorized(c, "User not authenticated")
		return
	}

	bindings, err := h.bindings.ListBindings(c.Request.Context(), subject.UserID)
	if err != nil {
		response.ErrorFrom(c, err)
		return
	}

	items := make([]botBindingItem, 0, len(bindings))
	for i := range bindings {
		binding := bindings[i]
		items = append(items, botBindingItem{
			ID:          binding.ID,
			Platform:    binding.Platform,
			ExternalID:  binding.ExternalID,
			TokenPrefix: binding.TokenPrefix,
			BoundAt:     binding.BoundAt.UTC(),
			LastUsedAt:  utcTimePtr(binding.LastUsedAt),
			CreatedAt:   binding.CreatedAt.UTC(),
		})
	}
	response.Success(c, gin.H{"items": items})
}

// RevokeBinding 解除指定机器人绑定。
// DELETE /api/v1/user/bot-bindings/:id
func (h *BotHandler) RevokeBinding(c *gin.Context) {
	if h == nil || h.bindings == nil {
		response.InternalError(c, "Bot binding service is not available")
		return
	}
	subject, ok := middleware2.GetAuthSubjectFromContext(c)
	if !ok {
		response.Unauthorized(c, "User not authenticated")
		return
	}
	bindingID, err := strconv.ParseInt(strings.TrimSpace(c.Param("id")), 10, 64)
	if err != nil || bindingID <= 0 {
		response.BadRequest(c, "Invalid binding id")
		return
	}

	if err := h.bindings.RevokeBinding(c.Request.Context(), subject.UserID, bindingID); err != nil {
		response.ErrorFrom(c, err)
		return
	}
	response.Success(c, gin.H{"revoked": true})
}

// Redeem 用绑定码兑换机器人令牌（公开接口，由聊天插件调用）。
// POST /api/v1/bot-bindings/redeem
func (h *BotHandler) Redeem(c *gin.Context) {
	if h == nil || h.bindings == nil {
		response.InternalError(c, "Bot binding service is not available")
		return
	}
	var req redeemBotBindingRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.BadRequest(c, "Invalid request: "+err.Error())
		return
	}

	claim, err := h.bindings.Redeem(c.Request.Context(), req.Code, req.Platform, req.ExternalID)
	if err != nil {
		response.ErrorFrom(c, err)
		return
	}

	claimUser := botBindingClaimUser{ID: claim.UserID}
	if h.users != nil {
		if user, userErr := h.users.GetByID(c.Request.Context(), claim.UserID); userErr == nil && user != nil {
			claimUser.ID = user.ID
			claimUser.Email = maskBotEmail(user.Email)
			claimUser.Username = user.Username
		}
	}

	response.Success(c, botBindingClaimResponse{
		TokenType:   "bot",
		BotToken:    claim.Token,
		TokenPrefix: claim.TokenPrefix,
		Platform:    claim.Platform,
		ExternalID:  claim.ExternalID,
		BoundAt:     claim.BoundAt.UTC(),
		User:        claimUser,
	})
}

// Unbind 撤销当前令牌对应的绑定。
// POST /api/v1/bot/unbind
func (h *BotHandler) Unbind(c *gin.Context) {
	if h == nil || h.bindings == nil {
		response.InternalError(c, "Bot binding service is not available")
		return
	}
	binding, ok := middleware2.GetBotBindingFromContext(c)
	if !ok || binding == nil {
		response.Unauthorized(c, "Bot binding is not authenticated")
		return
	}
	if err := h.bindings.RevokeCurrentBinding(c.Request.Context(), binding); err != nil {
		response.ErrorFrom(c, err)
		return
	}
	response.Success(c, gin.H{"revoked": true})
}

// BalanceLowAlerts claims queued QQ balance alerts for the authenticated binding.
func (h *BotHandler) BalanceLowAlerts(c *gin.Context) {
	if h == nil || h.balanceNotifyQQRepo == nil {
		response.InternalError(c, "QQ balance notification service is not available")
		return
	}
	binding, ok := middleware2.GetBotBindingFromContext(c)
	if !ok || binding == nil {
		response.Unauthorized(c, "Bot binding is not authenticated")
		return
	}
	if binding.Platform != "qq" {
		response.Forbidden(c, "QQ balance alerts require a QQ binding")
		return
	}

	now := time.Now().UTC()
	alerts, err := h.balanceNotifyQQRepo.ClaimBalanceLow(
		c.Request.Context(), binding.UserID, binding.ID, now, now.Add(2*time.Minute), 20,
	)
	if err != nil {
		response.InternalError(c, "Failed to claim QQ balance alerts")
		return
	}
	response.Success(c, gin.H{"items": alerts})
}

// AckBalanceLowAlert removes one alert after the bot confirms the private message was sent.
func (h *BotHandler) AckBalanceLowAlert(c *gin.Context) {
	if h == nil || h.balanceNotifyQQRepo == nil {
		response.InternalError(c, "QQ balance notification service is not available")
		return
	}
	binding, ok := middleware2.GetBotBindingFromContext(c)
	if !ok || binding == nil {
		response.Unauthorized(c, "Bot binding is not authenticated")
		return
	}
	if binding.Platform != "qq" {
		response.Forbidden(c, "QQ balance alerts require a QQ binding")
		return
	}
	alertID, err := strconv.ParseInt(strings.TrimSpace(c.Param("id")), 10, 64)
	if err != nil || alertID <= 0 {
		response.BadRequest(c, "Invalid alert id")
		return
	}
	if err := h.balanceNotifyQQRepo.AckBalanceLow(c.Request.Context(), binding.UserID, binding.ID, alertID); err != nil {
		response.InternalError(c, "Failed to acknowledge QQ balance alert")
		return
	}
	response.Success(c, gin.H{"acknowledged": true})
}

// Profile 返回绑定账号的基础资料（邮箱脱敏）。
// GET /api/v1/bot/profile
func (h *BotHandler) Profile(c *gin.Context) {
	if h == nil || h.users == nil {
		response.InternalError(c, "User service is not available")
		return
	}
	subject, ok := middleware2.GetAuthSubjectFromContext(c)
	if !ok {
		response.Unauthorized(c, "User not authenticated")
		return
	}
	user, err := h.users.GetByID(c.Request.Context(), subject.UserID)
	if err != nil {
		response.ErrorFrom(c, err)
		return
	}
	response.Success(c, botProfileResponse{
		ID:          user.ID,
		Email:       maskBotEmail(user.Email),
		Username:    user.Username,
		Concurrency: user.Concurrency,
		Status:      user.Status,
		CreatedAt:   user.CreatedAt.UTC(),
	})
}

// APIKeys 返回绑定账号的 API Key 元数据（只返回脱敏后的前缀）。
// GET /api/v1/bot/api-keys
func (h *BotHandler) APIKeys(c *gin.Context) {
	if h == nil || h.apiKeys == nil {
		response.InternalError(c, "API key service is not available")
		return
	}
	subject, ok := middleware2.GetAuthSubjectFromContext(c)
	if !ok {
		response.Unauthorized(c, "User not authenticated")
		return
	}

	page, pageSize := response.ParsePagination(c)
	if pageSize > 100 {
		pageSize = 100
	}
	keys, result, err := h.apiKeys.List(c.Request.Context(), subject.UserID, pagination.PaginationParams{
		Page:      page,
		PageSize:  pageSize,
		SortBy:    "created_at",
		SortOrder: pagination.SortOrderDesc,
	}, service.APIKeyListFilters{})
	if err != nil {
		response.ErrorFrom(c, err)
		return
	}

	items := make([]botAPIKeyItem, 0, len(keys))
	for i := range keys {
		key := keys[i]
		masked, prefix := maskBotAPIKey(key.Key)
		items = append(items, botAPIKeyItem{
			ID:          key.ID,
			Name:        key.Name,
			KeyMasked:   masked,
			KeyPrefix:   prefix,
			Status:      key.Status,
			GroupID:     key.GroupID,
			Quota:       key.Quota,
			QuotaUsed:   key.QuotaUsed,
			ExpiresAt:   utcTimePtr(key.ExpiresAt),
			LastUsedAt:  utcTimePtr(key.LastUsedAt),
			CreatedAt:   key.CreatedAt.UTC(),
			RateLimit5h: key.RateLimit5h,
			RateLimit1d: key.RateLimit1d,
			RateLimit7d: key.RateLimit7d,
			Usage5h:     key.Usage5h,
			Usage1d:     key.Usage1d,
			Usage7d:     key.Usage7d,
		})
	}

	total := int64(len(items))
	if result != nil {
		total = result.Total
	}
	response.Paginated(c, items, total, page, pageSize)
}

// UsageStats 按周期返回绑定账号的用量统计。
// GET /api/v1/bot/usage/stats?period=month&timezone=Asia/Shanghai
func (h *BotHandler) UsageStats(c *gin.Context) {
	if h == nil || h.usage == nil {
		response.InternalError(c, "Usage service is not available")
		return
	}
	subject, ok := middleware2.GetAuthSubjectFromContext(c)
	if !ok {
		response.Unauthorized(c, "User not authenticated")
		return
	}

	userTZ := strings.TrimSpace(c.Query("timezone"))
	period := strings.ToLower(strings.TrimSpace(c.DefaultQuery("period", "month")))
	now := timezone.NowInUserLocation(userTZ)

	var startTime time.Time
	hasStart := true
	switch period {
	case "", "month":
		startTime = now.AddDate(0, -1, 0)
	case "today":
		startTime = timezone.StartOfDayInUserLocation(now, userTZ)
	case "week", "7d":
		startTime = now.AddDate(0, 0, -7)
	case "30d":
		startTime = now.AddDate(0, 0, -30)
	case "all":
		hasStart = false
	default:
		response.BadRequest(c, "Invalid period, allowed values are today, week, month, 7d, 30d, all")
		return
	}
	endTime := now

	filters := usagestats.UsageLogFilters{UserID: subject.UserID}
	if hasStart {
		start := startTime
		filters.StartTime = &start
	}
	end := endTime
	filters.EndTime = &end

	stats, err := h.usage.GetStatsWithFilters(c.Request.Context(), filters)
	if err != nil {
		response.ErrorFrom(c, err)
		return
	}
	// 与用户端 /usage/stats 口径保持一致：机器人接口不下发内部成本与端点明细。
	stats.TotalAccountCost = nil
	stats.UpstreamEndpoints = nil
	stats.EndpointPaths = nil
	response.Success(c, stats)
}

func utcTimePtr(value *time.Time) *time.Time {
	if value == nil {
		return nil
	}
	utc := value.UTC()
	return &utc
}

// maskBotAPIKey 生成可安全展示的 Key 前缀，绝不回显完整密钥。
func maskBotAPIKey(key string) (masked string, prefix string) {
	trimmed := strings.TrimSpace(key)
	if trimmed == "" {
		return "", ""
	}
	if len(trimmed) <= 8 {
		return "***", "***"
	}
	head := 6
	tail := 4
	if len(trimmed) < head+tail+3 {
		visible := len(trimmed) / 2
		return trimmed[:visible] + "***", trimmed[:visible] + "***"
	}
	return trimmed[:head] + "***" + trimmed[len(trimmed)-tail:], trimmed[:head] + "***"
}

// maskBotEmail 邮箱脱敏：保留域名，只展示首字母。
func maskBotEmail(email string) string {
	trimmed := strings.TrimSpace(email)
	at := strings.LastIndex(trimmed, "@")
	if at <= 0 {
		if trimmed == "" {
			return ""
		}
		return "***"
	}
	// 按 rune 截断：邮箱本地部分可能包含中文等多字节字符，按字节切会破坏 UTF-8。
	local := []rune(trimmed[:at])
	domain := trimmed[at:]
	if len(local) == 0 {
		return "***" + domain
	}
	return string(local[0]) + "***" + domain
}
