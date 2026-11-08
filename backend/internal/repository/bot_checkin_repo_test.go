package repository

import (
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/stretchr/testify/require"
)

func TestCalculateBotCheckInRewardStartsCycleAfterSevenDays(t *testing.T) {
	tests := []struct {
		name           string
		previousReward float64
		previousStreak int
		hasPrevious    bool
		firstReward    float64
		increment      float64
		dailyCap       float64
		wantStreak     int
		wantReward     float64
		wantIncrement  float64
	}{
		{name: "first day", firstReward: 0.1, increment: 0.03, dailyCap: 1, wantStreak: 1, wantReward: 0.1},
		{name: "second day uses a new random amount", previousReward: 0.19, previousStreak: 1, hasPrevious: true, firstReward: 0.07, increment: 0.03, dailyCap: 1, wantStreak: 2, wantReward: 0.07},
		{name: "seventh day doubles today's random reward", previousReward: 0.28, previousStreak: 6, hasPrevious: true, firstReward: 0.1, increment: 0.03, dailyCap: 1, wantStreak: 7, wantReward: 0.2},
		{name: "eighth day resets", previousReward: 0.31, previousStreak: 7, hasPrevious: true, firstReward: 0.1, increment: 0.03, dailyCap: 1, wantStreak: 1, wantReward: 0.1},
		{name: "cap still applies", previousReward: 0.49, previousStreak: 6, hasPrevious: true, firstReward: 0.3, increment: 0.03, dailyCap: 0.5, wantStreak: 7, wantReward: 0.5},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			streak, reward, increment := calculateBotCheckInReward(
				tt.previousReward, tt.previousStreak, tt.firstReward, tt.increment, tt.dailyCap, tt.hasPrevious,
			)
			require.Equal(t, tt.wantStreak, streak)
			require.InDelta(t, tt.wantReward, reward, 1e-9)
			require.InDelta(t, tt.wantIncrement, increment, 1e-9)
		})
	}

	require.Equal(t, 7, service.BotCheckInStreakCycleDays)
}
