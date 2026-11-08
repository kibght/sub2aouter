package middleware

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

type stubBotTokenAuthenticator struct {
	binding  *service.BotBinding
	err      error
	gotToken string

	revokedID     int64
	revokedUserID int64
}

func (s *stubBotTokenAuthenticator) Authenticate(_ context.Context, token string) (*service.BotBinding, error) {
	s.gotToken = token
	if s.err != nil {
		return nil, s.err
	}
	return s.binding, nil
}

func (s *stubBotTokenAuthenticator) RevokeBinding(_ context.Context, userID, bindingID int64) error {
	s.revokedUserID = userID
	s.revokedID = bindingID
	return nil
}

type stubBotUserReader struct {
	user *service.User
	err  error
}

func (s *stubBotUserReader) GetByID(_ context.Context, _ int64) (*service.User, error) {
	if s.err != nil {
		return nil, s.err
	}
	return s.user, nil
}

func newBotAuthTestRouter(authenticator botTokenAuthenticator, users jwtUserReader) *gin.Engine {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.Use(botAuth(authenticator, users))
	router.GET("/bot/profile", func(c *gin.Context) {
		subject, ok := GetAuthSubjectFromContext(c)
		binding, hasBinding := GetBotBindingFromContext(c)
		if !ok || !hasBinding {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "missing context"})
			return
		}
		c.JSON(http.StatusOK, gin.H{
			"user_id":    subject.UserID,
			"binding_id": binding.ID,
			"role":       c.GetString(string(ContextKeyUserRole)),
		})
	})
	return router
}

func performBotAuthRequest(router *gin.Engine, authorization string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, "/bot/profile", nil)
	if authorization != "" {
		req.Header.Set("Authorization", authorization)
	}
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	return rec
}

func TestBotAuthRejectsMissingOrForeignScheme(t *testing.T) {
	authenticator := &stubBotTokenAuthenticator{binding: &service.BotBinding{ID: 1, UserID: 2}}
	router := newBotAuthTestRouter(authenticator, &stubBotUserReader{user: &service.User{ID: 2, Status: service.StatusActive}})

	rec := performBotAuthRequest(router, "")
	require.Equal(t, http.StatusUnauthorized, rec.Code)
	require.Contains(t, rec.Body.String(), "UNAUTHORIZED")

	rec = performBotAuthRequest(router, "Bearer bt_token")
	require.Equal(t, http.StatusUnauthorized, rec.Code)
	require.Contains(t, rec.Body.String(), "INVALID_AUTH_HEADER")

	rec = performBotAuthRequest(router, "Bot   ")
	require.Equal(t, http.StatusUnauthorized, rec.Code)
	require.Contains(t, rec.Body.String(), "EMPTY_TOKEN")
	require.Empty(t, authenticator.gotToken)
}

func TestBotAuthRejectsUnknownToken(t *testing.T) {
	authenticator := &stubBotTokenAuthenticator{err: service.ErrBotBindingInvalid}
	router := newBotAuthTestRouter(authenticator, &stubBotUserReader{})

	rec := performBotAuthRequest(router, "Bot bt_unknown")
	require.Equal(t, http.StatusUnauthorized, rec.Code)
	require.Contains(t, rec.Body.String(), "BOT_BINDING_INVALID")
}

func TestBotAuthRejectsInactiveUser(t *testing.T) {
	authenticator := &stubBotTokenAuthenticator{binding: &service.BotBinding{ID: 1, UserID: 2}}
	router := newBotAuthTestRouter(authenticator, &stubBotUserReader{
		user: &service.User{ID: 2, Status: "suspended"},
	})

	rec := performBotAuthRequest(router, "Bot bt_token")
	require.Equal(t, http.StatusUnauthorized, rec.Code)
	require.Contains(t, rec.Body.String(), "USER_INACTIVE")
}

func TestBotAuthRejectsCredentialChange(t *testing.T) {
	authenticator := &stubBotTokenAuthenticator{binding: &service.BotBinding{ID: 1, UserID: 2, UserTokenVersion: 11}}
	router := newBotAuthTestRouter(authenticator, &stubBotUserReader{
		user: &service.User{ID: 2, Status: service.StatusActive, TokenVersion: 12},
	})

	rec := performBotAuthRequest(router, "Bot bt_token")
	require.Equal(t, http.StatusUnauthorized, rec.Code)
	require.Contains(t, rec.Body.String(), "TOKEN_REVOKED")
	// 失效绑定应被顺手吊销，避免占用该账号的生效绑定名额。
	require.Equal(t, int64(1), authenticator.revokedID)
	require.Equal(t, int64(2), authenticator.revokedUserID)
}

func TestBotAuthTreatsUserStorageFailureAsUnavailable(t *testing.T) {
	authenticator := &stubBotTokenAuthenticator{binding: &service.BotBinding{ID: 1, UserID: 2}}
	router := newBotAuthTestRouter(authenticator, &stubBotUserReader{err: errors.New("database is down")})

	rec := performBotAuthRequest(router, "Bot bt_token")
	// 存储故障不能伪装成"令牌失效"：插件收到 401 会清掉用户的本地绑定。
	require.Equal(t, http.StatusServiceUnavailable, rec.Code)
	require.Contains(t, rec.Body.String(), "USER_UNAVAILABLE")
}

func TestBotAuthRejectsDeletedUser(t *testing.T) {
	authenticator := &stubBotTokenAuthenticator{binding: &service.BotBinding{ID: 1, UserID: 2}}
	router := newBotAuthTestRouter(authenticator, &stubBotUserReader{err: service.ErrUserNotFound})

	rec := performBotAuthRequest(router, "Bot bt_token")
	require.Equal(t, http.StatusUnauthorized, rec.Code)
	require.Contains(t, rec.Body.String(), "USER_NOT_FOUND")
}

func TestBotAuthAllowsValidBinding(t *testing.T) {
	authenticator := &stubBotTokenAuthenticator{binding: &service.BotBinding{ID: 9, UserID: 2, UserTokenVersion: 12}}
	router := newBotAuthTestRouter(authenticator, &stubBotUserReader{
		user: &service.User{ID: 2, Status: service.StatusActive, TokenVersion: 12, Role: service.RoleAdmin, Concurrency: 3},
	})

	rec := performBotAuthRequest(router, "bot bt_valid")
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.Equal(t, "bt_valid", authenticator.gotToken)
	require.JSONEq(t, `{"user_id":2,"binding_id":9,"role":"admin"}`, rec.Body.String())
}

func TestBotAuthFailsClosedWithoutDependencies(t *testing.T) {
	router := newBotAuthTestRouter(nil, nil)

	rec := performBotAuthRequest(router, "Bot bt_token")
	require.Equal(t, http.StatusServiceUnavailable, rec.Code)
	require.Contains(t, rec.Body.String(), "BOT_BINDING_UNAVAILABLE")
}
