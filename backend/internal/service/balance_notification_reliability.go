package service

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	balanceReconcileInterval = 5 * time.Minute
	balanceReconcileBatch    = 200
	balanceQueryTimeout      = 2 * time.Second
	balanceEmailLease        = 2 * time.Minute
)

// BalanceEmailDelivery is one independently leased recipient in a low-balance event.
type BalanceEmailDelivery struct {
	ID, EventID, UserID int64
	Recipient, Name     string
	Balance, Threshold  float64
	RechargeURL         string
	Attempts            int
	Eligible            bool
}

// BalanceNotificationRepository never reads usage logs. Balance changes register
// events atomically in their transaction; reconciliation repairs known missed work.
type BalanceNotificationRepository interface {
	ReconcileBatch(context.Context, int64, int) (int64, int, error)
	ClaimEmails(context.Context, time.Time, time.Time, int) ([]BalanceEmailDelivery, error)
	FinishEmail(context.Context, BalanceEmailDelivery, string, time.Time, string) error
}

type balanceEmailSender interface {
	SendWithOutcome(context.Context, NotificationEmailSendInput) (NotificationEmailSendOutcome, error)
}

type balanceNotificationWorker struct {
	repo        BalanceNotificationRepository
	sender      balanceEmailSender
	ctx         context.Context
	cancel      context.CancelFunc
	wg          sync.WaitGroup
	stopOnce    sync.Once
	reconciling atomic.Bool
}

func (s *BalanceNotifyService) SetBalanceNotificationRepository(repo BalanceNotificationRepository) {
	s.reliabilityRepo = repo
}

// StartReliability is called only after all dependencies have been attached.
func (s *BalanceNotifyService) StartReliability() {
	if s.reliabilityRepo == nil || s.notificationEmailService == nil || s.reliability != nil {
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	w := &balanceNotificationWorker{repo: s.reliabilityRepo, sender: s.notificationEmailService, ctx: ctx, cancel: cancel}
	s.reliability = w
	w.wg.Add(2)
	go func() {
		defer w.wg.Done()
		ticker := time.NewTicker(balanceReconcileInterval)
		defer ticker.Stop()
		for {
			w.reconcile()
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
		}
	}()
	go func() {
		defer w.wg.Done()
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		for {
			w.deliver()
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
		}
	}()
}

func (w *balanceNotificationWorker) stop() {
	if w == nil {
		return
	}
	w.stopOnce.Do(func() { w.cancel(); w.wg.Wait() })
}

func (w *balanceNotificationWorker) reconcile() {
	if !w.reconciling.CompareAndSwap(false, true) {
		return
	}
	defer w.reconciling.Store(false)
	defer func() {
		if recover() != nil {
			slog.Error("panic in balance notification reconciliation")
		}
	}()
	var cursor int64
	for w.ctx.Err() == nil {
		ctx, cancel := context.WithTimeout(w.ctx, balanceQueryTimeout)
		next, count, err := w.repo.ReconcileBatch(ctx, cursor, balanceReconcileBatch)
		cancel()
		if err != nil {
			slog.Warn("balance notification reconciliation failed", "after_user_id", cursor)
			return
		}
		if count == 0 || next <= cursor {
			return
		}
		cursor = next
		if count < balanceReconcileBatch {
			return
		}
	}
}

func balanceEmailRetryDelay(attempt int) time.Duration {
	switch attempt {
	case 1:
		return time.Minute
	case 2:
		return 5 * time.Minute
	case 3:
		return 15 * time.Minute
	default:
		return time.Hour
	}
}

func balanceEmailFailureCode(err error) string {
	var templateErr notificationEmailTemplateError
	switch {
	case errors.Is(err, ErrEmailNotConfigured):
		return "smtp_not_configured"
	case errors.Is(err, context.DeadlineExceeded):
		return "timeout"
	case errors.As(err, &templateErr):
		return "template_invalid"
	case strings.Contains(err.Error(), "smtp auth"):
		return "smtp_auth_failed"
	case strings.Contains(err.Error(), "smtp dial"):
		return "smtp_connect_failed"
	case strings.Contains(err.Error(), "smtp rcpt"):
		return "recipient_rejected"
	default:
		return "delivery_failed"
	}
}

func (w *balanceNotificationWorker) deliver() {
	defer func() {
		if recover() != nil {
			slog.Error("panic in balance notification delivery")
		}
	}()
	ctx, cancel := context.WithTimeout(w.ctx, balanceQueryTimeout)
	now := time.Now().UTC()
	// Lease one at a time so a slow SMTP server cannot exhaust other leases.
	deliveries, err := w.repo.ClaimEmails(ctx, now, now.Add(balanceEmailLease), 1)
	cancel()
	if err != nil {
		if w.ctx.Err() == nil {
			slog.Warn("balance notification email claim failed")
		}
		return
	}
	for _, d := range deliveries {
		if w.ctx.Err() != nil {
			return
		} // persisted lease expires after shutdown
		status, errorCode := "cancelled", ""
		var retryAt time.Time
		if d.Eligible {
			ctx, cancel := context.WithTimeout(w.ctx, emailSendTimeout)
			outcome, sendErr := w.sender.SendWithOutcome(ctx, NotificationEmailSendInput{
				Event: NotificationEmailEventBalanceLow, UserID: d.UserID,
				RecipientEmail: d.Recipient, RecipientName: d.Name,
				SourceType: "balance_event", SourceID: strconv.FormatInt(d.EventID, 10), ReminderKey: "once",
				Variables: map[string]string{"current_balance": fmt.Sprintf("%.2f", d.Balance), "threshold": fmt.Sprintf("%.2f", d.Threshold), "recharge_url": d.RechargeURL},
			})
			cancel()
			switch {
			case sendErr != nil:
				status, errorCode = "pending", balanceEmailFailureCode(sendErr)
				retryAt = time.Now().UTC().Add(balanceEmailRetryDelay(d.Attempts))
			case outcome == NotificationEmailSuppressed:
				status = "suppressed"
			case outcome == NotificationEmailSent || outcome == NotificationEmailAlreadySent:
				status = "sent"
			default:
				status = "cancelled"
			}
		}
		ctx, cancel := context.WithTimeout(w.ctx, balanceQueryTimeout)
		err := w.repo.FinishEmail(ctx, d, status, retryAt, errorCode)
		cancel()
		if err != nil {
			slog.Warn("balance notification email result persistence failed", "delivery_id", d.ID)
		} else {
			slog.Info("balance notification email result", "delivery_id", d.ID, "event_id", d.EventID, "status", status, "attempt", d.Attempts, "error_code", errorCode)
		}
	}
}
