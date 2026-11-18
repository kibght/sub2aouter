//go:build unit

package admin

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

func botCheckInSettingsData(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var payload struct {
		Data map[string]any `json:"data"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &payload))
	return payload.Data
}

func TestUpdateSettingsBotCheckInUsagePersistsAndReads(t *testing.T) {
	h, repo := newStepUpSwitchTestHandler(t, map[string]string{service.SettingKeyBotCheckInEnabled: "true"})
	rec := doUpdateSettings(t, h, map[string]any{
		"bot_checkin_usage_requirement": "amount",
		"bot_checkin_required_tokens":   125000,
		"bot_checkin_required_amount":   1001.07,
	}, nil)
	data := botCheckInSettingsData(t, rec)
	require.Equal(t, "amount", data["bot_checkin_usage_requirement"])
	require.Equal(t, float64(125000), data["bot_checkin_required_tokens"])
	require.Equal(t, 1001.07, data["bot_checkin_required_amount"])
	require.Equal(t, "amount", repo.values[service.SettingKeyBotCheckInUsageRequirement])
	require.Equal(t, "125000", repo.values[service.SettingKeyBotCheckInRequiredTokens])
	require.Equal(t, "1001.07000000", repo.values[service.SettingKeyBotCheckInRequiredAmount])
	require.Equal(t, "true", repo.values[service.SettingKeyBotCheckInEnabled])

	rec = doUpdateSettings(t, h, map[string]any{"bot_checkin_required_amount": 0}, nil)
	data = botCheckInSettingsData(t, rec)
	require.Equal(t, "amount", data["bot_checkin_usage_requirement"])
	require.Equal(t, float64(125000), data["bot_checkin_required_tokens"])
	require.Equal(t, float64(0), data["bot_checkin_required_amount"])

	rec = httptest.NewRecorder()
	c, _ := gin.CreateTestContext(rec)
	c.Request = httptest.NewRequest(http.MethodGet, "/api/v1/admin/settings", nil)
	h.GetSettings(c)
	data = botCheckInSettingsData(t, rec)
	require.Equal(t, "amount", data["bot_checkin_usage_requirement"])
	require.Equal(t, float64(125000), data["bot_checkin_required_tokens"])
	require.Equal(t, float64(0), data["bot_checkin_required_amount"])
}

func TestUpdateSettingsBotCheckInUsagePreservesLegacyAndExplicitZero(t *testing.T) {
	h, repo := newStepUpSwitchTestHandler(t, map[string]string{service.SettingKeyBotCheckInEnabled: "true"})
	rec := doUpdateSettings(t, h, map[string]any{"site_name": "example"}, nil)
	data := botCheckInSettingsData(t, rec)
	require.Equal(t, "tokens", data["bot_checkin_usage_requirement"])
	require.Equal(t, float64(1000000), data["bot_checkin_required_tokens"])
	require.Equal(t, "true", repo.values[service.SettingKeyBotCheckInEnabled])

	rec = doUpdateSettings(t, h, map[string]any{"bot_checkin_required_tokens": 0}, nil)
	data = botCheckInSettingsData(t, rec)
	require.Equal(t, "tokens", data["bot_checkin_usage_requirement"])
	require.Equal(t, float64(0), data["bot_checkin_required_tokens"])
	require.Equal(t, "0", repo.values[service.SettingKeyBotCheckInRequiredTokens])
}

func TestUpdateSettingsBotCheckInUsageRejectsInvalidThresholds(t *testing.T) {
	for _, tc := range []struct {
		key   string
		value any
	}{
		{"bot_checkin_usage_requirement", ""},
		{"bot_checkin_usage_requirement", "both"},
		{"bot_checkin_required_tokens", -1},
		{"bot_checkin_required_tokens", 1.5},
		{"bot_checkin_required_tokens", int64(9007199254740992)},
		{"bot_checkin_required_amount", -0.01},
		{"bot_checkin_required_amount", 0.000000001},
	} {
		t.Run(fmt.Sprint(tc.key, "/", tc.value), func(t *testing.T) {
			h, repo := newStepUpSwitchTestHandler(t, map[string]string{service.SettingKeyBotCheckInEnabled: "true"})
			rec := doUpdateSettings(t, h, map[string]any{tc.key: tc.value}, nil)
			require.Equal(t, http.StatusBadRequest, rec.Code, rec.Body.String())
			require.Equal(t, map[string]string{service.SettingKeyBotCheckInEnabled: "true"}, repo.values)
		})
	}
}
