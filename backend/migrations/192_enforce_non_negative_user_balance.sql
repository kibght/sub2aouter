-- Keep legacy negative balances untouched. The trigger validates inserts and
-- actual balance changes while allowing unrelated fields on legacy rows to be updated.

CREATE OR REPLACE FUNCTION public.enforce_non_negative_user_balance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'INSERT' OR NEW.balance IS DISTINCT FROM OLD.balance THEN
        IF NEW.balance IS NULL
           OR NEW.balance < 0
           OR NEW.balance::text IN ('NaN', 'Infinity', '-Infinity') THEN
            RAISE EXCEPTION 'user balance must be finite and non-negative'
                USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS users_enforce_non_negative_balance ON users;
CREATE TRIGGER users_enforce_non_negative_balance
    BEFORE INSERT OR UPDATE OF balance ON users
    FOR EACH ROW
    EXECUTE FUNCTION public.enforce_non_negative_user_balance();
