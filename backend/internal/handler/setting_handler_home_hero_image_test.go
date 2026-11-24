//go:build unit

package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/config"
	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

func TestSettingHandlerPublicHomeHeroImage(t *testing.T) {
	gin.SetMode(gin.TestMode)
	image := "https://example.com/hero.webp"
	repo := &settingHandlerPublicRepoStub{values: map[string]string{service.SettingKeyHomeHeroImage: image}}
	h := NewSettingHandler(service.NewSettingService(repo, &config.Config{}), "test-version")
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Request = httptest.NewRequest(http.MethodGet, "/api/v1/settings/public", nil)
	h.GetPublicSettings(c)
	require.Equal(t, http.StatusOK, recorder.Code)
	var result struct {
		Data struct {
			HomeHeroImage string `json:"home_hero_image"`
		} `json:"data"`
	}
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &result))
	require.Equal(t, image, result.Data.HomeHeroImage)
}
