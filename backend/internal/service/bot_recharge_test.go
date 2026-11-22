package service

import (
	"context"
	"encoding/base64"
	"errors"
	"image/png"
	"strings"
	"testing"
	"time"

	dbent "github.com/Wei-Shaw/sub2api/ent"
	"github.com/Wei-Shaw/sub2api/internal/payment"
	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/stretchr/testify/require"
)

type botRechargeConfigStub struct {
	config *PaymentConfig
	limits *MethodLimitsResponse
}

func (s *botRechargeConfigStub) GetPaymentConfig(context.Context) (*PaymentConfig, error) {
	return s.config, nil
}
func (s *botRechargeConfigStub) GetAvailableMethodLimits(context.Context) (*MethodLimitsResponse, error) {
	return s.limits, nil
}

type botRechargeRepoStub struct {
	record        *BotRechargeRequestRecord
	lookupErr     error
	claimUserID   int64
	claimBinding  int64
	claimPlatform string
	claimExternal string
}

func (s *botRechargeRepoStub) FindRequest(context.Context, int64, string) (*BotRechargeRequestRecord, error) {
	return s.record, s.lookupErr
}
func (s *botRechargeRepoStub) FindOrderRequest(context.Context, int64, int64) (*BotRechargeRequestRecord, error) {
	return s.record, nil
}
func (s *botRechargeRepoStub) LatestOrderID(context.Context, int64) (int64, error) {
	if s.record == nil {
		return 0, nil
	}
	return s.record.PaymentOrderID, nil
}
func (s *botRechargeRepoStub) ClaimCompletedNotifications(_ context.Context, userID, bindingID int64, platform, external string, _ int) ([]BotRechargeNotification, error) {
	s.claimUserID, s.claimBinding, s.claimPlatform, s.claimExternal = userID, bindingID, platform, external
	return []BotRechargeNotification{}, nil
}
func (s *botRechargeRepoStub) AckNotification(context.Context, int64, int64, int64) (bool, error) {
	return true, nil
}

type botRechargePaymentsStub struct {
	createCalls int
	getCalls    int
	params      CreateOrderRequest
	order       *dbent.PaymentOrder
	created     *CreateOrderResponse
	err         error
	onCreate    func()
}

func (s *botRechargePaymentsStub) CreateOrder(_ context.Context, req CreateOrderRequest) (*CreateOrderResponse, error) {
	s.createCalls++
	s.params = req
	if s.onCreate != nil {
		s.onCreate()
	}
	return s.created, s.err
}
func (s *botRechargePaymentsStub) GetOrder(_ context.Context, _ int64, userID int64) (*dbent.PaymentOrder, error) {
	s.getCalls++
	if s.order == nil || s.order.UserID != userID {
		return nil, ErrBotRechargeOrderUnavailable
	}
	return s.order, nil
}

func botRechargeTestConfig() *botRechargeConfigStub {
	return &botRechargeConfigStub{
		config: &PaymentConfig{Enabled: true},
		limits: &MethodLimitsResponse{Methods: map[string]MethodLimits{
			payment.TypeAlipay: {Currency: "CNY", SingleMin: 1, SingleMax: 100},
			payment.TypeWxpay:  {Currency: "CNY", SingleMin: 2, SingleMax: 200},
			payment.TypeStripe: {Currency: "USD", SingleMin: 3, SingleMax: 300},
		}},
	}
}

func botRechargeTestParams() BotRechargeCreateParams {
	return BotRechargeCreateParams{UserID: 7, BindingID: 9, Platform: "qq", ExternalID: "42", RequestID: "message-1", PaymentType: payment.TypeAlipay, Amount: 10}
}

func TestBotRechargeOptionsFollowBalanceSwitchAndLimitChannels(t *testing.T) {
	cfg := botRechargeTestConfig()
	cfg.config.MinAmount = 5
	cfg.config.MaxAmount = 150
	svc := &BotRechargeService{config: cfg}
	options, err := svc.Options(context.Background())
	require.NoError(t, err)
	require.True(t, options.Enabled)
	require.Equal(t, float64(5), options.MinAmount)
	require.Equal(t, float64(150), options.MaxAmount)
	require.Len(t, options.Methods, 2)
	require.Equal(t, 1.0, options.Methods[payment.TypeAlipay].Min)
	require.NotContains(t, options.Methods, payment.TypeStripe)
	cfg.config.BalanceDisabled = true
	options, err = svc.Options(context.Background())
	require.NoError(t, err)
	require.False(t, options.Enabled)
}

func TestBotRechargeCreateUsesOnlyBindingIdentityAndBalanceOrder(t *testing.T) {
	repo := &botRechargeRepoStub{}
	payments := &botRechargePaymentsStub{created: &CreateOrderResponse{OrderID: 51, Status: OrderStatusPending, Amount: 12, PayAmount: 10, QRCode: "weixin://wxpay/bizpayurl?pr=test"}}
	svc := &BotRechargeService{config: botRechargeTestConfig(), repo: repo, payments: payments}
	result, err := svc.CreateOrder(context.Background(), botRechargeTestParams())
	require.NoError(t, err)
	require.Equal(t, 1, payments.createCalls)
	require.Equal(t, payment.OrderTypeBalance, payments.params.OrderType)
	require.Equal(t, int64(7), payments.params.UserID)
	require.Equal(t, int64(9), payments.params.BotBindingID)
	require.Equal(t, "message-1", payments.params.BotRequestID)
	require.True(t, payments.params.BotPaymentRequired)
	require.Equal(t, "CNY", result.Currency)
	require.Equal(t, "USD", result.CreditedCurrency)
	require.Equal(t, 12.0, result.CreditedAmount)
	require.NotEmpty(t, result.QRCodePNGBase64)
}

func TestBotRechargeDuplicateReturnsOriginalOrderWithoutNewPayment(t *testing.T) {
	params := botRechargeTestParams()
	repo := &botRechargeRepoStub{record: &BotRechargeRequestRecord{PaymentOrderID: 51, BindingID: 9, Platform: "qq", ExternalID: "42", PaymentType: payment.TypeAlipay, Amount: 10}}
	payments := &botRechargePaymentsStub{order: &dbent.PaymentOrder{ID: 51, UserID: 7, Status: OrderStatusPaid, Amount: 12, PayAmount: 10, ExpiresAt: time.Now()}}
	// No config dependency: retrieval remains available after recharge is disabled.
	svc := &BotRechargeService{repo: repo, payments: payments}
	result, err := svc.CreateOrder(context.Background(), params)
	require.NoError(t, err)
	require.Equal(t, int64(51), result.OrderID)
	require.Equal(t, OrderStatusPaid, result.Status)
	require.Nil(t, result.CompletedAt)
	require.Zero(t, payments.createCalls)
	params.Amount = 11
	_, err = svc.CreateOrder(context.Background(), params)
	require.Equal(t, "BOT_RECHARGE_REQUEST_CONFLICT", infraerrors.Reason(err))
}

func TestBotRechargeLostResponseRecoversCommittedRequest(t *testing.T) {
	repo := &botRechargeRepoStub{}
	payments := &botRechargePaymentsStub{err: errors.New("gateway timeout"), order: &dbent.PaymentOrder{ID: 51, UserID: 7, Status: OrderStatusPending}}
	payments.onCreate = func() {
		repo.record = &BotRechargeRequestRecord{PaymentOrderID: 51, BindingID: 9, Platform: "qq", ExternalID: "42", PaymentType: payment.TypeAlipay, Amount: 10}
	}
	svc := &BotRechargeService{repo: repo, payments: payments, config: botRechargeTestConfig()}
	result, err := svc.CreateOrder(context.Background(), botRechargeTestParams())
	require.NoError(t, err)
	require.Equal(t, int64(51), result.OrderID)
	require.Equal(t, 1, payments.createCalls)
}

func TestBotRechargeRejectsFractionalMinorUnitsBeforeOrderCreation(t *testing.T) {
	repo := &botRechargeRepoStub{}
	payments := &botRechargePaymentsStub{}
	svc := &BotRechargeService{repo: repo, payments: payments, config: botRechargeTestConfig()}
	params := botRechargeTestParams()
	params.Amount = 10.001
	_, err := svc.CreateOrder(context.Background(), params)
	require.Equal(t, "INVALID_AMOUNT", infraerrors.Reason(err))
	require.Zero(t, payments.createCalls)
}

func TestBotRechargeNotificationUsesImmutableBindingScope(t *testing.T) {
	repo := &botRechargeRepoStub{}
	svc := &BotRechargeService{repo: repo}
	_, err := svc.Notifications(context.Background(), 7, 9, "qq", "42")
	require.NoError(t, err)
	require.Equal(t, int64(7), repo.claimUserID)
	require.Equal(t, int64(9), repo.claimBinding)
	require.Equal(t, "qq", repo.claimPlatform)
	require.Equal(t, "42", repo.claimExternal)
}

func TestBotRechargeRejectsBrowserSDKBeforePaymentCreation(t *testing.T) {
	for _, key := range []string{payment.TypeStripe, payment.TypeAirwallex, "unknown"} {
		err := validateBotRechargeSelection(&payment.InstanceSelection{ProviderKey: key})
		require.Equal(t, "BOT_RECHARGE_CHANNEL_UNAVAILABLE", infraerrors.Reason(err))
	}
	for _, key := range []string{payment.TypeAlipay, payment.TypeWxpay, payment.TypeEasyPay} {
		require.NoError(t, validateBotRechargeSelection(&payment.InstanceSelection{ProviderKey: key}))
	}
}

func TestBotRechargeQRCodePNGHasQuietZoneAndValidPNG(t *testing.T) {
	encoded := botRechargeQRCodePNG("weixin://wxpay/bizpayurl?pr=test")
	raw, err := base64.StdEncoding.DecodeString(encoded)
	require.NoError(t, err)
	img, err := png.Decode(strings.NewReader(string(raw)))
	require.NoError(t, err)
	require.Greater(t, img.Bounds().Dx(), 150)
	r, g, b, _ := img.At(0, 0).RGBA()
	require.Equal(t, uint32(65535), r)
	require.Equal(t, r, g)
	require.Equal(t, r, b)
	require.Empty(t, botRechargeQRCodePNG(""))
}
