-- 持久化机器人抽奖配置、用户次数、抽奖/发放记录和可恢复的全体发放批次。

CREATE TABLE IF NOT EXISTS bot_lottery_config (
    id SMALLINT PRIMARY KEY CHECK (id = 1),
    enabled BOOLEAN NOT NULL DEFAULT FALSE,
    prizes JSONB NOT NULL DEFAULT '[]'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bot_lottery_accounts (
    user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    remaining BIGINT NOT NULL DEFAULT 0 CHECK (remaining >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bot_lottery_grant_batches (
    id BIGSERIAL PRIMARY KEY,
    request_id VARCHAR(64) NOT NULL UNIQUE,
    actor_user_id BIGINT NOT NULL REFERENCES users(id),
    count BIGINT NOT NULL CHECK (count > 0),
    notes TEXT NOT NULL DEFAULT '',
    total BIGINT NOT NULL DEFAULT 0 CHECK (total >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bot_lottery_grant_batch_items (
    batch_id BIGINT NOT NULL REFERENCES bot_lottery_grant_batches(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'success', 'failed', 'skipped')),
    remaining_after BIGINT NULL,
    error_message TEXT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (batch_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_bot_lottery_grant_items_pending
    ON bot_lottery_grant_batch_items (batch_id, user_id)
    WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS bot_lottery_operations (
    id BIGSERIAL PRIMARY KEY,
    operation_id VARCHAR(64) NOT NULL UNIQUE,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    action VARCHAR(16) NOT NULL CHECK (action IN ('grant', 'draw')),
    count_delta BIGINT NOT NULL CHECK (count_delta <> 0),
    remaining_after BIGINT NOT NULL CHECK (remaining_after >= 0),
    prize_id VARCHAR(64) NULL,
    prize_name VARCHAR(240) NULL,
    reward_amount NUMERIC(20,8) NULL CHECK (reward_amount IS NULL OR reward_amount >= 0),
    config_snapshot TEXT NULL,
    balance_before NUMERIC(20,8) NULL,
    balance_after NUMERIC(20,8) NULL,
    notes TEXT NOT NULL DEFAULT '',
    actor_user_id BIGINT NULL REFERENCES users(id) ON DELETE SET NULL,
    target_identity TEXT NOT NULL DEFAULT '',
    batch_id BIGINT NULL REFERENCES bot_lottery_grant_batches(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK ((action = 'draw' AND count_delta = -1 AND prize_name IS NOT NULL AND reward_amount IS NOT NULL) OR (action = 'grant' AND count_delta > 0))
);

CREATE INDEX IF NOT EXISTS idx_bot_lottery_operations_user_created
    ON bot_lottery_operations (user_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_bot_lottery_operations_batch
    ON bot_lottery_operations (batch_id, user_id)
    WHERE batch_id IS NOT NULL;

ALTER TABLE redeem_codes DROP CONSTRAINT IF EXISTS redeem_codes_type_check;
