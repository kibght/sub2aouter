-- 机器人首次绑定奖励与每日签到记录。
CREATE TABLE IF NOT EXISTS bot_checkins (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reward_date DATE NOT NULL,
    streak_day INT NOT NULL,
    reward_amount NUMERIC(20, 8) NOT NULL,
    increment_amount NUMERIC(20, 8) NOT NULL DEFAULT 0,
    balance_before NUMERIC(20, 8) NOT NULL,
    balance_after NUMERIC(20, 8) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT bot_checkins_streak_day_positive CHECK (streak_day > 0),
    CONSTRAINT bot_checkins_reward_nonnegative CHECK (reward_amount >= 0),
    CONSTRAINT bot_checkins_increment_nonnegative CHECK (increment_amount >= 0),
    UNIQUE (user_id, reward_date)
);

CREATE INDEX IF NOT EXISTS idx_bot_checkins_user_created
    ON bot_checkins (user_id, created_at DESC);

ALTER TABLE redeem_codes DROP CONSTRAINT IF EXISTS redeem_codes_type_check;
