-- Usage billing intentionally allows a committed balance to become negative.
-- Admission checks reject new requests while the balance is below the minimum,
-- and an overdraft event cancels the user's other in-flight requests.
DROP TRIGGER IF EXISTS users_enforce_non_negative_balance ON users;
DROP FUNCTION IF EXISTS public.enforce_non_negative_user_balance();
