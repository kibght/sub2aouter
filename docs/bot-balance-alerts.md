# QQ 余额预警接口

机器人使用已绑定的令牌调用以下接口，认证头为 `Authorization: Bot <token>`。仅平台为 `qq` 的绑定可领取提醒。

## 领取提醒

`GET /api/v1/bot/balance-alerts`

响应数据位于标准响应的 `data.items`：

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "items": [
      {
        "id": 42,
        "current_balance": 3.5,
        "threshold": 5,
        "site_name": "Example",
        "recharge_url": "https://example.com/recharge",
        "created_at": "2026-10-26T05:00:00Z"
      }
    ]
  }
}
```

每次最多领取 20 条，按创建时间排序；成功领取后两分钟内不会被其他轮询重复领取。插件应向当前绑定对应的 QQ 账号发送私聊，发送失败时不要确认，租约到期后提醒会重新出现。

## 确认发送

私聊发送成功后调用：

`POST /api/v1/bot/balance-alerts/{id}/ack`

请求体为空。成功响应的 `data.acknowledged` 为 `true`。确认操作仅删除当前用户、当前绑定拥有的提醒。若 QQ 已接受消息但确认请求失败，租约到期后可能重复发送，因此投递语义为至少一次。

## 开关与绑定

- 网站个人资料页的 QQ 开关依赖现有余额预警总开关和阈值；没有有效 QQ 绑定时不能开启。
- 关闭 QQ 开关会清除该用户所有未发送提醒；关闭总开关也会清除未发送提醒。
- 解除最后一个 QQ 绑定会关闭 QQ 开关并清除该绑定的提醒。
- 只有在余额首次从阈值及以上扣到阈值以下时才生成提醒；全局余额预警设置关闭时不生成或投递提醒。
