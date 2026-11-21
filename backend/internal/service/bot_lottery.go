package service

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"math"
	"math/big"
	"strings"
	"sync"
	"time"

	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
)

var (
	ErrBotLotteryDisabled          = infraerrors.Forbidden("BOT_LOTTERY_DISABLED", "Bot lottery is disabled")
	ErrBotLotteryNoTickets         = infraerrors.Conflict("BOT_LOTTERY_NO_TICKETS", "No lottery attempts remain")
	ErrBotLotteryBadConfig         = infraerrors.BadRequest("BOT_LOTTERY_CONFIG_INVALID", "Lottery configuration is invalid")
	ErrBotLotteryAdminRequired     = infraerrors.Forbidden("BOT_LOTTERY_ADMIN_REQUIRED", "Bot lottery grants require an administrator account")
	ErrBotLotteryRequestIDRequired = infraerrors.BadRequest("BOT_LOTTERY_REQUEST_ID_REQUIRED", "request_id is required")
	ErrBotLotteryRepository        = infraerrors.ServiceUnavailable("BOT_LOTTERY_UNAVAILABLE", "Bot lottery service is unavailable")
	ErrBotLotteryTargetAmbiguous   = infraerrors.Conflict("BOT_LOTTERY_TARGET_AMBIGUOUS", "This QQ account is bound to multiple website accounts")
	ErrBotLotteryTargetNotFound    = infraerrors.NotFound("BOT_LOTTERY_TARGET_NOT_FOUND", "The target QQ account has no active website binding")
	ErrBotLotteryBatchNotFound     = infraerrors.NotFound("BOT_LOTTERY_BATCH_NOT_FOUND", "The lottery grant batch was not found")
)

const (
	BotLotteryActionGrant = "grant"
	BotLotteryActionDraw  = "draw"
)

type BotLotteryPrize struct {
	ID     string  `json:"id"`
	Name   string  `json:"name"`
	Amount float64 `json:"amount"`
	Weight int64   `json:"weight"`
}

type BotLotteryConfig struct {
	Enabled bool              `json:"enabled"`
	Prizes  []BotLotteryPrize `json:"prizes"`
}

type BotLotteryRecord struct {
	ID        int64     `json:"id"`
	Action    string    `json:"action"`
	Count     int64     `json:"count"`
	Remaining int64     `json:"remaining"`
	PrizeName string    `json:"prize_name,omitempty"`
	Reward    float64   `json:"reward"`
	Notes     string    `json:"notes,omitempty"`
	CreatedAt time.Time `json:"created_at"`
}

type BotLotteryDrawResult struct {
	Status    string  `json:"status"`
	PrizeName string  `json:"prize_name"`
	Reward    float64 `json:"reward"`
	Remaining int64   `json:"remaining"`
	Replayed  bool    `json:"replayed"`
}

type BotLotteryGrantResult struct {
	Status    string `json:"status"`
	UserID    int64  `json:"user_id,omitempty"`
	Count     int64  `json:"count,omitempty"`
	Remaining int64  `json:"remaining,omitempty"`
	Replayed  bool   `json:"replayed"`
	BatchID   int64  `json:"batch_id,omitempty"`
	Total     int64  `json:"total"`
	Success   int64  `json:"success"`
	Failed    int64  `json:"failed"`
	Skipped   int64  `json:"skipped"`
	Pending   int64  `json:"pending"`
}

type BotLotteryGrantBatchItem struct {
	UserID int64  `json:"user_id"`
	Status string `json:"status"`
	Error  string `json:"error,omitempty"`
}

type BotLotteryGrantBatch struct {
	BotLotteryGrantResult
	CreatedAt time.Time                  `json:"created_at"`
	Items     []BotLotteryGrantBatchItem `json:"items"`
}

type BotLotteryGrantBatchRequest struct {
	Count       int64
	Notes       string
	RequestID   string
	ActorID     int64
	OperationID string
}

type BotLotteryRepository interface {
	GetConfig(context.Context) (*BotLotteryConfig, error)
	SaveConfig(context.Context, BotLotteryConfig) error
	GetRemaining(context.Context, int64) (int64, error)
	FindDraw(context.Context, int64, string) (*BotLotteryDrawResult, error)
	Draw(context.Context, int64, string, BotLotteryPrize, string) (*BotLotteryDrawResult, error)
	ListRecords(context.Context, int64, int) ([]BotLotteryRecord, error)
	FindGrant(context.Context, string, string, int64, string) (*BotLotteryGrantResult, error)
	Grant(context.Context, int64, int64, string, string, int64, string) (int64, bool, error)
	ResolveQQUser(context.Context, string) (int64, error)
	CreateGrantBatch(context.Context, BotLotteryGrantBatchRequest) (int64, bool, error)
	ProcessGrantBatch(context.Context, int64) error
	GetGrantBatch(context.Context, int64) (*BotLotteryGrantBatch, error)
	PendingGrantBatchIDs(context.Context, int) ([]int64, error)
}

type BotLotteryCacheInvalidator interface {
	InvalidateUserBalance(context.Context, int64) error
}

type BotLotteryAuthCacheInvalidator interface {
	InvalidateAuthCacheByUserID(context.Context, int64)
}

type BotLotteryService struct {
	repo         BotLotteryRepository
	billingCache BotLotteryCacheInvalidator
	authCache    BotLotteryAuthCacheInvalidator
	startOnce    sync.Once
	stopOnce     sync.Once
	cancel       context.CancelFunc
	done         chan struct{}
	wake         chan struct{}
}

func NewBotLotteryService(repo BotLotteryRepository, billingCache BotLotteryCacheInvalidator, authCache BotLotteryAuthCacheInvalidator) *BotLotteryService {
	return &BotLotteryService{repo: repo, billingCache: billingCache, authCache: authCache, done: make(chan struct{}), wake: make(chan struct{}, 1)}
}

func ProvideBotLotteryService(repo BotLotteryRepository, billingCache *BillingCacheService, authCache APIKeyAuthCacheInvalidator) *BotLotteryService {
	svc := NewBotLotteryService(repo, billingCache, authCache)
	svc.Start()
	return svc
}

func ValidateBotLotteryConfig(config BotLotteryConfig) error {
	if len(config.Prizes) > 100 {
		return ErrBotLotteryBadConfig
	}
	ids := make(map[string]struct{}, len(config.Prizes))
	var totalWeight int64
	for _, prize := range config.Prizes {
		if strings.TrimSpace(prize.ID) == "" || len(prize.ID) > 64 || strings.TrimSpace(prize.Name) == "" || len([]rune(prize.Name)) > 80 || strings.ContainsRune(prize.ID+prize.Name, '\x00') || prize.Weight <= 0 || prize.Weight > 1_000_000 || math.IsNaN(prize.Amount) || math.IsInf(prize.Amount, 0) || prize.Amount < 0 || prize.Amount > 1_000_000 || math.Abs(math.Round(prize.Amount*100_000_000)-prize.Amount*100_000_000) > 0.000001 {
			return ErrBotLotteryBadConfig
		}
		if _, exists := ids[prize.ID]; exists {
			return ErrBotLotteryBadConfig
		}
		ids[prize.ID] = struct{}{}
		totalWeight += prize.Weight
		if totalWeight > math.MaxInt32 {
			return ErrBotLotteryBadConfig
		}
	}
	if config.Enabled && len(config.Prizes) == 0 {
		return ErrBotLotteryBadConfig
	}
	return nil
}

func (s *BotLotteryService) Config(ctx context.Context) (*BotLotteryConfig, error) {
	if s == nil || s.repo == nil {
		return nil, ErrBotLotteryRepository
	}
	return s.repo.GetConfig(ctx)
}

func (s *BotLotteryService) UpdateConfig(ctx context.Context, config BotLotteryConfig) error {
	if s == nil || s.repo == nil {
		return ErrBotLotteryRepository
	}
	if err := ValidateBotLotteryConfig(config); err != nil {
		return err
	}
	return s.repo.SaveConfig(ctx, config)
}

func (s *BotLotteryService) Remaining(ctx context.Context, userID int64) (int64, error) {
	if s == nil || s.repo == nil || userID <= 0 {
		return 0, ErrBotLotteryRepository
	}
	return s.repo.GetRemaining(ctx, userID)
}

func (s *BotLotteryService) Draw(ctx context.Context, userID int64, requestID string) (*BotLotteryDrawResult, error) {
	if s == nil || s.repo == nil || userID <= 0 {
		return nil, ErrBotLotteryRepository
	}
	operationID, err := BotLotteryOperationID(fmt.Sprintf("draw:%d", userID), requestID)
	if err != nil {
		return nil, err
	}
	prior, err := s.repo.FindDraw(ctx, userID, operationID)
	if err != nil {
		return nil, err
	}
	if prior != nil {
		return prior, nil
	}
	config, err := s.repo.GetConfig(ctx)
	if err != nil {
		return nil, err
	}
	if !config.Enabled {
		return nil, ErrBotLotteryDisabled
	}
	if err = ValidateBotLotteryConfig(*config); err != nil {
		return nil, err
	}
	prize, err := chooseBotLotteryPrize(config.Prizes)
	if err != nil {
		return nil, err
	}
	result, err := s.repo.Draw(ctx, userID, operationID, prize, BotLotteryConfigSnapshot(*config))
	if err != nil {
		return nil, err
	}
	if !result.Replayed {
		s.invalidateBalance(ctx, userID)
	}
	return result, nil
}

func (s *BotLotteryService) Records(ctx context.Context, userID int64, limit int) ([]BotLotteryRecord, error) {
	if s == nil || s.repo == nil || userID <= 0 {
		return nil, ErrBotLotteryRepository
	}
	return s.repo.ListRecords(ctx, userID, limit)
}

func (s *BotLotteryService) GrantOne(ctx context.Context, userID, count int64, notes, requestID string, actorID int64) (*BotLotteryGrantResult, error) {
	if s == nil || s.repo == nil || userID <= 0 || actorID <= 0 || count <= 0 || count > 100_000 || len([]rune(notes)) > 500 {
		return nil, ErrBotLotteryBadConfig
	}
	operationID, err := BotLotteryOperationID(fmt.Sprintf("grant:%d", actorID), requestID)
	if err != nil {
		return nil, err
	}
	target := fmt.Sprintf("user:%d", userID)
	prior, err := s.repo.FindGrant(ctx, operationID, target, count, notes)
	if err != nil {
		return nil, err
	}
	if prior != nil {
		return prior, nil
	}
	remaining, replayed, err := s.repo.Grant(ctx, userID, count, notes, operationID, actorID, target)
	if err != nil {
		return nil, err
	}
	return &BotLotteryGrantResult{Status: "success", UserID: userID, Count: count, Remaining: remaining, Replayed: replayed}, nil
}

func (s *BotLotteryService) GrantAll(ctx context.Context, request BotLotteryGrantBatchRequest) (*BotLotteryGrantBatch, error) {
	if s == nil || s.repo == nil || request.ActorID <= 0 || request.Count <= 0 || request.Count > 100_000 || len([]rune(request.Notes)) > 500 {
		return nil, ErrBotLotteryBadConfig
	}
	requestHash, err := BotLotteryOperationID(fmt.Sprintf("grant-all:%d", request.ActorID), request.RequestID)
	if err != nil {
		return nil, err
	}
	request.OperationID = requestHash
	batchID, replayed, err := s.repo.CreateGrantBatch(ctx, request)
	if err != nil {
		return nil, err
	}
	select {
	case s.wake <- struct{}{}:
	default:
	}
	batch, err := s.repo.GetGrantBatch(ctx, batchID)
	if err != nil {
		return nil, err
	}
	batch.Replayed = replayed
	return batch, nil
}

func (s *BotLotteryService) GrantToQQ(ctx context.Context, qq string, count int64, notes, requestID string, actorID int64) (*BotLotteryGrantResult, error) {
	if s == nil || s.repo == nil || actorID <= 0 || count <= 0 || count > 100_000 || len([]rune(notes)) > 500 {
		return nil, ErrBotLotteryBadConfig
	}
	target := "qq:" + strings.TrimSpace(qq)
	operationID, err := BotLotteryOperationID(fmt.Sprintf("grant:%d", actorID), requestID)
	if err != nil {
		return nil, err
	}
	prior, err := s.repo.FindGrant(ctx, operationID, target, count, notes)
	if err != nil {
		return nil, err
	}
	if prior != nil {
		return prior, nil
	}
	userID, err := s.repo.ResolveQQUser(ctx, qq)
	if err != nil {
		return nil, err
	}
	remaining, replayed, err := s.repo.Grant(ctx, userID, count, notes, operationID, actorID, target)
	if err != nil {
		return nil, err
	}
	return &BotLotteryGrantResult{Status: "success", UserID: userID, Count: count, Remaining: remaining, Replayed: replayed}, nil
}

func (s *BotLotteryService) AdminGrant(ctx context.Context, userID, count int64, notes, requestID string, actorID int64) (*BotLotteryGrantResult, error) {
	if userID > 0 {
		return s.GrantOne(ctx, userID, count, notes, requestID, actorID)
	}
	return nil, ErrBotLotteryBadConfig
}

func (s *BotLotteryService) CreateAdminGrantBatch(ctx context.Context, request BotLotteryGrantBatchRequest) (*BotLotteryGrantBatch, error) {
	return s.GrantAll(ctx, request)
}

func (s *BotLotteryService) GrantBatch(ctx context.Context, id int64) (*BotLotteryGrantBatch, error) {
	if s == nil || s.repo == nil || id <= 0 {
		return nil, ErrBotLotteryRepository
	}
	batch, err := s.repo.GetGrantBatch(ctx, id)
	if err != nil {
		return nil, err
	}
	return batch, nil
}

func (s *BotLotteryService) AdminHistory(ctx context.Context, userID int64, limit int) (int64, []BotLotteryRecord, error) {
	remaining, err := s.Remaining(ctx, userID)
	if err != nil {
		return 0, nil, err
	}
	records, err := s.Records(ctx, userID, limit)
	return remaining, records, err
}

func (s *BotLotteryService) invalidateBalance(ctx context.Context, userID int64) {
	if s.authCache != nil {
		s.authCache.InvalidateAuthCacheByUserID(ctx, userID)
	}
	if s.billingCache != nil {
		_ = s.billingCache.InvalidateUserBalance(ctx, userID)
	}
}

func BotLotteryOperationID(scope, requestID string) (string, error) {
	requestID = strings.TrimSpace(requestID)
	if requestID == "" || len(requestID) > 200 {
		return "", ErrBotLotteryRequestIDRequired
	}
	digest := sha256.Sum256([]byte(scope + ":" + requestID))
	return hex.EncodeToString(digest[:]), nil
}

func BotLotteryConfigSnapshot(config BotLotteryConfig) string {
	data, _ := json.Marshal(config)
	return string(data)
}

func chooseBotLotteryPrize(prizes []BotLotteryPrize) (BotLotteryPrize, error) {
	var total int64
	for _, prize := range prizes {
		total += prize.Weight
	}
	if total <= 0 {
		return BotLotteryPrize{}, ErrBotLotteryBadConfig
	}
	pick, err := rand.Int(rand.Reader, big.NewInt(total))
	if err != nil {
		return BotLotteryPrize{}, fmt.Errorf("choose bot lottery prize: %w", err)
	}
	remaining := pick.Int64()
	for _, prize := range prizes {
		if remaining < prize.Weight {
			return prize, nil
		}
		remaining -= prize.Weight
	}
	return BotLotteryPrize{}, ErrBotLotteryBadConfig
}

func (s *BotLotteryService) Start() {
	if s == nil {
		return
	}
	s.startOnce.Do(func() {
		ctx, cancel := context.WithCancel(context.Background())
		s.cancel = cancel
		go func() {
			defer close(s.done)
			ticker := time.NewTicker(2 * time.Second)
			defer ticker.Stop()
			for {
				runCtx, done := context.WithTimeout(ctx, 30*time.Second)
				if err := s.ProcessPendingGrantBatches(runCtx); err != nil && ctx.Err() == nil {
					log.Printf("[BotLottery] resume pending grants: %v", err)
				}
				done()
				select {
				case <-ctx.Done():
					return
				case <-ticker.C:
				case <-s.wake:
				}
			}
		}()
	})
}

func (s *BotLotteryService) Stop() {
	if s == nil {
		return
	}
	s.stopOnce.Do(func() { s.Start(); s.cancel(); <-s.done })
}

func (s *BotLotteryService) ProcessPendingGrantBatches(ctx context.Context) error {
	if s == nil || s.repo == nil {
		return ErrBotLotteryRepository
	}
	ids, err := s.repo.PendingGrantBatchIDs(ctx, 10)
	if err != nil {
		return err
	}
	var firstErr error
	for _, id := range ids {
		if err := s.repo.ProcessGrantBatch(ctx, id); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}
