//go:build unit

package service

import (
	"context"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/config"
	"github.com/stretchr/testify/require"
)

func TestSettingServiceBotCheckInUsageRoundTrip(t *testing.T) {
	repo := &settingUpdateRepoStub{}
	svc := NewSettingService(repo, &config.Config{})
	checkIn := defaultBotCheckInSettings()
	checkIn.Enabled = true
	checkIn.UsageRequirement = BotCheckInUsageAmount
	checkIn.RequiredTokens = 125_000
	checkIn.RequiredAmount = 1234.12345678

	require.NoError(t, svc.UpdateSettings(context.Background(), &SystemSettings{BotCheckInSettings: checkIn}))
	require.Equal(t, BotCheckInUsageAmount, repo.updates[SettingKeyBotCheckInUsageRequirement])
	require.Equal(t, "125000", repo.updates[SettingKeyBotCheckInRequiredTokens])
	require.Equal(t, "1234.12345678", repo.updates[SettingKeyBotCheckInRequiredAmount])
	require.Equal(t, checkIn, parseBotCheckInSettings(repo.updates))
}

func TestSettingServiceBotCheckInUsageLegacyInternalCaller(t *testing.T) {
	repo := &settingUpdateRepoStub{}
	svc := NewSettingService(repo, &config.Config{})

	require.NoError(t, svc.UpdateSettings(context.Background(), &SystemSettings{}))
	require.Equal(t, BotCheckInUsageTokens, repo.updates[SettingKeyBotCheckInUsageRequirement])
	require.Equal(t, "1000000", repo.updates[SettingKeyBotCheckInRequiredTokens])
}
