package middleware

import (
	"context"
	"strings"

	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/gin-gonic/gin"
)

// ContextKeyBotBinding 机器人令牌绑定上下文键（*service.BotBinding）。
const ContextKeyBotBinding ContextKey = "bot_binding"

// BotAuthMiddleware 机器人令牌认证中间件类型。
type BotAuthMiddleware gin.HandlerFunc

// NewBotAuthMiddleware 创建机器人令牌认证中间件。
// 聊天插件使用 "Authorization: Bot <token>"，与面板的 Bearer JWT 完全分离。
func NewBotAuthMiddleware(botBindingService *service.BotBindingService, userService *service.UserService) BotAuthMiddleware {
	return BotAuthMiddleware(botAuth(botBindingService, userService))
}

type botTokenAuthenticator interface {
	Authenticate(ctx context.Context, token string) (*service.BotBinding, error)
	RevokeBinding(ctx context.Context, userID, bindingID int64) error
}

// botAuth 机器人令牌认证实现：校验令牌、加载用户并写入与会话认证一致的上下文。
func botAuth(authenticator botTokenAuthenticator, users jwtUserReader) gin.HandlerFunc {
	return func(c *gin.Context) {
		authHeader := c.GetHeader("Authorization")
		if strings.TrimSpace(authHeader) == "" {
			AbortWithError(c, 401, "UNAUTHORIZED", "Authorization header is required")
			return
		}
		parts := strings.SplitN(authHeader, " ", 2)
		if len(parts) != 2 || !strings.EqualFold(strings.TrimSpace(parts[0]), "Bot") {
			AbortWithError(c, 401, "INVALID_AUTH_HEADER", "Authorization header format must be 'Bot {token}'")
			return
		}
		token := strings.TrimSpace(parts[1])
		if token == "" {
			AbortWithError(c, 401, "EMPTY_TOKEN", "Token cannot be empty")
			return
		}
		if authenticator == nil || users == nil {
			AbortWithError(c, 503, "BOT_BINDING_UNAVAILABLE", "Bot binding is not available")
			return
		}

		binding, err := authenticator.Authenticate(c.Request.Context(), token)
		if err != nil {
			// 令牌本身无效返回 401（插件据此清空本地绑定）；存储异常返回 503，避免误判为解绑。
			if infraerrors.Code(err) == 401 {
				AbortWithError(c, 401, "BOT_BINDING_INVALID", "Bot binding token is invalid or revoked")
				return
			}
			AbortWithError(c, 503, "BOT_BINDING_UNAVAILABLE", "Bot binding storage is unavailable")
			return
		}
		if binding == nil {
			AbortWithError(c, 401, "BOT_BINDING_INVALID", "Bot binding token is invalid or revoked")
			return
		}

		user, err := users.GetByID(c.Request.Context(), binding.UserID)
		if err != nil {
			// 账号不存在/已删除 → 401（插件据此清空本地绑定）；数据库等存储异常 → 503，
			// 避免把暂时故障当成"绑定失效"而迫使用户重新绑定。
			if infraerrors.Code(err) == 404 {
				AbortWithError(c, 401, "USER_NOT_FOUND", "User not found")
				return
			}
			AbortWithError(c, 503, "USER_UNAVAILABLE", "User storage is unavailable")
			return
		}
		if user == nil {
			AbortWithError(c, 401, "USER_NOT_FOUND", "User not found")
			return
		}
		if !user.IsActive() {
			AbortWithError(c, 401, "USER_INACTIVE", "User account is not active")
			return
		}
		// 绑定令牌同样受密码变更影响：TokenVersion 不一致说明密码已更换，需要重新绑定。
		if user.TokenVersion != binding.UserTokenVersion {
			// 顺手吊销这条已经失效的绑定，避免它长期占用该账号的生效绑定名额。
			if authenticator != nil {
				_ = authenticator.RevokeBinding(c.Request.Context(), binding.UserID, binding.ID)
			}
			AbortWithError(c, 401, "TOKEN_REVOKED", "Bot binding has been revoked (account credential changed)")
			return
		}

		c.Set(string(ContextKeyUser), AuthSubject{
			UserID:      user.ID,
			Concurrency: user.Concurrency,
		})
		c.Set(string(ContextKeyUserRole), user.Role)
		c.Set(ContextKeyAuthEmail, user.Email)
		c.Set(string(ContextKeyBotBinding), binding)

		c.Next()
	}
}

// GetBotBindingFromContext 读取当前请求的机器人绑定。
func GetBotBindingFromContext(c *gin.Context) (*service.BotBinding, bool) {
	value, exists := c.Get(string(ContextKeyBotBinding))
	if !exists {
		return nil, false
	}
	binding, ok := value.(*service.BotBinding)
	return binding, ok
}
