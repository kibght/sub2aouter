//go:build unit

package middleware

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/pkg/adminaccess"
	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

func TestScopedAdminBotRoutesPreserveBoundUserIdentity(t *testing.T) {
	gin.SetMode(gin.TestMode)
	keyRepo := &adminAuthKeyRepo{}
	settings := service.NewSettingService(nil, nil)
	settings.SetScopedAdminKeyRepository(keyRepo)
	key, _, err := settings.CreateScopedAdminKey(context.Background(), service.ScopedAdminKeyInput{
		Name: "bot transport", Enabled: true, ConfirmFullAccess: true,
		Policy: adminaccess.Policy{FullAccess: true},
	}, 99)
	require.NoError(t, err)
	users := service.NewUserService(&stubUserRepo{getByID: func(_ context.Context, id int64) (*service.User, error) {
		return &service.User{ID: id, Role: service.RoleAdmin, Status: service.StatusActive}, nil
	}}, nil, nil, nil)
	adminMiddleware := NewAdminAuthMiddleware(nil, users, settings, nil)
	botMiddleware := botAuth(&stubBotTokenAuthenticator{
		binding: &service.BotBinding{ID: 17, UserID: 7},
	}, &stubBotUserReader{user: &service.User{
		ID: 7, Role: service.RoleUser, Status: service.StatusActive, Concurrency: 3,
	}})
	router := gin.New()
	router.POST("/api/v1/admin/bot-bindings/redeem", gin.HandlerFunc(adminMiddleware), func(c *gin.Context) {
		subject, ok := GetAuthSubjectFromContext(c)
		require.True(t, ok)
		require.Equal(t, int64(99), subject.UserID)
		c.Status(http.StatusNoContent)
	})
	router.GET("/api/v1/admin/bot/profile", gin.HandlerFunc(adminMiddleware), botMiddleware, func(c *gin.Context) {
		subject, ok := GetAuthSubjectFromContext(c)
		require.True(t, ok)
		require.Equal(t, int64(7), subject.UserID)
		require.Equal(t, 3, subject.Concurrency)
		require.Equal(t, service.RoleUser, c.GetString(string(ContextKeyUserRole)))
		binding, ok := GetBotBindingFromContext(c)
		require.True(t, ok)
		require.Equal(t, int64(17), binding.ID)
		c.Status(http.StatusNoContent)
	})
	request := func(method, path, adminKey, botHeader string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, path, nil)
		req.Header.Set("x-api-key", adminKey)
		req.Header.Set("Authorization", botHeader)
		recorder := httptest.NewRecorder()
		router.ServeHTTP(recorder, req)
		return recorder
	}
	for _, tc := range []struct {
		name, method, path, adminKey, botHeader string
		status                                  int
	}{
		{"full key and binding", "GET", "/api/v1/admin/bot/profile", key, "Bot valid", http.StatusNoContent},
		{"no admin key", "GET", "/api/v1/admin/bot/profile", "", "Bot valid", http.StatusUnauthorized},
		{"no binding", "GET", "/api/v1/admin/bot/profile", key, "", http.StatusUnauthorized},
		{"redeem with key", "POST", "/api/v1/admin/bot-bindings/redeem", key, "", http.StatusNoContent},
		{"redeem without key", "POST", "/api/v1/admin/bot-bindings/redeem", "", "", http.StatusUnauthorized},
	} {
		t.Run(tc.name, func(t *testing.T) {
			recorder := request(tc.method, tc.path, tc.adminKey, tc.botHeader)
			require.Equal(t, tc.status, recorder.Code, recorder.Body.String())
		})
	}
	keyRepo.item.Policy = adminaccess.Policy{}
	require.Equal(t, http.StatusForbidden, request("GET", "/api/v1/admin/bot/profile", key, "Bot valid").Code)
	require.Equal(t, http.StatusForbidden, request("POST", "/api/v1/admin/bot-bindings/redeem", key, "").Code)
}
