package middleware

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/config"
	"github.com/Wei-Shaw/sub2api/internal/pkg/ctxkey"
	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

func TestGoogleAPIKeyAuthRegistersRequestForBalanceCancellation(t *testing.T) {
	gin.SetMode(gin.TestMode)
	const userID int64 = 91070001
	apiKeyService := newTestAPIKeyService(fakeAPIKeyRepo{
		getByKey: func(context.Context, string) (*service.APIKey, error) {
			return &service.APIKey{
				ID: 1, Key: "google-cancellation-test", Status: service.StatusActive,
				User: &service.User{ID: userID, Status: service.StatusActive, Balance: 1},
			}, nil
		},
	})
	router := gin.New()
	router.Use(APIKeyAuthWithSubscriptionGoogle(apiKeyService, nil, &config.Config{}))
	var requestCtx context.Context
	router.GET("/v1beta/test", func(c *gin.Context) {
		requestCtx = c.Request.Context()
		require.Equal(t, userID, requestCtx.Value(ctxkey.UserID))
		service.CancelGatewayRequestsForUser(userID + 1)
		require.NoError(t, requestCtx.Err())
		service.CancelGatewayRequestsForUser(userID)
		require.True(t, service.IsGatewayBalanceOverdraft(requestCtx))
		c.Status(http.StatusOK)
	})
	req := httptest.NewRequest(http.MethodGet, "/v1beta/test", nil)
	req.Header.Set("x-goog-api-key", "google-cancellation-test")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	require.Equal(t, http.StatusOK, rec.Code)
	require.NotNil(t, requestCtx)
}
