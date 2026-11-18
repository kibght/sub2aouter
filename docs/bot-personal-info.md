# 个人信息接口说明

## 请求

```http
GET /api/v1/bot/personal-info
Authorization: Bot <当前发送者的绑定令牌>
x-api-key: <插件配置的网站管理员 API Key>
```

无查询参数、无请求体。网站按 Bot 令牌绑定的用户确定查询对象，沿用现有机器人接口的双重认证；资料属于绑定用户，不属于管理员 API Key 对应的管理员。可沿用聚合查询的限流规则。

## 成功响应

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "id": 123,
    "username": "示例昵称",
    "balance": 12.5,
    "concurrency": 10,
    "current_concurrency": 2,
    "current_rpm": 6,
    "rpm_window_seconds": 60
  }
}
```

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `id` | 整数 | 绑定的网站用户 ID |
| `username` | 字符串 | 网站昵称；空值显示“未设置” |
| `balance` | 数值 | 与网站一致的账户余额；显示美元符号，最多六位小数 |
| `concurrency` | 整数 | 用户总并发额度；小于等于零表示不限制 |
| `current_concurrency` | 整数或 `null` | 当前正在执行的用户请求并发数 |
| `current_rpm` | 整数或 `null` | 近 60 秒已写入用量记录的请求总数 |
| `rpm_window_seconds` | 整数 | 固定为 `60` |

RPM 的统计范围是当前绑定用户的 `[当前时间−60秒, 当前时间)`，不要传入现有仪表盘的五分钟平均 RPM。有效的零值必须返回 `0`；无法取得的数值可以省略或返回 `null`，机器人直接省略相应行。

示例回复：

```text
👤 个人信息
昵称：示例昵称
用户 ID：123
账户余额：$12.5
总并发：10
当前并发：2
当前 RPM（近 60 秒）：6
账号状态：已绑定
```

## 错误响应

沿用现有机器人接口的 HTTP 状态及错误码，例如 `BOT_BINDING_INVALID`、`BOT_BINDING_NOT_FOUND`、`TOKEN_REVOKED`、`USER_NOT_FOUND`、`USER_INACTIVE`、`INVALID_ADMIN_KEY`。插件复用账号错误提示，只在确定绑定失效时清理本地绑定；普通接口 404、限流和服务故障不清理绑定。

接口返回邮箱、密钥等额外字段时，机器人不会将它们加入个人信息回复。

## Backend behavior

- Requires both the administrator `x-api-key` and the caller's `Authorization: Bot <token>` credentials.
- Applies the existing per-user global and heavy-query rate limits. Query parameters cannot select another user or change the RPM window.
- Reads `balance` directly from the user record, matching the website. It does not expose frozen balance, email, or credentials.
- Counts persisted usage records in the half-open 60-second window; requests that have not written a usage record are excluded.
- Reads current concurrency from the user slot cache. For an unlimited concurrency quota (`concurrency <= 0`), the count is `null` because these requests bypass slot tracking.
- Each dynamic metric has an independent two-second timeout. A failed or unavailable metric is returned as `null`; the other metric and basic profile remain available. Successful zero counts are returned as `0`.
- The existing `/api/v1/bot/profile` contract is unchanged. No database migration is required.
- Deploy the backend before enabling the command in plugin 1.4.5.
