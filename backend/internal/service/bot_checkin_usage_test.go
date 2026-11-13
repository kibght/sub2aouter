package service

import (
	"context"
	"math"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestBotCheckInPassesConfiguredUsageRequirement(t *testing.T) {
	for _, tc := range []struct {
		name       string
		mode       string
		enabled    bool
		tokens     int64
		amount     float64
		wantTokens int64
		wantAmount float64
	}{
		{"tokens", BotCheckInUsageTokens, true, 250_000, 0.07, 250_000, 0},
		{"amount", BotCheckInUsageAmount, true, 250_000, 0.07, 0, 0.07},
		{"zero tokens", BotCheckInUsageTokens, true, 0, 0.07, 0, 0},
		{"zero amount", BotCheckInUsageAmount, true, 250_000, 0, 0, 0},
		{"disabled amount", BotCheckInUsageAmount, false, 250_000, 0.07, 0, 0.07},
	} {
		t.Run(tc.name, func(t *testing.T) {
			settings := defaultBotCheckInSettings()
			settings.Enabled = tc.enabled
			settings.UsageRequirement = tc.mode
			settings.RequiredTokens, settings.RequiredAmount = tc.tokens, tc.amount
			repo := &botCheckInRepositoryStub{result: &BotCheckInResult{TodayTokens: 123, TodayAmount: 0.04}}
			svc := NewBotCheckInService(repo, botCheckInSettingsStub{settings: settings}, nil, nil)

			result, _, err := svc.CheckIn(context.Background(), 42)

			require.NoError(t, err)
			require.Equal(t, tc.mode, result.UsageRequirement)
			require.Equal(t, tc.wantTokens, result.RequiredTokens)
			require.Equal(t, tc.wantAmount, result.RequiredAmount)
			if tc.enabled {
				require.Equal(t, tc.mode, repo.params.UsageRequirement)
				require.Equal(t, tc.wantTokens, repo.params.RequiredTokens)
				require.Equal(t, tc.wantAmount, repo.params.RequiredAmount)
				require.Equal(t, int64(123), result.TodayTokens)
				require.Equal(t, 0.04, result.TodayAmount)
			} else {
				require.Equal(t, BotCheckInParams{}, repo.params)
				require.Equal(t, BotCheckInStatusDisabled, result.Status)
			}
		})
	}
}

func TestParseBotCheckInUsageSettingsPreservesLegacyConfiguration(t *testing.T) {
	settings := parseBotCheckInSettings(map[string]string{
		SettingKeyBotCheckInEnabled:        "true",
		SettingKeyBotCheckInFirstRewardMin: "0.07",
		SettingKeyBotCheckInFirstRewardMax: "0.27",
	})

	require.True(t, settings.Enabled)
	require.Equal(t, 0.07, settings.FirstRewardMin)
	require.Equal(t, 0.27, settings.FirstRewardMax)
	require.Equal(t, BotCheckInUsageTokens, settings.UsageRequirement)
	require.Equal(t, BotCheckInRequiredTokensDefault, settings.RequiredTokens)
	require.Zero(t, settings.RequiredAmount)
}

func TestParseBotCheckInUsageSettingsLoadsThresholds(t *testing.T) {
	settings := parseBotCheckInSettings(map[string]string{
		SettingKeyBotCheckInEnabled:          "true",
		SettingKeyBotCheckInUsageRequirement: BotCheckInUsageAmount,
		SettingKeyBotCheckInRequiredTokens:   "0",
		SettingKeyBotCheckInRequiredAmount:   "1001.12345678",
	})

	require.True(t, settings.Enabled)
	require.Equal(t, BotCheckInUsageAmount, settings.UsageRequirement)
	require.Zero(t, settings.RequiredTokens)
	require.Equal(t, 1001.12345678, settings.RequiredAmount)
}

func TestBotCheckInValidatesUsageThresholds(t *testing.T) {
	for _, tc := range []struct {
		name   string
		change func(*BotCheckInSettings)
	}{
		{"empty mode", func(s *BotCheckInSettings) { s.UsageRequirement = "" }},
		{"unknown mode", func(s *BotCheckInSettings) { s.UsageRequirement = "both" }},
		{"negative tokens", func(s *BotCheckInSettings) { s.RequiredTokens = -1 }},
		{"unsafe tokens", func(s *BotCheckInSettings) { s.RequiredTokens = BotCheckInRequiredTokensMax + 1 }},
		{"negative amount", func(s *BotCheckInSettings) { s.RequiredAmount = -0.01 }},
		{"excess precision", func(s *BotCheckInSettings) { s.RequiredAmount = 0.000000001 }},
		{"NaN", func(s *BotCheckInSettings) { s.RequiredAmount = math.NaN() }},
		{"infinite", func(s *BotCheckInSettings) { s.RequiredAmount = math.Inf(1) }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			settings := defaultBotCheckInSettings()
			tc.change(&settings)
			require.Error(t, ValidateBotCheckInSettingsForHandler(settings))
		})
	}
	for _, amount := range []float64{0, 0.07, 0.00000001, 1001.12345678} {
		settings := defaultBotCheckInSettings()
		settings.RequiredAmount = amount
		settings.RequiredTokens = BotCheckInRequiredTokensMax
		settings.FirstRewardMin = 0.07
		require.NoError(t, ValidateBotCheckInSettingsForHandler(settings))
	}
}

func TestParseBotCheckInUsageSettingsFailsClosedForInvalidStoredThresholds(t *testing.T) {
	for _, tc := range []struct{ key, value string }{
		{SettingKeyBotCheckInUsageRequirement, "both"},
		{SettingKeyBotCheckInRequiredTokens, "1.5"},
		{SettingKeyBotCheckInRequiredTokens, "-1"},
		{SettingKeyBotCheckInRequiredTokens, "9007199254740992"},
		{SettingKeyBotCheckInRequiredAmount, "0.000000001"},
	} {
		t.Run(tc.key+tc.value, func(t *testing.T) {
			settings := parseBotCheckInSettings(map[string]string{
				SettingKeyBotCheckInEnabled: "true", tc.key: tc.value,
			})
			require.False(t, settings.Enabled)
		})
	}
}
