//go:build integration

package repository

import (
	"context"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/stretchr/testify/require"
)

func TestBotBindingRepositoryRedeemIsSingleUseAndRebindRevokes(t *testing.T) {
	ctx := context.Background()
	client := testEntClient(t)
	user := mustCreateUser(t, client, &service.User{Email: "bot-binding-" + time.Now().Format(time.RFC3339Nano) + "@example.com"})

	repo := NewBotBindingRepository(integrationDB)
	t.Cleanup(func() {
		_, _ = integrationDB.ExecContext(ctx, `DELETE FROM bot_bindings WHERE user_id = $1`, user.ID)
		_, _ = integrationDB.ExecContext(ctx, `DELETE FROM bot_binding_codes WHERE user_id = $1`, user.ID)
	})

	now := time.Now().UTC()
	firstCode := service.HashBotBindingSecret("ABCDEFGH")
	require.NoError(t, repo.CreateCode(ctx, &service.BotBindingCodeRecord{
		UserID:    user.ID,
		CodeHash:  firstCode,
		ExpiresAt: now.Add(time.Minute),
		Now:       now,
	}))

	firstTokenHash := service.HashBotBindingSecret("bt_first-token")
	firstBinding, err := repo.RedeemCode(ctx, service.BotBindingRedeemParams{
		CodeHash:    firstCode,
		Platform:    "qq",
		ExternalID:  "10001",
		TokenHash:   firstTokenHash,
		TokenPrefix: "bt_first-t",
		Now:         now,
	})
	require.NoError(t, err)
	require.NotZero(t, firstBinding.ID)
	require.Equal(t, user.ID, firstBinding.UserID)
	require.Equal(t, "qq", firstBinding.Platform)
	require.NotZero(t, firstBinding.UserTokenVersion)

	// 绑定码只能用一次。
	_, err = repo.RedeemCode(ctx, service.BotBindingRedeemParams{
		CodeHash:    firstCode,
		Platform:    "qq",
		ExternalID:  "10001",
		TokenHash:   service.HashBotBindingSecret("bt_replay"),
		TokenPrefix: "bt_replay",
		Now:         now.Add(time.Second),
	})
	require.ErrorIs(t, err, service.ErrBotBindingCodeInvalid)

	// 令牌可以解析回绑定。
	loaded, err := repo.GetByTokenHash(ctx, firstTokenHash)
	require.NoError(t, err)
	require.Equal(t, firstBinding.ID, loaded.ID)

	// 同一聊天账号重新绑定会吊销旧绑定。
	secondCode := service.HashBotBindingSecret("IJKLMNPQ")
	require.NoError(t, repo.CreateCode(ctx, &service.BotBindingCodeRecord{
		UserID:    user.ID,
		CodeHash:  secondCode,
		ExpiresAt: now.Add(time.Minute),
		Now:       now,
	}))
	secondTokenHash := service.HashBotBindingSecret("bt_second-token")
	secondBinding, err := repo.RedeemCode(ctx, service.BotBindingRedeemParams{
		CodeHash:    secondCode,
		Platform:    "qq",
		ExternalID:  "10001",
		TokenHash:   secondTokenHash,
		TokenPrefix: "bt_second",
		Now:         now.Add(2 * time.Second),
	})
	require.NoError(t, err)
	require.NotEqual(t, firstBinding.ID, secondBinding.ID)

	_, err = repo.GetByTokenHash(ctx, firstTokenHash)
	require.ErrorIs(t, err, service.ErrBotBindingInvalid)

	bindings, err := repo.ListByUserID(ctx, user.ID)
	require.NoError(t, err)
	require.Len(t, bindings, 1)
	require.Equal(t, secondBinding.ID, bindings[0].ID)

	// 解绑后令牌立即失效，重复解绑返回 NotFound。
	require.NoError(t, repo.RevokeByID(ctx, user.ID, secondBinding.ID, now.Add(3*time.Second)))
	_, err = repo.GetByTokenHash(ctx, secondTokenHash)
	require.ErrorIs(t, err, service.ErrBotBindingInvalid)
	require.ErrorIs(t, repo.RevokeByID(ctx, user.ID, secondBinding.ID, now.Add(4*time.Second)), service.ErrBotBindingNotFound)

	// 其他用户不能解绑别人的绑定。
	other := mustCreateUser(t, client, &service.User{Email: "bot-binding-other-" + time.Now().Format(time.RFC3339Nano) + "@example.com"})
	thirdCode := service.HashBotBindingSecret("RSTUVWXY")
	require.NoError(t, repo.CreateCode(ctx, &service.BotBindingCodeRecord{
		UserID:    user.ID,
		CodeHash:  thirdCode,
		ExpiresAt: now.Add(time.Minute),
		Now:       now,
	}))
	third, err := repo.RedeemCode(ctx, service.BotBindingRedeemParams{
		CodeHash:    thirdCode,
		Platform:    "qq",
		ExternalID:  "10002",
		TokenHash:   service.HashBotBindingSecret("bt_third-token"),
		TokenPrefix: "bt_third-",
		Now:         now.Add(5 * time.Second),
	})
	require.NoError(t, err)
	require.ErrorIs(t, repo.RevokeByID(ctx, other.ID, third.ID, now.Add(6*time.Second)), service.ErrBotBindingNotFound)
}

func TestBotBindingRepositoryRejectsExpiredCodesAndInactiveUsers(t *testing.T) {
	ctx := context.Background()
	client := testEntClient(t)
	user := mustCreateUser(t, client, &service.User{Email: "bot-binding-expired-" + time.Now().Format(time.RFC3339Nano) + "@example.com"})
	blocked := mustCreateUser(t, client, &service.User{
		Email:  "bot-binding-blocked-" + time.Now().Format(time.RFC3339Nano) + "@example.com",
		Status: "suspended",
	})

	repo := NewBotBindingRepository(integrationDB)
	t.Cleanup(func() {
		_, _ = integrationDB.ExecContext(ctx, `DELETE FROM bot_bindings WHERE user_id = $1 OR user_id = $2`, user.ID, blocked.ID)
		_, _ = integrationDB.ExecContext(ctx, `DELETE FROM bot_binding_codes WHERE user_id = $1 OR user_id = $2`, user.ID, blocked.ID)
	})

	now := time.Now().UTC()
	expiredCode := service.HashBotBindingSecret("EXPIRED1")
	require.NoError(t, repo.CreateCode(ctx, &service.BotBindingCodeRecord{
		UserID:    user.ID,
		CodeHash:  expiredCode,
		ExpiresAt: now.Add(-time.Minute),
		Now:       now.Add(-2 * time.Minute),
	}))
	_, err := repo.RedeemCode(ctx, service.BotBindingRedeemParams{
		CodeHash:    expiredCode,
		Platform:    "qq",
		ExternalID:  "20001",
		TokenHash:   service.HashBotBindingSecret("bt_expired"),
		TokenPrefix: "bt_expire",
		Now:         now,
	})
	require.ErrorIs(t, err, service.ErrBotBindingCodeInvalid)

	blockedCode := service.HashBotBindingSecret("BLOCKED1")
	require.NoError(t, repo.CreateCode(ctx, &service.BotBindingCodeRecord{
		UserID:    blocked.ID,
		CodeHash:  blockedCode,
		ExpiresAt: now.Add(time.Minute),
		Now:       now,
	}))
	_, err = repo.RedeemCode(ctx, service.BotBindingRedeemParams{
		CodeHash:    blockedCode,
		Platform:    "qq",
		ExternalID:  "20002",
		TokenHash:   service.HashBotBindingSecret("bt_blocked"),
		TokenPrefix: "bt_blocke",
		Now:         now,
	})
	require.ErrorIs(t, err, service.ErrBotBindingInactive)
}

// 兑换接口是公开的，external_id 由调用方提供：别人提交相同聊天账号 ID 时，
// 不能吊销该 ID 真正主人的绑定令牌（审计发现的 P2）。
func TestBotBindingRepositoryKeepsOtherUsersBindingsIntact(t *testing.T) {
	ctx := context.Background()
	client := testEntClient(t)
	owner := mustCreateUser(t, client, &service.User{Email: "bot-binding-owner-" + time.Now().Format(time.RFC3339Nano) + "@example.com"})
	attacker := mustCreateUser(t, client, &service.User{Email: "bot-binding-attacker-" + time.Now().Format(time.RFC3339Nano) + "@example.com"})

	repo := NewBotBindingRepository(integrationDB)
	t.Cleanup(func() {
		_, _ = integrationDB.ExecContext(ctx, `DELETE FROM bot_bindings WHERE user_id = $1 OR user_id = $2`, owner.ID, attacker.ID)
		_, _ = integrationDB.ExecContext(ctx, `DELETE FROM bot_binding_codes WHERE user_id = $1 OR user_id = $2`, owner.ID, attacker.ID)
	})

	now := time.Now().UTC()
	ownerTokenHash := service.HashBotBindingSecret("bt_owner-token")
	ownerCode := service.HashBotBindingSecret("OWNER001")
	require.NoError(t, repo.CreateCode(ctx, &service.BotBindingCodeRecord{
		UserID:    owner.ID,
		CodeHash:  ownerCode,
		ExpiresAt: now.Add(time.Minute),
		Now:       now,
	}))
	ownerBinding, err := repo.RedeemCode(ctx, service.BotBindingRedeemParams{
		CodeHash:    ownerCode,
		Platform:    "qq",
		ExternalID:  "30001",
		TokenHash:   ownerTokenHash,
		TokenPrefix: "bt_owner-t",
		Now:         now,
	})
	require.NoError(t, err)

	attackerCode := service.HashBotBindingSecret("ATTACK01")
	require.NoError(t, repo.CreateCode(ctx, &service.BotBindingCodeRecord{
		UserID:    attacker.ID,
		CodeHash:  attackerCode,
		ExpiresAt: now.Add(time.Minute),
		Now:       now,
	}))
	attackerBinding, err := repo.RedeemCode(ctx, service.BotBindingRedeemParams{
		CodeHash:    attackerCode,
		Platform:    "qq",
		ExternalID:  "30001",
		TokenHash:   service.HashBotBindingSecret("bt_attacker-token"),
		TokenPrefix: "bt_attacke",
		Now:         now.Add(time.Second),
	})
	require.NoError(t, err)
	require.NotEqual(t, ownerBinding.ID, attackerBinding.ID)

	// 原主人的令牌必须继续有效。
	loaded, err := repo.GetByTokenHash(ctx, ownerTokenHash)
	require.NoError(t, err)
	require.Equal(t, ownerBinding.ID, loaded.ID)

	ownerBindings, err := repo.ListByUserID(ctx, owner.ID)
	require.NoError(t, err)
	require.Len(t, ownerBindings, 1)

	attackerBindings, err := repo.ListByUserID(ctx, attacker.ID)
	require.NoError(t, err)
	require.Len(t, attackerBindings, 1)
}
