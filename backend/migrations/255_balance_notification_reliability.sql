-- Durable, independent deliveries for each continuous low-balance episode.
CREATE TABLE IF NOT EXISTS balance_notification_state (
    user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    low BOOLEAN NOT NULL,
    eligible BOOLEAN NOT NULL,
    observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS balance_notification_events (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    current_balance NUMERIC(20,8) NOT NULL,
    threshold NUMERIC(20,8) NOT NULL,
    origin TEXT NOT NULL,
    email_allowed BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    closed_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_balance_notification_open_event
    ON balance_notification_events(user_id) WHERE closed_at IS NULL;
CREATE TABLE IF NOT EXISTS balance_notification_emails (
    id BIGSERIAL PRIMARY KEY,
    event_id BIGINT NOT NULL REFERENCES balance_notification_events(id) ON DELETE CASCADE,
    recipient TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','cancelled','suppressed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    lease_until TIMESTAMPTZ,
    last_error TEXT NOT NULL DEFAULT '',
    completed_at TIMESTAMPTZ,
    UNIQUE(event_id, recipient)
);
CREATE INDEX IF NOT EXISTS idx_balance_notification_email_due
    ON balance_notification_emails(next_attempt_at,id) WHERE status='pending';
ALTER TABLE balance_low_qq_deliveries ADD COLUMN IF NOT EXISTS event_id BIGINT REFERENCES balance_notification_events(id);
ALTER TABLE balance_low_qq_deliveries ADD COLUMN IF NOT EXISTS acked_at TIMESTAMPTZ;
ALTER TABLE balance_low_qq_deliveries ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS idx_balance_low_qq_event_binding
    ON balance_low_qq_deliveries(event_id,binding_id) WHERE event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_balance_low_qq_pending_claim
    ON balance_low_qq_deliveries(binding_id,claimed_until,created_at,id)
    WHERE acked_at IS NULL AND cancelled_at IS NULL;

-- Malformed optional settings must never make a charge fail.
CREATE OR REPLACE FUNCTION balance_notification_threshold(u users) RETURNS NUMERIC
LANGUAGE plpgsql STABLE AS $$
DECLARE v TEXT; t NUMERIC;
BEGIN
    t := u.balance_notify_threshold;
    IF t IS NULL THEN
        SELECT value INTO v FROM settings WHERE key='balance_low_notify_threshold';
        IF v IS NULL OR v !~ '^[0-9]+([.][0-9]+)?$' THEN RETURN 0; END IF;
        t := v::NUMERIC;
    END IF;
    IF t <= 0 OR t >= 'Infinity'::NUMERIC OR t = 'NaN'::NUMERIC THEN RETURN 0; END IF;
    IF u.balance_notify_threshold_type='percentage' AND u.total_recharged>0 THEN
        t := u.total_recharged*t/100;
    END IF;
    RETURN t;
EXCEPTION WHEN OTHERS THEN RETURN 0;
END $$;

CREATE OR REPLACE FUNCTION balance_notification_recipients(raw TEXT) RETURNS TABLE(email TEXT)
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE entries JSONB;
BEGIN
    entries := raw::JSONB;
    IF jsonb_typeof(entries)<>'array' THEN RETURN; END IF;
    RETURN QUERY SELECT DISTINCT lower(btrim(e->>'email'))
        FROM jsonb_array_elements(entries) e
        WHERE jsonb_typeof(e)='object' AND e->'verified'='true'::JSONB
          AND (e->'disabled' IS NULL OR e->'disabled' IN ('false'::JSONB,'null'::JSONB))
          AND jsonb_typeof(e->'email')='string' AND btrim(e->>'email')<>'';
EXCEPTION WHEN OTHERS THEN RETURN;
END $$;

CREATE OR REPLACE FUNCTION reconcile_balance_notification(p_user_id BIGINT, p_old_balance NUMERIC DEFAULT NULL)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
    u users%ROWTYPE; t NUMERIC; is_low BOOLEAN; enabled BOOLEAN;
    previous_low BOOLEAN; previous_eligible BOOLEAN; initialized BOOLEAN;
    eid BIGINT; email_ok BOOLEAN; crossed BOOLEAN;
BEGIN
    -- All paths acquire the user lock before touching events or deliveries.
    SELECT * INTO u FROM users WHERE id=p_user_id FOR UPDATE;
    IF NOT FOUND THEN RETURN; END IF;
    t := balance_notification_threshold(u);
    is_low := t>0 AND u.balance<t;
    enabled := u.deleted_at IS NULL AND u.status='active' AND u.balance_notify_enabled AND t>0
        AND EXISTS(SELECT 1 FROM settings WHERE key='balance_low_notify_enabled' AND value='true');
    SELECT low,eligible INTO previous_low,previous_eligible FROM balance_notification_state WHERE user_id=u.id;
    initialized := FOUND;
    SELECT id,email_allowed INTO eid,email_ok FROM balance_notification_events WHERE user_id=u.id AND closed_at IS NULL;
    crossed := p_old_balance IS NOT NULL AND p_old_balance>=t AND is_low;

    IF eid IS NOT NULL AND (NOT is_low OR u.deleted_at IS NOT NULL OR u.status<>'active' OR crossed) THEN
        UPDATE balance_notification_events SET closed_at=NOW() WHERE id=eid;
        UPDATE balance_notification_emails SET status='cancelled',completed_at=NOW(),lease_until=NULL
            WHERE event_id=eid AND status='pending';
        UPDATE balance_low_qq_deliveries SET cancelled_at=NOW(),claimed_until=NULL
            WHERE event_id=eid AND acked_at IS NULL AND cancelled_at IS NULL;
        eid := NULL;
    END IF;
    IF eid IS NULL AND is_low AND enabled AND (crossed OR (initialized AND NOT previous_low AND previous_eligible)) THEN
        INSERT INTO balance_notification_events(user_id,current_balance,threshold,origin)
            VALUES(u.id,u.balance,t,CASE WHEN crossed THEN 'deduction' ELSE 'compensation' END) RETURNING id INTO eid;
        email_ok := TRUE;
    END IF;
    INSERT INTO balance_notification_state(user_id,low,eligible) VALUES(u.id,is_low,enabled)
        ON CONFLICT(user_id) DO UPDATE SET low=EXCLUDED.low,eligible=EXCLUDED.eligible,observed_at=NOW()
        WHERE balance_notification_state.low IS DISTINCT FROM EXCLUDED.low
           OR balance_notification_state.eligible IS DISTINCT FROM EXCLUDED.eligible;
    IF eid IS NULL THEN RETURN; END IF;
    IF NOT enabled THEN
        UPDATE balance_notification_emails SET status='cancelled',completed_at=NOW(),lease_until=NULL
            WHERE event_id=eid AND status='pending';
        UPDATE balance_low_qq_deliveries SET cancelled_at=NOW(),claimed_until=NULL
            WHERE event_id=eid AND acked_at IS NULL AND cancelled_at IS NULL;
        RETURN;
    END IF;
    IF email_ok THEN
        INSERT INTO balance_notification_emails(event_id,recipient)
            SELECT eid,email FROM balance_notification_recipients(u.balance_notify_extra_emails)
            ON CONFLICT(event_id,recipient) DO NOTHING;
    END IF;
    INSERT INTO balance_low_qq_deliveries(user_id,binding_id,current_balance,threshold,site_name,recharge_url,event_id)
        SELECT u.id,b.id,u.balance,t,
            coalesce((SELECT value FROM settings WHERE key='site_name'),'Sub2API'),
            coalesce((SELECT value FROM settings WHERE key='balance_low_notify_recharge_url'),''),eid
        FROM bot_bindings b JOIN user_balance_notify_qq p ON p.user_id=b.user_id AND p.enabled
        WHERE b.user_id=u.id AND b.platform='qq' AND b.revoked_at IS NULL
        ON CONFLICT(event_id,binding_id) WHERE event_id IS NOT NULL DO NOTHING;
END $$;

-- Baseline existing balances without creating notifications for unknown history.
INSERT INTO balance_notification_state(user_id,low,eligible)
    SELECT u.id,t.v>0 AND u.balance<t.v,
        u.deleted_at IS NULL AND u.status='active' AND u.balance_notify_enabled AND t.v>0
        AND EXISTS(SELECT 1 FROM settings WHERE key='balance_low_notify_enabled' AND value='true')
    FROM users u CROSS JOIN LATERAL (SELECT balance_notification_threshold(u) v) t
    ON CONFLICT(user_id) DO NOTHING;

-- Keep only proven pending QQ work for currently low users. Never invent email history.
INSERT INTO balance_notification_events(user_id,current_balance,threshold,origin,email_allowed)
    SELECT DISTINCT ON (u.id) u.id,u.balance,balance_notification_threshold(u),'legacy_qq',FALSE
    FROM users u JOIN balance_low_qq_deliveries d ON d.user_id=u.id AND d.event_id IS NULL
      AND d.cancelled_at IS NULL AND d.acked_at IS NULL
    WHERE balance_notification_threshold(u)>0 AND u.balance<balance_notification_threshold(u)
      AND u.deleted_at IS NULL AND u.status='active'
    ORDER BY u.id,d.created_at DESC,d.id DESC
    ON CONFLICT(user_id) WHERE closed_at IS NULL DO NOTHING;
UPDATE balance_low_qq_deliveries d SET event_id=e.id
    FROM balance_notification_events e
    WHERE d.user_id=e.user_id AND e.closed_at IS NULL AND d.event_id IS NULL
      AND d.cancelled_at IS NULL AND d.acked_at IS NULL
      AND d.id=(SELECT d2.id FROM balance_low_qq_deliveries d2
                WHERE d2.user_id=d.user_id AND d2.binding_id=d.binding_id AND d2.event_id IS NULL
                  AND d2.cancelled_at IS NULL AND d2.acked_at IS NULL
                ORDER BY d2.created_at DESC,d2.id DESC LIMIT 1);
UPDATE balance_low_qq_deliveries SET cancelled_at=NOW() WHERE event_id IS NULL AND cancelled_at IS NULL;

CREATE OR REPLACE FUNCTION observe_balance_notification_change() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE t NUMERIC;
BEGIN
    t := balance_notification_threshold(NEW);
    -- Do not write notification tables for ordinary deductions on the same side.
    IF t<=0 OR (OLD.balance>=t AND NEW.balance>=t) OR (OLD.balance<t AND NEW.balance<t) THEN RETURN NEW; END IF;
    PERFORM reconcile_balance_notification(NEW.id,OLD.balance);
    RETURN NEW;
EXCEPTION WHEN OTHERS THEN
    -- A failed optional notification must not roll back committed billing work.
    RAISE WARNING 'balance notification registration failed user_id=% sqlstate=%',NEW.id,SQLSTATE;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS balance_notification_balance_change ON users;
CREATE TRIGGER balance_notification_balance_change AFTER UPDATE OF balance ON users
    FOR EACH ROW WHEN (OLD.balance IS DISTINCT FROM NEW.balance)
    EXECUTE FUNCTION observe_balance_notification_change();
