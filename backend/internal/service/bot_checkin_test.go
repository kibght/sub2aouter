package service

import (
	"context"
	"math"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

type botCheckInSettingsStub struct {
	settings BotCheckInSettings
}

func (s botCheckInSettingsStub) GetBotCheckInSettings(context.Context) BotCheckInSettings {
	return s.settings
}

type botCheckInRepositoryStub struct {
	params BotCheckInParams
	result *BotCheckInResult
}

func (s *botCheckInRepositoryStub) CheckIn(_ context.Context, params BotCheckInParams) (*BotCheckInResult, error) {
	s.params = params
	return s.result, nil
}

func TestBotCheckInUsesConfiguredRandomRewardRange(t *testing.T) {
	repo := &botCheckInRepositoryStub{result: &BotCheckInResult{
		CheckedIn: true, Reward: 0.12, Balance: 1.12,
		StreakDay: 1, RewardDate: time.Now(),
	}}
	settings := botCheckInSettingsStub{settings: BotCheckInSettings{
		Enabled: true, FirstRewardMin: 0.10, FirstRewardMax: 0.20,
		IncrementMin: 0.02, IncrementMax: 0.04, DailyCap: 0.50,
	}}
	service := NewBotCheckInService(repo, settings, nil, nil)

	result, next, err := service.CheckIn(context.Background(), 42)

	require.NoError(t, err)
	require.NotNil(t, result)
	require.False(t, next.IsZero())
	require.GreaterOrEqual(t, repo.params.FirstReward, settings.settings.FirstRewardMin)
	require.LessOrEqual(t, repo.params.FirstReward, settings.settings.FirstRewardMax)
	require.Equal(t, repo.params.FirstReward, math.Round(repo.params.FirstReward*100)/100)
	require.Zero(t, repo.params.Increment)
	require.Equal(t, 0.50, repo.params.DailyCap)
}

func TestBotCheckInRejectsInvalidRewardRange(t *testing.T) {
	repo := &botCheckInRepositoryStub{}
	service := NewBotCheckInService(repo, botCheckInSettingsStub{settings: BotCheckInSettings{
		Enabled: true, FirstRewardMin: 0.30, FirstRewardMax: 0.20,
		IncrementMin: 0.01, IncrementMax: 0.05, DailyCap: 0.50,
	}}, nil, nil)

	result, next, err := service.CheckIn(context.Background(), 42)

	require.Error(t, err)
	require.Nil(t, result)
	require.True(t, next.IsZero())
	require.Equal(t, BotCheckInParams{}, repo.params)
}

func TestRandomBotCheckInAmountIncludesConfiguredBounds(t *testing.T) {
	for _, amount := range []float64{0.01, 0.20} {
		got, err := randomBotCheckInAmount(amount, amount)
		require.NoError(t, err)
		require.Equal(t, amount, got)
	}
}

func TestParseBotCheckInSettingsLoadsConfiguredRewardRange(t *testing.T) {
	settings := parseBotCheckInSettings(map[string]string{
		SettingKeyBotCheckInEnabled:        "true",
		SettingKeyBotCheckInFirstRewardMin: "0.11",
		SettingKeyBotCheckInFirstRewardMax: "0.27",
		SettingKeyBotCheckInIncrementMin:   "0.01",
		SettingKeyBotCheckInIncrementMax:   "0.05",
		SettingKeyBotCheckInDailyCap:       "0.50",
	})

	require.True(t, settings.Enabled)
	require.Equal(t, 0.11, settings.FirstRewardMin)
	require.Equal(t, 0.27, settings.FirstRewardMax)
}

func TestParseBotCheckInSettingsUsesDefaultRewardRange(t *testing.T) {
	settings := parseBotCheckInSettings(nil)

	require.Equal(t, 0.01, settings.FirstRewardMin)
	require.Equal(t, 0.20, settings.FirstRewardMax)
}

func TestBotCheckInRejectsDisabledSetting(t *testing.T) {
	repo := &botCheckInRepositoryStub{}
	service := NewBotCheckInService(repo, botCheckInSettingsStub{settings: BotCheckInSettings{
		Enabled: false, FirstRewardMin: 0.05, FirstRewardMax: 0.20,
		IncrementMin: 0.01, IncrementMax: 0.05, DailyCap: 0.50,
	}}, nil, nil)

	result, next, err := service.CheckIn(context.Background(), 42)

	require.NoError(t, err)
	require.Equal(t, BotCheckInStatusDisabled, result.Status)
	require.Equal(t, BotCheckInRequiredTokens, result.RequiredTokens)
	require.False(t, next.IsZero())
	require.Equal(t, BotCheckInParams{}, repo.params)
}
