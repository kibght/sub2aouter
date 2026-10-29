package service

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

type stubBotBindingRepository struct {
	createdCode *BotBindingCodeRecord

	redeemParams BotBindingRedeemParams
	redeemResult *BotBinding
	redeemErr    error

	getTokenHash string
	getBinding   *BotBinding
	getErr       error

	touchedID     int64
	touchErr      error
	listUserID    int64
	listResult    []BotBinding
	listErr       error
	revokedUserID int64
	revokedID     int64
	revokeErr     error
}

func (r *stubBotBindingRepository) CreateCode(_ context.Context, record *BotBindingCodeRecord) error {
	r.createdCode = record
	return nil
}

func (r *stubBotBindingRepository) RedeemCode(_ context.Context, params BotBindingRedeemParams) (*BotBinding, error) {
	r.redeemParams = params
	if r.redeemErr != nil {
		return nil, r.redeemErr
	}
	if r.redeemResult != nil {
		return r.redeemResult, nil
	}
	return &BotBinding{ID: 7, UserID: 42, Platform: params.Platform, ExternalID: params.ExternalID}, nil
}

func (r *stubBotBindingRepository) GetByTokenHash(_ context.Context, tokenHash string) (*BotBinding, error) {
	r.getTokenHash = tokenHash
	if r.getErr != nil {
		return nil, r.getErr
	}
	return r.getBinding, nil
}

func (r *stubBotBindingRepository) TouchLastUsed(_ context.Context, id int64, _ time.Time) error {
	r.touchedID = id
	return r.touchErr
}

func (r *stubBotBindingRepository) ListByUserID(_ context.Context, userID int64) ([]BotBinding, error) {
	r.listUserID = userID
	return r.listResult, r.listErr
}

func (r *stubBotBindingRepository) RevokeByID(_ context.Context, userID, bindingID int64, _ time.Time) error {
	r.revokedUserID = userID
	r.revokedID = bindingID
	return r.revokeErr
}

func TestBotBindingCreateCodeStoresHashedCodeAndFormatsForHumans(t *testing.T) {
	repo := &stubBotBindingRepository{}
	svc := NewBotBindingService(repo)

	code, err := svc.CreateCode(context.Background(), 42)
	require.NoError(t, err)
	require.NotNil(t, repo.createdCode)

	// 展示给用户的绑定码为 XXXX-XXXX-XXXX，存储侧只保留规范化后的摘要。
	require.Len(t, code.Code, BotBindingCodeLength+2)
	require.Equal(t, "-", code.Code[4:5])
	require.Equal(t, "-", code.Code[9:10])
	formatted := strings.ReplaceAll(code.Code, "-", "")
	require.Equal(t, HashBotBindingSecret(formatted), repo.createdCode.CodeHash)
	require.Equal(t, int64(42), repo.createdCode.UserID)
	require.WithinDuration(t, time.Now().Add(BotBindingCodeTTL), code.ExpiresAt, 5*time.Second)
	require.WithinDuration(t, code.ExpiresAt, repo.createdCode.ExpiresAt, time.Millisecond)
	require.NotContains(t, repo.createdCode.CodeHash, formatted)
}

func TestBotBindingCreateCodeGeneratesDistinctCodes(t *testing.T) {
	svc := NewBotBindingService(&stubBotBindingRepository{})
	seen := make(map[string]struct{}, 20)
	for i := 0; i < 20; i++ {
		code, err := svc.CreateCode(context.Background(), 1)
		require.NoError(t, err)
		require.NotContains(t, seen, code.Code)
		seen[code.Code] = struct{}{}
	}
}

func TestBotBindingRedeemNormalizesCodePlatformAndExternalID(t *testing.T) {
	repo := &stubBotBindingRepository{
		redeemResult: &BotBinding{
			ID:       9,
			UserID:   42,
			Platform: "qq",
			BoundAt:  time.Now().UTC(),
		},
	}
	svc := NewBotBindingService(repo)

	claim, err := svc.Redeem(context.Background(), "  abcd-efgh  ", " QQ ", " 123456 ")
	require.NoError(t, err)
	require.NotNil(t, claim)

	require.Equal(t, "qq", repo.redeemParams.Platform)
	require.Equal(t, "123456", repo.redeemParams.ExternalID)
	require.Equal(t, HashBotBindingSecret("ABCDEFGH"), repo.redeemParams.CodeHash)
	require.True(t, strings.HasPrefix(claim.Token, "bt_"))
	require.Equal(t, HashBotBindingSecret(claim.Token), repo.redeemParams.TokenHash)
	require.Equal(t, claim.Token[:10], repo.redeemParams.TokenPrefix)
	require.Equal(t, int64(42), claim.UserID)
}

func TestBotBindingRedeemRejectsInvalidInput(t *testing.T) {
	svc := NewBotBindingService(&stubBotBindingRepository{})

	_, err := svc.Redeem(context.Background(), "abc", "qq", "123")
	require.ErrorIs(t, err, ErrBotBindingCodeInvalid)

	_, err = svc.Redeem(context.Background(), "ABCDEFGH", "", "123")
	require.ErrorIs(t, err, ErrBotBindingPlatform)

	_, err = svc.Redeem(context.Background(), "ABCDEFGH", "qq", "   ")
	require.ErrorIs(t, err, ErrBotBindingExternalID)

	_, err = svc.Redeem(context.Background(), "ABCDEFGH", "qq", strings.Repeat("9", 200))
	require.ErrorIs(t, err, ErrBotBindingExternalID)
}

func TestBotBindingRedeemPropagatesRepositoryErrors(t *testing.T) {
	repo := &stubBotBindingRepository{redeemErr: ErrBotBindingCodeInvalid}
	svc := NewBotBindingService(repo)

	_, err := svc.Redeem(context.Background(), "ABCDEFGH", "qq", "123")
	require.ErrorIs(t, err, ErrBotBindingCodeInvalid)
}

func TestBotBindingAuthenticateRequiresTokenPrefix(t *testing.T) {
	repo := &stubBotBindingRepository{getBinding: &BotBinding{ID: 1, UserID: 2}}
	svc := NewBotBindingService(repo)

	_, err := svc.Authenticate(context.Background(), "   ")
	require.ErrorIs(t, err, ErrBotBindingInvalid)

	_, err = svc.Authenticate(context.Background(), "nope-token")
	require.ErrorIs(t, err, ErrBotBindingInvalid)
	require.Empty(t, repo.getTokenHash)
}

func TestBotBindingAuthenticateHashesTokenAndTouchesLastUsed(t *testing.T) {
	repo := &stubBotBindingRepository{getBinding: &BotBinding{ID: 5, UserID: 3}}
	svc := NewBotBindingService(repo)

	binding, err := svc.Authenticate(context.Background(), " bt_example ")
	require.NoError(t, err)
	require.Equal(t, int64(5), binding.ID)
	require.Equal(t, HashBotBindingSecret("bt_example"), repo.getTokenHash)
	require.Equal(t, int64(5), repo.touchedID)
	require.NotNil(t, binding.LastUsedAt)
}

func TestBotBindingAuthenticateIgnoresTouchFailure(t *testing.T) {
	repo := &stubBotBindingRepository{
		getBinding: &BotBinding{ID: 5, UserID: 3},
		touchErr:   errors.New("write failed"),
	}
	svc := NewBotBindingService(repo)

	binding, err := svc.Authenticate(context.Background(), "bt_example")
	require.NoError(t, err)
	require.Nil(t, binding.LastUsedAt)
}

func TestBotBindingRevokeCurrentBindingUsesOwnership(t *testing.T) {
	repo := &stubBotBindingRepository{}
	svc := NewBotBindingService(repo)

	require.NoError(t, svc.RevokeCurrentBinding(context.Background(), &BotBinding{ID: 11, UserID: 22}))
	require.Equal(t, int64(22), repo.revokedUserID)
	require.Equal(t, int64(11), repo.revokedID)

	require.ErrorIs(t, svc.RevokeCurrentBinding(context.Background(), nil), ErrBotBindingNotFound)
	require.ErrorIs(t, svc.RevokeBinding(context.Background(), 0, 5), ErrBotBindingNotFound)
	require.ErrorIs(t, svc.RevokeBinding(context.Background(), 1, 0), ErrBotBindingNotFound)
}

func TestBotBindingListBindingsGuardsInvalidUser(t *testing.T) {
	svc := NewBotBindingService(&stubBotBindingRepository{})
	_, err := svc.ListBindings(context.Background(), 0)
	require.ErrorIs(t, err, ErrBotBindingNotFound)
}

func TestNormalizeAndFormatBotBindingCode(t *testing.T) {
	require.Equal(t, "ABCDEFGHIJKL", NormalizeBotBindingCode("  abcd-efgh-ijkl "))
	require.Equal(t, "ABCDEFGHIJKL", NormalizeBotBindingCode("ABCD EFGH IJKL"))
	require.Equal(t, "ABCDEFGHIJKL", NormalizeBotBindingCode("abcd.efgh.ijkl"))
	require.Equal(t, "ABCD-EFGH-IJKL", FormatBotBindingCode("ABCDEFGHIJKL"))
	require.Equal(t, "SHORT", FormatBotBindingCode("SHORT"))
}

func TestBotBindingCredentialVersionFollowsPasswordChanges(t *testing.T) {
	before := BotBindingCredentialVersion("user@example.com", "hash-a")
	after := BotBindingCredentialVersion("user@example.com", "hash-b")
	require.NotEqual(t, before, after)
	require.Equal(t, before, BotBindingCredentialVersion(" USER@example.com ", "hash-a"))
}
