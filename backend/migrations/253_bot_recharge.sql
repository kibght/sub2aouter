-- Persist idempotency keys with immutable bot-binding identity snapshots.
CREATE TABLE IF NOT EXISTS bot_recharge_requests (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    request_id VARCHAR(160) NOT NULL,
    binding_id BIGINT NOT NULL,
    platform VARCHAR(50) NOT NULL,
    external_id VARCHAR(128) NOT NULL,
    payment_order_id BIGINT NOT NULL UNIQUE REFERENCES payment_orders(id),
    payment_type VARCHAR(30) NOT NULL,
    requested_amount NUMERIC(20, 2) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT bot_recharge_requests_user_request_unique UNIQUE (user_id, request_id)
);

CREATE INDEX IF NOT EXISTS idx_bot_recharge_requests_user_created
    ON bot_recharge_requests (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS bot_recharge_notifications (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    binding_id BIGINT NOT NULL,
    external_id VARCHAR(128) NOT NULL,
    platform VARCHAR(50) NOT NULL,
    payment_order_id BIGINT NOT NULL UNIQUE REFERENCES payment_orders(id),
    credited_amount NUMERIC(20, 2) NOT NULL,
    currency VARCHAR(8) NOT NULL DEFAULT 'USD',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    lease_until TIMESTAMPTZ,
    acked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_bot_recharge_notifications_claim
    ON bot_recharge_notifications (binding_id, lease_until, id)
    WHERE acked_at IS NULL;
