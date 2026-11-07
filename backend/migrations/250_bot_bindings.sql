-- 机器人账号绑定：网站生成一次性绑定码，聊天机器人用绑定码换取独立令牌。
-- 绑定码与令牌都只保存 SHA-256 摘要，数据库泄露时无法直接复用。

CREATE TABLE IF NOT EXISTS bot_binding_codes (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash VARCHAR(64) NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ NULL,
    platform VARCHAR(64) NOT NULL DEFAULT '',
    external_id VARCHAR(128) NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bot_binding_codes_user_created
    ON bot_binding_codes (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_bot_binding_codes_expires
    ON bot_binding_codes (expires_at);

CREATE TABLE IF NOT EXISTS bot_bindings (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    platform VARCHAR(64) NOT NULL,
    external_id VARCHAR(128) NOT NULL,
    token_hash VARCHAR(64) NOT NULL UNIQUE,
    token_prefix VARCHAR(32) NOT NULL DEFAULT '',
    user_token_version BIGINT NOT NULL DEFAULT 0,
    bound_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at TIMESTAMPTZ NULL,
    revoked_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bot_bindings_user
    ON bot_bindings (user_id, bound_at DESC);

-- 同一聊天平台的同一个用户（例如同一个 QQ 号）同时只能有一条生效绑定。
-- 重新绑定时旧记录先被吊销，写路径在同一个事务内完成。
CREATE UNIQUE INDEX IF NOT EXISTS uq_bot_bindings_active_external
    ON bot_bindings (platform, external_id)
    WHERE revoked_at IS NULL;
