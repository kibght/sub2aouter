-- User-level QQ balance notification preference and per-binding delivery queue.

CREATE TABLE IF NOT EXISTS user_balance_notify_qq (
    user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    enabled BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS balance_low_qq_deliveries (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    binding_id BIGINT NOT NULL REFERENCES bot_bindings(id) ON DELETE CASCADE,
    current_balance NUMERIC(20, 8) NOT NULL,
    threshold NUMERIC(20, 8) NOT NULL,
    site_name TEXT NOT NULL DEFAULT '',
    recharge_url TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    claimed_until TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS idx_balance_low_qq_deliveries_claim
    ON balance_low_qq_deliveries (binding_id, claimed_until, created_at, id);

CREATE INDEX IF NOT EXISTS idx_balance_low_qq_deliveries_user
    ON balance_low_qq_deliveries (user_id, created_at);
