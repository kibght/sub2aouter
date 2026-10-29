package service

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"strings"
	"time"

	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
)

const (
	// BotBindingCodeLength 机器人绑定码长度。字母表已剔除 0/O/1/I 等易混淆字符。
	// 12 位（32^12 ≈ 1.15e18）≈ 60 bit 熵，配合 10 分钟 TTL 即可让数据库转储后的
	// 离线暴力破解在有效期内不可行，无需依赖额外的服务端密钥。
	BotBindingCodeLength = 12
	// BotBindingCodeTTL 机器人绑定码有效期：短时有效，避免被长期复用。
	BotBindingCodeTTL = 10 * time.Minute
	// BotBindingMaxActivePerUser 单个账号同时生效的机器人绑定数量上限。
	// 正常用户按聊天账号绑定（通常 1~2 条）；上限用于限制脚本化兑换造成的行数膨胀。
	BotBindingMaxActivePerUser = 20

	botBindingCodeAlphabet   = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
	botBindingTokenPrefix    = "bt_"
	botBindingTokenBytes     = 32
	botBindingTokenPrefixLen = 10
	botBindingMaxPlatformLen = 50
	botBindingMaxExternalID  = 128
	botBindingMinCodeLength  = 6
	botBindingMaxCodeLength  = 32
)

// 机器人绑定相关错误。状态码与聊天插件约定一致：
// 401 表示绑定码/令牌失效，403 表示账号不可用，404 表示绑定记录不存在。
var (
	ErrBotBindingCodeInvalid  = infraerrors.Unauthorized("BOT_BINDING_CODE_INVALID", "Bot binding code is invalid, expired or already used")
	ErrBotBindingInvalid      = infraerrors.Unauthorized("BOT_BINDING_INVALID", "Bot binding token is invalid or revoked")
	ErrBotBindingNotFound     = infraerrors.NotFound("BOT_BINDING_NOT_FOUND", "Bot binding not found")
	ErrBotBindingInactive     = infraerrors.Forbidden("BOT_BINDING_ACCOUNT_INACTIVE", "The bound account is not active")
	ErrBotBindingPlatform     = infraerrors.BadRequest("BOT_BINDING_PLATFORM_REQUIRED", "platform is required")
	ErrBotBindingExternalID   = infraerrors.BadRequest("BOT_BINDING_EXTERNAL_ID_REQUIRED", "external_id is required")
	ErrBotBindingRepository   = infraerrors.InternalServer("BOT_BINDING_UNAVAILABLE", "Bot binding storage is unavailable")
	ErrBotBindingLimitReached = infraerrors.Conflict("BOT_BINDING_LIMIT_REACHED", "Too many active bot bindings for this account")
)

// BotBinding 表示一条机器人账号绑定。令牌本体只在兑换时返回一次，
// 之后仅保留哈希与可展示前缀。
type BotBinding struct {
	ID               int64
	UserID           int64
	Platform         string
	ExternalID       string
	TokenPrefix      string
	UserTokenVersion int64
	BoundAt          time.Time
	LastUsedAt       *time.Time
	CreatedAt        time.Time
}

// BotBindingCode 是一次性绑定码明文及其过期时间（仅返回给生成它的登录用户）。
type BotBindingCode struct {
	Code      string
	ExpiresAt time.Time
}

// BotBindingClaim 是兑换绑定码的结果：除绑定信息外还带上仅此一次的令牌明文。
type BotBindingClaim struct {
	BotBinding
	Token string
}

// BotBindingCodeRecord 是写入绑定码表的持久化参数。
type BotBindingCodeRecord struct {
	UserID    int64
	CodeHash  string
	ExpiresAt time.Time
	Now       time.Time
}

// BotBindingRedeemParams 是兑换绑定码的持久化参数。
type BotBindingRedeemParams struct {
	CodeHash    string
	Platform    string
	ExternalID  string
	TokenHash   string
	TokenPrefix string
	Now         time.Time
}

// BotBindingRepository 定义机器人绑定的持久化能力。
type BotBindingRepository interface {
	CreateCode(ctx context.Context, record *BotBindingCodeRecord) error
	// RedeemCode 在一个事务内消费绑定码、吊销同平台账号的旧绑定并写入新绑定。
	RedeemCode(ctx context.Context, params BotBindingRedeemParams) (*BotBinding, error)
	GetByTokenHash(ctx context.Context, tokenHash string) (*BotBinding, error)
	TouchLastUsed(ctx context.Context, id int64, at time.Time) error
	ListByUserID(ctx context.Context, userID int64) ([]BotBinding, error)
	RevokeByID(ctx context.Context, userID, bindingID int64, revokedAt time.Time) error
}

// BotBindingService 负责绑定码签发、兑换、令牌校验与解绑。
type BotBindingService struct {
	repo BotBindingRepository
}

// NewBotBindingService 创建机器人绑定服务。
func NewBotBindingService(repo BotBindingRepository) *BotBindingService {
	return &BotBindingService{repo: repo}
}

// CreateCode 为当前登录用户生成一次性绑定码。
func (s *BotBindingService) CreateCode(ctx context.Context, userID int64) (*BotBindingCode, error) {
	if s == nil || s.repo == nil {
		return nil, ErrBotBindingRepository
	}
	if userID <= 0 {
		return nil, ErrBotBindingInactive
	}
	code, err := randomBotBindingCode(BotBindingCodeLength)
	if err != nil {
		return nil, fmt.Errorf("generate bot binding code: %w", err)
	}
	now := time.Now().UTC()
	expiresAt := now.Add(BotBindingCodeTTL)
	record := &BotBindingCodeRecord{
		UserID:    userID,
		CodeHash:  HashBotBindingSecret(code),
		ExpiresAt: expiresAt,
		Now:       now,
	}
	if err := s.repo.CreateCode(ctx, record); err != nil {
		return nil, err
	}
	return &BotBindingCode{Code: FormatBotBindingCode(code), ExpiresAt: expiresAt}, nil
}

// Redeem 用绑定码换取机器人令牌。platform/external_id 由聊天插件传入（如 qq/123456）。
func (s *BotBindingService) Redeem(ctx context.Context, code, platform, externalID string) (*BotBindingClaim, error) {
	if s == nil || s.repo == nil {
		return nil, ErrBotBindingRepository
	}
	normalizedCode := NormalizeBotBindingCode(code)
	if len(normalizedCode) < botBindingMinCodeLength || len(normalizedCode) > botBindingMaxCodeLength {
		return nil, ErrBotBindingCodeInvalid
	}
	normalizedPlatform, err := normalizeBotBindingPlatform(platform)
	if err != nil {
		return nil, err
	}
	normalizedExternalID, err := normalizeBotBindingExternalID(externalID)
	if err != nil {
		return nil, err
	}

	token, err := generateBotBindingToken()
	if err != nil {
		return nil, fmt.Errorf("generate bot binding token: %w", err)
	}
	now := time.Now().UTC()
	binding, err := s.repo.RedeemCode(ctx, BotBindingRedeemParams{
		CodeHash:    HashBotBindingSecret(normalizedCode),
		Platform:    normalizedPlatform,
		ExternalID:  normalizedExternalID,
		TokenHash:   HashBotBindingSecret(token),
		TokenPrefix: botBindingTokenDisplayPrefix(token),
		Now:         now,
	})
	if err != nil {
		return nil, err
	}
	return &BotBindingClaim{BotBinding: *binding, Token: token}, nil
}

// Authenticate 校验机器人令牌并返回绑定记录。
func (s *BotBindingService) Authenticate(ctx context.Context, token string) (*BotBinding, error) {
	if s == nil || s.repo == nil {
		return nil, ErrBotBindingRepository
	}
	trimmed := strings.TrimSpace(token)
	if trimmed == "" || !strings.HasPrefix(trimmed, botBindingTokenPrefix) {
		return nil, ErrBotBindingInvalid
	}
	binding, err := s.repo.GetByTokenHash(ctx, HashBotBindingSecret(trimmed))
	if err != nil {
		return nil, err
	}
	// 最近使用时间属于可观测信息，写失败不影响本次鉴权。
	now := time.Now().UTC()
	if err := s.repo.TouchLastUsed(ctx, binding.ID, now); err == nil {
		binding.LastUsedAt = &now
	}
	return binding, nil
}

// ListBindings 返回该用户当前生效的机器人绑定。
func (s *BotBindingService) ListBindings(ctx context.Context, userID int64) ([]BotBinding, error) {
	if s == nil || s.repo == nil {
		return nil, ErrBotBindingRepository
	}
	if userID <= 0 {
		return nil, ErrBotBindingNotFound
	}
	return s.repo.ListByUserID(ctx, userID)
}

// RevokeCurrentBinding 吊销当前令牌对应的绑定（机器人侧 /unbind）。
func (s *BotBindingService) RevokeCurrentBinding(ctx context.Context, binding *BotBinding) error {
	if binding == nil {
		return ErrBotBindingNotFound
	}
	return s.RevokeBinding(ctx, binding.UserID, binding.ID)
}

// BotBindingCredentialVersion 计算用户凭据指纹，用于让机器人绑定令牌在改密后失效。
//
// users 表没有 token_version 列：JWT 的 TokenVersion 由 email + password_hash 指纹推导，
// 这里复用同一推导方式，保证"改密即失效"的语义与网站会话一致。
func BotBindingCredentialVersion(email, passwordHash string) int64 {
	return resolvedTokenVersion(&User{Email: email, PasswordHash: passwordHash})
}

// RevokeBinding 吊销指定绑定（只能吊销自己的绑定）。
func (s *BotBindingService) RevokeBinding(ctx context.Context, userID, bindingID int64) error {
	if s == nil || s.repo == nil {
		return ErrBotBindingRepository
	}
	if userID <= 0 || bindingID <= 0 {
		return ErrBotBindingNotFound
	}
	return s.repo.RevokeByID(ctx, userID, bindingID, time.Now().UTC())
}

// NormalizeBotBindingCode 统一导入的绑定码：忽略大小写、空白与分隔符。
// 用户从网页复制时可能带上空格或连字符，机器人在聊天里收到的也可能被输入法改写。
func NormalizeBotBindingCode(raw string) string {
	var b strings.Builder
	for _, r := range strings.ToUpper(strings.TrimSpace(raw)) {
		switch r {
		case ' ', '\t', '\r', '\n', '-', '_', '.', '，':
			continue
		}
		_, _ = b.WriteRune(r)
	}
	return b.String()
}

// FormatBotBindingCode 把内部绑定码格式化为便于朗读与抄写的分段形式（XXXX-XXXX-XXXX）。
func FormatBotBindingCode(code string) string {
	if len(code) != BotBindingCodeLength {
		return code
	}
	return code[:4] + "-" + code[4:8] + "-" + code[8:]
}

// HashBotBindingSecret 计算绑定码/令牌的存储摘要。
func HashBotBindingSecret(secret string) string {
	sum := sha256.Sum256([]byte(secret))
	return hex.EncodeToString(sum[:])
}

func normalizeBotBindingPlatform(raw string) (string, error) {
	var b strings.Builder
	for _, r := range strings.ToLower(strings.TrimSpace(raw)) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '_', r == '-', r == ':', r == '.':
			_, _ = b.WriteRune(r)
		}
	}
	platform := b.String()
	if platform == "" {
		return "", ErrBotBindingPlatform
	}
	if len(platform) > botBindingMaxPlatformLen {
		platform = platform[:botBindingMaxPlatformLen]
	}
	return platform, nil
}

func normalizeBotBindingExternalID(raw string) (string, error) {
	externalID := strings.TrimSpace(raw)
	if externalID == "" {
		return "", ErrBotBindingExternalID
	}
	if len(externalID) > botBindingMaxExternalID {
		return "", ErrBotBindingExternalID
	}
	return externalID, nil
}

func randomBotBindingCode(length int) (string, error) {
	buf := make([]byte, length)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	// 字母表长度为 32，正好整除 256，取模不引入偏差。
	out := make([]byte, length)
	for i, v := range buf {
		out[i] = botBindingCodeAlphabet[int(v)%len(botBindingCodeAlphabet)]
	}
	return string(out), nil
}

func generateBotBindingToken() (string, error) {
	buf := make([]byte, botBindingTokenBytes)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return botBindingTokenPrefix + base64.RawURLEncoding.EncodeToString(buf), nil
}

func botBindingTokenDisplayPrefix(token string) string {
	if len(token) <= botBindingTokenPrefixLen {
		return token
	}
	return token[:botBindingTokenPrefixLen]
}
