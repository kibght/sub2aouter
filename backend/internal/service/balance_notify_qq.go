package service

import (
	"context"
	"time"

	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
)

var ErrQQBalanceNotificationBindingRequired = infraerrors.BadRequest(
	"QQ_BINDING_REQUIRED",
	"An active QQ bot binding is required to enable QQ balance notifications",
)

var ErrQQBalanceNotificationRequiresGeneral = infraerrors.BadRequest(
	"BALANCE_NOTIFY_DISABLED",
	"General balance notifications must be enabled before enabling QQ alerts",
)

// BalanceLowQQAlert is a balance threshold alert queued for one bound QQ account.
type BalanceLowQQAlert struct {
	ID          int64     `json:"id"`
	UserID      int64     `json:"user_id,omitempty"`
	Balance     float64   `json:"current_balance"`
	Threshold   float64   `json:"threshold"`
	SiteName    string    `json:"site_name"`
	RechargeURL string    `json:"recharge_url"`
	CreatedAt   time.Time `json:"created_at"`
}

// BalanceNotifyQQRepository stores balance alerts until the owning QQ binding
// confirms that its private-message send completed.
type BalanceNotifyQQRepository interface {
	EnqueueBalanceLow(ctx context.Context, userID int64, alert BalanceLowQQAlert) error
	HasActiveQQBinding(ctx context.Context, userID int64) (bool, error)
	GetQQBalanceNotifyEnabled(ctx context.Context, userID int64) (bool, error)
	SetQQBalanceNotifyEnabled(ctx context.Context, userID int64, enabled bool) error
	ClaimBalanceLow(ctx context.Context, userID, bindingID int64, now, leaseUntil time.Time, limit int) ([]BalanceLowQQAlert, error)
	AckBalanceLow(ctx context.Context, userID, bindingID, alertID int64) error
}
