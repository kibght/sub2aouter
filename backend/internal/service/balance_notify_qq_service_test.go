//go:build unit

package service

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

type stubBalanceNotifyQQRepository struct {
	alerts []BalanceLowQQAlert
	setErr error
	sets   []bool
}

func (s *stubBalanceNotifyQQRepository) EnqueueBalanceLow(_ context.Context, _ int64, alert BalanceLowQQAlert) error {
	s.alerts = append(s.alerts, alert)
	return nil
}
func (s *stubBalanceNotifyQQRepository) HasActiveQQBinding(context.Context, int64) (bool, error) {
	return true, nil
}
func (s *stubBalanceNotifyQQRepository) GetQQBalanceNotifyEnabled(context.Context, int64) (bool, error) {
	return true, nil
}
func (s *stubBalanceNotifyQQRepository) SetQQBalanceNotifyEnabled(_ context.Context, _ int64, enabled bool) error {
	s.sets = append(s.sets, enabled)
	return s.setErr
}
func (s *stubBalanceNotifyQQRepository) ClaimBalanceLow(context.Context, int64, int64, time.Time, time.Time, int) ([]BalanceLowQQAlert, error) {
	return nil, nil
}
func (s *stubBalanceNotifyQQRepository) AckBalanceLow(context.Context, int64, int64, int64) error {
	return nil
}

func TestCheckBalanceAfterDeductionQueuesQQAlertWithoutEmailService(t *testing.T) {
	settings := newMockSettingRepo()
	settings.data[SettingKeyBalanceLowNotifyEnabled] = "true"
	settings.data[SettingKeyBalanceLowNotifyThreshold] = "5"
	queue := &stubBalanceNotifyQQRepository{}
	svc := NewBalanceNotifyService(nil, settings, nil)
	svc.SetBalanceNotifyQQRepository(queue)

	svc.CheckBalanceAfterDeduction(context.Background(), &User{
		ID:                   7,
		BalanceNotifyEnabled: true,
		Username:             "alice",
	}, 6, 2)

	require.Len(t, queue.alerts, 1)
	require.Equal(t, 4.0, queue.alerts[0].Balance)
	require.Equal(t, 5.0, queue.alerts[0].Threshold)
	require.NotZero(t, queue.alerts[0].CreatedAt)
}

func TestCheckBalanceAfterDeductionDoesNotQueueWithoutCrossing(t *testing.T) {
	settings := newMockSettingRepo()
	settings.data[SettingKeyBalanceLowNotifyEnabled] = "true"
	settings.data[SettingKeyBalanceLowNotifyThreshold] = "5"
	queue := &stubBalanceNotifyQQRepository{}
	svc := NewBalanceNotifyService(nil, settings, nil)
	svc.SetBalanceNotifyQQRepository(queue)

	svc.CheckBalanceAfterDeduction(context.Background(), &User{ID: 7, BalanceNotifyEnabled: true}, 4, 1)

	require.Empty(t, queue.alerts)
}

func TestUpdateProfileRejectsQQAlertsWithoutGeneralToggle(t *testing.T) {
	users := &mockUserRepo{getByIDUser: &User{ID: 7, BalanceNotifyEnabled: false}}
	queue := &stubBalanceNotifyQQRepository{}
	svc := NewUserService(users, nil, nil, nil)
	svc.SetBalanceNotifyQQRepository(queue)

	_, err := svc.UpdateProfile(context.Background(), 7, UpdateProfileRequest{BalanceNotifyQQEnabled: boolPointer(true)})

	require.ErrorIs(t, err, ErrQQBalanceNotificationRequiresGeneral)
	require.Empty(t, queue.sets)
}

func TestUpdateProfilePropagatesMissingQQBindingFromRepository(t *testing.T) {
	users := &mockUserRepo{getByIDUser: &User{ID: 7, BalanceNotifyEnabled: true}}
	queue := &stubBalanceNotifyQQRepository{setErr: ErrQQBalanceNotificationBindingRequired}
	svc := NewUserService(users, nil, nil, nil)
	svc.SetBalanceNotifyQQRepository(queue)

	_, err := svc.UpdateProfile(context.Background(), 7, UpdateProfileRequest{BalanceNotifyQQEnabled: boolPointer(true)})

	require.ErrorIs(t, err, ErrQQBalanceNotificationBindingRequired)
	require.Equal(t, []bool{true}, queue.sets)
}

func boolPointer(value bool) *bool {
	return &value
}
