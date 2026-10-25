-- 机器人绑定的生效唯一索引按"用户"收敛。
--
-- 兑换接口是公开的：external_id（例如 QQ 号）由调用方提供，服务端无法证明调用方
-- 真的拥有该聊天账号。192 的 (platform, external_id) 唯一索引要求兑换时吊销同平台
-- 同 ID 的所有绑定，等于允许任何登录用户让别人的机器人令牌失效。
-- 改为 (user_id, platform, external_id)：同一用户对同一聊天账号仍只有一条生效绑定，
-- 不同用户之间的绑定互不影响。

DROP INDEX IF EXISTS uq_bot_bindings_active_external;

CREATE UNIQUE INDEX IF NOT EXISTS uq_bot_bindings_active_user_external
    ON bot_bindings (user_id, platform, external_id)
    WHERE revoked_at IS NULL;
