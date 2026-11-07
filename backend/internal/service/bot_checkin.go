package service

import (
	"context"
	"crypto/rand"
	"fmt"
	"math"
	"math/big"
	"time"

	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/Wei-Shaw/sub2api/internal/pkg/timezone"
)

const botCheckInAmountScale int64 = 100_000_000

const (
	BotCheckInRequiredTokens int64 = 1_000_000
)

// BotCheckInStreakCycleDays is the number of consecutive check-in days before
// the reward cycle starts again from the first-day range.
const BotCheckInStreakCycleDays = 7

const (
	BotCheckInRedeemType              = "bot_checkin"
	BotBindingBonusRedeemType         = "bot_binding_bonus"
	BotCheckInStatusDisabled          = "disabled"
	BotCheckInStatusInsufficientUsage = "insufficient_usage"
	BotCheckInStatusAlreadyCheckedIn  = "already_checked_in"
	BotCheckInStatusSuccess           = "success"
	BotCheckInStatusInactive          = "account_inactive"
)

var ErrBotCheckInDisabled = infraerrors.Forbidden("BOT_CHECKIN_DISABLED", "Bot check-in is disabled")

type BotCheckInParams struct {
	UserID      int64
	RewardDate  string
	FirstReward float64
	Increment   float64
	DailyCap    float64
	Now         time.Time
}

type BotCheckInResult struct {
	Status         string
	Eligible       bool
	TodayTokens    int64
	RequiredTokens int64
	CheckedIn      bool
	Reward         float64
	Balance        float64
	StreakDay      int
	RewardDate     time.Time
	CreatedAt      time.Time
}

type BotCheckInRepository interface {
	CheckIn(ctx context.Context, params BotCheckInParams) (*BotCheckInResult, error)
}

type botCheckInSettingsReader interface {
	GetBotCheckInSettings(ctx context.Context) BotCheckInSettings
}

type balanceCacheInvalidator interface {
	InvalidateUserBalance(ctx context.Context, userID int64) error
}

type BotCheckInService struct {
	repo                 BotCheckInRepository
	settings             botCheckInSettingsReader
	billingCache         balanceCacheInvalidator
	authCacheInvalidator APIKeyAuthCacheInvalidator
}

func NewBotCheckInService(
	repo BotCheckInRepository,
	settings botCheckInSettingsReader,
	billingCache balanceCacheInvalidator,
	authCacheInvalidator APIKeyAuthCacheInvalidator,
) *BotCheckInService {
	return &BotCheckInService{
		repo: repo, settings: settings, billingCache: billingCache,
		authCacheInvalidator: authCacheInvalidator,
	}
}

func (s *BotCheckInService) InvalidateBalance(ctx context.Context, userID int64) {
	if s == nil {
		return
	}
	if s.authCacheInvalidator != nil {
		s.authCacheInvalidator.InvalidateAuthCacheByUserID(ctx, userID)
	}
	if s.billingCache != nil {
		go func() {
			cacheCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			_ = s.billingCache.InvalidateUserBalance(cacheCtx, userID)
		}()
	}
}

func (s *BotCheckInService) CheckIn(ctx context.Context, userID int64) (*BotCheckInResult, time.Time, error) {
	if s == nil || s.repo == nil || s.settings == nil || userID <= 0 {
		return nil, time.Time{}, ErrBotBindingRepository
	}
	now := timezone.Now()
	dayStart := timezone.StartOfDay(now)
	nextCheckInAt := dayStart.AddDate(0, 0, 1)
	baseResult := &BotCheckInResult{
		Status: BotCheckInStatusDisabled, RequiredTokens: BotCheckInRequiredTokens,
		RewardDate: dayStart,
	}
	settings := s.settings.GetBotCheckInSettings(ctx)
	if !settings.Enabled {
		return baseResult, nextCheckInAt, nil
	}
	if err := validateBotCheckInSettings(settings); err != nil {
		return nil, time.Time{}, err
	}

	firstReward, err := randomBotCheckInAmount(settings.FirstRewardMin, settings.FirstRewardMax)
	if err != nil {
		return nil, time.Time{}, fmt.Errorf("generate first check-in reward: %w", err)
	}
	result, err := s.repo.CheckIn(ctx, BotCheckInParams{
		UserID: userID, RewardDate: dayStart.Format("2006-01-02"),
		FirstReward: firstReward, DailyCap: settings.DailyCap,
		Now: now.UTC(),
	})
	if err != nil {
		return nil, time.Time{}, err
	}
	if result.CheckedIn {
		s.InvalidateBalance(ctx, userID)
	}
	return result, nextCheckInAt, nil
}

func validateBotCheckInSettings(settings BotCheckInSettings) error {
	values := []float64{
		settings.FirstRewardMin, settings.FirstRewardMax,
		settings.IncrementMin, settings.IncrementMax, settings.DailyCap,
	}
	for _, value := range values {
		if math.IsNaN(value) || math.IsInf(value, 0) || value < 0 || value > 1000 || math.Round(value*float64(botCheckInAmountScale)) != value*float64(botCheckInAmountScale) {
			return fmt.Errorf("invalid bot check-in settings")
		}
	}
	if settings.FirstRewardMin > settings.FirstRewardMax || settings.IncrementMin > settings.IncrementMax {
		return fmt.Errorf("invalid bot check-in settings")
	}
	return nil
}

func ValidateBotCheckInSettingsForHandler(settings BotCheckInSettings) error {
	return validateBotCheckInSettings(settings)
}

func randomBotCheckInAmount(minimum, maximum float64) (float64, error) {
	const currencyScale int64 = 100
	minUnits := int64(math.Round(minimum * float64(currencyScale)))
	maxUnits := int64(math.Round(maximum * float64(currencyScale)))
	span := maxUnits - minUnits + 1
	if span <= 0 {
		return 0, fmt.Errorf("invalid random reward range")
	}
	value, err := rand.Int(rand.Reader, big.NewInt(span))
	if err != nil {
		return 0, err
	}
	return float64(minUnits+value.Int64()) / float64(currencyScale), nil
}

func BotCheckInUnits(value float64) int64 {
	return int64(math.Round(value * float64(botCheckInAmountScale)))
}
