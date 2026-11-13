package service

import (
	"context"
	"crypto/rand"
	"fmt"
	"math"
	"math/big"
	"strconv"
	"strings"
	"time"

	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/Wei-Shaw/sub2api/internal/pkg/timezone"
)

const botCheckInAmountScale int64 = 100_000_000

// BotCheckInStreakCycleDays is the number of consecutive check-in days before
// the reward cycle starts again from the daily reward range.
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
	UsageRequirement string
	RequiredTokens   int64
	RequiredAmount   float64
	UserID           int64
	RewardDate       string
	FirstReward      float64
	Increment        float64
	DailyCap         float64
	Now              time.Time
}

type BotCheckInResult struct {
	UsageRequirement string
	TodayAmount      float64
	RequiredAmount   float64
	Status           string
	Eligible         bool
	TodayTokens      int64
	RequiredTokens   int64
	CheckedIn        bool
	Reward           float64
	Balance          float64
	StreakDay        int
	RewardDate       time.Time
	CreatedAt        time.Time
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
	settings := defaultBotCheckInUsage(s.settings.GetBotCheckInSettings(ctx))
	requiredTokens, requiredAmount := settings.RequiredTokens, settings.RequiredAmount
	if settings.UsageRequirement == BotCheckInUsageAmount {
		requiredTokens = 0
	} else {
		requiredAmount = 0
	}
	baseResult := &BotCheckInResult{
		Status: BotCheckInStatusDisabled, UsageRequirement: settings.UsageRequirement,
		RequiredTokens: requiredTokens, RequiredAmount: requiredAmount, RewardDate: dayStart,
	}
	if !settings.Enabled {
		return baseResult, nextCheckInAt, nil
	}
	if err := validateBotCheckInSettings(settings); err != nil {
		return nil, time.Time{}, err
	}

	firstReward, err := randomBotCheckInAmount(settings.FirstRewardMin, settings.FirstRewardMax)
	if err != nil {
		return nil, time.Time{}, fmt.Errorf("generate daily check-in reward: %w", err)
	}
	result, err := s.repo.CheckIn(ctx, BotCheckInParams{
		UserID: userID, RewardDate: dayStart.Format("2006-01-02"),
		FirstReward: firstReward, DailyCap: settings.DailyCap,
		UsageRequirement: settings.UsageRequirement, RequiredTokens: requiredTokens, RequiredAmount: requiredAmount,
		Now: now.UTC(),
	})
	if err != nil {
		return nil, time.Time{}, err
	}
	result.UsageRequirement = settings.UsageRequirement
	result.RequiredTokens, result.RequiredAmount = requiredTokens, requiredAmount
	if result.CheckedIn {
		s.InvalidateBalance(ctx, userID)
	}
	return result, nextCheckInAt, nil
}

func defaultBotCheckInSettings() BotCheckInSettings {
	return BotCheckInSettings{
		Enabled: BotCheckInEnabledDefault, FirstRewardMin: BotCheckInFirstRewardMinDefault,
		FirstRewardMax: BotCheckInFirstRewardMaxDefault, IncrementMin: BotCheckInIncrementMinDefault,
		IncrementMax: BotCheckInIncrementMaxDefault, DailyCap: BotCheckInDailyCapDefault,
		UsageRequirement: BotCheckInUsageRequirementDefault, RequiredTokens: BotCheckInRequiredTokensDefault,
		RequiredAmount: BotCheckInRequiredAmountDefault,
	}
}

// Preserve defaults for existing internal callers that construct settings without usage fields.
func defaultBotCheckInUsage(settings BotCheckInSettings) BotCheckInSettings {
	if settings.UsageRequirement == "" {
		settings.UsageRequirement = BotCheckInUsageRequirementDefault
		if settings.RequiredTokens == 0 {
			settings.RequiredTokens = BotCheckInRequiredTokensDefault
		}
	}
	return settings
}

func validBotCheckInAmount(value float64) bool {
	if math.IsNaN(value) || math.IsInf(value, 0) || value < 0 {
		return false
	}
	decimal := strconv.FormatFloat(value, 'f', -1, 64)
	dot := strings.IndexByte(decimal, '.')
	return dot < 0 || len(decimal)-dot-1 <= 8
}

func validateBotCheckInSettings(settings BotCheckInSettings) error {
	if settings.UsageRequirement != BotCheckInUsageTokens && settings.UsageRequirement != BotCheckInUsageAmount {
		return fmt.Errorf("invalid bot check-in usage requirement")
	}
	if settings.RequiredTokens < 0 || settings.RequiredTokens > BotCheckInRequiredTokensMax || !validBotCheckInAmount(settings.RequiredAmount) {
		return fmt.Errorf("invalid bot check-in usage threshold")
	}
	values := []float64{
		settings.FirstRewardMin, settings.FirstRewardMax,
		settings.IncrementMin, settings.IncrementMax, settings.DailyCap,
	}
	for _, value := range values {
		if !validBotCheckInAmount(value) || value > 1000 {
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
