//go:build unit

package admin

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

func TestUpdateSettingsHomeHeroImagePreservesAndClears(t *testing.T) {
	h, repo := newStepUpSwitchTestHandler(t, map[string]string{
		service.SettingKeyHomeHeroImage: "/images/original-hero.webp",
		service.SettingKeySiteName:      "Example Gateway",
	})

	rec := doUpdateSettings(t, h, map[string]any{"risk_control_enabled": true}, nil)
	require.Equal(t, http.StatusOK, rec.Code)
	require.Equal(t, "/images/original-hero.webp", repo.values[service.SettingKeyHomeHeroImage])

	image := "https://example.com/new-hero.webp"
	rec = doUpdateSettings(t, h, map[string]any{"home_hero_image": image}, nil)
	require.Equal(t, http.StatusOK, rec.Code)
	require.Equal(t, image, repo.values[service.SettingKeyHomeHeroImage])
	require.Equal(t, "Example Gateway", repo.values[service.SettingKeySiteName])
	var updated struct {
		Data struct {
			HomeHeroImage string `json:"home_hero_image"`
		} `json:"data"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &updated))
	require.Equal(t, image, updated.Data.HomeHeroImage)

	read := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(read)
	c.Request = httptest.NewRequest(http.MethodGet, "/api/v1/admin/settings", nil)
	h.GetSettings(c)
	require.Equal(t, http.StatusOK, read.Code)
	require.NoError(t, json.Unmarshal(read.Body.Bytes(), &updated))
	require.Equal(t, image, updated.Data.HomeHeroImage)

	rec = doUpdateSettings(t, h, map[string]any{"home_hero_image": ""}, nil)
	require.Equal(t, http.StatusOK, rec.Code)
	require.Empty(t, repo.values[service.SettingKeyHomeHeroImage])
}
