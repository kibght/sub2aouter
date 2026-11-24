//go:build integration

package repository

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/Wei-Shaw/sub2api/migrations"
	"github.com/stretchr/testify/require"
)

func balanceReliabilitySettings(t *testing.T) {
	t.Helper()
	for key, value := range map[string]string{"balance_low_notify_enabled": "true", "balance_low_notify_threshold": "10"} {
		var previous string
		err := integrationDB.QueryRow("SELECT value FROM settings WHERE key=$1", key).Scan(&previous)
		existed := err == nil
		require.NoError(t, func() error {
			_, e := integrationDB.Exec("INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value", key, value)
			return e
		}())
		t.Cleanup(func() {
			if existed {
				_, e := integrationDB.Exec("UPDATE settings SET value=$2 WHERE key=$1", key, previous)
				require.NoError(t, e)
			} else {
				_, e := integrationDB.Exec("DELETE FROM settings WHERE key=$1", key)
				require.NoError(t, e)
			}
		})
	}
}

func balanceReliabilityUser(t *testing.T, balance float64) (int64, int64) {
	t.Helper()
	u := mustCreateBotBindingUser(t, testEntClient(t), &service.User{Email: fmt.Sprintf("balance-reliable-%d@example.test", time.Now().UnixNano()), Balance: balance, Status: service.StatusActive})
	_, err := integrationDB.Exec(`UPDATE users SET balance_notify_enabled=TRUE,balance_notify_threshold=10,
		balance_notify_extra_emails='[{"email":"Recipient@example.test","verified":true},{"email":"recipient@example.test","verified":true},{"email":"unverified@example.test","verified":false},{"email":"disabled@example.test","verified":true,"disabled":true}]' WHERE id=$1`, u.ID)
	require.NoError(t, err)
	var binding int64
	require.NoError(t, integrationDB.QueryRow(`INSERT INTO bot_bindings(user_id,platform,external_id,token_hash) VALUES($1,'qq',$2,$3) RETURNING id`, u.ID, fmt.Sprint(u.ID), service.HashBotBindingSecret(fmt.Sprint(u.ID))).Scan(&binding))
	_, err = integrationDB.Exec("INSERT INTO user_balance_notify_qq(user_id,enabled) VALUES($1,TRUE)", u.ID)
	require.NoError(t, err)
	_, err = integrationDB.Exec("SELECT reconcile_balance_notification($1)", u.ID)
	require.NoError(t, err)
	return u.ID, binding
}

func balanceReliabilityCount(t *testing.T, query string, id int64) int {
	t.Helper()
	var count int
	require.NoError(t, integrationDB.QueryRow(query, id).Scan(&count))
	return count
}

func TestBalanceReliabilityTriggerAtomicRollbackDedupAndRecovery(t *testing.T) {
	balanceReliabilitySettings(t)
	uid, binding := balanceReliabilityUser(t, 12)
	ctx := context.Background()
	tx, err := integrationDB.BeginTx(ctx, nil)
	require.NoError(t, err)
	_, err = tx.Exec("UPDATE users SET balance=9 WHERE id=$1", uid)
	require.NoError(t, err)
	var count int
	require.NoError(t, tx.QueryRow("SELECT count(*) FROM balance_notification_events WHERE user_id=$1", uid).Scan(&count))
	require.Equal(t, 1, count)
	require.NoError(t, tx.Rollback())
	require.Zero(t, balanceReliabilityCount(t, "SELECT count(*) FROM balance_notification_events WHERE user_id=$1", uid))

	var wg sync.WaitGroup
	errs := make(chan error, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, e := integrationDB.Exec("UPDATE users SET balance=balance-0.5 WHERE id=$1", uid)
			errs <- e
		}()
	}
	wg.Wait()
	close(errs)
	for e := range errs {
		require.NoError(t, e)
	}
	require.Equal(t, 1, balanceReliabilityCount(t, "SELECT count(*) FROM balance_notification_events WHERE user_id=$1", uid))
	require.Equal(t, 1, balanceReliabilityCount(t, "SELECT count(*) FROM balance_notification_emails d JOIN balance_notification_events e ON e.id=d.event_id WHERE e.user_id=$1", uid))
	require.Equal(t, 1, balanceReliabilityCount(t, "SELECT count(*) FROM balance_low_qq_deliveries WHERE user_id=$1", uid))
	qq := NewBalanceNotifyQQRepository(integrationDB)
	now := time.Now().UTC()
	alerts, err := qq.ClaimBalanceLow(ctx, uid, binding, now, now.Add(time.Minute), 10)
	require.NoError(t, err)
	require.Len(t, alerts, 1)
	require.NoError(t, qq.AckBalanceLow(ctx, uid, binding, alerts[0].ID))
	require.NoError(t, qq.AckBalanceLow(ctx, uid, binding, alerts[0].ID))
	alerts, err = qq.ClaimBalanceLow(ctx, uid, binding, now, now.Add(time.Minute), 10)
	require.NoError(t, err)
	require.Empty(t, alerts)
	require.Equal(t, 1, balanceReliabilityCount(t, "SELECT count(*) FROM balance_low_qq_deliveries WHERE user_id=$1 AND acked_at IS NOT NULL", uid))
	_, err = integrationDB.Exec("UPDATE users SET balance=20 WHERE id=$1", uid)
	require.NoError(t, err)
	require.Equal(t, 1, balanceReliabilityCount(t, "SELECT count(*) FROM balance_notification_emails d JOIN balance_notification_events e ON e.id=d.event_id WHERE e.user_id=$1 AND d.status='cancelled'", uid))
	_, err = integrationDB.Exec("UPDATE users SET balance=9 WHERE id=$1", uid)
	require.NoError(t, err)
	require.Equal(t, 2, balanceReliabilityCount(t, "SELECT count(*) FROM balance_notification_events WHERE user_id=$1", uid))
	require.Equal(t, 1, balanceReliabilityCount(t, "SELECT count(*) FROM balance_notification_events WHERE user_id=$1 AND closed_at IS NULL", uid))
	alerts, err = qq.ClaimBalanceLow(ctx, uid, binding, now.Add(time.Minute), now.Add(2*time.Minute), 10)
	require.NoError(t, err)
	require.Len(t, alerts, 1)
}

func TestBalanceReliabilityUnknownHistoryIsNotBackfilledAndKnownMissIsRepaired(t *testing.T) {
	balanceReliabilitySettings(t)
	uid, _ := balanceReliabilityUser(t, 2)
	_, err := integrationDB.Exec("SELECT reconcile_balance_notification($1)", uid)
	require.NoError(t, err)
	require.Zero(t, balanceReliabilityCount(t, "SELECT count(*) FROM balance_notification_events WHERE user_id=$1", uid))
	// An observed high balance followed by a low balance is evidence even when
	// optional trigger registration failed. No usage-history scan is necessary.
	_, err = integrationDB.Exec("UPDATE balance_notification_state SET low=FALSE,eligible=TRUE WHERE user_id=$1", uid)
	require.NoError(t, err)
	_, err = integrationDB.Exec("SELECT reconcile_balance_notification($1)", uid)
	require.NoError(t, err)
	_, err = integrationDB.Exec("SELECT reconcile_balance_notification($1)", uid)
	require.NoError(t, err)
	require.Equal(t, 1, balanceReliabilityCount(t, "SELECT count(*) FROM balance_notification_events WHERE user_id=$1 AND origin='compensation'", uid))
}

func TestBalanceReliabilityLeaseRestartEligibilityAndIndependentChannels(t *testing.T) {
	balanceReliabilitySettings(t)
	uid, binding := balanceReliabilityUser(t, 12)
	_, err := integrationDB.Exec("UPDATE users SET balance=9 WHERE id=$1", uid)
	require.NoError(t, err)
	r := NewBalanceNotificationRepository(integrationDB)
	ctx := context.Background()
	now := time.Now().UTC()
	deliveries, err := r.ClaimEmails(ctx, now, now.Add(time.Minute), 20)
	require.NoError(t, err)
	var d service.BalanceEmailDelivery
	for _, item := range deliveries {
		if item.UserID == uid {
			d = item
		}
	}
	require.NotZero(t, d.ID)
	require.True(t, d.Eligible)
	require.Equal(t, 1, d.Attempts)
	_, err = integrationDB.Exec("UPDATE users SET balance_notify_extra_emails='[]' WHERE id=$1", uid)
	require.NoError(t, err)
	// A process restart recovers the expired lease and sees fresh preferences.
	recovered, err := NewBalanceNotificationRepository(integrationDB).ClaimEmails(ctx, now.Add(2*time.Minute), now.Add(3*time.Minute), 20)
	require.NoError(t, err)
	var next service.BalanceEmailDelivery
	for _, item := range recovered {
		if item.UserID == uid {
			next = item
		}
	}
	require.Equal(t, d.ID, next.ID)
	require.Equal(t, 2, next.Attempts)
	require.False(t, next.Eligible)
	require.NoError(t, r.FinishEmail(ctx, d, "sent", now, "")) // stale worker cannot overwrite new lease
	require.Equal(t, 1, balanceReliabilityCount(t, "SELECT count(*) FROM balance_notification_emails d JOIN balance_notification_events e ON e.id=d.event_id WHERE e.user_id=$1 AND d.status='pending'", uid))
	require.NoError(t, r.FinishEmail(ctx, next, "cancelled", now, ""))
	qq := NewBalanceNotifyQQRepository(integrationDB)
	alerts, err := qq.ClaimBalanceLow(ctx, uid, binding, now, now.Add(time.Minute), 10)
	require.NoError(t, err)
	require.Len(t, alerts, 1)
	_, err = integrationDB.Exec("UPDATE users SET balance=11 WHERE id=$1", uid)
	require.NoError(t, err)
	alerts, err = qq.ClaimBalanceLow(ctx, uid, binding, now.Add(2*time.Minute), now.Add(3*time.Minute), 10)
	require.NoError(t, err)
	require.Empty(t, alerts)
}

func TestBalanceReliabilityInvalidOptionalConfigurationDoesNotBreakCharges(t *testing.T) {
	balanceReliabilitySettings(t)
	uid, _ := balanceReliabilityUser(t, 12)
	_, err := integrationDB.Exec("UPDATE users SET balance_notify_threshold=NULL,balance_notify_extra_emails='invalid-json' WHERE id=$1", uid)
	require.NoError(t, err)
	_, err = integrationDB.Exec("UPDATE settings SET value='not-a-number' WHERE key='balance_low_notify_threshold'")
	require.NoError(t, err)
	_, err = integrationDB.Exec("UPDATE users SET balance=9 WHERE id=$1", uid)
	require.NoError(t, err)
	var balance float64
	require.NoError(t, integrationDB.QueryRow("SELECT balance FROM users WHERE id=$1", uid).Scan(&balance))
	require.Equal(t, 9.0, balance)
	_, err = integrationDB.Exec("UPDATE settings SET value='10' WHERE key='balance_low_notify_threshold'")
	require.NoError(t, err)
	_, err = integrationDB.Exec("UPDATE users SET balance=12 WHERE id=$1", uid)
	require.NoError(t, err)
	_, err = integrationDB.Exec("UPDATE users SET balance=9 WHERE id=$1", uid)
	require.NoError(t, err)
	require.Equal(t, 1, balanceReliabilityCount(t, "SELECT count(*) FROM balance_notification_events WHERE user_id=$1", uid))
	require.Zero(t, balanceReliabilityCount(t, "SELECT count(*) FROM balance_notification_emails d JOIN balance_notification_events e ON e.id=d.event_id WHERE e.user_id=$1", uid))
}

func TestBalanceReliabilityMigrationCanBeReapplied(t *testing.T) {
	data, err := migrations.FS.ReadFile("255_balance_notification_reliability.sql")
	require.NoError(t, err)
	tx, err := integrationDB.Begin()
	require.NoError(t, err)
	defer tx.Rollback()
	_, err = tx.Exec(string(data))
	require.NoError(t, err)
	_, err = tx.Exec(string(data))
	require.NoError(t, err)
}

func TestBalanceReliabilityLegacyQQMigrationKeepsOnlyProvenPendingWork(t *testing.T) {
	balanceReliabilitySettings(t)
	uid, binding := balanceReliabilityUser(t, 2)
	tx, err := integrationDB.Begin()
	require.NoError(t, err)
	defer tx.Rollback()
	for i := 0; i < 2; i++ {
		_, err = tx.Exec(`INSERT INTO balance_low_qq_deliveries(user_id,binding_id,current_balance,threshold) VALUES($1,$2,2,10)`, uid, binding)
		require.NoError(t, err)
	}
	data, err := migrations.FS.ReadFile("255_balance_notification_reliability.sql")
	require.NoError(t, err)
	_, err = tx.Exec(string(data))
	require.NoError(t, err)
	_, err = tx.Exec(string(data))
	require.NoError(t, err)
	_, err = tx.Exec("SELECT reconcile_balance_notification($1)", uid)
	require.NoError(t, err)
	var count int
	require.NoError(t, tx.QueryRow("SELECT count(*) FROM balance_low_qq_deliveries WHERE user_id=$1 AND cancelled_at IS NULL", uid).Scan(&count))
	require.Equal(t, 1, count)
	require.NoError(t, tx.QueryRow("SELECT count(*) FROM balance_notification_events WHERE user_id=$1 AND origin='legacy_qq' AND NOT email_allowed", uid).Scan(&count))
	require.Equal(t, 1, count)
	require.NoError(t, tx.QueryRow("SELECT count(*) FROM balance_notification_emails d JOIN balance_notification_events e ON e.id=d.event_id WHERE e.user_id=$1", uid).Scan(&count))
	require.Zero(t, count)
}

func TestBalanceReliabilityReconcileSkipsConcurrentReplicaWithoutWaiting(t *testing.T) {
	balanceReliabilitySettings(t)
	tx, err := integrationDB.Begin()
	require.NoError(t, err)
	defer tx.Rollback()
	_, err = tx.Exec("SELECT pg_advisory_xact_lock(27631,255)")
	require.NoError(t, err)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	next, count, err := NewBalanceNotificationRepository(integrationDB).ReconcileBatch(ctx, 0, 200)
	require.NoError(t, err)
	require.Zero(t, next)
	require.Zero(t, count)
}
