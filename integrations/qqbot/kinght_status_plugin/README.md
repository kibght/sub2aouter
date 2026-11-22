# Kinght 站点状态插件

这是一个 MaiBot 插件，用来查询 `https://api.kinght.top/` 的渠道健康状态、首 Token（TTFT）指标、绑定账号用量并接收 QQ 余额预警。

## 安装

将 `kinght_status_plugin` 整个目录复制到 MaiBot 的 `plugins` 目录，重载插件或重启 MaiBot。插件配置中填写：

- `api_base_url`：默认 `https://api.kinght.top/api/v1`，通常无需修改。
- `email`：网站账号邮箱。
- `password`：网站账号密码。
- `access_token`：浏览器登录后，从本地存储的 `auth_token` 获取。
- `refresh_token`：浏览器登录后，从本地存储的 `refresh_token` 获取。
- `admin_api_key`：网站管理员 API Key。新版网站的绑定码兑换、账号用量和余额预警接口都要求请求同时携带此 `x-api-key` 和绑定令牌；请通过密码控件配置，不要发送到聊天中。
- `first_token_source`：普通用户固定使用 `public`；管理员可以使用 `admin_overview` 或 `admin_models`。
- `first_token_range`：首 Token 命令的默认查询范围，普通用户常用 `24h`、`7d` 或 `30d`。
- `admin_user_ids`：可使用管理员首 Token 数据源和 `/绑定诊断` 的用户 ID，多个 ID 用逗号或换行分隔；也可写成 `平台:user_id`；留空表示不启用管理员功能。
- `allowed_group_ids`：群聊白名单，多个群 ID 用逗号或换行分隔；留空表示允许所有群聊。私聊不受该项限制。
- `onebot_api_base`：QQ 适配器的 OneBot HTTP 地址（例如 `http://127.0.0.1:3000`）。SnowLuma 适配器配置可用时插件会优先调用 `recall_message`；填写此地址可作为兼容回退。
- `onebot_access_token`：OneBot HTTP 访问令牌；适配器未设置令牌时留空。
- `enable_group_join_approval`：启用邮箱核对入群，默认开启；会优先使用 SnowLuma 适配器连接，也可使用 OneBot HTTP 地址回退，并需要网站管理员账号和管理员 API Key。
- `group_join_approval_group_ids`：自动审批的群号，多个群号用逗号或换行分隔；留空处理所有群。
- `group_join_approval_interval_seconds`：轮询待处理入群申请的间隔，默认 30 秒。
- `reject_invalid_group_join_requests`：邮箱缺失、格式不正确或未找到网站用户时自动拒绝入群，并把具体原因写入 QQ 审核回复；默认开启。管理员接口暂时不可用时会保留申请，待下一轮重试。

余额预警由网站个人资料中的余额预警总开关、阈值和 QQ 机器人开关控制。插件不读取或保存网站账号的普通 API Key；仅使用绑定码兑换的网站机器人令牌。管理员 API Key 只作为请求头使用。

### 触发词配置

“触发词”配置分组中可以分别配置余额预警、账号命令和三个状态命令：

- `余额预警触发词`：默认 `余额预警`；可在私聊或群聊查询网站开关状态。
- `个人信息触发词`：默认 `个人信息`；仅在私聊查询绑定网站账号的个人信息。
- `绑定账号触发词`、`解绑账号触发词`、`绑定状态触发词`、`绑定帮助触发词`、`绑定诊断触发词`、`个人信息触发词`、`我的用量触发词`、`Key用量触发词`、`余额预警触发词` 和 `签到触发词`：分别配置账号命令的触发词。
- `启用渠道状态` 和 `渠道状态触发词`：默认 `渠道状态，渠道，状态`。
- `启用首字状态` 和 `首字状态触发词`：默认 `首字状态，首字，首Token`。
- `启用站点状态` 和 `站点状态触发词`：默认 `站点状态，网站状态`。

触发词填写时可以用逗号、中文逗号、空格、换行、分号或竖线分隔。触发词需要带 `/` 使用，例如自定义 `健康查询` 后可发送 `/健康查询 海外`；后面的 `海外` 会按分组名称关键词筛选。留空参数时显示全部分组。关闭某项开关后，该项自定义触发词和对应旧命令都不会执行。

如果网站启用了 Cloudflare Turnstile，插件不能代替浏览器完成人机验证。请先在浏览器登录网站，再打开开发者工具的“应用程序 / Application”中的本地存储，选择 `https://api.kinght.top`，将 `auth_token` 填入 `access_token`，将 `refresh_token` 填入 `refresh_token`。不要把这两个令牌发送到聊天中。

插件优先使用配置的令牌。access token 过期时会调用网站的刷新接口；网站轮换令牌后，插件会将最新令牌保存在 MaiBot 分配给本插件的持久数据目录中，重启后继续使用。令牌缓存不会写入聊天消息或插件源码目录。配置 `email` 和 `password` 仍可用于未启用 Turnstile 的站点登录；登录接口要求 HTTPS，账号启用了双重验证时插件会提示无法完成登录。

也可以通过环境变量提供账号信息：

```text
KINGHT_API_EMAIL=你的账号邮箱
KINGHT_API_PASSWORD=你的账号密码
KINGHT_API_ACCESS_TOKEN=浏览器中的auth_token
KINGHT_API_REFRESH_TOKEN=浏览器中的refresh_token
KINGHT_ADMIN_API_KEY=网站管理员APIKey
```

权限配置示例：

```text
admin_user_ids=qq:123456789,987654321
allowed_group_ids=246801357
```

登录凭据仅用于请求网站登录接口，不会写入聊天消息。通过环境变量配置令牌时，令牌轮换后的值同样保存在 MaiBot 分配的持久数据目录中。

## 命令

### 网站账号绑定与用量

先登录网站，在个人资料页点击“生成机器人绑定码”，再向机器人发送：

```text
/绑定账号 <绑定码>
/绑定状态
/解绑账号
/个人信息
/我的用量
/Key用量
/余额预警
/签到
/绑定帮助
/绑定诊断
```

绑定码只能使用一次并会自动过期。首次绑定成功会赠送 `$0.50`，机器人仅在网站返回首绑奖励时提示到账；重新绑定不会重复发放。插件只保存网站签发的机器人会话令牌，不保存网站密码、浏览器 JWT 或 API Key；绑定数据按 `平台:用户ID` 隔离。绑定、解绑、绑定状态、`/绑定帮助`、`/绑定诊断`、`/余额预警` 和 `/签到` 可在私聊或群聊中查询；`/我的用量` 和 `/Key用量` 统一要求私聊执行。群聊回复会艾特当前用户，绑定状态中的用户标识会脱敏显示。发送 `/绑定账号 <绑定码>` 后，插件会按顺序尝试调用宿主的 `recall_message` 工具、宿主传入的适配器对象、SnowLuma 的 OneBot WebSocket `delete_msg`，最后按配置调用 OneBot HTTP 的 `delete_msg`。全部路径不可用时，插件会在回复中明确提示，并建议手动撤回。

签到命令触发词可在插件“触发词”设置中修改，默认支持 `/签到`。

签到门槛由网站配置，可选“每日消费金额”或“Token 用量”。插件按接口 `usage_requirement` 返回的 `amount` 或 `tokens` 显示不足原因：金额模式显示今日消费金额和要求金额（美元，最多 8 位小数），Token 模式显示今日用量和要求用量。金额模式仅统计余额消费，不含订阅；门槛为 0 时由网站直接判断是否可签到。旧接口未返回模式时兼容 Token 用量。两种门槛的签到奖励均为余额。

`/签到` 按最新网站返回的业务状态处理：成功返回赠送金额和连续签到天数；重复签到返回当天已领取金额和连续签到天数；签到功能关闭、今日 Token 使用量不足、账号停用或服务不可用时分别返回对应原因，并附带 `签到状态：success`、`already_checked_in`、`disabled`、`insufficient_usage`、`account_inactive` 或 `service_unavailable`，方便机器人继续识别。签到接口发生未绑定、绑定失效、授权失败、限流或 HTTP 错误时，也会返回对应的 `签到状态`；重复签到和未绑定错误不会再与普通失败混淆。签到赠送金额直接计入网站用户管理页面的余额，后台充值记录说明会标记为“签到赠送金额”，与用户主动充值区分。

1.4.8 起，签到成功按以下格式显示，发送给用户的状态统一显示为中文：

```text
赠送金额：$0.19
本月签到：1/30天
本周签到：1/7天
连续签到：1天
签到状态：成功
```

重复签到显示“今日已签到”和“已领取金额”，并显示相同的签到统计，状态为“已签到”。统计读取网站接口的 `month_checked_days`、`month_total_days`、`week_checked_days`、`consecutive_days`，本月天数由网站提供，本周固定为 7 天。统计以网站签到记录为准；旧接口或部分字段缺失时，对应统计显示“暂无数据”，真实零值正常展示。连续签到天数不使用奖励周期 `streak_day` 推算，可跨月、跨周累计。

本周签到满 7 天才双倍：周一至周日每天都签到，周日领取双倍。

账号命令的回复都会带稳定状态：绑定成功或用量查询成功为 `账号状态：bound`，解绑成功为 `unbound`，未绑定为 `not_bound`，群聊、平台或用户上下文不完整为 `context_invalid`，绑定码错误、绑定失效、账号停用、授权失败、限流、超时、网络错误、HTTP 错误和响应格式错误分别返回对应状态。`/余额预警` 会返回 `余额预警状态：enabled`、`disabled`、`platform_unsupported`、`binding_invalid`、`binding_not_found`、`unauthorized`、`account_inactive`、`forbidden`、`rate_limited`、`timeout`、`network_error`、`invalid_response`、`server_error`、`http_error` 或 `service_unavailable`；实际推送的预警消息带 `余额预警状态：triggered`。下游机器人可以直接按状态分支，无需解析中文原因。

启用邮箱核对入群后，插件每隔一段时间优先通过 MaiBot SnowLuma 的 `adapter.napcat.group.get_group_system_msg` 获取 `data.join_requests`，从申请的 `message`（同时兼容拆分的备注/答案字段）中提取邮箱，使用网站管理员会话和 `x-api-key` 调用 `GET /api/v1/admin/users?search=<邮箱>` 做精确匹配；匹配到网站用户后按 `request_id` 调用 `adapter.napcat.group.set_group_add_request` 同意。未填写邮箱、邮箱格式不正确或没有找到该邮箱用户时，插件会调用同一接口拒绝申请，并在 `reason` 中返回对应的具体原因；管理员接口暂时不可用时保留申请并在下一轮重试。没有 `api.call` 能力时再使用 SnowLuma 配置的 OneBot WebSocket 或 `onebot_api_base` 回退。

`/余额预警` 读取网站公开设置中的余额预警总开关，并返回已开启或未开启；群聊和私聊均可查询。网站后台开启余额预警总开关、个人资料页开启余额不足通知、设置阈值并开启 QQ 机器人预警后，插件启动时和之后每 60 秒领取一次待发提醒。每条提醒包含网站、当前余额、预警阈值和充值地址；私聊发送成功后插件才确认，发送失败或确认失败会在服务端租约到期后重试。

`/绑定诊断` 仅允许 `admin_user_ids` 中的管理员账号使用，会依次检查账号资料、仪表盘用量和周期用量，显示 HTTP 状态、站点错误码和耗时；回复不会显示站点 URL、接口路径或异常详情。

```text
/渠道状态
/渠道状态 分组名称关键词
/首字状态
/首字状态 分组名称关键词
/站点状态
```

`/站点状态` 只显示渠道监控总览和逐分组的首 Token、成功率和缓存率，并使用紧凑的分组卡片格式。

`/渠道状态` 和 `/首字状态` 后面的参数都是分组名称关键词，会按 `group_name` 做包含匹配；不带参数时显示全部分组。首字查询的默认时间范围仍由 `first_token_range` 配置决定。

`/站点状态` 的首 TOKEN 按网站监控页面显示为单值秒数（例如 `5.0s`，无数据为 `-`），每个分组同时显示网站返回的倍率（例如 `倍率 0.08x`）。

三个状态命令不再限制管理员用户。普通用户使用公开首 Token 数据，`admin_user_ids` 中的用户可以使用配置的管理员首 Token 数据源；如果配置了 `allowed_group_ids`，群聊命令只在白名单群聊中执行。

## 数据来源

- 个人信息：`GET /api/v1/admin/bot/personal-info`，请求同时携带管理员 `x-api-key` 和当前用户的 Bot 绑定令牌。接口约定及回复示例见 [个人信息接口说明](PERSONAL_INFO_API.md)。
- 渠道状态：V2 监控模式下使用普通用户可访问的 `GET /api/v1/channel-monitor-v2/snapshot?range=24h` 显示总览，并使用 `GET /api/v1/channel-monitor-v2/dimensions?range=24h` 和 `GET /api/v1/channel-monitor-v2/matrix?range=24h&group_by=platform_group` 显示逐分组指标；V1 模式使用 `GET /api/v1/channel-monitors` 显示渠道明细。
- 分组倍率：V2 监控模式额外读取普通用户可访问的 `GET /api/v1/groups/available`，按分组 ID 或名称合并 `rate_multiplier`。
- `/站点状态` 默认使用网站渠道监控页面的 `90m` 范围，也可以使用 `/站点状态 24h`、`/站点状态 7d` 或 `/站点状态 30d` 指定范围。
- 渠道监控中的成功率按网站页面口径计算为 `1 - error_rate`；接口同时返回的 `success_rate` 不用于该显示，因此会与网站页面保持一致。
- 普通用户首 Token 状态：`GET /api/v1/channel-monitor-v2/snapshot?range=24h`；带关键词时追加 `group_name`，并兼容返回分组明细后的本地筛选。
- 管理员分组查询：`GET /api/v1/admin/groups?search=<分组名称关键词>`，再将分组 ID 传给统计接口。
- 管理员首 Token 概览：`GET /api/v1/admin/ops/dashboard/overview?time_range=24h&group_id=<id>`。
- 管理员按模型统计：`GET /api/v1/admin/ops/dashboard/openai-token-stats?time_range=1d&group_id=<id>`。
- QQ 余额预警领取：请求同时携带管理员 `x-api-key` 和绑定令牌，调用 `GET /api/v1/admin/bot/balance-alerts`；私聊发送成功后调用 `POST /api/v1/admin/bot/balance-alerts/{id}/ack`。

普通用户首 Token 数据受网站监控开关和账号权限影响；管理员模式必须配置管理员账号。网站关闭渠道监控或对应时间范围没有流量时，插件会显示暂无统计数据。

## 个人信息

绑定网站账号后，在私聊中发送 `/个人信息`。机器人显示网站昵称、用户 ID、账户余额、总并发、当前并发和当前 RPM（近 60 秒）。群聊调用时只艾特发送者并提示私聊，不查询个人数据。

RPM 按近 60 秒已写入用量记录的请求数展示。缺失或为 `null` 的数值项会省略，真实零值正常展示；昵称为空显示“未设置”，总并发小于等于零显示“不限制”，余额最多保留六位小数。网站需要提供上述个人信息接口，具体字段见 [个人信息接口说明](PERSONAL_INFO_API.md)。

## 充值、抽奖与次数发放（1.4.9）

需要同时升级网站后端并运行相应数据库迁移。插件保留 `/Key用量`、`/首Token` 等混合中文名称；纯英文指令别名已经移除，旧配置中的纯英文触发词也不会执行或出现在帮助中。内部组件标识、接口字段和网站 API 路径不受影响。

```text
/充值
/充值 10 支付宝
/充值 10 微信
/充值订单
/充值订单 <订单号>
/抽奖
/抽奖次数
/抽奖记录
/发放抽奖次数 <QQ号> <次数> [备注]
/发放抽奖次数 全部 <次数> [备注]
/发放抽奖次数 查询 <批次号>
```

充值和订单查询仅限私聊。金额按所选支付渠道的币种解释，机器人分别显示实际应付金额和预计到账的网站余额。二维码由网站生成，插件不需要额外安装图片库。支付完成并实际入账后，机器人会在启动时和之后每 60 秒领取到账通知，私聊成功发送后确认。订单查询可以恢复原支付二维码，不会重新创建订单。

抽奖和次数查询支持群聊及私聊；抽奖记录仅限私聊。群内回复艾特发起者，只展示本次奖励和剩余次数。奖池、概率和开关在网站后台配置，余额奖励由网站事务入账；插件不在本地随机发奖。次数归属网站账号，解绑重绑后保留。

发放次数仅限管理员私聊。操作者的 QQ 号必须在 `admin_user_ids` 中，同时绑定的网站账号必须是管理员。`全部` 表示给网站中所有有效 QQ 绑定的网站账号各增加指定次数，按网站用户去重，不依赖插件本地绑定列表。网站后台也支持单人和全体发放。批次状态持久保存，可重启恢复，完成后机器人向发起管理员私聊汇总；亦可按批次号查询。

充值、抽奖和发放命令需要原始 QQ 消息编号。重复消息使用同一个请求标识；请求超时时保留待确认操作，重发相同操作先恢复原请求，不会自动更换标识再次抽奖或下单。请先查询原订单、抽奖记录或发放批次。待确认请求与批次记录保存在插件持久数据目录。

### 抽奖余额门槛（1.4.11）

发送 `/抽奖` 后，插件先读取当前绑定账号的个人信息验证余额。余额为零或负数时，仅回复“余额不足”，不发送抽奖请求，不消耗次数。余额读取失败、缺失或异常时也停止抽奖；只有余额大于零才会继续。网站端会在数据库事务中再次校验余额，避免并发消费后仍执行抽奖。


### 1.4.12 API migration

Bot endpoints now use `/api/v1/admin/bot/*`; binding redemption uses `/api/v1/admin/bot-bindings/redeem`. Upgrade the website and plugin together. The administrator key remains in `x-api-key`; the bound user remains in `Authorization: Bot`. Existing binding data and cached sessions remain valid.
