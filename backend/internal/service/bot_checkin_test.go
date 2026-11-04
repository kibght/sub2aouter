package service

import (
	"context"
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

func TestBotCheckInUsesConfiguredRewardRanges(t *testing.T) {
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
	require.GreaterOrEqual(t, repo.params.FirstReward, 0.10)
	require.LessOrEqual(t, repo.params.FirstReward, 0.20)
	require.GreaterOrEqual(t, repo.params.Increment, 0.02)
	require.LessOrEqual(t, repo.params.Increment, 0.04)
	require.Equal(t, 0.50, repo.params.DailyCap)
}

func TestBotCheckInRejectsDisabledSetting(t *testing.T) {
	repo := &botCheckInRepositoryStub{}
	service := NewBotCheckInService(repo, botCheckInSettingsStub{settings: BotCheckInSettings{
		Enabled: false, FirstRewardMin: 0.05, FirstRewardMax: 0.20,
		IncrementMin: 0.01, IncrementMax: 0.05, DailyCap: 0.50,
	}}, nil, nil)

	_, _, err := service.CheckIn(context.Background(), 42)

	require.ErrorIs(t, err, ErrBotCheckInDisabled)
	require.Equal(t, BotCheckInParams{}, repo.params)
}
