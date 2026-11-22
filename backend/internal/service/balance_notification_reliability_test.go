package service

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

type balanceDeliveryTestRepo struct {
	deliveries    []BalanceEmailDelivery
	result        string
	retry         time.Time
	code          string
	claimDeadline time.Duration
	batch         func(context.Context, int64, int) (int64, int, error)
}

func (r *balanceDeliveryTestRepo) ReconcileBatch(ctx context.Context, id int64, limit int) (int64, int, error) {
	if r.batch != nil {
		return r.batch(ctx, id, limit)
	}
	return 0, 0, nil
}
func (r *balanceDeliveryTestRepo) ClaimEmails(ctx context.Context, now, lease time.Time, limit int) ([]BalanceEmailDelivery, error) {
	if d, ok := ctx.Deadline(); ok {
		r.claimDeadline = time.Until(d)
	}
	return r.deliveries, nil
}
func (r *balanceDeliveryTestRepo) FinishEmail(_ context.Context, _ BalanceEmailDelivery, status string, retry time.Time, code string) error {
	r.result, r.retry, r.code = status, retry, code
	return nil
}

type balanceDeliveryTestSender struct {
	calls   int
	outcome NotificationEmailSendOutcome
	err     error
	input   NotificationEmailSendInput
}

func (s *balanceDeliveryTestSender) SendWithOutcome(_ context.Context, input NotificationEmailSendInput) (NotificationEmailSendOutcome, error) {
	s.calls++
	s.input = input
	return s.outcome, s.err
}

func TestBalanceReliabilityDeliveryOutcomesAndRetry(t *testing.T) {
	for _, tc := range []struct {
		name     string
		eligible bool
		outcome  NotificationEmailSendOutcome
		err      error
		want     string
		calls    int
	}{
		{"smtp accepted", true, NotificationEmailSent, nil, "sent", 1},
		{"previously sent", true, NotificationEmailAlreadySent, nil, "sent", 1},
		{"unsubscribe", true, NotificationEmailSuppressed, nil, "suppressed", 1},
		{"smtp failure", true, "", errors.New("temporary"), "pending", 1},
		{"disabled or recovered", false, "", nil, "cancelled", 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := &balanceDeliveryTestRepo{deliveries: []BalanceEmailDelivery{{ID: 1, EventID: 2, UserID: 3, Recipient: "recipient@example.test", Eligible: tc.eligible, Attempts: 2}}}
			s := &balanceDeliveryTestSender{outcome: tc.outcome, err: tc.err}
			w := &balanceNotificationWorker{repo: r, sender: s, ctx: context.Background()}
			before := time.Now()
			w.deliver()
			require.Equal(t, tc.want, r.result)
			require.Equal(t, tc.calls, s.calls)
			require.Positive(t, r.claimDeadline)
			require.LessOrEqual(t, r.claimDeadline, balanceQueryTimeout)
			if tc.want == "pending" {
				require.WithinDuration(t, before.Add(5*time.Minute), r.retry, time.Second)
				require.Equal(t, "delivery_failed", r.code)
			}
			if tc.calls > 0 {
				require.Equal(t, "balance_event", s.input.SourceType)
				require.Equal(t, "2", s.input.SourceID)
				require.Equal(t, "once", s.input.ReminderKey)
			}
		})
	}
	for n, want := range []time.Duration{time.Minute, 5 * time.Minute, 15 * time.Minute, time.Hour, time.Hour, time.Hour} {
		require.Equal(t, want, balanceEmailRetryDelay(n+1))
	}
}

func TestBalanceReliabilityReconciliationIsBoundedAndDoesNotOverlap(t *testing.T) {
	started, release := make(chan struct{}), make(chan struct{})
	var mu sync.Mutex
	var cursors []int64
	r := &balanceDeliveryTestRepo{batch: func(ctx context.Context, id int64, limit int) (int64, int, error) {
		require.Equal(t, 200, limit)
		deadline, ok := ctx.Deadline()
		require.True(t, ok)
		require.LessOrEqual(t, time.Until(deadline), 2*time.Second)
		mu.Lock()
		cursors = append(cursors, id)
		mu.Unlock()
		if id == 0 {
			close(started)
			<-release
			return 200, 200, nil
		}
		return 201, 1, nil
	}}
	w := &balanceNotificationWorker{repo: r, ctx: context.Background()}
	done := make(chan struct{})
	go func() { w.reconcile(); close(done) }()
	<-started
	w.reconcile()
	close(release)
	<-done
	require.Equal(t, []int64{0, 200}, cursors)
}

func TestBalanceReliabilityShutdownLeavesLeaseForRestart(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	r := &balanceDeliveryTestRepo{deliveries: []BalanceEmailDelivery{{ID: 1, Eligible: true}}}
	s := &balanceDeliveryTestSender{}
	w := &balanceNotificationWorker{repo: r, sender: s, ctx: ctx}
	w.deliver()
	require.Zero(t, s.calls)
	require.Empty(t, r.result)
}

func TestBalanceReliabilitySenderReportsSuppressionAndPriorSuccess(t *testing.T) {
	ctx := context.Background()
	repo := newNotificationEmailMemorySettingRepo()
	svc := NewNotificationEmailService(repo, nil)
	input := NotificationEmailSendInput{Event: NotificationEmailEventBalanceLow, RecipientEmail: "recipient@example.test", SourceType: "balance_event", SourceID: "12", ReminderKey: "once"}
	require.NoError(t, repo.Set(ctx, notificationEmailPreferenceKey(input.Event, input.RecipientEmail), "unsubscribed"))
	outcome, err := svc.SendWithOutcome(ctx, input)
	require.NoError(t, err)
	require.Equal(t, NotificationEmailSuppressed, outcome)
	require.NoError(t, repo.Set(ctx, notificationEmailPreferenceKey(input.Event, input.RecipientEmail), "subscribed"))
	require.NoError(t, repo.Set(ctx, notificationEmailDeliveryKey(input.Event, input.SourceType, input.SourceID, input.RecipientEmail, input.ReminderKey), "accepted"))
	outcome, err = svc.SendWithOutcome(ctx, input)
	require.NoError(t, err)
	require.Equal(t, NotificationEmailAlreadySent, outcome)
}
