package service

import (
	"bytes"
	"context"
	"encoding/base64"
	"image"
	"image/color"
	"image/draw"
	"image/png"
	"math"
	"strings"
	"time"

	dbent "github.com/Wei-Shaw/sub2api/ent"
	"github.com/Wei-Shaw/sub2api/internal/payment"
	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/boombuler/barcode"
	"github.com/boombuler/barcode/qr"
)

const (
	botRechargeCurrency      = "USD"
	botRechargeRequestMaxLen = 160
)

var (
	ErrBotRechargeInvalidRequestID = infraerrors.BadRequest("BOT_RECHARGE_REQUEST_ID_REQUIRED", "request_id is required")
	ErrBotRechargeRequestConflict  = infraerrors.Conflict("BOT_RECHARGE_REQUEST_CONFLICT", "request_id was already used with different recharge parameters")
	ErrBotRechargeOrderUnavailable = infraerrors.NotFound("BOT_RECHARGE_ORDER_NOT_FOUND", "bot recharge order not found")
)

type BotRechargeRequestRecord struct {
	PaymentOrderID int64
	BindingID      int64
	Platform       string
	ExternalID     string
	PaymentType    string
	Amount         float64
}

type BotRechargeNotification struct {
	ID             int64
	OrderID        int64
	CreditedAmount float64
	Currency       string
	CreatedAt      time.Time
}

type BotRechargeRepository interface {
	FindRequest(ctx context.Context, userID int64, requestID string) (*BotRechargeRequestRecord, error)
	FindOrderRequest(ctx context.Context, userID, orderID int64) (*BotRechargeRequestRecord, error)
	LatestOrderID(ctx context.Context, userID int64) (int64, error)
	ClaimCompletedNotifications(ctx context.Context, userID, bindingID int64, platform, externalID string, limit int) ([]BotRechargeNotification, error)
	AckNotification(ctx context.Context, userID, bindingID, notificationID int64) (bool, error)
}

type BotRechargePaymentConfig interface {
	GetPaymentConfig(ctx context.Context) (*PaymentConfig, error)
	GetAvailableMethodLimits(ctx context.Context) (*MethodLimitsResponse, error)
}

type BotRechargeMethod struct {
	DisplayName string  `json:"display_name"`
	Currency    string  `json:"currency"`
	Min         float64 `json:"min"`
	Max         float64 `json:"max"`
}

type BotRechargeOptions struct {
	Enabled   bool                         `json:"enabled"`
	Methods   map[string]BotRechargeMethod `json:"methods"`
	MinAmount float64                      `json:"min_amount"`
	MaxAmount float64                      `json:"max_amount"`
}

type BotRechargeOrder struct {
	OrderID          int64      `json:"order_id"`
	Status           string     `json:"status"`
	PayAmount        float64    `json:"pay_amount"`
	Currency         string     `json:"currency"`
	PayCurrency      string     `json:"pay_currency,omitempty"`
	CreditedAmount   float64    `json:"credited_amount"`
	CreditedCurrency string     `json:"credited_currency"`
	PaymentType      string     `json:"payment_type,omitempty"`
	PayURL           string     `json:"pay_url,omitempty"`
	QRCode           string     `json:"qr_code,omitempty"`
	QRCodePNGBase64  string     `json:"qr_code_png_base64,omitempty"`
	ExpiresAt        time.Time  `json:"expires_at"`
	CompletedAt      *time.Time `json:"completed_at,omitempty"`
}

type BotRechargeCreateParams struct {
	UserID      int64
	BindingID   int64
	Platform    string
	ExternalID  string
	RequestID   string
	Amount      float64
	PaymentType string
	ClientIP    string
}

type BotRechargeService struct {
	payments botRechargePayments
	config   BotRechargePaymentConfig
	repo     BotRechargeRepository
}

type botRechargePayments interface {
	CreateOrder(ctx context.Context, req CreateOrderRequest) (*CreateOrderResponse, error)
	GetOrder(ctx context.Context, orderID, userID int64) (*dbent.PaymentOrder, error)
}

func NewBotRechargeService(payments *PaymentService, config *PaymentConfigService, repo BotRechargeRepository) *BotRechargeService {
	return &BotRechargeService{payments: payments, config: config, repo: repo}
}

func (s *BotRechargeService) Options(ctx context.Context) (*BotRechargeOptions, error) {
	if s == nil || s.config == nil {
		return nil, infraerrors.ServiceUnavailable("BOT_RECHARGE_UNAVAILABLE", "recharge service is unavailable")
	}
	cfg, err := s.config.GetPaymentConfig(ctx)
	if err != nil {
		return nil, err
	}
	limits, err := s.config.GetAvailableMethodLimits(ctx)
	if err != nil {
		return nil, err
	}
	if cfg == nil || limits == nil {
		return nil, infraerrors.ServiceUnavailable("BOT_RECHARGE_UNAVAILABLE", "recharge configuration is unavailable")
	}
	methods := make(map[string]BotRechargeMethod, 2)
	for _, method := range []string{payment.TypeAlipay, payment.TypeWxpay} {
		limit, ok := limits.Methods[method]
		if !ok {
			continue
		}
		displayName := strings.TrimSpace(limit.DisplayName)
		if displayName == "" {
			displayName = map[string]string{payment.TypeAlipay: "支付宝", payment.TypeWxpay: "微信支付"}[method]
		}
		methods[method] = BotRechargeMethod{
			DisplayName: displayName,
			Currency:    limit.Currency,
			Min:         limit.SingleMin,
			Max:         limit.SingleMax,
		}
	}
	return &BotRechargeOptions{
		Enabled:   cfg.Enabled && !cfg.BalanceDisabled && len(methods) > 0,
		Methods:   methods,
		MinAmount: cfg.MinAmount,
		MaxAmount: cfg.MaxAmount,
	}, nil
}

// Browser-SDK-only providers must be rejected before a payable order exists.
// Official Alipay, native WeChat Pay and EasyPay provide URL/QR checkout flows.
func validateBotRechargeSelection(sel *payment.InstanceSelection) error {
	if sel == nil {
		return infraerrors.ServiceUnavailable("BOT_RECHARGE_CHANNEL_UNAVAILABLE", "payment channel is not available for bot checkout")
	}
	switch strings.ToLower(strings.TrimSpace(sel.ProviderKey)) {
	case payment.TypeAlipay, payment.TypeWxpay, payment.TypeEasyPay:
		return nil
	default:
		return infraerrors.ServiceUnavailable("BOT_RECHARGE_CHANNEL_UNAVAILABLE", "payment channel requires a browser payment SDK")
	}
}

func (s *BotRechargeService) CreateOrder(ctx context.Context, params BotRechargeCreateParams) (*BotRechargeOrder, error) {
	if s == nil || s.payments == nil || s.repo == nil {
		return nil, infraerrors.ServiceUnavailable("BOT_RECHARGE_UNAVAILABLE", "recharge service is unavailable")
	}
	requestID := strings.TrimSpace(params.RequestID)
	if requestID == "" || len(requestID) > botRechargeRequestMaxLen {
		return nil, ErrBotRechargeInvalidRequestID
	}
	if params.UserID <= 0 || params.BindingID <= 0 || strings.TrimSpace(params.Platform) == "" || strings.TrimSpace(params.ExternalID) == "" {
		return nil, infraerrors.BadRequest("BOT_RECHARGE_CONTEXT_INVALID", "bot recharge binding context is invalid")
	}
	paymentType := NormalizeVisibleMethod(params.PaymentType)
	prior, err := s.repo.FindRequest(ctx, params.UserID, requestID)
	if err != nil {
		return nil, err
	}
	if prior != nil {
		if !sameBotRechargeRequest(prior, params, paymentType) {
			return nil, ErrBotRechargeRequestConflict
		}
		return s.orderFromRecord(ctx, params.UserID, prior)
	}
	if paymentType != payment.TypeAlipay && paymentType != payment.TypeWxpay {
		return nil, infraerrors.BadRequest("BOT_RECHARGE_METHOD_UNSUPPORTED", "only Alipay and WeChat Pay are available for bot recharge")
	}
	if math.IsNaN(params.Amount) || math.IsInf(params.Amount, 0) || params.Amount <= 0 {
		return nil, infraerrors.BadRequest("INVALID_AMOUNT", "amount must be a positive number")
	}
	options, err := s.Options(ctx)
	if err != nil {
		return nil, err
	}
	if !options.Enabled {
		return nil, infraerrors.Forbidden("BOT_RECHARGE_DISABLED", "bot recharge is currently unavailable")
	}
	method, ok := options.Methods[paymentType]
	if !ok {
		return nil, infraerrors.ServiceUnavailable("BOT_RECHARGE_CHANNEL_UNAVAILABLE", "payment channel is not available for bot checkout")
	}
	if err := validateCreateOrderAmountCurrency(params.Amount, method.Currency); err != nil {
		return nil, err
	}

	created, createErr := s.payments.CreateOrder(ctx, CreateOrderRequest{
		UserID: params.UserID, Amount: params.Amount, PaymentType: paymentType,
		ClientIP: params.ClientIP, OrderType: payment.OrderTypeBalance, PaymentSource: "bot",
		BotRequestID: requestID, BotBindingID: params.BindingID,
		BotPlatform: strings.TrimSpace(params.Platform), BotExternalID: strings.TrimSpace(params.ExternalID),
		BotPaymentRequired: true,
	})
	if createErr != nil {
		// If another concurrent request committed the key first, return its order
		// instead of creating or exposing a second payment attempt.
		prior, lookupErr := s.repo.FindRequest(ctx, params.UserID, requestID)
		if lookupErr != nil {
			return nil, createErr
		}
		if prior == nil {
			return nil, createErr
		}
		if !sameBotRechargeRequest(prior, params, paymentType) {
			return nil, ErrBotRechargeRequestConflict
		}
		return s.orderFromRecord(ctx, params.UserID, prior)
	}
	if created == nil || created.OrderID <= 0 {
		return nil, infraerrors.ServiceUnavailable("BOT_RECHARGE_ORDER_UNAVAILABLE", "payment provider did not create an order")
	}
	return &BotRechargeOrder{
		OrderID: created.OrderID, Status: created.Status, PayAmount: created.PayAmount,
		Currency:       s.resolvePaymentCurrency(ctx, paymentType, created.Currency),
		PayCurrency:    s.resolvePaymentCurrency(ctx, paymentType, created.Currency),
		CreditedAmount: created.Amount, PaymentType: paymentType,
		CreditedCurrency: botRechargeCurrency,
		PayURL:           created.PayURL, QRCode: created.QRCode, ExpiresAt: created.ExpiresAt,
		QRCodePNGBase64: botRechargeQRCodePNG(created.QRCode),
	}, nil
}

func sameBotRechargeRequest(record *BotRechargeRequestRecord, params BotRechargeCreateParams, paymentType string) bool {
	if record == nil {
		return false
	}
	return record.PaymentType == paymentType && record.BindingID == params.BindingID &&
		record.Platform == strings.TrimSpace(params.Platform) && record.ExternalID == strings.TrimSpace(params.ExternalID) &&
		record.Amount == params.Amount
}

func (s *BotRechargeService) Order(ctx context.Context, userID, orderID int64) (*BotRechargeOrder, error) {
	if s == nil || s.repo == nil || s.payments == nil {
		return nil, infraerrors.ServiceUnavailable("BOT_RECHARGE_UNAVAILABLE", "recharge service is unavailable")
	}
	record, err := s.repo.FindOrderRequest(ctx, userID, orderID)
	if err != nil {
		return nil, err
	}
	if record == nil {
		return nil, ErrBotRechargeOrderUnavailable
	}
	return s.orderFromRecord(ctx, userID, record)
}

func (s *BotRechargeService) LatestOrder(ctx context.Context, userID int64) (*BotRechargeOrder, error) {
	if s == nil || s.repo == nil {
		return nil, infraerrors.ServiceUnavailable("BOT_RECHARGE_UNAVAILABLE", "recharge service is unavailable")
	}
	orderID, err := s.repo.LatestOrderID(ctx, userID)
	if err != nil {
		return nil, err
	}
	if orderID <= 0 {
		return nil, ErrBotRechargeOrderUnavailable
	}
	return s.Order(ctx, userID, orderID)
}

func (s *BotRechargeService) orderFromRecord(ctx context.Context, userID int64, record *BotRechargeRequestRecord) (*BotRechargeOrder, error) {
	order, err := s.payments.GetOrder(ctx, record.PaymentOrderID, userID)
	if err != nil {
		return nil, err
	}
	qrCode := ""
	if order.QrCode != nil {
		qrCode = *order.QrCode
	}
	payURL := ""
	if order.PayURL != nil {
		payURL = *order.PayURL
	}
	var completedAt *time.Time
	if order.CompletedAt != nil {
		value := order.CompletedAt.UTC()
		completedAt = &value
	}
	return &BotRechargeOrder{
		OrderID: order.ID, Status: order.Status, PayAmount: order.PayAmount,
		Currency:       s.resolvePaymentCurrency(ctx, order.PaymentType, botRechargePaymentCurrency(order)),
		PayCurrency:    s.resolvePaymentCurrency(ctx, order.PaymentType, botRechargePaymentCurrency(order)),
		CreditedAmount: order.Amount, PaymentType: order.PaymentType,
		CreditedCurrency: botRechargeCurrency,
		PayURL:           payURL, QRCode: qrCode, ExpiresAt: order.ExpiresAt.UTC(),
		QRCodePNGBase64: botRechargeQRCodePNG(qrCode),
		CompletedAt:     completedAt,
	}, nil
}

// Include a four-module quiet zone and scale by whole QR modules so the
// payment payload remains scannable after normal QQ image handling.
func botRechargeQRCodePNG(payload string) string {
	if strings.TrimSpace(payload) == "" {
		return ""
	}
	encoded, err := qr.Encode(payload, qr.M, qr.Auto)
	if err != nil {
		return ""
	}
	modules := encoded.Bounds().Dx()
	scale := 6
	if modules > 85 {
		scale = 4
	}
	code, err := barcode.Scale(encoded, modules*scale, modules*scale)
	if err != nil {
		return ""
	}
	quiet := 4 * scale
	canvas := image.NewRGBA(image.Rect(0, 0, modules*scale+2*quiet, modules*scale+2*quiet))
	draw.Draw(canvas, canvas.Bounds(), &image.Uniform{C: color.White}, image.Point{}, draw.Src)
	draw.Draw(canvas, code.Bounds().Add(image.Pt(quiet, quiet)), code, image.Point{}, draw.Src)
	var output bytes.Buffer
	if err := png.Encode(&output, canvas); err != nil {
		return ""
	}
	return base64.StdEncoding.EncodeToString(output.Bytes())
}

func (s *BotRechargeService) resolvePaymentCurrency(ctx context.Context, method, providerCurrency string) string {
	if currency := strings.ToUpper(strings.TrimSpace(providerCurrency)); currency != "" {
		return currency
	}
	if s != nil && s.config != nil {
		limits, err := s.config.GetAvailableMethodLimits(ctx)
		if err == nil && limits != nil {
			if methodLimit, ok := limits.Methods[NormalizeVisibleMethod(method)]; ok && strings.TrimSpace(methodLimit.Currency) != "" {
				return strings.ToUpper(strings.TrimSpace(methodLimit.Currency))
			}
		}
	}
	return payment.DefaultPaymentCurrency
}

func botRechargePaymentCurrency(order *dbent.PaymentOrder) string {
	if order != nil && order.ProviderSnapshot != nil {
		if currency, ok := order.ProviderSnapshot["currency"].(string); ok && strings.TrimSpace(currency) != "" {
			return strings.ToUpper(strings.TrimSpace(currency))
		}
	}
	return payment.DefaultPaymentCurrency
}

func (s *BotRechargeService) Notifications(ctx context.Context, userID, bindingID int64, platform, externalID string) ([]BotRechargeNotification, error) {
	if s == nil || s.repo == nil {
		return nil, infraerrors.ServiceUnavailable("BOT_RECHARGE_UNAVAILABLE", "recharge service is unavailable")
	}
	if userID <= 0 || bindingID <= 0 || strings.TrimSpace(platform) == "" || strings.TrimSpace(externalID) == "" {
		return nil, infraerrors.BadRequest("BOT_RECHARGE_CONTEXT_INVALID", "bot recharge binding context is invalid")
	}
	return s.repo.ClaimCompletedNotifications(ctx, userID, bindingID, platform, externalID, 20)
}

func (s *BotRechargeService) AckNotification(ctx context.Context, userID, bindingID, notificationID int64) (bool, error) {
	if s == nil || s.repo == nil {
		return false, infraerrors.ServiceUnavailable("BOT_RECHARGE_UNAVAILABLE", "recharge service is unavailable")
	}
	if userID <= 0 || bindingID <= 0 || notificationID <= 0 {
		return false, infraerrors.BadRequest("BOT_RECHARGE_CONTEXT_INVALID", "notification context is invalid")
	}
	return s.repo.AckNotification(ctx, userID, bindingID, notificationID)
}
