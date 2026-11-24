//go:build unit

package service

import (
	"context"
	"errors"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestNotificationSettingsInvalidateAuthAfterCommit(t *testing.T) {
	for _, req := range []UpdateProfileRequest{
		{BalanceNotifyEnabled: boolPtr(true)},
		{BalanceNotifyThreshold: float64Ptr(2)},
	} {
		repo := &mockUserRepo{getByIDUser: &User{ID: 7, Status: StatusActive}}
		auth := &mockAuthCacheInvalidator{}
		svc := NewUserService(repo, nil, auth, nil)
		_, err := svc.UpdateProfile(context.Background(), 7, req)
		require.NoError(t, err)
		require.Equal(t, []int64{7}, auth.invalidatedUserIDs)
	}
	repo := &mockUserRepo{getByIDUser: &User{ID: 7}, updateFn: func(context.Context, *User) error { return errors.New("rollback") }}
	auth := &mockAuthCacheInvalidator{}
	svc := NewUserService(repo, nil, auth, nil)
	_, err := svc.UpdateProfile(context.Background(), 7, UpdateProfileRequest{BalanceNotifyThreshold: float64Ptr(2)})
	require.Error(t, err)
	require.Empty(t, auth.invalidatedUserIDs)
}

func TestNotificationEmailChangesInvalidateAuthOnlyAfterSave(t *testing.T) {
	for _, operation := range []string{"add", "verify", "remove", "disable", "failed save"} {
		t.Run(operation, func(t *testing.T) {
			u := &User{ID: 7, BalanceNotifyExtraEmails: []NotifyEmailEntry{{Email: "notify@example.test", Verified: operation != "verify"}}}
			repo := &mockUserRepo{getByIDUser: u}
			auth := &mockAuthCacheInvalidator{}
			svc := NewUserService(repo, nil, auth, nil)
			var err error
			switch operation {
			case "add":
				err = svc.addOrVerifyNotifyEmail(context.Background(), 7, "new@example.test")
			case "verify":
				err = svc.addOrVerifyNotifyEmail(context.Background(), 7, "notify@example.test")
			case "remove":
				err = svc.RemoveNotifyEmail(context.Background(), 7, "notify@example.test")
			case "disable":
				err = svc.ToggleNotifyEmail(context.Background(), 7, "notify@example.test", true)
			case "failed save":
				repo.updateFn = func(context.Context, *User) error { return errors.New("write failed") }
				err = svc.ToggleNotifyEmail(context.Background(), 7, "notify@example.test", true)
			}
			if operation == "failed save" {
				require.Error(t, err)
				require.Empty(t, auth.invalidatedUserIDs)
			} else {
				require.NoError(t, err)
				require.Equal(t, []int64{7}, auth.invalidatedUserIDs)
			}
		})
	}
}
