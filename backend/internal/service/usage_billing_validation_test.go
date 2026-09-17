package service

import (
	"math"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestUsageBillingCommandRejectsInvalidCosts(t *testing.T) {
	for _, value := range []float64{-1, math.NaN(), math.Inf(1), math.Inf(-1)} {
		cmd := &UsageBillingCommand{BalanceCost: value}
		require.ErrorIs(t, cmd.Validate(), ErrUsageBillingAmountInvalid)
	}
}

func TestBatchImageBalanceHoldCommandRejectsInvalidAmounts(t *testing.T) {
	for _, value := range []float64{-1, math.NaN(), math.Inf(1), math.Inf(-1)} {
		cmd := &BatchImageBalanceHoldCommand{HoldAmount: value}
		require.ErrorIs(t, cmd.Validate(), ErrUsageBillingAmountInvalid)
	}
}
