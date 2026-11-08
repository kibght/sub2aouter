package dto

import (
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/stretchr/testify/require"
)

func TestRedeemCodeFromServiceIncludesBotRewardNotes(t *testing.T) {
	for _, rewardType := range []string{
		service.BotBindingBonusRedeemType,
		service.BotCheckInRedeemType,
	} {
		rewardType := rewardType
		t.Run(rewardType, func(t *testing.T) {
			notes := "bot reward"
			mapped := redeemCodeFromServiceBase(&service.RedeemCode{Type: rewardType, Notes: notes})
			require.NotNil(t, mapped.Notes)
			require.Equal(t, notes, *mapped.Notes)
		})
	}
}
