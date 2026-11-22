"""MaiBot 插件：查询 api.kinght.top 的渠道和首 Token 状态。"""

from __future__ import annotations

import asyncio
import hashlib
import inspect
import json
import logging
import math
import os
import re
import tempfile
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Mapping
from urllib.error import HTTPError, URLError
from urllib.request import Request, build_opener

from maibot_sdk import Command, Field, MaiBotPlugin, PluginConfigBase

try:
    from maibot_sdk import HookHandler
except ImportError:
    try:
        from maibot_sdk.components import HookHandler
    except ImportError:
        class _CompatHookType:
            value = "HOOK_HANDLER"

        class _CompatHookInfo:
            """为缺少 HookHandler 导出但仍支持组件收集的 SDK 提供元数据。"""

            def __init__(self, name: str, hook: str, description: str) -> None:
                self.name = name
                self.type = _CompatHookType()
                self.metadata = {}
                self.hook = hook
                self.description = description

            def model_dump(self, *, mode: str = "python", exclude: set[str] | None = None) -> dict[str, Any]:
                del mode
                values = {
                    "description": self.description,
                    "enabled": True,
                    "hook": self.hook,
                    "mode": "blocking",
                    "order": "normal",
                    "timeout_ms": 0,
                    "error_policy": "skip",
                }
                for key in exclude or set():
                    values.pop(key, None)
                return values

        def HookHandler(
            hook: str,
            *,
            name: str = "",
            description: str = "",
            **_kwargs: Any,
        ):
            """兼容缺少公共导出时的命名 Hook 装饰器。"""

            def decorator(function: Any) -> Any:
                function.__maibot_component_info__ = _CompatHookInfo(
                    name or function.__name__, hook, description
                )
                return function

            return decorator

try:
    from .client import KinghtAPIClient, KinghtAPIError
except ImportError:  # 兼容宿主按单文件方式加载 plugin.py 的旧版插件加载器
    from client import KinghtAPIClient, KinghtAPIError


STATUS_LABELS = {
    "operational": "正常",
    "healthy": "正常",
    "ok": "正常",
    "good": "正常",
    "degraded": "降级",
    "warning": "警告",
    "failed": "失败",
    "critical": "严重",
    "error": "错误",
    "unavailable": "不可用",
    "unknown": "未知",
}

STATE_TEXT_LABELS = {
    "bound": "已绑定",
    "not_bound": "未绑定",
    "unbound": "已解绑",
    "binding_invalid": "绑定已失效",
    "binding_not_found": "未找到绑定记录",
    "binding_code_required": "缺少绑定码",
    "binding_code_invalid": "绑定码无效",
    "binding_limit_reached": "绑定数量已达上限",
    "platform_required": "未识别平台",
    "platform_unsupported": "不支持的平台",
    "external_id_required": "未识别用户",
    "context_invalid": "会话信息无效",
    "unauthorized": "授权失败",
    "account_inactive": "账号已停用",
    "forbidden": "无权限",
    "rate_limited": "请求过于频繁",
    "service_unavailable": "服务暂不可用",
    "insufficient_usage": "用量不足",
    "success": "成功",
    "already_checked_in": "已签到",
    "disabled": "未开启",
    "enabled": "已开启",
    "configuration_error": "配置错误",
    "invalid_response": "返回数据异常",
    "invalid_request": "请求参数错误",
    "http_error": "请求失败",
    "server_error": "服务器错误",
    "timeout": "请求超时",
    "network_error": "网络连接失败",
    "not_found": "接口不存在",
    "triggered": "已触发",
    "ok": "正常",
    "failed": "失败",
    "pending": "处理中",
    "completed": "已完成",
    "replayed": "已恢复原结果",
    "insufficient_balance": "余额不足",
    "insufficient_plays": "抽奖次数不足",
    "lottery_disabled": "抽奖活动未开启",
    "recharge_disabled": "充值功能未开启",
    "channel_unavailable": "支付渠道不可用",
    "invalid_amount": "充值金额无效",
    "result_unknown": "结果待确认",
    "conflict": "请求冲突",
}

_STATUS_VALUE_PATTERN = re.compile(
    r"((?:账号|签到|余额预警|充值|抽奖|次数发放|诊断|健康)?状态：)([A-Za-z][A-Za-z0-9_-]*)"
)


class PluginSectionConfig(PluginConfigBase):
    """插件启用状态和配置元数据。"""

    __ui_label__ = "插件"

    enabled: bool = Field(default=True, description="是否启用插件")
    config_version: str = Field(default="1.4.12", description="插件配置版本")


class TriggerSectionConfig(PluginConfigBase):
    """触发词与功能开关。"""

    __ui_label__ = "触发词"
    __ui_order__ = 1

    enable_channel_status: bool = Field(
        default=True,
        description="是否启用渠道状态命令",
        json_schema_extra={"label": "启用渠道状态"},
    )
    channel_status_triggers: str = Field(
        default="渠道状态，渠道，状态",
        description="渠道状态触发词，多个词用逗号、空格或换行分隔；为空时忽略",
        json_schema_extra={"label": "渠道状态触发词", "placeholder": "渠道状态，渠道，状态"},
    )
    enable_first_token_status: bool = Field(
        default=True,
        description="是否启用首字状态命令",
        json_schema_extra={"label": "启用首字状态"},
    )
    first_token_status_triggers: str = Field(
        default="首字状态，首字，首Token",
        description="首字状态触发词，多个词用逗号、空格或换行分隔；为空时忽略",
        json_schema_extra={"label": "首字状态触发词", "placeholder": "首字状态，首字，首Token"},
    )
    enable_site_status: bool = Field(
        default=True,
        description="是否启用站点状态命令",
        json_schema_extra={"label": "启用站点状态"},
    )
    site_status_triggers: str = Field(
        default="站点状态，网站状态",
        description="站点状态触发词，多个词用逗号、空格或换行分隔；为空时忽略",
        json_schema_extra={"label": "站点状态触发词", "placeholder": "站点状态，网站状态"},
    )
    bind_account_triggers: str = Field(
        default="绑定账号",
        description="绑定账号触发词，多个词用逗号、空格或换行分隔",
        json_schema_extra={"label": "绑定账号触发词", "placeholder": "绑定账号"},
    )
    unbind_account_triggers: str = Field(
        default="解绑账号",
        description="解绑账号触发词，多个词用逗号、空格或换行分隔",
        json_schema_extra={"label": "解绑账号触发词", "placeholder": "解绑账号"},
    )
    binding_status_triggers: str = Field(
        default="绑定状态",
        description="绑定状态触发词，多个词用逗号、空格或换行分隔",
        json_schema_extra={"label": "绑定状态触发词", "placeholder": "绑定状态"},
    )
    binding_help_triggers: str = Field(
        default="绑定帮助",
        description="绑定帮助触发词，多个词用逗号、空格或换行分隔",
        json_schema_extra={"label": "绑定帮助触发词", "placeholder": "绑定帮助"},
    )
    binding_diagnose_triggers: str = Field(
        default="绑定诊断",
        description="绑定诊断触发词，多个词用逗号、空格或换行分隔",
        json_schema_extra={"label": "绑定诊断触发词", "placeholder": "绑定诊断"},
    )
    personal_info_triggers: str = Field(
        default="个人信息",
        description="个人信息触发词，多个词用逗号、空格或换行分隔",
        json_schema_extra={"label": "个人信息触发词", "placeholder": "个人信息"},
    )
    my_usage_triggers: str = Field(
        default="我的用量",
        description="我的用量触发词，多个词用逗号、空格或换行分隔",
        json_schema_extra={"label": "我的用量触发词", "placeholder": "我的用量"},
    )
    key_usage_triggers: str = Field(
        default="Key用量",
        description="Key用量触发词，多个词用逗号、空格或换行分隔",
        json_schema_extra={"label": "Key用量触发词", "placeholder": "Key用量"},
    )
    balance_alerts_triggers: str = Field(
        default="余额预警",
        description="余额预警触发词，多个词用逗号、空格或换行分隔",
        json_schema_extra={"label": "余额预警触发词", "placeholder": "余额预警"},
    )
    check_in_triggers: str = Field(
        default="签到",
        description="签到触发词，多个词用逗号、空格或换行分隔",
        json_schema_extra={"label": "签到触发词", "placeholder": "签到"},
    )
    recharge_triggers: str = Field(
        default="充值",
        description="充值触发词，多个词用逗号、空格或换行分隔",
        json_schema_extra={"label": "充值触发词", "placeholder": "充值"},
    )
    recharge_order_triggers: str = Field(
        default="充值订单",
        description="充值订单查询触发词，多个词用逗号、空格或换行分隔",
        json_schema_extra={"label": "充值订单触发词", "placeholder": "充值订单"},
    )
    lottery_triggers: str = Field(
        default="抽奖",
        description="抽奖触发词，多个词用逗号、空格或换行分隔",
        json_schema_extra={"label": "抽奖触发词", "placeholder": "抽奖"},
    )
    lottery_plays_triggers: str = Field(
        default="抽奖次数",
        description="抽奖次数查询触发词，多个词用逗号、空格或换行分隔",
        json_schema_extra={"label": "抽奖次数触发词", "placeholder": "抽奖次数"},
    )
    lottery_records_triggers: str = Field(
        default="抽奖记录",
        description="抽奖记录查询触发词，多个词用逗号、空格或换行分隔",
        json_schema_extra={"label": "抽奖记录触发词", "placeholder": "抽奖记录"},
    )
    lottery_grant_triggers: str = Field(
        default="发放抽奖次数",
        description="管理员发放抽奖次数触发词",
        json_schema_extra={"label": "发放抽奖次数触发词", "placeholder": "发放抽奖次数"},
    )


class KinghtStatusConfig(PluginConfigBase):
    """站点状态插件配置。"""

    plugin: PluginSectionConfig = Field(default_factory=PluginSectionConfig)
    triggers: TriggerSectionConfig = Field(default_factory=TriggerSectionConfig)

    api_base_url: str = Field(
        default="https://api.kinght.top/api/v1",
        description="站点 API 地址，可填写 https://api.kinght.top 或完整的 /api/v1 地址",
    )
    email: str = Field(
        default="",
        description="用于登录 Kinght 网站的邮箱",
    )
    password: str = Field(
        default="",
        description="Kinght 网站账号密码",
        json_schema_extra={"x-widget": "password"},
    )
    access_token: str = Field(
        default="",
        description="Kinght 网站访问令牌；填写后优先使用",
        json_schema_extra={"x-widget": "password"},
    )
    admin_api_key: str = Field(
        default="",
        description="网站机器人接口所需的管理员 API Key，会作为 x-api-key 请求头发送",
        json_schema_extra={"label": "网站管理员 API Key", "x-widget": "password"},
    )
    refresh_token: str = Field(
        default="",
        description="用于续期访问令牌的 Kinght 网站刷新令牌",
        json_schema_extra={"x-widget": "password"},
    )
    request_timeout_seconds: float = Field(default=10.0, description="接口请求超时时间（秒）")
    first_token_source: str = Field(
        default="public",
        description="首 Token 数据来源：public、admin_overview 或 admin_models",
    )
    first_token_range: str = Field(default="24h", description="默认查询时间范围")
    max_channels: int = Field(default=20, description="一次消息最多显示的渠道数量")
    max_model_rows: int = Field(default=10, description="管理员首 Token 模型统计最多显示的数量")
    admin_user_ids: str = Field(
        default="",
        description="可使用管理员首 Token 数据源和绑定诊断的用户 ID，多个 ID 用逗号或换行分隔；留空不启用管理员功能",
    )
    allowed_group_ids: str = Field(
        default="",
        description="群聊白名单，多个群 ID 用逗号或换行分隔；留空允许所有群聊",
    )
    onebot_api_base: str = Field(
        default="",
        description="QQ 适配器的 OneBot HTTP 地址，例如 http://127.0.0.1:3000；填写后插件才能真正撤回绑定码消息",
        json_schema_extra={"label": "OneBot HTTP 地址", "placeholder": "http://127.0.0.1:3000"},
    )
    onebot_access_token: str = Field(
        default="",
        description="OneBot HTTP 访问令牌；适配器未设置令牌时留空",
        json_schema_extra={"label": "OneBot 访问令牌", "x-widget": "password"},
    )
    enable_group_join_approval: bool = Field(
        default=True,
        description="自动核对入群申请备注中的邮箱，匹配网站用户后同意入群",
        json_schema_extra={"label": "启用邮箱核对入群"},
    )
    group_join_approval_group_ids: str = Field(
        default="",
        description="自动审批的群号，多个群号用逗号或换行分隔；留空处理所有群",
        json_schema_extra={"label": "入群审批群号"},
    )
    group_join_approval_interval_seconds: float = Field(
        default=30.0,
        description="轮询 OneBot 入群申请的间隔（秒）",
        json_schema_extra={"label": "入群申请轮询间隔"},
    )
    reject_invalid_group_join_requests: bool = Field(
        default=True,
        description="邮箱缺失、格式错误或未找到网站用户时自动拒绝入群并返回原因",
        json_schema_extra={"label": "拒绝无效入群申请"},
    )


def _text(value: Any, default: str = "-") -> str:
    if value is None:
        return default
    value = str(value).strip()
    return value or default


def _mask_identifier(value: Any) -> str:
    """脱敏显示用户标识，避免在群聊回复中回显完整 ID。"""

    raw = str(value or "").strip()
    if not raw:
        return "未知用户"
    if len(raw) <= 2:
        return "**"
    return f"{raw[0]}***"


def _number(value: Any) -> float | None:
    if isinstance(value, bool) or value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _bool_value(value: Any, default: bool = False) -> bool:
    """将网站返回的布尔字段稳定转换为布尔值。"""

    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return value != 0
    if isinstance(value, str):
        normalized = value.strip().casefold()
        if normalized in {"1", "true", "yes", "y", "on", "enabled", "active"}:
            return True
        if normalized in {"0", "false", "no", "n", "off", "disabled", "inactive", ""}:
            return False
    return default


def _format_number(value: Any, suffix: str = "") -> str:
    number = _number(value)
    if number is None:
        return "-"
    if number.is_integer():
        return f"{int(number)}{suffix}"
    return f"{number:.2f}{suffix}"


def _format_rate(value: Any) -> str:
    rate = _number(value)
    if rate is None:
        return "-"
    if -1 <= rate <= 1:
        rate *= 100
    return f"{rate:.2f}%"


def _status(value: Any) -> str:
    raw = _text(value, "unknown").lower().replace(" ", "_")
    if raw in STATUS_LABELS:
        return STATUS_LABELS[raw]
    value_text = _text(value, "未知")
    return value_text if re.search(r"[\u4e00-\u9fff]", value_text) else "未知"


def _localize_status_values(message: str) -> str:
    """只翻译发给用户的状态字段，内部逻辑继续使用接口原始枚举。"""

    def replace(match: re.Match[str]) -> str:
        value = match.group(2)
        label = STATE_TEXT_LABELS.get(value.casefold())
        if label is None:
            label = value if re.search(r"[\u4e00-\u9fff]", value) else "未知状态"
        return f"{match.group(1)}{label}"

    return _STATUS_VALUE_PATTERN.sub(replace, str(message))


def _status_emoji(value: Any) -> str:
    raw = _text(value, "unknown").lower().replace(" ", "_")
    if raw in {"operational", "healthy", "ok", "good"}:
        return "✅"
    if raw in {"degraded", "warning"}:
        return "⚠️"
    if raw in {"failed", "critical", "error", "unavailable"}:
        return "❌"
    return "❔"


def _now_text() -> str:
    """按站点用户常用的 Asia/Shanghai 时区显示时间。"""

    shanghai = timezone(timedelta(hours=8))
    return datetime.now(shanghai).strftime("%Y-%m-%d %H:%M:%S")


def _items(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, dict)]
    if isinstance(payload, dict):
        for key in ("items", "channels", "monitors", "results", "groups"):
            value = payload.get(key)
            if isinstance(value, list):
                return [item for item in value if isinstance(item, dict)]
        nested = payload.get("data")
        if isinstance(nested, (dict, list)) and nested is not payload:
            return _items(nested)
    return []


def _v2_group_rows(
    dimensions: Any,
    matrix: Any,
    available_groups: Any = None,
) -> list[dict[str, Any]]:
    """Join visible group names, monitor metrics, and user-visible rate multipliers."""

    dimension_rows = _items(dimensions)
    matrix_rows = _items(matrix)
    available_rows = _items(available_groups)

    def group_name(row: Mapping[str, Any]) -> str:
        return _group_name(row) or _text(row.get("name"), "")

    def group_id(row: Mapping[str, Any]) -> str:
        value = row.get("group_id", row.get("groupId", row.get("id")))
        return "" if value is None else str(value).strip()

    matrix_by_id: dict[str, dict[str, Any]] = {}
    matrix_by_name: dict[tuple[str, str], dict[str, Any]] = {}
    for row in matrix_rows:
        identifier = group_id(row)
        name = group_name(row)
        platform = _text(row.get("platform"), "").casefold()
        if identifier:
            matrix_by_id.setdefault(identifier, row)
        if name:
            matrix_by_name.setdefault((platform, name.casefold()), row)

    available_by_id: dict[str, dict[str, Any]] = {}
    available_by_name: dict[tuple[str, str], dict[str, Any]] = {}
    for row in available_rows:
        identifier = group_id(row)
        name = group_name(row)
        platform = _text(row.get("platform"), "").casefold()
        if identifier:
            available_by_id.setdefault(identifier, row)
        if name:
            available_by_name.setdefault((platform, name.casefold()), row)

    def merge_rate_multiplier(row: dict[str, Any]) -> None:
        identifier = group_id(row)
        name = group_name(row)
        platform = _text(row.get("platform"), "").casefold()
        available = available_by_id.get(identifier) if identifier else None
        if available is None and name:
            available = available_by_name.get((platform, name.casefold()))
            if available is None:
                available = available_by_name.get(("", name.casefold()))
        if available is None:
            return
        for key in ("rate_multiplier", "rateMultiplier"):
            multiplier = _number(available.get(key))
            if multiplier is not None:
                row["rate_multiplier"] = multiplier
                return

    result: list[dict[str, Any]] = []
    used: set[int] = set()
    for dimension in dimension_rows:
        identifier = group_id(dimension)
        name = group_name(dimension)
        platform = _text(dimension.get("platform"), "").casefold()
        metric_row = matrix_by_id.get(identifier) if identifier else None
        if metric_row is None and name:
            metric_row = matrix_by_name.get((platform, name.casefold()))
            if metric_row is None:
                metric_row = matrix_by_name.get(("", name.casefold()))

        row = dict(dimension)
        if metric_row is not None:
            row.update(metric_row)
            used.add(id(metric_row))
        if name:
            row["group_name"] = name
        elif group_name(row):
            row["group_name"] = group_name(row)
        merge_rate_multiplier(row)
        result.append(row)

    for row in matrix_rows:
        if id(row) in used:
            continue
        normalized = dict(row)
        name = group_name(row)
        if name:
            normalized["group_name"] = name
        merge_rate_multiplier(normalized)
        result.append(normalized)

    return result


def _configured_ids(value: Any) -> set[str]:
    """解析配置中的用户或群聊 ID。"""

    if isinstance(value, (list, tuple, set)):
        parts = [str(item) for item in value]
    else:
        parts = re.split(r"[\s,，;；|]+", _text(value, ""))
    return {part.strip().casefold() for part in parts if part.strip()}


def _configured_triggers(value: Any, default: str) -> set[str]:
    """解析配置中的触发词并统一为不带斜杠的小写形式。"""

    raw_value = default if value is None else value
    if isinstance(raw_value, (list, tuple, set)):
        parts = [str(item) for item in raw_value]
    else:
        parts = re.split(r"[\s,，;；|]+", _text(raw_value, ""))
    normalized: set[str] = set()
    for part in parts:
        token = str(part).strip().lstrip("/").strip()
        if token and not re.fullmatch(r"[A-Za-z][A-Za-z0-9_-]*", token):
            normalized.add(token)
    return normalized


def _nested_context_value(value: Any, keys: tuple[str, ...], depth: int = 0) -> Any:
    """从 MaiBot 不同版本的消息字典或对象中读取上下文字段。"""

    if value is None or depth > 4:
        return None
    if isinstance(value, Mapping):
        for key in keys:
            if key in value and value[key] is not None:
                return value[key]
        for child_key in (
            "message",
            "message_info",
            "message_base_info",
            "group_info",
            "user_info",
            "sender",
            "context",
            "event",
            "additional_data",
            "data",
        ):
            if child_key in value:
                found = _nested_context_value(value[child_key], keys, depth + 1)
                if found is not None:
                    return found
        return None
    for key in keys:
        found = getattr(value, key, None)
        if found is not None:
            return found
    return None


def _context_id(value: Any, keys: tuple[str, ...]) -> str:
    if isinstance(value, Mapping):
        nested = _nested_context_value(value, keys)
        if nested is not None and nested is not value:
            value = nested
    if value is None or isinstance(value, (Mapping, list, tuple, set)):
        return ""
    return str(value).strip()


def _message_context(kwargs: Mapping[str, Any], stream_id: str) -> tuple[str, str, bool]:
    """返回当前命令的用户 ID、群 ID 和是否群聊。"""

    sources: list[Any] = [kwargs]
    for key in ("message", "event", "context"):
        if key in kwargs:
            sources.append(kwargs[key])
    user_id = ""
    group_id = ""
    is_group = False
    for source in sources:
        if not user_id:
            user_id = _context_id(source, ("user_id", "userId", "sender_id", "senderId"))
        if not group_id:
            group_id = _context_id(source, ("group_id", "groupId"))
        group_flag = _nested_context_value(source, ("is_group_message", "is_group", "is_group_chat"))
        if isinstance(group_flag, bool):
            is_group = is_group or group_flag
        elif group_flag is not None:
            is_group = is_group or bool(group_flag)
        message_type = _nested_context_value(
            source, ("message_type", "chat_type", "conversation_type", "messageType")
        )
        if isinstance(message_type, str):
            is_group = is_group or message_type.strip().casefold() in {
                "group",
                "group_chat",
                "groupchat",
                "guild",
                "channel",
            }
    return user_id, group_id, is_group or bool(group_id)


def _group_name(row: Mapping[str, Any]) -> str:
    """读取渠道或统计行中的分组名称。"""

    for key in ("group_name", "groupName", "group"):
        value = row.get(key)
        if isinstance(value, Mapping):
            value = value.get("name") or value.get("group_name") or value.get("title")
        if value is not None and str(value).strip():
            return str(value).strip()
    return ""


def _group_payloads(payload: Any) -> list[tuple[str, dict[str, Any]]]:
    """提取快照中可能存在的分组明细。"""

    def from_container(container: Any) -> list[tuple[str, dict[str, Any]]]:
        result: list[tuple[str, dict[str, Any]]] = []
        if isinstance(container, list):
            for item in container:
                if not isinstance(item, dict):
                    continue
                name = _group_name(item)
                if name:
                    result.append((name, item))
            return result
        if isinstance(container, dict):
            direct_name = _group_name(container)
            if direct_name:
                return [(direct_name, container)]
            for name, item in container.items():
                if isinstance(item, dict):
                    row = dict(item)
                    row.setdefault("group_name", str(name))
                    result.append((str(name), row))
            return result
        return result

    if isinstance(payload, list):
        return from_container(payload)
    if not isinstance(payload, dict):
        return []
    for key in ("groups", "group_stats", "group_metrics", "group_data", "by_group", "items"):
        found = from_container(payload.get(key))
        if found:
            return found
    for key in ("data", "snapshot", "overview", "metrics", "health"):
        nested = payload.get(key)
        if isinstance(nested, (dict, list)):
            found = _group_payloads(nested)
            if found:
                return found
    return []


def _metric_value(source: Mapping[str, Any], *keys: str) -> float | None:
    for key in keys:
        value = source.get(key)
        if isinstance(value, dict):
            value = next(
                (value[name] for name in ("value", "ms", "value_ms") if value.get(name) is not None),
                None,
            )
        number = _number(value)
        if number is not None:
            return number
    return None


def _metric_sources(payload: Any) -> list[Mapping[str, Any]]:
    """提取监控行及其常用嵌套指标容器。"""

    if not isinstance(payload, dict):
        return []
    sources: list[Mapping[str, Any]] = [payload]
    for key in ("metrics", "stats", "ttft", "first_token", "cache", "health"):
        value = payload.get(key)
        if isinstance(value, dict):
            sources.append(value)
            nested_metrics = value.get("metrics")
            if isinstance(nested_metrics, dict):
                sources.append(nested_metrics)
            nested_ttft = value.get("ttft")
            if isinstance(nested_ttft, dict):
                sources.append(nested_ttft)
    return sources


def _first_metric_value(sources: list[Mapping[str, Any]], *keys: str) -> float | None:
    for source in sources:
        value = _metric_value(source, *keys)
        if value is not None:
            return value
    return None


def _display_success_rate(sources: list[Mapping[str, Any]]) -> float | None:
    """Match the website's channel-monitor success-rate calculation."""

    error_rate = _first_metric_value(sources, "error_rate", "request_error_rate")
    if error_rate is not None:
        # The API normally returns a ratio, but accept percentage values too.
        normalized_error = error_rate / 100 if abs(error_rate) > 1 else error_rate
        return max(0.0, min(1.0, 1.0 - normalized_error))
    return _first_metric_value(sources, "success_rate", "request_success_rate")


def extract_ttft_metrics(payload: Any) -> dict[str, float]:
    """兼容用户端快照和管理员概览的首 Token 字段。"""

    candidates: list[Mapping[str, Any]] = []
    if isinstance(payload, dict):
        candidates.append(payload)
        overview = payload.get("overview")
        if isinstance(overview, dict):
            candidates.append(overview)
        snapshot = payload.get("snapshot")
        if isinstance(snapshot, dict):
            candidates.append(snapshot)
        for parent in (
            payload,
            overview if isinstance(overview, dict) else {},
            snapshot if isinstance(snapshot, dict) else {},
        ):
            metrics = parent.get("metrics") if isinstance(parent, dict) else None
            if isinstance(metrics, dict):
                candidates.append(metrics)
                ttft = metrics.get("ttft")
                if isinstance(ttft, dict):
                    candidates.append(ttft)
        ttft = payload.get("ttft")
        if isinstance(ttft, dict):
            candidates.append(ttft)

    aliases = {
        "p50": ("p50_ms", "p50", "ttft_p50_ms"),
        "p90": ("p90_ms", "p90", "ttft_p90_ms"),
        "p95": ("p95_ms", "p95", "ttft_p95_ms"),
        "p99": ("p99_ms", "p99", "ttft_p99_ms"),
        "avg": ("avg_ms", "avg", "average_ms", "mean_ms", "ttft_avg_ms"),
        "max": ("max_ms", "max", "ttft_max_ms"),
    }
    result: dict[str, float] = {}
    for target, keys in aliases.items():
        for candidate in candidates:
            value = _metric_value(candidate, *keys)
            if value is not None:
                result[target] = value
                break
    return result


def extract_ttft_status(payload: Any) -> str:
    """提取健康评分中的首 Token 状态。"""

    if not isinstance(payload, dict):
        return "unknown"
    candidates: list[Any] = [payload.get("status")]
    health = payload.get("health")
    if isinstance(health, dict):
        candidates.extend((health.get("ttft"), health.get("first_token"), health.get("overall")))
    overview = payload.get("overview")
    if isinstance(overview, dict):
        candidates.append(overview.get("status"))
        health = overview.get("health")
        if isinstance(health, dict):
            candidates.extend((health.get("ttft"), health.get("first_token"), health.get("overall")))
    snapshot = payload.get("snapshot")
    if isinstance(snapshot, dict):
        candidates.append(snapshot.get("status"))
        health = snapshot.get("health")
        if isinstance(health, dict):
            candidates.extend((health.get("ttft"), health.get("first_token"), health.get("overall")))
    for candidate in candidates:
        if isinstance(candidate, dict):
            candidate = candidate.get("status") or candidate.get("state") or candidate.get("level")
        if isinstance(candidate, str) and candidate.strip():
            return candidate.strip()
    return "unknown"


def _format_compact_ttft(ttft: Mapping[str, Any]) -> str:
    """Format the website's single first-token value in seconds."""

    value = _number(ttft.get("p50"))
    return f"首 TOKEN：{value / 1000:.1f}s" if value is not None else "首 TOKEN：-"


def _format_compact_rates(success_rate: Any, error_rate: Any, cache_rate: Any) -> str:
    """Format success, error, and cache rates with stable labels."""

    return (
        f"成功 {_format_rate(success_rate)}｜"
        f"错误 {_format_rate(error_rate)}｜"
        f"缓存 {_format_rate(cache_rate)}"
    )


def _format_multiplier(value: Any) -> str:
    number = _number(value)
    if number is None:
        return "-"
    return f"{number:.12g}x"


def _format_compact_group_rates(
    success_rate: Any,
    error_rate: Any,
    cache_rate: Any,
    multiplier: Any,
) -> str:
    """Format group rates and the group's configured billing multiplier."""

    return f"{_format_compact_rates(success_rate, error_rate, cache_rate)}｜倍率 {_format_multiplier(multiplier)}"


def _range_for_source(source: str, requested: str | None, configured: str) -> str:
    value = (requested or configured or "24h").strip()
    if source in {"admin", "admin_overview"}:
        return {"90m": "1h", "1d": "24h", "7d": "24h", "15d": "24h", "30d": "24h"}.get(value, value)
    if source == "admin_models":
        return {"90m": "1h", "6h": "1h", "24h": "1d", "7d": "15d"}.get(value, value)
    return {"30m": "90m", "1h": "90m", "6h": "24h", "1d": "24h", "15d": "7d"}.get(value, value)


class KinghtStatusPlugin(MaiBotPlugin):
    """查询网站渠道健康和首 Token 指标。"""

    config_model = KinghtStatusConfig

    def __init__(self) -> None:
        super().__init__()
        self._client: KinghtAPIClient | None = None
        self._client_config_key: tuple[Any, ...] | None = None
        self._balance_alert_task: asyncio.Task[Any] | None = None
        self._balance_alert_lock: asyncio.Lock | None = None
        self._join_request_task: asyncio.Task[Any] | None = None
        self._join_request_lock: asyncio.Lock | None = None
        self._join_request_seen: dict[str, float] = {}
        self._recharge_notification_task: asyncio.Task[Any] | None = None
        self._recharge_notification_lock: asyncio.Lock | None = None
        self._lottery_batch_task: asyncio.Task[Any] | None = None
        self._lottery_batch_lock: asyncio.Lock | None = None

    def _session_path(self) -> Path | None:
        try:
            return Path(self.ctx.paths.data_dir) / "session.json"
        except Exception:
            return None

    def _bindings_path(self) -> Path | None:
        """返回绑定数据文件；绑定令牌只放在 MaiBot 的插件数据目录。"""

        try:
            return Path(self.ctx.paths.data_dir) / "account_bindings.json"
        except Exception:
            return None

    def _lottery_batches_path(self) -> Path | None:
        try:
            return Path(self.ctx.paths.data_dir) / "lottery_grant_batches.json"
        except Exception:
            return None

    def _pending_operations_path(self) -> Path | None:
        try:
            return Path(self.ctx.paths.data_dir) / "pending_bot_operations.json"
        except Exception:
            return None

    def _read_pending_operations(self) -> dict[str, dict[str, str]]:
        path = self._pending_operations_path()
        if path is None:
            return {}
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return {}
        except (OSError, ValueError, TypeError) as exc:
            raise KinghtAPIError("本地待确认操作记录无法读取，请联系管理员检查。", code="BOT_OPERATION_STORAGE", status_code=503) from exc
        if not isinstance(value, dict):
            raise KinghtAPIError("本地待确认操作记录格式无效，请联系管理员检查。", code="BOT_OPERATION_STORAGE", status_code=503)
        return {
            str(key): {str(field): str(item) for field, item in row.items()}
            for key, row in value.items()
            if isinstance(row, dict)
        }

    def _write_pending_operations(self, pending: Mapping[str, Mapping[str, Any]]) -> bool:
        path = self._pending_operations_path()
        if path is None:
            return False
        temporary_path: str | None = None
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            descriptor, temporary_path = tempfile.mkstemp(
                prefix=".kinght-bot-operations-", suffix=".tmp", dir=str(path.parent)
            )
            with os.fdopen(descriptor, "w", encoding="utf-8") as output:
                json.dump(dict(pending), output, ensure_ascii=False, separators=(",", ":"))
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary_path, path)
            return True
        except OSError:
            logging.getLogger(__name__).warning("无法保存待确认的机器人操作")
            if temporary_path:
                try:
                    os.unlink(temporary_path)
                except OSError:
                    pass
            return False

    def _read_lottery_batches(self) -> dict[str, dict[str, str]]:
        path = self._lottery_batches_path()
        if path is None:
            return {}
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError, TypeError):
            return {}
        if not isinstance(value, dict):
            return {}
        return {
            str(batch_id): {str(key): str(item) for key, item in row.items()}
            for batch_id, row in value.items()
            if isinstance(row, dict) and str(row.get("status", "pending")) != "completed"
        }

    def _write_lottery_batches(self, batches: Mapping[str, Mapping[str, Any]]) -> None:
        path = self._lottery_batches_path()
        if path is None:
            return
        temporary_path: str | None = None
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            descriptor, temporary_path = tempfile.mkstemp(
                prefix=".kinght-lottery-batches-", suffix=".tmp", dir=str(path.parent)
            )
            with os.fdopen(descriptor, "w", encoding="utf-8") as output:
                json.dump(dict(batches), output, ensure_ascii=False, separators=(",", ":"))
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary_path, path)
        except OSError:
            logging.getLogger(__name__).warning("无法保存抽奖发放批次状态")
            if temporary_path:
                try:
                    os.unlink(temporary_path)
                except OSError:
                    pass

    def _read_bindings(self) -> dict[str, dict[str, str]]:
        path = self._bindings_path()
        if path is None:
            return {}
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError, TypeError):
            return {}
        if not isinstance(value, dict):
            return {}
        result: dict[str, dict[str, str]] = {}
        for key, record in value.items():
            if isinstance(key, str) and isinstance(record, dict):
                token = str(record.get("access_token") or record.get("bot_token") or "").strip()
                if token:
                    result[key] = {
                        "access_token": token,
                        "refresh_token": str(record.get("refresh_token") or "").strip(),
                        "bound_at": str(record.get("bound_at") or "").strip(),
                        "platform": str(record.get("platform") or "").strip(),
                        "external_id": str(record.get("external_id") or "").strip(),
                    }
        return result

    def _write_bindings(self, bindings: Mapping[str, Mapping[str, Any]]) -> None:
        path = self._bindings_path()
        if path is None:
            return
        temporary_path: str | None = None
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            descriptor, temporary_path = tempfile.mkstemp(
                prefix=".kinght-bindings-", suffix=".tmp", dir=str(path.parent)
            )
            with os.fdopen(descriptor, "w", encoding="utf-8") as output:
                json.dump(dict(bindings), output, ensure_ascii=False, separators=(",", ":"))
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary_path, path)
        except OSError:
            logging.getLogger(__name__).warning("无法保存网站账号绑定数据")
            if temporary_path:
                try:
                    os.unlink(temporary_path)
                except OSError:
                    pass

    @staticmethod
    def _binding_identity(kwargs: Mapping[str, Any], stream_id: str) -> tuple[str, str, bool]:
        user_id, group_id, is_group = _message_context(kwargs, stream_id)
        if not user_id and stream_id and not group_id:
            user_id = str(stream_id).strip()
        platform = _text(
            _nested_context_value(kwargs, ("platform", "platform_name", "adapter", "protocol")),
            "qq",
        ).casefold()
        return platform, user_id, is_group

    def _binding_key(self, kwargs: Mapping[str, Any], stream_id: str) -> tuple[str, str, str, bool]:
        platform, user_id, is_group = self._binding_identity(kwargs, stream_id)
        return platform, user_id, f"{platform}:{user_id}" if platform and user_id else "", is_group

    def _make_bound_client(self, key: str, record: Mapping[str, Any]) -> KinghtAPIClient:
        config = self.config
        base_url = _text(getattr(config, "api_base_url", "https://api.kinght.top/api/v1"))
        timeout = _number(getattr(config, "request_timeout_seconds", 10.0)) or 10.0
        admin_api_key = _text(getattr(config, "admin_api_key", ""), "").strip() or os.getenv(
            "KINGHT_ADMIN_API_KEY", ""
        ).strip()

        def persist(access_token: str, refresh_token: str) -> None:
            bindings = self._read_bindings()
            current = dict(bindings.get(key, {}))
            current.update({"access_token": access_token, "refresh_token": refresh_token})
            bindings[key] = current
            self._write_bindings(bindings)

        return KinghtAPIClient(
            base_url=base_url,
            timeout=timeout,
            access_token="",
            refresh_token=str(record.get("refresh_token") or ""),
            admin_api_key=admin_api_key,
            bot_binding_token=str(
                record.get("bot_token") or record.get("access_token") or ""
            ),
            on_tokens_updated=persist,
        )

    def _get_bound_client(self, key: str) -> KinghtAPIClient | None:
        if not key:
            return None
        record = self._read_bindings().get(key)
        return self._make_bound_client(key, record) if record else None

    def _remove_binding(self, key: str) -> bool:
        bindings = self._read_bindings()
        removed = bindings.pop(key, None) is not None
        if removed:
            self._write_bindings(bindings)
        return removed

    @staticmethod
    def _token_seed_fingerprint(base_url: str, email: str, access_token: str, refresh_token: str) -> str:
        seed = json.dumps(
            [base_url, email, access_token, refresh_token],
            ensure_ascii=False,
            separators=(",", ":"),
        )
        return hashlib.sha256(seed.encode("utf-8")).hexdigest()

    @staticmethod
    def _read_session_tokens(session_path: Path | None, seed_fingerprint: str) -> tuple[str, str]:
        if session_path is None:
            return "", ""
        try:
            saved = json.loads(session_path.read_text(encoding="utf-8"))
        except (OSError, ValueError, TypeError):
            return "", ""
        if not isinstance(saved, dict) or saved.get("seed_fingerprint") != seed_fingerprint:
            return "", ""
        return (
            _text(saved.get("access_token"), "").strip(),
            _text(saved.get("refresh_token"), "").strip(),
        )

    @staticmethod
    def _write_session_tokens(
        session_path: Path | None,
        seed_fingerprint: str,
        access_token: str,
        refresh_token: str,
    ) -> None:
        if session_path is None or not (access_token or refresh_token):
            return
        temporary_path: str | None = None
        try:
            session_path.parent.mkdir(parents=True, exist_ok=True)
            descriptor, temporary_path = tempfile.mkstemp(
                prefix=".kinght-session-",
                suffix=".tmp",
                dir=str(session_path.parent),
            )
            with os.fdopen(descriptor, "w", encoding="utf-8") as output:
                json.dump(
                    {
                        "seed_fingerprint": seed_fingerprint,
                        "access_token": access_token,
                        "refresh_token": refresh_token,
                    },
                    output,
                )
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary_path, session_path)
        except OSError:
            logging.getLogger(__name__).warning(
                "Could not persist Kinght session tokens in the MaiBot plugin data directory"
            )
            if temporary_path:
                try:
                    os.unlink(temporary_path)
                except OSError:
                    pass

    def _get_client(self) -> KinghtAPIClient:
        config = self.config
        base_url = _text(getattr(config, "api_base_url", "https://api.kinght.top/api/v1"))
        email = _text(getattr(config, "email", ""), "").strip() or os.getenv("KINGHT_API_EMAIL", "").strip()
        password = getattr(config, "password", "") or os.getenv("KINGHT_API_PASSWORD", "")
        configured_access_token = _text(getattr(config, "access_token", ""), "").strip() or os.getenv("KINGHT_API_ACCESS_TOKEN", "").strip()
        configured_refresh_token = _text(getattr(config, "refresh_token", ""), "").strip() or os.getenv("KINGHT_API_REFRESH_TOKEN", "").strip()
        admin_api_key = _text(getattr(config, "admin_api_key", ""), "").strip() or os.getenv(
            "KINGHT_ADMIN_API_KEY", ""
        ).strip()
        seed_fingerprint = self._token_seed_fingerprint(
            base_url,
            email,
            configured_access_token,
            configured_refresh_token,
        )
        session_path = self._session_path()
        cached_access_token, cached_refresh_token = self._read_session_tokens(
            session_path,
            seed_fingerprint,
        )
        access_token = cached_access_token or configured_access_token
        refresh_token = cached_refresh_token or configured_refresh_token
        timeout = _number(getattr(config, "request_timeout_seconds", 10.0)) or 10.0
        config_key = (
            base_url,
            email,
            password,
            configured_access_token,
            configured_refresh_token,
            admin_api_key,
            timeout,
            session_path,
        )
        if self._client is not None and self._client_config_key == config_key:
            return self._client

        def persist_tokens(updated_access_token: str, updated_refresh_token: str) -> None:
            self._write_session_tokens(
                session_path,
                seed_fingerprint,
                updated_access_token,
                updated_refresh_token,
            )

        self._client = KinghtAPIClient(
            base_url=base_url,
            email=email,
            password=password,
            timeout=timeout,
            access_token=access_token,
            refresh_token=refresh_token,
            admin_api_key=admin_api_key,
            on_tokens_updated=persist_tokens,
        )
        self._client_config_key = config_key
        return self._client

    async def on_load(self) -> None:
        self._get_client()
        if self._balance_alert_task is None or self._balance_alert_task.done():
            self._balance_alert_task = asyncio.create_task(self._balance_alert_loop())
        if self._recharge_notification_task is None or self._recharge_notification_task.done():
            self._recharge_notification_task = asyncio.create_task(self._recharge_notification_loop())
        if self._lottery_batch_task is None or self._lottery_batch_task.done():
            self._lottery_batch_task = asyncio.create_task(self._lottery_batch_loop())
        if self._join_request_task is None or self._join_request_task.done():
            self._join_request_task = asyncio.create_task(self._join_request_loop())

    async def on_unload(self) -> None:
        task = self._balance_alert_task
        self._balance_alert_task = None
        if task is not None:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
        for task_name in ("_recharge_notification_task", "_lottery_batch_task", "_join_request_task"):
            task = getattr(self, task_name, None)
            setattr(self, task_name, None)
            if task is not None:
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass
        self._client = None
        self._client_config_key = None
        self._balance_alert_lock = None
        self._join_request_lock = None
        self._recharge_notification_lock = None
        self._lottery_batch_lock = None
        self._join_request_seen.clear()

    async def _balance_alert_loop(self) -> None:
        """轮询网站待发的 QQ 余额提醒，成功私聊后确认提醒。"""

        while True:
            try:
                await self._poll_balance_alerts()
            except asyncio.CancelledError:
                raise
            except Exception:
                logging.getLogger(__name__).warning("轮询 QQ 余额预警失败", exc_info=True)
            await asyncio.sleep(60)

    async def _recharge_notification_loop(self) -> None:
        while True:
            try:
                await self._poll_recharge_notifications()
            except asyncio.CancelledError:
                raise
            except Exception:
                logging.getLogger(__name__).warning("轮询充值到账通知失败", exc_info=True)
            await asyncio.sleep(60)

    async def _lottery_batch_loop(self) -> None:
        while True:
            try:
                await self._poll_lottery_grant_batches()
            except asyncio.CancelledError:
                raise
            except Exception:
                logging.getLogger(__name__).warning("查询抽奖次数发放批次失败", exc_info=True)
            await asyncio.sleep(10)

    async def _join_request_loop(self) -> None:
        """轮询 OneBot 待处理入群申请，按网站邮箱用户列表自动审批。"""

        while True:
            try:
                if _bool_value(getattr(self.config, "enable_group_join_approval", True), True):
                    await self._poll_group_join_requests()
            except asyncio.CancelledError:
                raise
            except Exception:
                logging.getLogger(__name__).warning("轮询 QQ 入群申请失败", exc_info=True)
            interval = _number(getattr(self.config, "group_join_approval_interval_seconds", 30.0)) or 30.0
            await asyncio.sleep(max(5.0, min(interval, 300.0)))

    async def _poll_group_join_requests(self) -> int:
        lock = getattr(self, "_join_request_lock", None)
        if lock is None:
            lock = asyncio.Lock()
            self._join_request_lock = lock
        async with lock:
            result = await self._onebot_action("get_group_system_msg", {})
            requests = self._join_request_items(result)
            approved = 0
            now = time.monotonic()
            for request in requests:
                if await self._approve_join_request_if_known(request):
                    approved += 1
            self._join_request_seen = {
                key: seen_at for key, seen_at in self._join_request_seen.items() if now - seen_at < 3600
            }
            return approved

    async def _approve_join_request_if_known(self, request: Mapping[str, Any]) -> bool:
        if request.get("checked") is True or str(request.get("checked") or "").strip().casefold() in {
            "1",
            "true",
            "yes",
        }:
            return False
        request_type = str(request.get("request_type") or "group").strip().casefold()
        sub_type = str(request.get("sub_type") or "add").strip().casefold()
        if request_type not in {"group", "group_add", "add", ""}:
            return False
        if sub_type not in {"add", "group_add", ""}:
            return False
        group_id = str(request.get("group_id") or request.get("group") or "").strip()
        allowed_groups = _configured_ids(getattr(self.config, "group_join_approval_group_ids", ""))
        if allowed_groups and group_id.casefold() not in allowed_groups:
            return False
        flag = str(request.get("flag") or request.get("request_id") or request.get("seq") or "").strip()
        if not group_id or not flag:
            return False
        request_key = f"{group_id}:{flag}"
        if request_key in self._join_request_seen:
            return False
        comment = " ".join(
            value
            for key in (
                "comment",
                "requester_add_msg",
                "requester_add_answer",
                "message",
                "reason",
                "remark",
                "answer",
                "answers",
            )
            if (value := _text(request.get(key), "").strip())
        )
        email_match = re.search(r"[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}", comment, re.IGNORECASE)
        # 配置模型默认开启拒绝。旧版宿主未提供该字段时也按新版安全默认值
        # 处理，确保无邮箱、格式错误和未知邮箱的申请不会被静默放行。
        reject_invalid = _bool_value(
            getattr(self.config, "reject_invalid_group_join_requests", True), True
        )
        if email_match is None:
            if reject_invalid:
                has_email_field = re.search(r"(?:邮箱|email|e-mail)", comment, re.IGNORECASE) is not None
                reason = (
                    "拒绝：入群申请中的邮箱格式不正确，请填写已注册的网站邮箱。"
                    if has_email_field or "@" in comment
                    else "拒绝：入群申请未填写邮箱，请填写已注册的网站邮箱。"
                )
                await self._reject_join_request(
                    group_id,
                    flag,
                    request_key,
                    reason,
                )
            return False
        email = email_match.group(0).strip().casefold()
        client = self._get_client()
        try:
            email_exists = await client.find_admin_user_by_email(email)
        except Exception:
            # 管理员接口或网络暂时不可用时保留申请，避免误拒绝；下一轮会重新核验。
            logging.getLogger(__name__).warning(
                "核对入群申请邮箱失败，暂不处理：群 %s，申请 %s",
                group_id,
                flag,
                exc_info=True,
            )
            return False
        if not email_exists:
            logging.getLogger(__name__).info(
                "入群申请邮箱未匹配网站用户：%s", _mask_identifier(email)
            )
            if reject_invalid:
                await self._reject_join_request(
                    group_id,
                    flag,
                    request_key,
                    "拒绝：没有找到该邮箱用户，请先注册网站账号后再申请入群。",
                )
            return False
        result = await self._onebot_action(
            "set_group_add_request",
            {"flag": flag, "sub_type": "add", "approve": True, "reason": ""},
        )
        if not self._onebot_result_ok(result):
            logging.getLogger(__name__).warning("同意 QQ 入群申请失败：群 %s，申请 %s", group_id, flag)
            return False
        self._join_request_seen[request_key] = time.monotonic()
        logging.getLogger(__name__).info("已按网站用户邮箱同意 QQ 入群申请：群 %s", group_id)
        return True

    async def _reject_join_request(
        self,
        group_id: str,
        flag: str,
        request_key: str,
        reason: str,
    ) -> bool:
        """拒绝无效入群申请，并把可读原因传给 QQ 审核接口。"""

        result = await self._onebot_action(
            "set_group_add_request",
            {"flag": flag, "sub_type": "add", "approve": False, "reason": reason},
        )
        if not self._onebot_result_ok(result):
            logging.getLogger(__name__).warning(
                "拒绝 QQ 入群申请失败：群 %s，申请 %s，原因：%s", group_id, flag, reason
            )
            return False
        # 无效申请已经明确处理，标记后避免轮询期间重复拒绝和重复回复。
        self._join_request_seen[request_key] = time.monotonic()
        logging.getLogger(__name__).info(
            "已拒绝 QQ 入群申请：群 %s，申请 %s，原因：%s", group_id, flag, reason
        )
        return True

    @staticmethod
    def _join_request_items(result: Any) -> list[Mapping[str, Any]]:
        data = result.get("data") if isinstance(result, Mapping) else result
        if isinstance(data, Mapping):
            for key in ("join_requests", "group_requests", "requests", "items"):
                value = data.get(key)
                if isinstance(value, list):
                    data = value
                    break
        if not isinstance(data, list):
            return []
        return [item for item in data if isinstance(item, Mapping)]

    @staticmethod
    def _onebot_result_ok(result: Any) -> bool:
        if not isinstance(result, Mapping):
            return False
        # OneBot implementations commonly return an empty JSON object for a
        # successful action.  MaiBot's HTTP wrapper may instead expose code=0.
        if not result:
            return True
        status = str(result.get("status") or "").strip().casefold()
        if status == "ok" or result.get("retcode") in (0, "0") or result.get("code") in (0, "0"):
            return True
        if status or "retcode" in result or "code" in result:
            return False
        nested = result.get("data")
        if not isinstance(nested, Mapping):
            return False
        nested_status = str(nested.get("status") or "").strip().casefold()
        if nested_status == "failed" or nested.get("retcode") not in (None, 0, "0"):
            return False
        return (
            not nested
            or nested_status == "ok"
            or nested.get("code") in (0, "0")
            or nested.get("retcode") in (0, "0")
        )

    async def _poll_balance_alerts(self) -> int:
        bindings = self._read_bindings()
        if not bindings:
            return 0
        lock = getattr(self, "_balance_alert_lock", None)
        if lock is None:
            lock = asyncio.Lock()
            self._balance_alert_lock = lock
        async with lock:
            delivered = 0
            for key, record in bindings.items():
                platform = _text(record.get("platform"), key.split(":", 1)[0] if ":" in key else "")
                user_id = _text(record.get("external_id"), "")
                if platform.casefold() != "qq" or not user_id:
                    continue
                client = self._make_bound_client(key, record)
                try:
                    payload = await client.get_balance_alerts()
                except Exception as exc:  # noqa: BLE001 - 后台轮询不能影响其他绑定
                    logging.getLogger(__name__).warning(
                        "读取 QQ 余额预警失败（%s）: %s", _mask_identifier(user_id), exc
                    )
                    self._clear_invalid_binding(key, exc)
                    continue
                if not _items(payload):
                    continue
                try:
                    target_stream = await self._private_alert_stream(platform, user_id)
                except Exception as exc:  # noqa: BLE001 - 后台轮询不能影响其他绑定
                    logging.getLogger(__name__).warning(
                        "打开 QQ 私聊流失败（%s）: %s", _mask_identifier(user_id), exc
                    )
                    continue
                delivered += await self._deliver_balance_alerts(client, payload, target_stream)
            return delivered

    async def _poll_recharge_notifications(self) -> int:
        bindings = self._read_bindings()
        lock = getattr(self, "_recharge_notification_lock", None)
        if lock is None:
            lock = asyncio.Lock()
            self._recharge_notification_lock = lock
        async with lock:
            delivered = 0
            for key, record in bindings.items():
                platform = _text(record.get("platform"), key.split(":", 1)[0] if ":" in key else "")
                user_id = _text(record.get("external_id"), "")
                if platform.casefold() != "qq" or not user_id:
                    continue
                client = self._make_bound_client(key, record)
                try:
                    payload = await client.get_bot_recharge_notifications()
                except Exception as exc:
                    logging.getLogger(__name__).warning(
                        "读取 QQ 充值到账通知失败（%s）: %s", _mask_identifier(user_id), exc
                    )
                    self._clear_invalid_binding(key, exc)
                    continue
                for row in _items(payload):
                    notification_id = row.get("id")
                    if notification_id is None:
                        continue
                    amount = self._format_check_in_money(row.get("credited_amount"))
                    currency = _text(row.get("credited_currency") or row.get("currency"), "USD").upper()
                    order_id = _text(row.get("order_id"), "-")
                    message = (
                        "充值到账通知\n"
                        f"订单号：{order_id}\n"
                        f"到账金额：{amount} {currency}\n"
                        f"充值订单：/充值订单 {order_id}"
                    )
                    try:
                        stream = await self._private_alert_stream(platform, user_id)
                        sent = await self.ctx.send.text(message, stream)
                        if sent is False:
                            raise RuntimeError("私聊发送返回失败")
                        await client.ack_bot_recharge_notification(notification_id)
                    except Exception as exc:
                        logging.getLogger(__name__).warning(
                            "发送充值到账通知失败（通知 %s）: %s", notification_id, exc
                        )
                        continue
                    delivered += 1
            return delivered

    async def _poll_lottery_grant_batches(self) -> int:
        batches = self._read_lottery_batches()
        if not batches:
            return 0
        lock = getattr(self, "_lottery_batch_lock", None)
        if lock is None:
            lock = asyncio.Lock()
            self._lottery_batch_lock = lock
        async with lock:
            completed = 0
            completed_ids: list[str] = []
            for batch_id, saved in list(batches.items()):
                binding_key = _text(saved.get("binding_key"), "")
                binding = self._read_bindings().get(binding_key)
                if binding is None:
                    continue
                client = self._make_bound_client(binding_key, binding)
                try:
                    payload = await client.get_lottery_grant_batch(batch_id)
                except Exception as exc:
                    logging.getLogger(__name__).warning(
                        "读取抽奖发放批次 %s 失败: %s", batch_id, exc
                    )
                    self._clear_invalid_binding(binding_key, exc)
                    continue
                if not isinstance(payload, Mapping) or str(payload.get("status") or "").casefold() != "completed":
                    continue
                message = (
                    f"抽奖次数批量发放完成\n批次号：{batch_id}\n"
                    f"目标用户：{_text(payload.get('total'), '0')}\n"
                    f"成功：{_text(payload.get('success'), '0')}\n"
                    f"跳过：{_text(payload.get('skipped'), '0')}\n"
                    f"失败：{_text(payload.get('failed'), '0')}\n"
                    f"实际增加总次数：{int(_number(payload.get('success')) or 0) * int(_number(payload.get('count')) or _number(saved.get('count')) or 0)}"
                )
                try:
                    stream = await self._private_alert_stream(
                        _text(saved.get("platform"), "qq"), _text(saved.get("external_id"), "")
                    )
                    sent = await self.ctx.send.text(message, stream)
                    if sent is False:
                        continue
                except Exception as exc:
                    logging.getLogger(__name__).warning("发送抽奖发放汇总失败: %s", exc)
                    continue
                completed_ids.append(batch_id)
                completed += 1
            if completed:
                current = self._read_lottery_batches()
                for batch_id in completed_ids:
                    current.pop(batch_id, None)
                self._write_lottery_batches(current)
            return completed

    async def _private_alert_stream(self, platform: str, user_id: str) -> str:
        """获取指定 QQ 用户的私聊流，兼容旧版 SDK 的查询方法。"""

        chat = getattr(self.ctx, "chat", None)
        platform, user_id = platform.strip().casefold(), user_id.strip()
        if not platform or not user_id:
            raise RuntimeError("A platform and user are required for private alert routing")

        def field_text(value: Any) -> str:
            if isinstance(value, (str, int)) and not isinstance(value, bool):
                return str(value).strip()
            return ""

        def unwrap(result: Any) -> Any:
            if isinstance(result, Mapping):
                if result.get("success", True) is not True or result.get("error"):
                    raise RuntimeError("Private stream lookup failed")
                if "stream" in result:
                    return result["stream"]
            return result

        def stream_id(value: Any) -> str:
            if not isinstance(value, str):
                return ""
            value = value.strip()
            if value == user_id or value.isdecimal() or value.casefold() in {"false", "none", "null", "error", "failed"}:
                return ""
            return value if re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:/-]*", value) else ""

        def candidate(result: Any, *, listed: bool) -> tuple[str, str | None, str] | None:
            if isinstance(result, Mapping) and "account_id" in result:
                if not field_text(result["account_id"]) or not listed:
                    return None
            result = unwrap(result)
            if isinstance(result, str):
                resolved = stream_id(result)
                return (resolved, None, "") if resolved and not listed else None
            if not isinstance(result, Mapping):
                return None
            target_platform = field_text(result.get("platform")).casefold()
            target_user = field_text(result.get("user_id"))
            if listed and (target_platform != platform or target_user != user_id):
                return None
            if target_platform and target_platform != platform or target_user and target_user != user_id:
                return None
            if result.get("is_group_session") or field_text(result.get("group_id")):
                return None
            if field_text(result.get("chat_type")).casefold() not in {"", "private"}:
                return None
            account_id = field_text(result.get("account_id")) if "account_id" in result else None
            if account_id == "" or account_id is not None and not listed:
                return None
            for key in ("stream_id", "session_id", "id"):
                resolved = stream_id(result.get(key))
                if resolved:
                    return resolved, account_id, field_text(result.get("scope"))
            return None

        lister = getattr(chat, "get_private_streams", None)
        if callable(lister):
            result = lister(platform=platform)
            if inspect.isawaitable(result):
                result = await result
            result = unwrap(result)
            rows = result.get("streams") if isinstance(result, Mapping) else result
            if not isinstance(rows, (list, tuple)):
                raise RuntimeError("Private stream enumeration returned an invalid result")
            routed: dict[str, tuple[str | None, str]] = {}
            legacy: dict[str, tuple[str | None, str]] = {}
            for row in rows:
                resolved = candidate(row, listed=True)
                if resolved is None:
                    continue
                resolved_id, account_id, scope = resolved
                routes = routed if account_id is not None else legacy
                if resolved_id in routes and routes[resolved_id] != (account_id, scope):
                    raise RuntimeError("Private alert routing is ambiguous")
                routes[resolved_id] = (account_id, scope)
            routes = routed or legacy
            if len(routes) != 1:
                raise RuntimeError("No unique existing private stream is available")
            return next(iter(routes))

        getter = getattr(chat, "get_stream_by_user_id", None)
        if callable(getter):
            result = getter(user_id, platform=platform)
            if inspect.isawaitable(result):
                result = await result
            resolved = candidate(result, listed=False)
            if resolved is not None:
                return resolved[0]
        raise RuntimeError("No safe existing private stream is available")

    async def _deliver_balance_alerts(
        self,
        client: KinghtAPIClient,
        payload: Any,
        stream_id: str,
    ) -> int:
        rows = _items(payload)
        delivered = 0
        for row in rows:
            alert_id = row.get("id")
            if alert_id is None:
                continue
            message = self._format_balance_alert(row)
            try:
                sent = await self.ctx.send.text(message, stream_id)
                if sent is False:
                    raise RuntimeError("私聊发送返回失败")
                await client.ack_balance_alert(alert_id)
            except Exception as exc:  # noqa: BLE001 - 确认失败时保留提醒供租约重试
                logging.getLogger(__name__).warning(
                    "发送 QQ 余额预警失败（提醒 %s）: %s", alert_id, exc
                )
                continue
            delivered += 1
        return delivered

    @staticmethod
    def _format_balance_alert(row: Mapping[str, Any]) -> str:
        site_name = _text(row.get("site_name"), "网站")
        current_balance = KinghtStatusPlugin._format_money(row.get("current_balance"))
        threshold = KinghtStatusPlugin._format_money(row.get("threshold"))
        lines = [
            "⚠️ 余额预警",
            f"网站：{site_name}",
            f"当前余额：{current_balance}",
            f"预警阈值：{threshold}",
        ]
        recharge_url = _text(row.get("recharge_url"), "")
        if recharge_url and recharge_url != "-":
            lines.append(f"充值地址：{recharge_url}")
        lines.append("可私聊机器人发送 /充值 查看支付宝或微信充值方式。")
        lines.append("余额预警状态：已触发")
        return "\n".join(lines)

    async def on_config_update(self, scope: str, config_data: dict[str, object], version: str) -> None:
        del scope, config_data, version
        self._get_client()

    async def _send(
        self,
        stream_id: str,
        message: str,
        *,
        success: bool = True,
        kwargs: Mapping[str, Any] | None = None,
    ):
        message = _localize_status_values(message)
        if isinstance(kwargs, Mapping):
            _platform, user_id, is_group = self._binding_identity(kwargs, stream_id)
            if is_group:
                return await self._send_account_reply(
                    stream_id,
                    message,
                    user_id=user_id,
                    is_group=True,
                    success=success,
                )
        await self.ctx.send.text(message, stream_id)
        return success, message, True

    async def _send_account_reply(
        self,
        stream_id: str,
        message: str,
        *,
        user_id: str = "",
        is_group: bool = False,
        success: bool = True,
    ):
        """发送账号命令回复；群聊中只通过消息段艾特，不回显完整用户标识。"""

        message = _localize_status_values(message)
        if is_group:
            if not user_id:
                logging.getLogger(__name__).warning("群聊回复缺少用户 ID，已跳过无艾特回复")
                return False, message, False
            segments = [
                {"type": "at", "data": {"target_user_id": str(user_id)}},
                {"type": "text", "data": f" {_text(message, '')}"},
            ]
            try:
                sent = await self.ctx.send.hybrid(segments, stream_id)
                if sent is not False:
                    return success, message, True
            except Exception as exc:
                logging.getLogger(__name__).warning("群聊艾特回复发送失败: %s", exc)
            return False, message, False
        await self.ctx.send.text(message, stream_id)
        return success, message, True

    @staticmethod
    def _message_id(kwargs: Mapping[str, Any]) -> str:
        """从命令上下文读取平台消息 ID，供适配器撤回敏感消息。"""

        for source in (kwargs, kwargs.get("message"), kwargs.get("event")):
            value = _nested_context_value(source, ("message_id", "messageId", "msg_id", "msgId"))
            if value is not None and str(value).strip():
                return str(value).strip()
        return ""

    def _operation_request_id(self, kind: str, user_key: str, kwargs: Mapping[str, Any]) -> str:
        message_id = self._message_id(kwargs)
        if not message_id:
            return ""
        _user_id, group_id, is_group = _message_context(kwargs, "")
        scope = f"group:{group_id}" if is_group else "private"
        material = "\0".join((kind, user_key, scope, message_id))
        return hashlib.sha256(material.encode("utf-8")).hexdigest()

    def _prepare_idempotent_operation(
        self,
        operation: str,
        user_key: str,
        request_id: str,
        fingerprint: str,
    ) -> tuple[str, str | None]:
        """持久化写操作键，未知结果恢复时沿用原键，防止再次扣次或下单。"""

        if not request_id:
            return "", "无法读取原始消息编号，请重新发送命令。\n账号状态：context_invalid"
        pending = self._read_pending_operations()
        key = f"{operation}:{user_key}"
        binding = self._read_bindings().get(user_key, {})
        token = str(binding.get("bot_token") or binding.get("access_token") or "")
        binding_fingerprint = hashlib.sha256(token.encode("utf-8")).hexdigest() if token else ""
        previous = pending.get(key)
        if previous is not None:
            if previous.get("binding_fingerprint", "") != binding_fingerprint:
                return "", "账号绑定已变更，上一笔操作结果仍待确认，请先核对原账号的订单或抽奖记录并联系管理员处理。"
            if previous.get("fingerprint") != fingerprint:
                return "", "上一笔操作结果尚未确认，请先查询原订单或抽奖记录。\n账号状态：result_unknown"
            return _text(previous.get("request_id"), ""), None
        pending[key] = {"request_id": request_id, "fingerprint": fingerprint, "binding_fingerprint": binding_fingerprint}
        if not self._write_pending_operations(pending):
            return "", "暂时无法保存操作记录，本次操作尚未提交，请联系管理员检查插件数据目录。"
        return request_id, None

    def _finish_idempotent_operation(self, operation: str, user_key: str, request_id: str = "") -> None:
        pending = self._read_pending_operations()
        if request_id and pending.get(f"{operation}:{user_key}", {}).get("request_id") != request_id:
            return
        if pending.pop(f"{operation}:{user_key}", None) is not None:
            self._write_pending_operations(pending)

    @staticmethod
    async def _await_result(value: Any) -> Any:
        if inspect.isawaitable(value):
            return await value
        return value

    def _onebot_config(self) -> tuple[str, str]:
        """读取 OneBot HTTP 地址与访问令牌，供插件直接调用适配器撤回消息。"""

        config = self.config
        base = _text(getattr(config, "onebot_api_base", ""), "").strip()
        token = _text(getattr(config, "onebot_access_token", ""), "").strip()
        return base, token

    async def _snowluma_connection_config(self) -> tuple[str, str] | None:
        """读取 SnowLuma 适配器的 OneBot WebSocket 连接配置。"""

        config_capability = getattr(getattr(self, "ctx", None), "config", None)
        get_plugin_config = getattr(config_capability, "get_plugin", None)
        if not callable(get_plugin_config):
            return None
        try:
            adapter_config = await get_plugin_config("maibot-team.snowluma-adapter")
        except Exception as exc:  # noqa: BLE001 - 适配器配置不可用时继续尝试 HTTP 回退
            logging.getLogger(__name__).debug("读取 SnowLuma 配置失败: %s", exc)
            return None
        if not isinstance(adapter_config, Mapping):
            return None
        client_config = adapter_config.get("client")
        if not isinstance(client_config, Mapping):
            return None
        server = _text(client_config.get("server"), "").strip()
        port = _text(client_config.get("port"), "").strip()
        token = _text(client_config.get("token"), "").strip()
        if not server or not port or not token:
            return None
        if server.startswith(("ws://", "wss://")):
            websocket_url = server.rstrip("/")
        else:
            websocket_url = f"ws://{server}:{port}"
        return websocket_url, token

    async def _snowluma_action(self, action: str, payload: Mapping[str, Any]) -> Any:
        """通过 SnowLuma 的公开 API 或其 OneBot WebSocket 调用动作。

        MaiBot 1.3.9 的 SnowLuma 适配器把 OneBot 动作公开为
        ``adapter.napcat.group.*`` API。优先使用宿主 API 可以复用适配器的
        已连接会话，不需要插件另开一条 WebSocket；旧版宿主没有 API 能力时
        再使用适配器配置中的 WebSocket 作为兼容回退。
        """

        api = getattr(getattr(self, "ctx", None), "api", None)
        call_api = getattr(api, "call", None)
        if callable(call_api):
            api_name = f"adapter.napcat.group.{action}"
            try:
                api_result = await self._await_result(
                    call_api(api_name, version="1", params=dict(payload))
                )
                if not (
                    isinstance(api_result, Mapping)
                    and api_result.get("success") is False
                ):
                    return api_result
            except Exception as exc:  # noqa: BLE001 - 旧宿主继续尝试 WebSocket/HTTP
                logging.getLogger(__name__).debug("SnowLuma API 调用失败（%s）：%s", action, exc)

        connection = await self._snowluma_connection_config()
        if connection is None:
            return None
        websocket_url, token = connection
        try:
            import websockets
        except ImportError:
            logging.getLogger(__name__).debug("当前运行环境未安装 websockets")
            return None

        echo = f"kinght-{action}-{time.monotonic_ns()}"
        request = {"action": action, "params": dict(payload), "echo": echo}

        async def call(header_name: str) -> Any:
            async with websockets.connect(
                websocket_url,
                **{header_name: {"Authorization": f"Bearer {token}"}},
                open_timeout=5,
                close_timeout=5,
            ) as websocket:
                await websocket.send(json.dumps(request, ensure_ascii=False))
                deadline = time.monotonic() + 5
                while time.monotonic() < deadline:
                    remaining = max(0.1, deadline - time.monotonic())
                    try:
                        raw = await asyncio.wait_for(websocket.recv(), timeout=remaining)
                    except asyncio.TimeoutError:
                        return None
                    if isinstance(raw, bytes):
                        raw = raw.decode("utf-8", "replace")
                    try:
                        result = json.loads(raw)
                    except (TypeError, ValueError):
                        continue
                    if isinstance(result, Mapping) and str(result.get("echo") or "") == echo:
                        return result
                return None

        try:
            try:
                return await call("additional_headers")
            except TypeError:
                return await call("extra_headers")
        except Exception as exc:  # noqa: BLE001 - HTTP 配置仍可作为回退
            logging.getLogger(__name__).warning("SnowLuma OneBot 动作失败（%s）：%s", action, exc)
            return None

    async def _onebot_action(self, action: str, payload: Mapping[str, Any]) -> Any:
        """通过 OneBot HTTP 调用动作接口。"""

        snowluma_result = await self._snowluma_action(action, payload)
        if snowluma_result is not None:
            return snowluma_result
        base, token = self._onebot_config()
        if not base:
            return None
        url = f"{base.rstrip('/')}/{action.lstrip('/')}"
        body = json.dumps(dict(payload), ensure_ascii=False).encode("utf-8")
        headers = {"Content-Type": "application/json", "Accept": "application/json"}
        if token:
            headers["Authorization"] = f"Bearer {token}"

        def call() -> Any:
            request = Request(url, data=body, headers=headers, method="POST")
            with build_opener().open(request, timeout=5.0) as response:
                return json.loads(response.read().decode("utf-8") or "{}")

        if hasattr(asyncio, "to_thread"):
            return await asyncio.to_thread(call)
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(None, call)

    async def _recall_via_onebot(self, message_id: str) -> bool:
        """通过 OneBot HTTP 接口真正撤回消息；未配置地址时直接跳过。"""

        base, token = self._onebot_config()
        if not base or not message_id:
            return False
        url = f"{base.rstrip('/')}/delete_msg"
        payload_id: Any = int(message_id) if message_id.isdigit() else message_id
        body = json.dumps({"message_id": payload_id}, ensure_ascii=False).encode("utf-8")
        headers = {"Content-Type": "application/json", "Accept": "application/json"}
        if token:
            headers["Authorization"] = f"Bearer {token}"

        def call() -> Any:
            request = Request(url, data=body, headers=headers, method="POST")
            with build_opener().open(request, timeout=5.0) as response:
                raw = response.read()
            return json.loads(raw.decode("utf-8") or "{}")

        try:
            if hasattr(asyncio, "to_thread"):
                result = await asyncio.to_thread(call)
            else:
                loop = asyncio.get_running_loop()
                result = await loop.run_in_executor(None, call)
        except (HTTPError, URLError, OSError, ValueError, TimeoutError) as exc:
            logging.getLogger(__name__).warning("OneBot 撤回绑定码消息失败: %s", exc)
            return False
        if isinstance(result, Mapping):
            status = str(result.get("status") or "").strip().lower()
            if status == "ok" or result.get("retcode") in (0, "0"):
                return True
        return False

    async def _recall_via_adapter(self, kwargs: Mapping[str, Any], message_id: str) -> bool:
        """宿主直接提供适配器对象时按常见命名调用撤回接口。"""

        candidates: list[Any] = []
        for key in ("bot", "adapter", "platform_adapter", "event", "message"):
            candidate = kwargs.get(key)
            if candidate is not None and candidate not in candidates:
                candidates.append(candidate)
        method_names = ("delete_msg", "delete_message", "recall_message", "recall", "retract_message")
        for candidate in candidates:
            for method_name in method_names:
                method = getattr(candidate, method_name, None)
                if not callable(method):
                    continue
                for args, call_kwargs in (
                    ((), {"message_id": message_id}),
                    ((), {"msg_id": message_id}),
                    ((message_id,), {}),
                ):
                    try:
                        result = await self._await_result(method(*args, **call_kwargs))
                    except (TypeError, ValueError):
                        continue
                    except Exception:
                        break
                    if result is not False:
                        return True

            call_api = getattr(candidate, "call_api", None) or getattr(candidate, "call_action", None)
            if callable(call_api):
                for action, params in (("delete_msg", {"message_id": message_id}), ("recall", {"message_id": message_id})):
                    try:
                        result = await self._await_result(call_api(action, **params))
                    except (TypeError, ValueError):
                        continue
                    except Exception:
                        break
                    if result is not False:
                        return True
        return False

    async def _recall_via_snowluma(self, message_id: str) -> bool:
        """通过 SnowLuma 适配器的已配置 OneBot WebSocket 撤回消息。"""
        if not message_id:
            return False
        result = await self._snowluma_action(
            "delete_msg",
            {"message_id": int(message_id) if message_id.isdigit() else message_id},
        )
        return self._onebot_result_ok(result)

    async def _recall_via_host_tool(
        self,
        kwargs: Mapping[str, Any],
        message_id: str,
        stream_id: str = "",
    ) -> bool:
        """通过 MaiBot 宿主调用适配器注册的撤回工具。

        SnowLuma 的 ``recall_message`` 是宿主工具注册表中的工具，普通插件
        不会直接拿到适配器对象。新宿主提供 ``tool.invoke`` 能力后，优先
        走这条链路；旧宿主没有该能力时返回 False，继续尝试兼容路径。
        """

        call_capability = getattr(getattr(self, "ctx", None), "call_capability", None)
        if not callable(call_capability) or not message_id:
            return False

        user_id, group_id, is_group = _message_context(kwargs, stream_id)
        platform = _text(
            _nested_context_value(kwargs, ("platform", "platform_name", "adapter", "protocol")),
            "qq",
        ).casefold()
        arguments = {"message_id": str(message_id)}
        context = {
            "platform": platform,
            "user_id": user_id,
            "group_id": group_id,
            "stream_id": str(stream_id or ""),
            "is_group": bool(is_group),
        }
        try:
            result = await call_capability(
                "tool.invoke",
                tool_name="recall_message",
                arguments=arguments,
                context=context,
                provider_plugin_id="maibot-team.snowluma-adapter",
            )
        except (AttributeError, NotImplementedError, PermissionError, RuntimeError, TypeError, ValueError) as exc:
            logging.getLogger(__name__).debug("宿主撤回工具不可用: %s", exc)
            return False
        except Exception as exc:  # noqa: BLE001 - capability failures must not block binding
            logging.getLogger(__name__).warning("宿主撤回工具调用失败: %s", exc)
            return False

        if isinstance(result, bool):
            return result
        if isinstance(result, Mapping):
            if "success" in result:
                return bool(result.get("success"))
            nested = result.get("result")
            if isinstance(nested, Mapping) and "success" in nested:
                return bool(nested.get("success"))
            return bool(result.get("ok"))
        return bool(result)

    async def _recall_sensitive_message(
        self,
        kwargs: Mapping[str, Any],
        stream_id: str = "",
    ) -> bool:
        """撤回包含绑定码的用户消息：宿主工具、适配器对象、OneBot 依次兜底。"""

        message_id = self._message_id(kwargs)
        if not message_id:
            return False
        if await self._recall_via_host_tool(kwargs, message_id, stream_id):
            return True
        if await self._recall_via_adapter(kwargs, message_id):
            return True
        if await self._recall_via_snowluma(message_id):
            return True
        return await self._recall_via_onebot(message_id)

    @staticmethod
    def _groups(kwargs: dict[str, Any]) -> dict[str, Any]:
        groups = kwargs.get("matched_groups")
        return groups if isinstance(groups, dict) else {}

    def _trigger_setting(self, name: str, default: Any = None) -> Any:
        """读取触发词配置，并兼容旧版扁平配置对象。"""

        config = self.config
        section = getattr(config, "triggers", None)
        if section is not None and hasattr(section, name):
            return getattr(section, name)
        return getattr(config, name, default)

    def _command_enabled(self, name: str) -> bool:
        return bool(self._trigger_setting(name, True))

    def _rewrite_custom_trigger_text(self, text: str) -> str | None:
        """将自定义触发词转换为静态命令，避免动态正则抢占其他插件。"""

        normalized_text = str(text or "").strip()
        match = re.fullmatch(r"/(?P<command>\S+)(?:\s+(?P<argument>.*?))?", normalized_text, re.DOTALL)
        if match is None:
            return None

        command = match.group("command").casefold()
        argument = (match.group("argument") or "").strip()
        trigger_groups = (
            (
                "always",
                "bind_account_triggers",
                "绑定账号",
                "绑定账号",
            ),
            (
                "always",
                "unbind_account_triggers",
                "解绑账号",
                "解绑账号",
            ),
            (
                "always",
                "binding_status_triggers",
                "绑定状态",
                "绑定状态",
            ),
            (
                "always",
                "binding_help_triggers",
                "绑定帮助",
                "绑定帮助",
            ),
            (
                "always",
                "binding_diagnose_triggers",
                "绑定诊断",
                "绑定诊断",
            ),
            (
                "always",
                "personal_info_triggers",
                "个人信息",
                "个人信息",
            ),
            (
                "always",
                "my_usage_triggers",
                "我的用量",
                "我的用量",
            ),
            (
                "always",
                "key_usage_triggers",
                "Key用量",
                "Key用量",
            ),
            (
                "always",
                "balance_alerts_triggers",
                "余额预警",
                "余额预警",
            ),
            (
                "always",
                "check_in_triggers",
                "签到",
                "签到",
            ),
            ("always", "recharge_triggers", "充值", "充值"),
            ("always", "recharge_order_triggers", "充值订单", "充值订单"),
            ("always", "lottery_triggers", "抽奖", "抽奖"),
            ("always", "lottery_plays_triggers", "抽奖次数", "抽奖次数"),
            ("always", "lottery_records_triggers", "抽奖记录", "抽奖记录"),
            ("always", "lottery_grant_triggers", "发放抽奖次数", "发放抽奖次数"),
            (
                "enable_channel_status",
                "channel_status_triggers",
                "渠道状态，渠道，状态",
                "渠道状态",
            ),
            (
                "enable_first_token_status",
                "first_token_status_triggers",
                "首字状态，首字，首Token",
                "首字状态",
            ),
            (
                "enable_site_status",
                "site_status_triggers",
                "站点状态，网站状态",
                "站点状态",
            ),
        )
        for enabled_name, setting_name, default, canonical in trigger_groups:
            if enabled_name != "always" and not self._command_enabled(enabled_name):
                continue
            if command not in {value.casefold() for value in _configured_triggers(self._trigger_setting(setting_name, None), default)}:
                continue
            if argument:
                return f"/{canonical} {argument}"
            return f"/{canonical}"
        return None

    def _is_admin_user(self, stream_id: str, kwargs: Mapping[str, Any]) -> bool:
        user_id, _group_id, _is_group = _message_context(kwargs, stream_id)
        platform = _text(_nested_context_value(kwargs, ("platform", "platform_name")), "qq").casefold()
        admin_ids = _configured_ids(getattr(self.config, "admin_user_ids", ""))
        if not admin_ids or not user_id:
            return False
        candidates = {user_id.casefold()}
        if platform:
            candidates.add(f"{platform}:{user_id.casefold()}")
        return bool(candidates.intersection(admin_ids))

    def _permission_error(self, stream_id: str, kwargs: Mapping[str, Any]) -> str | None:
        """检查群聊白名单配置。"""

        config = self.config
        allowed_group_ids = _configured_ids(getattr(config, "allowed_group_ids", ""))
        if not allowed_group_ids:
            return None

        _user_id, group_id, is_group = _message_context(kwargs, stream_id)
        if allowed_group_ids and is_group:
            if not group_id:
                return "无法识别当前群聊 ID，命令未在白名单群聊中执行。"
            if group_id.casefold() not in allowed_group_ids:
                return "当前群聊不在插件白名单中，无法执行该命令。"
        return None

    @staticmethod
    def _friendly_error(error: Exception) -> str:
        if isinstance(error, KinghtAPIError):
            error_code = str(error.code or "").casefold()
            error_message = error.message.casefold()
            if error_code == "turnstile_verification_failed" or "turnstile" in error_message:
                return "网站登录需要通过 Cloudflare Turnstile 验证，插件无法代替浏览器完成验证。请先在浏览器登录网站，再将 access_token 和 refresh_token 填入插件配置。"
            if error.code == "session_tokens_invalid":
                return "网站令牌已过期或无效，请重新登录网站并更新插件配置中的 access_token 和 refresh_token。"
            if error.code == "credentials_missing":
                return "请在插件配置中填写 access_token 和 refresh_token，或配置网站账号邮箱和密码。"
            if error.code == "two_factor_required":
                return "网站账号启用了双重验证，当前插件无法完成登录。"
            if error.status_code == 401:
                return "网站登录失败或登录状态已失效，请检查账号邮箱和密码。"
            if error.status_code == 403:
                return "当前网站账号没有访问该状态接口的权限，请使用有相应权限的账号。"
            if error.status_code == 404:
                return "站点没有找到状态接口，请检查 API 地址和站点版本。"
            if "超时" in error.message:
                return "查询站点超时，请稍后重试。"
            if "连接" in error.message or "网络" in error.message:
                return "无法连接站点，请检查网络和 API 地址。"
        return "查询站点状态失败，请检查插件配置和站点网络。"

    async def _channel_data(self, group_keyword: str = "", time_range: str = "24h") -> Any:
        client = self._get_client()
        try:
            settings = await client.get_public_settings()
        except KinghtAPIError:
            settings = {}
        if isinstance(settings, dict) and _text(settings.get("channel_monitor_mode"), "").lower() == "v2":
            payload = await client.get_channel_monitor_v2_snapshot(time_range, group_name=group_keyword)
            requests = [
                client.get_channel_monitor_v2_dimensions(time_range),
                client.get_channel_monitor_v2_matrix(time_range, group_by="platform_group"),
            ]
            get_available_groups = getattr(client, "get_available_groups", None)
            if callable(get_available_groups):
                requests.append(get_available_groups())
            results = await asyncio.gather(*requests, return_exceptions=True)
            dimensions, matrix = results[:2]
            available_groups = results[2] if len(results) > 2 else None
            if isinstance(dimensions, Exception) and not isinstance(dimensions, KinghtAPIError):
                raise dimensions
            if isinstance(matrix, Exception) and not isinstance(matrix, KinghtAPIError):
                raise matrix
            if isinstance(dimensions, KinghtAPIError):
                dimensions = None
            if isinstance(matrix, KinghtAPIError):
                matrix = None
            if isinstance(available_groups, Exception):
                available_groups = None
            groups = _v2_group_rows(dimensions, matrix, available_groups)
            if groups and isinstance(payload, dict):
                payload = dict(payload)
                payload["groups"] = groups
            return payload
        return await client.get_channel_monitors()

    def _format_channel_snapshot(
        self,
        payload: Mapping[str, Any],
        group_keyword: str = "",
        time_range: str = "24h",
    ) -> str:
        health = payload.get("health")
        metrics = payload.get("metrics")
        if not isinstance(health, dict) or not isinstance(metrics, dict):
            title = f"📡 渠道监控 {time_range}"
            if group_keyword:
                title += f"｜分组：{group_keyword}"
            return f"{title}\n站点没有返回可识别的 V2 监控数据。"

        title = f"📡 渠道监控 {time_range}"
        if group_keyword:
            title += f"｜分组：{group_keyword}"
        lines = [title]
        overall = _text(health.get("overall"), "unknown")
        score = _number(health.get("score"))
        overall_parts = [
            f"整体：{_status_emoji(overall)} {_status(overall)}",
            f"评分 {_format_number(score)}",
        ]
        coverage = payload.get("coverage")
        coverage_complete: Any = None
        if isinstance(coverage, dict):
            coverage_complete = coverage.get("coverage_complete")
        elif isinstance(coverage, bool):
            coverage_complete = coverage
        coverage_text = (
            "完整"
            if coverage_complete is True
            else "不完整"
            if coverage_complete is False
            else "-"
        )
        overall_parts.append(f"覆盖：{coverage_text}")
        lines.append("｜".join(overall_parts))

        sources = _metric_sources(payload)
        error_rate = _first_metric_value(sources, "error_rate", "request_error_rate")
        success_rate = _display_success_rate(sources)
        cache_rate = _first_metric_value(sources, "cache_rate", "cache_hit_rate", "cache_hit_ratio")
        lines.append(f"总计：{_format_compact_rates(success_rate, error_rate, cache_rate)}")
        ttft = extract_ttft_metrics(payload)
        lines.append(_format_compact_ttft(ttft))

        groups = _group_payloads(payload)
        if group_keyword:
            query = group_keyword.casefold()
            matched_groups = [(name, row) for name, row in groups if query in name.casefold()]
            if matched_groups:
                groups = matched_groups
            elif groups:
                return f"📡 渠道监控 {time_range}｜分组：{group_keyword}\n未找到匹配的分组。"

        if groups:
            for name, row in groups:
                sources = _metric_sources(row)
                error_rate = _first_metric_value(sources, "error_rate", "request_error_rate")
                success_rate = _display_success_rate(sources)
                cache_rate = _first_metric_value(
                    sources, "cache_rate", "cache_hit_rate", "cache_hit_ratio"
                )
                ttft = extract_ttft_metrics(row)
                lines.append(f"━━━━━━━━━━【{name}】")
                lines.append(
                    _format_compact_group_rates(
                        success_rate,
                        error_rate,
                        cache_rate,
                        row.get("rate_multiplier"),
                    )
                )
                lines.append(_format_compact_ttft(ttft))
        return "\n".join(lines)

    def _format_channels(self, payload: Any, group_keyword: str = "", time_range: str = "24h") -> str:
        config = self.config
        if isinstance(payload, dict) and isinstance(payload.get("health"), dict):
            return self._format_channel_snapshot(payload, group_keyword, time_range)
        rows = _items(payload)
        group_keyword = group_keyword.strip()
        query = group_keyword.casefold()
        if query:
            rows = [
                row
                for row in rows
                if query in _group_name(row).casefold()
            ]
        max_channels = max(1, min(int(getattr(config, "max_channels", 20) or 20), 100))
        rows = rows[:max_channels]
        if not rows:
            scope = f"分组：{group_keyword}" if group_keyword else "全部分组"
            return f"📡 渠道状态（{scope}）\n渠道列表为空：当前账号没有可见的逐渠道明细，或站点尚未配置监控渠道。"

        scope = f"分组：{group_keyword}" if group_keyword else "全部分组"
        lines = [f"📡 渠道状态（{scope}，共 {len(rows)} 个）"]
        for row in rows:
            raw_status = _text(row.get("primary_status"), "unknown")
            title = _text(row.get("name"), "未命名渠道")
            provider = _text(row.get("provider"))
            group_name = _text(_group_name(row), "未分组")
            model = _text(row.get("primary_model"))
            availability = _format_number(row.get("availability_7d"), "%")
            latency = _format_number(row.get("primary_latency_ms"), " ms")
            ping = _format_number(row.get("primary_ping_latency_ms"), " ms")
            detail = f"{title}｜分组：{group_name}｜{provider}｜{model}"
            lines.append(
                f"{_status_emoji(raw_status)} {detail}\n"
                f"状态：{_status(raw_status)}　7 天可用率：{availability}\n"
                f"延迟：{latency}　Ping：{ping}"
            )
            extras = row.get("extra_models")
            if isinstance(extras, list) and extras:
                extra_text = "、".join(
                    f"{_text(item.get('model'))}:{_status(item.get('status'))}"
                    for item in extras[:5]
                    if isinstance(item, dict)
                )
                if extra_text:
                    lines.append(f"其它模型：{extra_text}")
        return "\n".join(lines)

    def _format_first_token_single(self, payload: Any, time_range: str, group_name: str = "") -> str:
        metrics = extract_ttft_metrics(payload)
        raw_status = extract_ttft_status(payload)
        scope = f"｜分组：{group_name}" if group_name else "｜全部分组"
        lines = [f"⚡ 首字（首 Token）状态（{time_range}）{scope}"]
        lines.append(f"健康状态：{_status_emoji(raw_status)} {_status(raw_status)}")
        if not metrics:
            lines.append("当前时间范围暂无首字统计数据。")
            return "\n".join(lines)
        labels = (("p50", "P50"), ("p90", "P90"), ("p95", "P95"), ("p99", "P99"), ("avg", "平均"), ("max", "最大"))
        values = [f"{label} {_format_number(metrics[key], ' ms')}" for key, label in labels if key in metrics]
        lines.append("　".join(values))
        return "\n".join(lines)

    def _format_first_token(self, payload: Any, time_range: str, group_keyword: str = "") -> str:
        group_keyword = group_keyword.strip()
        groups = _group_payloads(payload)
        if groups:
            if group_keyword:
                query = group_keyword.casefold()
                groups = [(name, row) for name, row in groups if query in name.casefold()]
            if not groups:
                return f"⚡ 首字（首 Token）状态（{time_range}）｜分组：{group_keyword}\n未找到匹配的分组。"
            return "\n\n".join(
                self._format_first_token_single(row, time_range, name) for name, row in groups
            )
        return self._format_first_token_single(payload, time_range, group_keyword)

    def _format_model_first_token(self, payload: Any, time_range: str, group_name: str = "") -> str:
        rows = _items(payload)
        if not rows and isinstance(payload, dict):
            rows = _items(payload.get("data"))
        scope = f"｜分组：{group_name}" if group_name else "｜全部分组"
        if not rows:
            return f"⚡ 首字（首 Token）模型状态（{time_range}）{scope}\n暂无模型统计数据。"
        max_rows = max(1, min(int(getattr(self.config, "max_model_rows", 10) or 10), 50))
        lines = [f"⚡ 首字（首 Token）模型状态（{time_range}）{scope}"]
        for row in rows[:max_rows]:
            model = _text(row.get("model"), "未命名模型")
            platform = _text(row.get("platform"), "")
            prefix = f"{platform} / " if platform != "-" and platform else ""
            average = _format_number(row.get("avg_first_token_ms"), " ms")
            requests = _format_number(row.get("requests_with_first_token"), " 次")
            lines.append(f"• {prefix}{model}：平均 {average}，有效请求 {requests}")
        return "\n".join(lines)

    async def _resolve_admin_groups(self, keyword: str) -> list[tuple[str, str]]:
        client = self._get_client()
        payload = await client.get_admin_groups(keyword)
        rows = _items(payload)
        if isinstance(payload, dict) and payload.get("id") is not None:
            rows.append(payload)
        query = keyword.casefold()
        matches: list[tuple[str, str]] = []
        for row in rows:
            name = _group_name(row) or _text(row.get("name"), "")
            group_id = row.get("id") or row.get("group_id") or row.get("groupId")
            if name and group_id is not None and query in name.casefold():
                matches.append((str(group_id), name))
        # 后端搜索已经按名称筛选，这里仍去重，避免分页或兼容接口重复返回。
        unique: list[tuple[str, str]] = []
        seen: set[str] = set()
        for group_id, name in matches:
            if group_id in seen:
                continue
            seen.add(group_id)
            unique.append((group_id, name))
        return unique

    async def _first_token_data(
        self,
        group_keyword: str = "",
        *,
        requested_range: str | None = None,
        source_override: str | None = None,
    ) -> list[tuple[Any, str, str, str]]:
        source = _text(
            source_override or getattr(self.config, "first_token_source", "public"),
            "public",
        ).lower()
        source = {"admin": "admin_overview", "overview": "admin_overview", "models": "admin_models"}.get(
            source, source
        )
        group_keyword = group_keyword.strip()
        configured_range = _text(getattr(self.config, "first_token_range", "24h"), "24h")
        time_range = _range_for_source(source, requested_range, configured_range)
        client = self._get_client()

        if source == "admin_overview":
            groups = await self._resolve_admin_groups(group_keyword) if group_keyword else [("", "")]
            return [
                (await client.get_admin_overview(time_range, group_id=group_id or None), time_range, source, name)
                for group_id, name in groups
            ]
        if source == "admin_models":
            top_n = max(1, int(getattr(self.config, "max_model_rows", 10) or 10))
            groups = await self._resolve_admin_groups(group_keyword) if group_keyword else [("", "")]
            return [
                (
                    await client.get_admin_token_stats(time_range, top_n, group_id=group_id or None),
                    time_range,
                    source,
                    name,
                )
                for group_id, name in groups
            ]

        try:
            payload = await client.get_channel_monitor_v2_snapshot(time_range, group_name=group_keyword)
        except KinghtAPIError as exc:
            # 兼容未实现 group_name 查询参数的旧版站点，继续读取快照并在返回明细中本地过滤。
            if group_keyword and exc.status_code in {400, 422}:
                payload = await client.get_channel_monitor_v2_snapshot(time_range)
            else:
                raise
        return [(payload, time_range, "public", group_keyword)]

    def _account_command_context(
        self,
        stream_id: str,
        kwargs: Mapping[str, Any],
        *,
        allow_group: bool = False,
        group_error: str = "Key 用量查询请私聊机器人执行。",
    ) -> tuple[str, str, str, bool, str | None]:
        platform, user_id, key, is_group = self._binding_key(kwargs, stream_id)
        if is_group and not allow_group:
            return platform, user_id, key, True, group_error
        if not user_id or not key:
            return platform, user_id, key, is_group, "无法识别当前用户，请在私聊中重试。"
        return platform, user_id, key, is_group, None

    @staticmethod
    def _account_context_error(error_message: str | None) -> str:
        """给账号命令的上下文错误附加稳定状态，便于机器人继续分流。"""

        message = str(error_message or "无法识别当前用户，请在私聊中重试。").strip()
        if "账号状态：" in message:
            return message
        return f"{message}\n账号状态：context_invalid"

    @staticmethod
    def _usage_number(payload: Any, *keys: str) -> Any:
        if not isinstance(payload, Mapping):
            return None
        for key in keys:
            if payload.get(key) is not None:
                return payload.get(key)
        return None

    @staticmethod
    def _format_money(value: Any) -> str:
        number = _number(value)
        return "-" if number is None else f"{number:.6f}".rstrip("0").rstrip(".")

    def _format_personal_info(self, profile: Mapping[str, Any]) -> str:
        def metric(name: str) -> float | None:
            value = _number(profile.get(name))
            return value if value is not None and math.isfinite(value) else None

        lines = ["👤 个人信息", f"昵称：{_text(profile.get('username'), '未设置')}"]
        user_id = profile.get("id")
        if user_id is not None and _text(user_id, ""):
            lines.append(f"用户 ID：{_text(user_id)}")
        balance = metric("balance")
        if balance is not None:
            lines.append(f"账户余额：${self._format_money(balance)}")
        concurrency = metric("concurrency")
        if concurrency is not None:
            limit = "不限制" if concurrency <= 0 else _format_number(concurrency)
            lines.append(f"总并发：{limit}")
        current_concurrency = metric("current_concurrency")
        if current_concurrency is not None and current_concurrency >= 0:
            lines.append(f"当前并发：{_format_number(current_concurrency)}")
        current_rpm = metric("current_rpm")
        if current_rpm is not None and current_rpm >= 0:
            window = metric("rpm_window_seconds")
            window = window if window is not None and window > 0 else 60
            lines.append(f"当前 RPM（近 {_format_number(window)} 秒）：{_format_number(current_rpm)}")
        lines.append("账号状态：bound")
        return "\n".join(lines)

    def _format_account_usage(self, stats: Any, profile: Any) -> str:
        if not isinstance(stats, Mapping):
            stats = {}
        if not isinstance(profile, Mapping):
            profile = {}
        lines = ["📊 我的用量"]
        lines.append(
            "累计：请求 "
            f"{_format_number(self._usage_number(stats, 'total_requests'))} 次｜"
            f"Token {_format_number(self._usage_number(stats, 'total_tokens'))}｜"
            f"实际消耗 {self._format_money(self._usage_number(stats, 'total_actual_cost', 'actual_cost'))}"
        )
        lines.append(
            "今日：请求 "
            f"{_format_number(self._usage_number(stats, 'today_requests'))} 次｜"
            f"Token {_format_number(self._usage_number(stats, 'today_tokens'))}｜"
            f"实际消耗 {self._format_money(self._usage_number(stats, 'today_actual_cost', 'today_cost'))}"
        )
        balance = self._usage_number(profile, "balance", "quota", "remaining_balance")
        # 网站当前的机器人资料接口没有余额字段，取不到时不要显示误导性的“-”。
        if balance is not None:
            lines.append(f"账户余额：{self._format_money(balance)}")
        rpm = self._usage_number(stats, "rpm")
        tpm = self._usage_number(stats, "tpm")
        if rpm is not None or tpm is not None:
            lines.append(f"近 5 分钟：RPM {_format_number(rpm)}｜TPM {_format_number(tpm)}")
        duration = self._usage_number(stats, "average_duration_ms")
        if duration is not None:
            lines.append(f"平均耗时：{_format_number(duration)} ms")
        lines.append("账号状态：bound")
        return "\n".join(lines)

    @staticmethod
    def _key_rows(payload: Any) -> list[dict[str, Any]]:
        rows = _items(payload)
        if rows:
            return rows
        if isinstance(payload, Mapping):
            nested = payload.get("keys") or payload.get("api_keys")
            if isinstance(nested, list):
                return [item for item in nested if isinstance(item, dict)]
        return []

    def _format_key_usage(self, keys_payload: Any, usage_payload: Any) -> str:
        rows = self._key_rows(keys_payload)
        usage = usage_payload.get("stats") if isinstance(usage_payload, Mapping) else {}
        if not isinstance(usage, Mapping):
            usage = {}
        if not rows:
            return "🔑 Key用量\n当前账号没有 API Key。\n账号状态：bound"
        lines = [f"🔑 Key用量（共 {len(rows)} 个）"]
        for row in rows[:100]:
            raw_id = row.get("id") or row.get("api_key_id")
            stat = usage.get(str(raw_id), usage.get(raw_id, {})) if raw_id is not None else {}
            if not isinstance(stat, Mapping):
                stat = {}
            name = _text(row.get("name") or row.get("key_name"), "未命名 Key")
            # 只显示站点返回的非敏感前缀；绝不回显 key、token 等完整字段。
            prefix = _text(row.get("key_masked") or row.get("key_prefix") or row.get("prefix"), "")
            label = f"{name}（{prefix}）" if prefix and prefix != "-" else name
            lines.append(
                f"• {label}：今日 {self._format_money(stat.get('today_actual_cost'))}｜"
                f"累计 {self._format_money(stat.get('total_actual_cost'))}"
            )
        lines.append("账号状态：bound")
        return "\n".join(lines)

    async def _account_client(self, key: str) -> KinghtAPIClient:
        client = self._get_bound_client(key)
        if client is None:
            raise KinghtAPIError("账号尚未绑定", code="account_not_bound")
        return client

    def _clear_invalid_binding(self, key: str, error: Exception) -> None:
        if not isinstance(error, KinghtAPIError):
            return
        code = str(error.code or "").strip().upper()
        if code in {"INVALID_ADMIN_KEY", "AUTHORIZATION_REQUIRED", "UNAUTHORIZED"}:
            return
        if code in {
            "BOT_BINDING_INVALID",
            "BOT_BINDING_NOT_FOUND",
            "TOKEN_REVOKED",
            "USER_NOT_FOUND",
            "EMPTY_TOKEN",
            "INVALID_AUTH_HEADER",
        } or (error.status_code == 401 and not code):
            self._remove_binding(key)

    @Command(
        "bind_account",
        description="绑定网站账号",
        pattern=r"^/绑定账号(?:\s+(?P<code>\S+))?$",
    )
    async def handle_bind_account(self, stream_id: str = "", **kwargs: Any):
        stream_id = stream_id or _text(kwargs.get("stream_id"), "")
        recalled = await self._recall_sensitive_message(kwargs, stream_id)
        platform, user_id, key, is_group, error_message = self._account_command_context(
            stream_id, kwargs, allow_group=True
        )
        if error_message:
            return await self._send_account_reply(
                stream_id,
                self._account_context_error(error_message),
                user_id=user_id,
                is_group=is_group,
                success=False,
            )
        code = _text(self._groups(kwargs).get("code"), "").strip()
        if not code:
            return await self._send_account_reply(
                stream_id,
                "绑定码不能为空，请先在网站个人资料页生成绑定码，再发送 /绑定账号 <绑定码>。\n账号状态：binding_code_required",
                user_id=user_id,
                is_group=is_group,
                success=False,
            )
        try:
            claim = await self._get_client().redeem_bot_binding_code(code, platform, user_id)
            if not isinstance(claim, Mapping):
                raise KinghtAPIError("网站未返回机器人绑定令牌")
            token_type = str(claim.get("token_type") or "").strip()
            if token_type.casefold() != "bot":
                raise KinghtAPIError("网站返回的令牌类型无效", code="bot_token_type_invalid")
            token = str(
                claim.get("bot_token")
                or claim.get("bot_access_token")
                or claim.get("access_token")
                or claim.get("token")
                or ""
            ).strip()
            if not token:
                raise KinghtAPIError("网站未返回机器人绑定令牌")
            bindings = self._read_bindings()
            bindings[key] = {
                "bot_token": token,
                "refresh_token": str(claim.get("refresh_token") or "").strip(),
                "bound_at": str(claim.get("bound_at") or "").strip(),
                "platform": platform,
                "external_id": user_id,
            }
            self._write_bindings(bindings)
            message = "网站账号绑定成功，现在可以使用 /我的用量 和 /Key用量。\n账号状态：bound"
            if claim.get("bind_bonus_granted") is True:
                bonus_amount = _number(claim.get("bind_bonus_amount"))
                if bonus_amount is not None:
                    message += f"\n首次绑定赠送金额：${bonus_amount:.2f}，余额已到账。"
            if is_group and not recalled:
                message += "\n未能自动撤回绑定码消息，请手动撤回。"
            return await self._send_account_reply(
                stream_id,
                message,
                user_id=user_id,
                is_group=is_group,
            )
        except Exception as exc:
            return await self._send_account_reply(
                stream_id,
                self._friendly_account_error(exc, operation="绑定账号"),
                user_id=user_id,
                is_group=is_group,
                success=False,
            )

    @Command(
        "unbind_account",
        description="解绑网站账号",
        pattern=r"^/解绑账号$",
    )
    async def handle_unbind_account(self, stream_id: str = "", **kwargs: Any):
        stream_id = stream_id or _text(kwargs.get("stream_id"), "")
        _platform, user_id, key, is_group, error_message = self._account_command_context(
            stream_id, kwargs, allow_group=True
        )
        if error_message:
            return await self._send_account_reply(
                stream_id,
                self._account_context_error(error_message),
                user_id=user_id,
                is_group=is_group,
                success=False,
            )
        record = self._read_bindings().get(key)
        if not record:
            return await self._send_account_reply(
                stream_id,
                "当前用户还没有绑定网站账号。\n账号状态：not_bound",
                user_id=user_id,
                is_group=is_group,
                success=False,
            )
        try:
            client = self._make_bound_client(key, record)
            await client.revoke_bot_binding()
        except KinghtAPIError as exc:
            # 旧版网站没有撤销路由，或令牌已失效时，本地记录仍应清理。
            if exc.status_code not in {401, 404}:
                return await self._send_account_reply(
                    stream_id,
                    self._friendly_account_error(exc, operation="解绑账号"),
                    user_id=user_id,
                    is_group=is_group,
                    success=False,
                )
        except Exception:
            return await self._send_account_reply(
                stream_id,
                "网站解绑请求失败，请稍后重试。\n账号状态：service_unavailable",
                user_id=user_id,
                is_group=is_group,
                success=False,
            )
        self._remove_binding(key)
        return await self._send_account_reply(
            stream_id, "网站账号已解绑。\n账号状态：unbound", user_id=user_id, is_group=is_group
        )

    @Command(
        "account_binding_status",
        description="查看网站账号绑定状态",
        pattern=r"^/绑定状态$",
    )
    async def handle_account_binding_status(self, stream_id: str = "", **kwargs: Any):
        stream_id = stream_id or _text(kwargs.get("stream_id"), "")
        platform, user_id, key, is_group, error_message = self._account_command_context(
            stream_id, kwargs, allow_group=True
        )
        if error_message:
            return await self._send_account_reply(
                stream_id,
                self._account_context_error(error_message),
                user_id=user_id,
                is_group=is_group,
                success=False,
            )
        record = self._read_bindings().get(key)
        if not record:
            return await self._send_account_reply(
                stream_id,
                "当前用户尚未绑定网站账号。\n账号状态：not_bound",
                user_id=user_id,
                is_group=is_group,
                success=False,
            )
        bound_at = record.get("bound_at") or "未知时间"
        return await self._send_account_reply(
            stream_id,
            f"网站账号已绑定。平台：{platform}，用户：{_mask_identifier(user_id)}，绑定时间：{bound_at}\n账号状态：bound",
            user_id=user_id,
            is_group=is_group,
        )

    @Command(
        "account_binding_help",
        description="查看网站账号绑定帮助",
        pattern=r"^/绑定帮助$",
    )
    async def handle_account_binding_help(self, stream_id: str = "", **kwargs: Any):
        stream_id = stream_id or _text(kwargs.get("stream_id"), "")
        _platform, user_id, _key, is_group, error_message = self._account_command_context(
            stream_id, kwargs, allow_group=True
        )
        if error_message:
            return await self._send_account_reply(
                stream_id,
                self._account_context_error(error_message),
                user_id=user_id,
                is_group=is_group,
                success=False,
            )
        base, _token = self._onebot_config()
        recall_note = (
            "绑定码消息会优先尝试 SnowLuma 撤回工具和 WebSocket；已配置 OneBot 接口时会继续作为回退。"
            if base
            else "绑定码消息会优先尝试 SnowLuma 撤回工具和 WebSocket，仍失败时请手动撤回。"
        )
        def trigger_text(setting_name: str, default: str) -> str:
            values = sorted(_configured_triggers(self._trigger_setting(setting_name, None), default))
            return "、".join(f"/{value}" for value in values)

        help_text = (
            "插件帮助：\n"
            f"帮助：{trigger_text('binding_help_triggers', '绑定帮助')}\n"
            f"绑定账号：{trigger_text('bind_account_triggers', '绑定账号')} <绑定码>\n"
            f"解绑账号：{trigger_text('unbind_account_triggers', '解绑账号')}\n"
            f"绑定状态：{trigger_text('binding_status_triggers', '绑定状态')}\n"
            f"绑定诊断：{trigger_text('binding_diagnose_triggers', '绑定诊断')}\n"
            f"个人信息（私聊）：{trigger_text('personal_info_triggers', '个人信息')}\n"
            f"我的用量（私聊）：{trigger_text('my_usage_triggers', '我的用量')}\n"
            f"Key用量（私聊）：{trigger_text('key_usage_triggers', 'Key用量')}\n"
            f"签到：{trigger_text('check_in_triggers', '签到')}\n"
            f"余额预警：{trigger_text('balance_alerts_triggers', '余额预警')}\n"
            f"充值（私聊）：{trigger_text('recharge_triggers', '充值')} <金额> <支付宝或微信>\n"
            f"充值订单（私聊）：{trigger_text('recharge_order_triggers', '充值订单')} [订单号]\n"
            f"抽奖：{trigger_text('lottery_triggers', '抽奖')}\n"
            f"抽奖次数：{trigger_text('lottery_plays_triggers', '抽奖次数')}\n"
            f"抽奖记录（私聊）：{trigger_text('lottery_records_triggers', '抽奖记录')}\n"
            f"发放抽奖次数（管理员，群聊和私聊都可以）：{trigger_text('lottery_grant_triggers', '发放抽奖次数')} <QQ号或全部> <次数> [备注]\n"
            f"发放进度（管理员，群聊和私聊都可以）：{trigger_text('lottery_grant_triggers', '发放抽奖次数')} 查询 <批次号>\n"
            f"渠道状态：{trigger_text('channel_status_triggers', '渠道状态，渠道，状态')} [分组关键词]\n"
            f"首字状态：{trigger_text('first_token_status_triggers', '首字状态，首字，首Token')} [分组关键词]\n"
            f"站点状态：{trigger_text('site_status_triggers', '站点状态，网站状态')} [90m|24h|7d|30d]\n"
            "绑定流程：登录网站，在个人资料页生成机器人绑定码，再发送绑定账号命令。\n"
            "余额预警：查询网站个人资料页的余额预警开关状态；群聊和私聊均可查询。\n"
            f"绑定码仅能使用一次，10 分钟内有效。{recall_note}"
        )
        return await self._send_account_reply(
            stream_id, help_text, user_id=user_id, is_group=is_group
        )

    @Command(
        "account_binding_diagnose",
        description="诊断网站账号绑定接口连通性",
        pattern=r"^/绑定诊断$",
    )
    async def handle_account_binding_diagnose(self, stream_id: str = "", **kwargs: Any):
        stream_id = stream_id or _text(kwargs.get("stream_id"), "")
        _platform, user_id, key, is_group, error_message = self._account_command_context(
            stream_id, kwargs, allow_group=True
        )
        if error_message:
            return await self._send_account_reply(
                stream_id,
                self._account_context_error(error_message),
                user_id=user_id,
                is_group=is_group,
                success=False,
            )
        if not self._is_admin_user(stream_id, kwargs):
            return await self._send_account_reply(
                stream_id,
                "只有管理员账号可以使用绑定诊断。\n诊断状态：forbidden",
                user_id=user_id,
                is_group=is_group,
                success=False,
            )
        record = self._read_bindings().get(key)
        if not record:
            return await self._send_account_reply(
                stream_id,
                "当前用户尚未绑定网站账号，请发送 /绑定账号 <绑定码>。\n诊断状态：not_bound",
                user_id=user_id,
                is_group=is_group,
                success=False,
            )
        client = self._make_bound_client(key, record)
        lines = ["🩺 绑定诊断"]
        checks = (
            ("账号资料", client.get_user_profile),
            ("仪表盘用量", client.get_usage_dashboard_stats),
            ("周期用量", lambda: client.get_usage_stats("today")),
        )
        all_ok = True
        for label, call in checks:
            started = time.monotonic()
            error: Exception | None = None
            try:
                await call()
            except Exception as exc:  # noqa: BLE001 - 诊断需要展示任意异常
                error = exc
            elapsed = int((time.monotonic() - started) * 1000)
            if error is None:
                lines.append(f"{label}：正常（{elapsed} ms）")
                continue
            all_ok = False
            if isinstance(error, KinghtAPIError):
                status = f"HTTP {error.status_code}" if error.status_code else "请求失败"
                code = str(error.code or "").strip()
                if not re.fullmatch(r"[A-Za-z0-9_.-]{1,48}", code):
                    code = "站点错误"
                lines.append(f"{label}：失败（{status}，{code}，{elapsed} ms）")
            else:
                lines.append(f"{label}：异常（客户端请求失败，{elapsed} ms）")
        onebot_base, _onebot_token = self._onebot_config()
        lines.append(
            "撤回消息：优先尝试 SnowLuma 撤回工具和 WebSocket"
            + ("，已配置 OneBot HTTP 作为回退" if onebot_base else "，未配置 OneBot HTTP 回退")
        )
        lines.append("诊断状态：ok" if all_ok else "诊断状态：failed")
        return await self._send_account_reply(
            stream_id, "\n".join(lines), user_id=user_id, is_group=is_group, success=all_ok
        )

    @Command(
        "personal_info",
        description="查询当前绑定网站账号的个人信息",
        pattern=r"^/个人信息$",
    )
    async def handle_personal_info(self, stream_id: str = "", **kwargs: Any):
        stream_id = stream_id or _text(kwargs.get("stream_id"), "")
        _platform, user_id, key, is_group, error_message = self._account_command_context(
            stream_id,
            kwargs,
            group_error="个人信息查询请私聊机器人执行。",
        )
        if error_message:
            return await self._send_account_reply(
                stream_id,
                self._account_context_error(error_message),
                user_id=user_id,
                is_group=is_group,
                success=False,
            )
        try:
            client = await self._account_client(key)
            profile = await client.get_personal_info()
            if not isinstance(profile, Mapping):
                raise KinghtAPIError("网站返回的个人信息无法识别", code="INVALID_RESPONSE")
            return await self._send_account_reply(
                stream_id,
                self._format_personal_info(profile),
                user_id=user_id,
                is_group=is_group,
            )
        except Exception as exc:
            logging.getLogger(__name__).warning(
                "查询网站个人信息失败（%s）: %s", _mask_identifier(user_id), exc, exc_info=True
            )
            self._clear_invalid_binding(key, exc)
            message = self._friendly_account_error(exc, operation="查询个人信息")
            if (
                isinstance(exc, KinghtAPIError)
                and exc.status_code == 404
                and message.endswith("\n账号状态：not_found")
            ):
                message = "网站尚未提供个人信息接口，请联系网站管理员。\n账号状态：not_found"
            return await self._send_account_reply(
                stream_id,
                message,
                user_id=user_id,
                is_group=is_group,
                success=False,
            )

    @Command(
        "my_usage",
        description="查询当前绑定网站账号的用量",
        pattern=r"^/我的用量$",
    )
    async def handle_my_usage(self, stream_id: str = "", **kwargs: Any):
        stream_id = stream_id or _text(kwargs.get("stream_id"), "")
        _platform, user_id, key, is_group, error_message = self._account_command_context(
            stream_id,
            kwargs,
            group_error="我的用量查询请私聊机器人执行。",
        )
        if error_message:
            return await self._send_account_reply(
                stream_id,
                self._account_context_error(error_message),
                user_id=user_id,
                is_group=is_group,
                success=False,
            )
        try:
            client = await self._account_client(key)
            # 只把仪表盘用量当作必需请求；资料接口取不到时不影响用量展示，
            # 也避免因两个请求同时命中网站限流导致整条命令失败。
            stats = await client.get_usage_dashboard_stats()
            if not isinstance(stats, Mapping):
                raise KinghtAPIError("网站返回的用量数据无法识别", code="INVALID_RESPONSE")
            profile: Any = {}
            try:
                profile = await client.get_user_profile()
            except KinghtAPIError as exc:
                code = str(exc.code or "").strip().upper()
                if exc.status_code in {401, 403} or code in {
                    "BOT_BINDING_INVALID",
                    "BOT_BINDING_NOT_FOUND",
                    "TOKEN_REVOKED",
                    "USER_NOT_FOUND",
                    "USER_INACTIVE",
                    "BOT_BINDING_ACCOUNT_INACTIVE",
                    "BOT_AUTH_REQUIRED",
                }:
                    raise
                logging.getLogger(__name__).info("读取网站账号资料失败，继续展示用量: %s", exc)
            except Exception as exc:  # noqa: BLE001 - 资料接口是可选信息
                logging.getLogger(__name__).info("读取网站账号资料失败，继续展示用量: %s", exc)
            return await self._send_account_reply(
                stream_id,
                self._format_account_usage(stats, profile),
                user_id=user_id,
                is_group=is_group,
            )
        except Exception as exc:
            logging.getLogger(__name__).warning(
                "查询网站账号用量失败（%s）: %s", _mask_identifier(user_id), exc, exc_info=True
            )
            self._clear_invalid_binding(key, exc)
            return await self._send_account_reply(
                stream_id,
                self._friendly_account_error(exc),
                user_id=user_id,
                is_group=is_group,
                success=False,
            )

    @Command(
        "key_usage",
        description="查询当前绑定网站账号的 API Key 用量",
        pattern=r"^/Key用量$",
    )
    async def handle_key_usage(self, stream_id: str = "", **kwargs: Any):
        stream_id = stream_id or _text(kwargs.get("stream_id"), "")
        _platform, user_id, key, is_group, error_message = self._account_command_context(stream_id, kwargs)
        if error_message:
            return await self._send_account_reply(
                stream_id,
                self._account_context_error(error_message),
                user_id=user_id,
                is_group=is_group,
                success=False,
            )
        try:
            client = await self._account_client(key)
            keys = await client.get_api_keys()
            if not isinstance(keys, (Mapping, list)):
                raise KinghtAPIError("网站返回的 API Key 数据无法识别", code="INVALID_RESPONSE")
            rows = self._key_rows(keys)
            ids = [row.get("id") or row.get("api_key_id") for row in rows]
            usage = await client.get_api_keys_usage([item for item in ids if item is not None])
            if not isinstance(usage, Mapping):
                raise KinghtAPIError("网站返回的 Key 用量数据无法识别", code="INVALID_RESPONSE")
            return await self._send_account_reply(
                stream_id,
                self._format_key_usage(keys, usage),
                user_id=user_id,
                is_group=is_group,
            )
        except Exception as exc:
            logging.getLogger(__name__).warning(
                "查询网站账号用量失败（%s）: %s", _mask_identifier(user_id), exc, exc_info=True
            )
            self._clear_invalid_binding(key, exc)
            return await self._send_account_reply(
                stream_id,
                self._friendly_account_error(exc),
                user_id=user_id,
                is_group=is_group,
                success=False,
            )

    @Command(
        "balance_alerts",
        description="查询网站余额预警开关状态",
        pattern=r"^/余额预警$",
    )
    async def handle_balance_alerts(self, stream_id: str = "", **kwargs: Any):
        stream_id = stream_id or _text(kwargs.get("stream_id"), "")
        platform, user_id, key, is_group, error_message = self._account_command_context(
            stream_id,
            kwargs,
            allow_group=True,
        )
        if error_message:
            return await self._send_account_reply(
                stream_id,
                self._account_context_error(error_message),
                user_id=user_id,
                is_group=is_group,
                success=False,
            )
        if platform != "qq":
            return await self._send_account_reply(
                stream_id,
                "余额预警仅支持 QQ 账号绑定。\n余额预警状态：platform_unsupported",
                user_id=user_id,
                is_group=is_group,
                success=False,
            )
        try:
            client = await self._account_client(key)
            settings = await client.get_public_settings()
            settings_data: Any = settings
            if isinstance(settings_data, Mapping) and isinstance(settings_data.get("data"), Mapping):
                settings_data = settings_data.get("data")
            if isinstance(settings_data, Mapping) and isinstance(settings_data.get("settings"), Mapping):
                settings_data = settings_data.get("settings")
            if not isinstance(settings_data, Mapping) or "balance_low_notify_enabled" not in settings_data:
                raise KinghtAPIError("网站返回的余额预警设置无法识别", code="INVALID_RESPONSE")
            enabled = (
                _bool_value(settings_data.get("balance_low_notify_enabled"), False)
            )
            return await self._send_account_reply(
                stream_id,
                (
                    "网站余额预警总开关：已开启。\n余额预警状态：enabled"
                    if enabled
                    else "网站余额预警总开关：未开启。\n余额预警状态：disabled"
                ),
                user_id=user_id,
                is_group=is_group,
            )
        except Exception as exc:
            logging.getLogger(__name__).warning(
                "读取余额预警开关失败（%s）: %s", _mask_identifier(user_id), exc, exc_info=True
            )
            self._clear_invalid_binding(key, exc)
            return await self._send_account_reply(
                stream_id,
                self._friendly_balance_alert_error(exc),
                user_id=user_id,
                is_group=is_group,
                success=False,
            )

    @staticmethod
    def _require_feature_payload(payload: Any) -> Mapping[str, Any]:
        if not isinstance(payload, Mapping):
            raise KinghtAPIError("网站返回的数据无法识别", code="INVALID_RESPONSE")
        return payload

    async def _run_account_feature(
        self, stream_id: str, kwargs: Mapping[str, Any], operation: str, execute: Any,
        *, allow_group: bool = False, admin: bool = False,
    ):
        stream_id = stream_id or _text(kwargs.get("stream_id"), "")
        platform, user_id, key, is_group, error = self._account_command_context(
            stream_id, kwargs, allow_group=allow_group,
            group_error=f"{operation}请私聊机器人执行。",
        )
        if not error:
            error = self._permission_error(stream_id, kwargs)
        if not error and platform != "qq":
            error = "此功能仅支持 QQ 账号绑定。"
        if not error and admin and not self._is_admin_user(stream_id, kwargs):
            error = "此命令仅允许插件管理员使用。"
        if error:
            return await self._send_account_reply(
                stream_id, self._account_context_error(error),
                user_id=user_id, is_group=is_group, success=False,
            )
        try:
            client = await self._account_client(key)
            message = await execute(client, key)
            return await self._send_account_reply(
                stream_id, message, user_id=user_id, is_group=is_group,
            )
        except Exception as exc:
            code = str(getattr(exc, "code", "") or "").upper()
            target_not_found = admin and getattr(exc, "status_code", None) == 404 and code in {
                "BOT_BINDING_NOT_FOUND", "USER_NOT_FOUND",
            }
            if not target_not_found:
                self._clear_invalid_binding(key, exc)
            message = self._friendly_account_error(exc, operation=operation)
            business_errors = {
                "BOT_LOTTERY_DISABLED": "抽奖活动尚未开启。",
                "LOTTERY_DISABLED": "抽奖活动尚未开启。",
                "BOT_LOTTERY_NO_TICKETS": "抽奖次数不足，请联系管理员领取次数。",
                "BOT_LOTTERY_INSUFFICIENT_BALANCE": "余额不足",
                "BOT_LOTTERY_NO_PLAYS": "抽奖次数不足，请联系管理员领取次数。",
                "BOT_LOTTERY_ADMIN_REQUIRED": "QQ 账号还需要绑定网站管理员账号才能发放次数。",
                "BOT_LOTTERY_CONFIG_INVALID": "抽奖配置或发放参数无效，请联系管理员检查。",
                "LOTTERY_NO_PLAYS": "抽奖次数不足，请联系管理员领取次数。",
                "BOT_LOTTERY_INSUFFICIENT_PLAYS": "抽奖次数不足，请联系管理员领取次数。",
                "BOT_LOTTERY_TARGET_NOT_FOUND": "目标 QQ 尚未有效绑定网站账号。",
                "BOT_LOTTERY_BATCH_NOT_FOUND": "没有找到此抽奖次数发放批次，请核对批次号。",
                "BOT_LOTTERY_TARGET_AMBIGUOUS": "目标 QQ 关联了多个网站账号，请在网站后台选择具体账号发放。",
                "IDEMPOTENCY_KEY_CONFLICT": "此操作编号已用于其他参数，请先核对原操作记录。",
                "PAYMENT_DISABLED": "网站尚未开启充值。",
                "BALANCE_PAYMENT_DISABLED": "网站尚未开启余额充值。",
                "BOT_RECHARGE_DISABLED": "网站尚未开启可用的支付宝或微信余额充值。",
                "BOT_RECHARGE_ORDER_NOT_FOUND": "没有找到本人的机器人充值订单。",
                "INVALID_AMOUNT": "充值金额无效，请通过 /充值 查看金额限制。",
                "BOT_RECHARGE_METHOD_UNAVAILABLE": "此支付渠道当前不可用，请通过 /充值 查看可用渠道。",
                "BOT_RECHARGE_CHANNEL_UNAVAILABLE": "此支付渠道当前不可用，请通过 /充值 查看可用渠道。",
                "BOT_RECHARGE_REQUEST_CONFLICT": "原请求参数不一致，请先查询原充值订单。",
                "BOT_RECHARGE_IN_PROGRESS": "充值订单结果待确认，请使用 /充值订单 查询。",
            }
            if code in business_errors:
                message = business_errors[code]
            if target_not_found:
                message = "目标 QQ 尚未有效绑定网站账号，未发放抽奖次数。"
            if code == "BOT_OPERATION_PENDING":
                message = str(getattr(exc, "message", "") or "操作结果待确认，请先查询。")
            status_code = getattr(exc, "status_code", None)
            if status_code is None or status_code >= 500:
                message += "\n如刚才提交了充值、抽奖或次数发放，结果可能已生效；请查询原结果，重发同一操作将先恢复原请求。"
            return await self._send_account_reply(
                stream_id, message, user_id=user_id, is_group=is_group, success=False,
            )

    async def _perform_feature_write(
        self, kind: str, key: str, kwargs: Mapping[str, Any], params: Mapping[str, Any], execute: Any,
    ) -> Mapping[str, Any]:
        fingerprint = json.dumps(dict(params), ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        request_id, error = self._prepare_idempotent_operation(
            kind, key, self._operation_request_id(kind, key, kwargs), fingerprint,
        )
        if error:
            raise KinghtAPIError(error, code="BOT_OPERATION_PENDING", status_code=409)
        try:
            payload = self._require_feature_payload(await execute(request_id))
            required = {
                "recharge": ("order_id", "status", "pay_amount", "credited_amount"),
                "lottery": ("prize_name", "reward", "remaining"),
                "lottery_grant": ("batch_id",) if "batch_id" in payload else ("count", "remaining"),
            }.get(kind, ())
            if any(field not in payload or payload[field] is None for field in required):
                raise KinghtAPIError("网站返回的操作结果不完整，请查询原结果。", code="INVALID_RESPONSE")
        except KinghtAPIError as exc:
            # 服务端明确拒绝的请求允许修正；超时、处理中、冲突与服务器错误保留原键。
            rejected_before_write = str(exc.code or "").upper() in {
                "BOT_RECHARGE_CHANNEL_UNAVAILABLE", "BOT_LOTTERY_NO_TICKETS",
            }
            if rejected_before_write or (exc.status_code is not None and 400 <= exc.status_code < 500 and exc.status_code not in {408, 409, 429}):
                self._finish_idempotent_operation(kind, key, request_id)
            raise
        self._finish_idempotent_operation(kind, key, request_id)
        return payload

    @staticmethod
    def _format_recharge_order(payload: Mapping[str, Any]) -> str:
        states = {
            "PENDING": "待支付", "PAID": "已支付，等待入账", "RECHARGING": "正在入账",
            "COMPLETED": "已到账", "EXPIRED": "已过期", "CANCELLED": "已取消",
            "FAILED": "失败", "REFUNDED": "已退款", "REFUND_PENDING": "退款处理中",
        }
        order_id = _text(payload.get("order_id"), "-")
        lines = [
            "充值订单", f"订单号：{order_id}",
            f"订单状态：{states.get(str(payload.get('status') or '').upper(), '结果待确认')}",
            f"应付金额：{KinghtStatusPlugin._format_check_in_money(payload.get('pay_amount'))} {_text(payload.get('currency'), 'CNY')}",
            f"到账余额：{KinghtStatusPlugin._format_check_in_money(payload.get('credited_amount'))} {_text(payload.get('credited_currency'), 'USD')}",
        ]
        if payload.get("expires_at"):
            lines.append(f"有效期至：{_text(payload.get('expires_at'))}")
        if payload.get("pay_url"):
            lines.append(f"支付链接：{_text(payload.get('pay_url'))}")
        if payload.get("qr_code"):
            lines.append("请使用对应支付应用扫描付款二维码。")
        lines.append(f"查询订单：/充值订单 {order_id}")
        return "\n".join(lines)

    async def _send_recharge_qr(self, payload: Mapping[str, Any], stream_id: str) -> bool:
        encoded = _text(payload.get("qr_code_png_base64"), "")
        if not encoded:
            return False
        try:
            result = await self.ctx.send.hybrid([
                {"type": "image", "binary_data_base64": encoded},
            ], stream_id)
            return result is not False
        except Exception as exc:
            logging.getLogger(__name__).warning("发送充值二维码失败，保留原订单: %s", exc)
            return False

    @Command("bot_recharge", description="为绑定网站账号充值", pattern=r"^/充值(?:\s+(?P<argument>.+))?$")
    async def handle_recharge(self, stream_id: str = "", **kwargs: Any):
        async def execute(client: KinghtAPIClient, key: str) -> str:
            argument = _text(self._groups(kwargs).get("argument"), "").strip()
            if not argument:
                payload = self._require_feature_payload(await client.get_bot_recharge_options())
                if not _bool_value(payload.get("enabled"), False):
                    return "网站尚未开启余额充值。"
                methods = payload.get("methods")
                if not isinstance(methods, Mapping) or not methods:
                    return "当前没有可用的支付宝或微信充值渠道。"
                lines = ["充值方式："]
                if payload.get("min_amount") is not None or payload.get("max_amount") is not None:
                    minimum = self._format_money(payload.get("min_amount", 0))
                    maximum = self._format_money(payload.get("max_amount")) if (_number(payload.get("max_amount")) or 0) > 0 else "不限"
                    lines.append(f"充值金额范围：{minimum} 至 {maximum}（按所选渠道币种）")
                for name in ("alipay", "wxpay"):
                    method = methods.get(name)
                    if not isinstance(method, Mapping):
                        continue
                    label = "支付宝" if name == "alipay" else "微信"
                    maximum = self._format_money(method.get("max")) if (_number(method.get("max")) or 0) > 0 else "不限"
                    lines.append(
                        f"{label}单笔支付范围：{self._format_money(method.get('min'))} 至 {maximum} {_text(method.get('currency'), 'CNY')}"
                    )
                lines.append("使用：/充值 <金额> <支付宝或微信>\n示例：/充值 10 支付宝")
                return "\n".join(lines)
            match = re.fullmatch(r"(?P<amount>\d+(?:\.\d{1,8})?)\s+(?P<method>支付宝|微信)", argument)
            if match is None:
                return "使用：/充值 <金额> <支付宝或微信>\n示例：/充值 10 支付宝"
            amount = float(match.group("amount"))
            if not math.isfinite(amount) or amount <= 0:
                return "充值金额必须为正数。"
            method = "alipay" if match.group("method") == "支付宝" else "wxpay"
            payload = await self._perform_feature_write(
                "recharge", key, kwargs, {"amount": amount, "payment_type": method},
                lambda request_id: client.create_bot_recharge_order(amount, method, request_id),
            )
            sent = await self._send_recharge_qr(payload, stream_id or _text(kwargs.get("stream_id"), ""))
            message = self._format_recharge_order(payload)
            if payload.get("qr_code") and not sent:
                message += "\n二维码暂时无法发送，请查询此订单重试或使用支付链接，请勿重复下单。"
            return message
        return await self._run_account_feature(stream_id, kwargs, "充值", execute)

    @Command("bot_recharge_order", description="查询本人充值订单", pattern=r"^/充值订单(?:\s+(?P<order_id>\d+))?$")
    async def handle_recharge_order(self, stream_id: str = "", **kwargs: Any):
        async def execute(client: KinghtAPIClient, _key: str) -> str:
            order_id = _text(self._groups(kwargs).get("order_id"), "").strip()
            payload = self._require_feature_payload(await client.get_bot_recharge_order(order_id))
            sent = await self._send_recharge_qr(payload, stream_id or _text(kwargs.get("stream_id"), ""))
            message = self._format_recharge_order(payload)
            if payload.get("qr_code") and not sent:
                message += "\n二维码暂时无法发送，请查询此订单重试或使用支付链接，请勿重复下单。"
            return message
        return await self._run_account_feature(stream_id, kwargs, "充值订单查询", execute)

    @Command("bot_lottery", description="消耗一次抽奖次数抽奖", pattern=r"^/抽奖$")
    async def handle_lottery(self, stream_id: str = "", **kwargs: Any):
        async def execute(client: KinghtAPIClient, key: str) -> str:
            profile = self._require_feature_payload(await client.get_personal_info())
            balance = _number(profile.get("balance"))
            if balance is None or not math.isfinite(balance) or isinstance(profile.get("balance"), bool):
                raise KinghtAPIError("网站未返回可验证的账户余额", code="INVALID_RESPONSE")
            if balance <= 0:
                raise KinghtAPIError("余额不足", code="BOT_LOTTERY_INSUFFICIENT_BALANCE", status_code=409)
            payload = await self._perform_feature_write(
                "lottery", key, kwargs, {}, client.draw_lottery,
            )
            return (
                f"抽奖结果：{_text(payload.get('prize_name'), '暂无奖项')}\n"
                f"奖励余额：${self._format_check_in_money(payload.get('reward'))}\n"
                f"剩余次数：{_text(payload.get('remaining'), '0')}\n抽奖状态：success"
            )
        return await self._run_account_feature(stream_id, kwargs, "抽奖", execute, allow_group=True)

    @Command("bot_lottery_plays", description="查询抽奖次数", pattern=r"^/抽奖次数$")
    async def handle_lottery_plays(self, stream_id: str = "", **kwargs: Any):
        async def execute(client: KinghtAPIClient, _key: str) -> str:
            payload = self._require_feature_payload(await client.get_lottery())
            state = "已开启" if _bool_value(payload.get("enabled"), False) else "未开启"
            return f"抽奖活动：{state}\n剩余次数：{_text(payload.get('remaining'), '0')}\n抽奖命令：/抽奖"
        return await self._run_account_feature(stream_id, kwargs, "抽奖次数查询", execute, allow_group=True)

    @Command("bot_lottery_records", description="查询本人最近五次抽奖记录", pattern=r"^/抽奖记录$")
    async def handle_lottery_records(self, stream_id: str = "", **kwargs: Any):
        async def execute(client: KinghtAPIClient, _key: str) -> str:
            payload = self._require_feature_payload(await client.get_lottery_records())
            rows = [row for row in _items(payload) if str(row.get("action") or "draw") == "draw"][:5]
            if not rows:
                return "暂无抽奖记录。"
            lines = ["最近抽奖记录："]
            for row in rows:
                lines.append(
                    f"{_text(row.get('created_at'), '-')}｜{_text(row.get('prize_name'), '-')}｜${self._format_check_in_money(row.get('reward'))}"
                )
            return "\n".join(lines)
        return await self._run_account_feature(stream_id, kwargs, "抽奖记录查询", execute)

    @Command("bot_lottery_grant", description="管理员发放抽奖次数", pattern=r"^/发放抽奖次数(?:\s+(?P<argument>.+))?$")
    async def handle_lottery_grant(self, stream_id: str = "", **kwargs: Any):
        async def execute(client: KinghtAPIClient, key: str) -> str:
            argument = _text(self._groups(kwargs).get("argument"), "").strip()
            query = re.fullmatch(r"查询\s+(\d+)", argument)
            if query:
                payload = self._require_feature_payload(await client.get_lottery_grant_batch(query.group(1)))
                return self._format_lottery_batch(payload)
            match = re.fullmatch(r"(?P<target>\d+|全部)\s+(?P<count>\d+)(?:\s+(?P<notes>.*))?", argument, re.DOTALL)
            if match is None:
                return "使用：/发放抽奖次数 <QQ号或全部> <次数> [备注]\n查询：/发放抽奖次数 查询 <批次号>"
            count = int(match.group("count"))
            if count < 1 or count > 100_000:
                return "每次增加的抽奖次数必须是 1 至 100000 的整数。"
            target = "all" if match.group("target") == "全部" else match.group("target")
            notes = (match.group("notes") or "").strip()
            payload = await self._perform_feature_write(
                "lottery_grant", key, kwargs, {"target": target, "count": count, "notes": notes},
                lambda request_id: client.grant_lottery_plays(target, count, notes, request_id),
            )
            batch_id = payload.get("batch_id")
            if batch_id is not None:
                if str(payload.get("status") or "").casefold() != "completed":
                    batches = self._read_lottery_batches()
                    platform, user_id, _is_group = self._binding_identity(kwargs, stream_id)
                    batches[str(batch_id)] = {"binding_key": key, "platform": platform, "external_id": user_id, "count": str(count)}
                    self._write_lottery_batches(batches)
                return self._format_lottery_batch(payload)
            return f"抽奖次数已发放。\n增加次数：{_text(payload.get('count'), str(count))}\n剩余次数：{_text(payload.get('remaining'), '-')}"
        return await self._run_account_feature(stream_id, kwargs, "发放抽奖次数", execute, allow_group=True, admin=True)

    @staticmethod
    def _format_lottery_batch(payload: Mapping[str, Any]) -> str:
        batch_id = _text(payload.get("batch_id"), "-")
        state = "已完成" if str(payload.get("status") or "").casefold() == "completed" else "处理中"
        return (
            f"抽奖次数批量发放：{state}\n批次号：{batch_id}\n"
            f"目标用户：{_text(payload.get('total'), '0')}\n成功：{_text(payload.get('success'), '0')}\n"
            f"跳过：{_text(payload.get('skipped'), '0')}\n失败：{_text(payload.get('failed'), '0')}\n"
            f"待处理：{_text(payload.get('pending'), '0')}\n查询：/发放抽奖次数 查询 {batch_id}"
        )

    @Command(
        "bot_check_in",
        description="机器人签到",
        pattern=r"^/签到$",
    )
    async def handle_check_in(self, stream_id: str = "", **kwargs: Any):
        stream_id = stream_id or _text(kwargs.get("stream_id"), "")
        _platform, user_id, key, is_group, error_message = self._account_command_context(
            stream_id, kwargs, allow_group=True
        )
        if error_message:
            error_message = f"{error_message}\n签到状态：context_invalid"
            return await self._send_account_reply(
                stream_id, error_message, user_id=user_id, is_group=is_group, success=False
            )
        try:
            client = await self._account_client(key)
            payload = await client.check_in()
            if not isinstance(payload, Mapping):
                raise KinghtAPIError("网站未返回签到结果")
            message = self._format_check_in_result(payload)
            status = self._check_in_status(payload)
            return await self._send_account_reply(
                stream_id,
                message,
                user_id=user_id,
                is_group=is_group,
                # “今日已签到”表示请求已正确处理；其余业务状态代表未领取。
                success=status in {"success", "already_checked_in"},
            )
        except Exception as exc:
            logging.getLogger(__name__).warning(
                "机器人签到失败（%s）: %s", _mask_identifier(user_id), exc, exc_info=True
            )
            self._clear_invalid_binding(key, exc)
            return await self._send_account_reply(
                stream_id,
                self._friendly_check_in_error(exc),
                user_id=user_id,
                is_group=is_group,
                success=False,
            )

    @staticmethod
    def _format_check_in_money(value: Any) -> str:
        number = _number(value)
        return "-" if number is None else f"{number:.8f}".rstrip("0").rstrip(".")

    @staticmethod
    def _check_in_status(payload: Mapping[str, Any]) -> str:
        """Normalize the status returned by the current Sub2API endpoint.

        The current web service returns a business ``status`` even when the
        request itself succeeds (for example ``disabled`` or
        ``insufficient_usage``).  Older versions only returned ``checked_in``;
        retain that fallback so existing deployments continue to work.
        """

        raw_status = str(payload.get("status") or "").strip().casefold()
        # An explicit status is authoritative.  Checking the boolean fields
        # first would turn an inconsistent ``status=already_checked_in`` /
        # ``checked_in=true`` response into a false success.
        status_aliases = {
            "success": "success",
            "checked_in": "success",
            "check_in_success": "success",
            "already_checked_in": "already_checked_in",
            "already_check_in": "already_checked_in",
            "today_checked_in": "already_checked_in",
            "duplicate_check_in": "already_checked_in",
            "disabled": "disabled",
            "check_in_disabled": "disabled",
            "insufficient_usage": "insufficient_usage",
            "check_in_insufficient_usage": "insufficient_usage",
            "not_eligible": "insufficient_usage",
            "usage_required": "insufficient_usage",
            "account_inactive": "account_inactive",
            "inactive": "account_inactive",
            "user_inactive": "account_inactive",
            "check_in_inactive": "account_inactive",
            "check_in_account_inactive": "account_inactive",
            "service_unavailable": "service_unavailable",
            "unavailable": "service_unavailable",
            "check_in_unavailable": "service_unavailable",
        }
        if raw_status:
            return status_aliases.get(raw_status, raw_status)

        # A few older deployments returned only ``message_key``.  Recognize
        # those values before falling back to the legacy booleans.
        message_key = str(payload.get("message_key") or "").strip().casefold()
        message_key_aliases = {
            "check_in_success": "success",
            "already_checked_in": "already_checked_in",
            "check_in_disabled": "disabled",
            "check_in_insufficient_usage": "insufficient_usage",
            "check_in_inactive": "account_inactive",
            "check_in_account_inactive": "account_inactive",
            "check_in_unavailable": "service_unavailable",
        }
        if message_key in message_key_aliases:
            return message_key_aliases[message_key]
        if payload.get("checked_in") is True:
            return "success"
        if payload.get("already_checked_in") is True:
            return "already_checked_in"
        # Legacy responses used checked_in=false for the duplicate case and
        # did not include a status field at all.
        if not raw_status:
            return "already_checked_in"
        return raw_status

    @classmethod
    def _format_check_in_usage_shortfall(cls, payload: Mapping[str, Any]) -> str:
        usage_requirement = str(payload.get("usage_requirement") or "tokens").strip().casefold()
        if usage_requirement == "amount":
            summary = "今日消费金额不足"
            today_key, required_key = "today_amount", "required_amount"
            today = f"${cls._format_check_in_money(payload.get(today_key))}"
            required = f"${cls._format_check_in_money(payload.get(required_key))}"
        else:
            summary = "今日 Token 使用量不足"
            today_key, required_key = "today_tokens", "required_tokens"
            today = _format_number(payload.get(today_key))
            required = _format_number(payload.get(required_key))
        if payload.get(today_key) is not None or payload.get(required_key) is not None:
            summary += f"（{today}/{required}）"
        return (
            f"{summary}，"
            "达到签到要求后才可以领取。\n"
            "签到状态：insufficient_usage"
        )

    @staticmethod
    def _format_check_in_statistics(payload: Mapping[str, Any]) -> str:
        def count(key: str) -> str | None:
            value = _number(payload.get(key))
            if value is None or not value.is_integer() or value < 0:
                return None
            return str(int(value))

        month_checked = count("month_checked_days")
        month_total = count("month_total_days")
        week_checked = count("week_checked_days")
        consecutive = count("consecutive_days")
        unavailable = "暂无数据"
        month = (
            f"{month_checked}/{month_total}天"
            if month_checked is not None and month_total is not None
            else unavailable
        )
        week = f"{week_checked}/7天" if week_checked is not None else unavailable
        streak = f"{consecutive}天" if consecutive is not None else unavailable
        return f"本月签到：{month}\n本周签到：{week}\n连续签到：{streak}"

    @classmethod
    def _format_check_in_result(cls, payload: Mapping[str, Any]) -> str:
        """Turn every successful API response into a distinct bot reply.

        ``status`` is deliberately included in the reply so downstream bot
        handlers can distinguish a disabled feature, an ineligible user and a
        duplicate check-in without guessing from reward values.
        """

        status = cls._check_in_status(payload)
        reward = cls._format_check_in_money(payload.get("reward"))
        if status == "success":
            return (
                f"赠送金额：${reward}\n"
                f"{cls._format_check_in_statistics(payload)}\n"
                "签到状态：success"
            )
        if status == "already_checked_in":
            return (
                f"今日已签到\n已领取金额：${reward}\n"
                f"{cls._format_check_in_statistics(payload)}\n"
                "签到状态：already_checked_in"
            )
        if status == "disabled":
            return "签到功能当前未开启，请联系网站管理员。\n签到状态：disabled"
        if status == "insufficient_usage":
            return cls._format_check_in_usage_shortfall(payload)
        if status == "account_inactive":
            return "绑定的网站账号已停用，暂时无法签到，请联系网站管理员。\n签到状态：account_inactive"
        if status == "service_unavailable":
            return "签到服务暂时不可用，请稍后重试。\n签到状态：service_unavailable"
        return f"签到失败（状态：{status}），请稍后重试。\n签到状态：{status}"

    @classmethod
    def _friendly_check_in_error(cls, error: Exception) -> str:
        if not isinstance(error, KinghtAPIError):
            return "签到失败，请稍后重试。\n签到状态：service_unavailable"
        code = str(error.code or "").strip().upper()
        metadata = error.metadata if isinstance(error.metadata, Mapping) else {}
        metadata_status = str(metadata.get("status") or "").strip().casefold()
        if code == "ACCOUNT_NOT_BOUND":
            return "当前用户尚未绑定网站账号，请先发送 /绑定账号 <绑定码>。\n签到状态：not_bound"
        duplicate_code = code in {
            "ALREADY_CHECKED_IN",
            "ALREADY_CHECK_IN",
            "CHECK_IN_ALREADY",
            "BOT_CHECKIN_ALREADY_CHECKED_IN",
            "TODAY_CHECKED_IN",
            "TODAY_ALREADY_CHECKED_IN",
            "DUPLICATE_CHECK_IN",
        } or (
            ("ALREADY" in code or "DUPLICATE" in code)
            and ("CHECK" in code or "SIGN" in code)
        )
        duplicate_message = any(
            marker in str(error.message or "").casefold()
            for marker in ("今日已签到", "已签到", "already checked in", "already signed in")
        )
        if (
            duplicate_code
            or duplicate_message
            or metadata_status in {"already_checked_in", "already_check_in", "duplicate_check_in"}
            or error.status_code == 409
        ):
            return "今日已签到\n签到状态：already_checked_in"
        if metadata_status == "disabled" or code in {"BOT_CHECKIN_DISABLED", "CHECK_IN_DISABLED"}:
            return "签到功能当前未开启，请联系网站管理员。\n签到状态：disabled"
        if code in {
            "BOT_CHECKIN_USAGE_REQUIRED",
            "BOT_CHECKIN_INSUFFICIENT_USAGE",
            "CHECK_IN_INSUFFICIENT_USAGE",
        } or metadata_status == "insufficient_usage":
            return cls._format_check_in_usage_shortfall(metadata)
        if metadata_status == "account_inactive" or code in {
            "BOT_BINDING_ACCOUNT_INACTIVE",
            "ACCOUNT_INACTIVE",
            "USER_INACTIVE",
        }:
            return "绑定的网站账号已停用，暂时无法签到，请联系网站管理员。\n签到状态：account_inactive"
        if metadata_status in {"service_unavailable", "unavailable"} or code in {
            "BOT_CHECKIN_UNAVAILABLE",
            "BOT_BINDING_UNAVAILABLE",
        }:
            return "签到服务暂时不可用，请稍后重试。\n签到状态：service_unavailable"
        if metadata_status in {"binding_invalid", "invalid_binding"} or code in {
            "BOT_BINDING_INVALID",
            "BOT_BINDING_NOT_FOUND",
            "TOKEN_REVOKED",
        }:
            return "网站账号绑定已失效，请重新生成绑定码并绑定。\n签到状态：binding_invalid"
        if metadata_status in {"unauthorized", "authentication_required"} or code in {
            "BOT_AUTH_REQUIRED",
            "AUTHENTICATION_REQUIRED",
        }:
            return "签到请求未通过网站授权，请重新绑定网站账号后再试。\n签到状态：unauthorized"
        if code == "INVALID_ADMIN_KEY":
            return "插件未配置或配置的网站管理员 API Key 无效，请联系管理员检查插件配置。\n签到状态：configuration_error"
        if code in {"UNAUTHORIZED", "AUTHORIZATION_REQUIRED"}:
            return "签到请求未通过网站授权，请重新绑定网站账号后再试。\n签到状态：unauthorized"
        if code in {"INVALID_RESPONSE", "MALFORMED_RESPONSE"}:
            return "网站返回的签到数据无法识别，请联系网站管理员。\n签到状态：invalid_response"
        if error.status_code == 401:
            return "网站账号绑定已失效，请重新生成绑定码并绑定。\n签到状态：binding_invalid"
        if error.status_code == 403:
            return "当前账号不能签到，请联系网站管理员。\n签到状态：forbidden"
        if error.status_code == 429:
            return "签到请求过于频繁，请稍后再试。\n签到状态：rate_limited"
        if error.status_code == 503:
            return "签到服务暂时不可用，请稍后重试。\n签到状态：service_unavailable"
        if error.status_code is not None and 500 <= error.status_code < 600:
            return f"签到服务出错（HTTP {error.status_code}），请稍后再试。\n签到状态：server_error"
        if error.status_code is not None:
            return f"签到失败（HTTP {error.status_code}）。\n签到状态：http_error"
        if "超时" in error.message:
            return "签到请求超时，请稍后重试。\n签到状态：timeout"
        if "连接" in error.message or "网络" in error.message:
            return "无法连接网站，请稍后重试。\n签到状态：network_error"
        if "无法解析" in error.message:
            return "网站返回的签到数据无法解析，请联系网站管理员。\n签到状态：invalid_response"
        return "签到失败，请稍后重试。\n签到状态：service_unavailable"

    @staticmethod
    def _friendly_balance_alert_error(error: Exception) -> str:
        if not isinstance(error, KinghtAPIError):
            return "查询余额预警失败，请稍后重试。\n余额预警状态：service_unavailable"
        code = str(error.code or "").strip().upper()
        metadata = error.metadata if isinstance(error.metadata, Mapping) else {}
        metadata_status = str(metadata.get("status") or "").strip().casefold()
        if code == "INVALID_ADMIN_KEY":
            return "插件未配置或配置的网站管理员 API Key 无效，请联系管理员检查插件配置。\n余额预警状态：configuration_error"
        if metadata_status in {"binding_invalid", "invalid_binding"}:
            return "网站账号绑定已失效，请重新生成绑定码并绑定。\n余额预警状态：binding_invalid"
        if metadata_status in {"binding_not_found", "not_found"}:
            return "网站没有找到当前机器人绑定记录，请重新绑定网站账号。\n余额预警状态：binding_not_found"
        if metadata_status in {"unauthorized", "authentication_required"}:
            return "网站账号认证已失效，请重新生成绑定码并绑定。\n余额预警状态：unauthorized"
        if metadata_status in {"account_inactive", "inactive"}:
            return "绑定的网站账号已停用，请联系网站管理员。\n余额预警状态：account_inactive"
        if metadata_status in {"forbidden", "permission_denied"}:
            return "当前绑定没有访问 QQ 余额预警的权限。\n余额预警状态：forbidden"
        if metadata_status in {"rate_limited", "too_many_requests"}:
            return "余额预警查询过于频繁，请稍后再试。\n余额预警状态：rate_limited"
        if metadata_status in {"service_unavailable", "unavailable"}:
            return "网站机器人绑定服务暂时不可用，请稍后重试。\n余额预警状态：service_unavailable"
        if code in {"INVALID_AUTH_HEADER", "EMPTY_TOKEN", "BOT_BINDING_INVALID", "TOKEN_REVOKED"}:
            return "网站账号绑定已失效，请重新生成绑定码并绑定。\n余额预警状态：binding_invalid"
        if code in {"BOT_BINDING_NOT_FOUND"}:
            return "网站没有找到当前机器人绑定记录，请重新绑定网站账号。\n余额预警状态：binding_not_found"
        if code in {"UNAUTHORIZED", "AUTHORIZATION_REQUIRED", "BOT_AUTH_REQUIRED"}:
            return "网站账号认证已失效，请重新生成绑定码并绑定。\n余额预警状态：unauthorized"
        if code in {"USER_NOT_FOUND"}:
            return "网站账号已不存在或绑定已失效，请重新绑定网站账号。\n余额预警状态：binding_invalid"
        if code in {"USER_INACTIVE", "BOT_BINDING_ACCOUNT_INACTIVE"}:
            return "绑定的网站账号已停用，请联系网站管理员。\n余额预警状态：account_inactive"
        if code in {"BOT_BINDING_UNAVAILABLE", "USER_UNAVAILABLE"}:
            return "网站机器人绑定服务暂时不可用，请稍后重试。\n余额预警状态：service_unavailable"
        if code in {"INVALID_RESPONSE", "MALFORMED_RESPONSE"}:
            return "网站返回的余额预警设置无法识别，请联系网站管理员。\n余额预警状态：invalid_response"
        if error.status_code == 401:
            return "网站账号绑定已失效，请重新生成绑定码并绑定。\n余额预警状态：binding_invalid"
        if error.status_code == 403:
            return "当前绑定没有访问 QQ 余额预警的权限。\n余额预警状态：forbidden"
        if error.status_code == 400:
            return "余额预警请求参数有误，请稍后重试。\n余额预警状态：invalid_request"
        if error.status_code == 404:
            return "网站暂未启用 QQ 余额预警接口，请联系网站管理员。\n余额预警状态：not_found"
        if error.status_code == 429:
            return "余额预警查询过于频繁，请稍后再试。\n余额预警状态：rate_limited"
        if error.status_code == 503:
            return "网站余额预警服务暂时不可用，请稍后再试。\n余额预警状态：service_unavailable"
        if error.status_code is not None and 500 <= error.status_code < 600:
            return f"网站余额预警服务出错（HTTP {error.status_code}），请稍后再试。\n余额预警状态：server_error"
        if error.status_code is not None:
            return f"查询余额预警失败（HTTP {error.status_code}）。\n余额预警状态：http_error"
        if "超时" in error.message:
            return "查询余额预警超时，请稍后重试。\n余额预警状态：timeout"
        if "连接" in error.message or "网络" in error.message:
            return "无法连接网站，请稍后重试。\n余额预警状态：network_error"
        if "无法解析" in error.message:
            return "网站返回的余额预警数据无法解析，请联系网站管理员。\n余额预警状态：invalid_response"
        return "查询余额预警失败，请稍后重试。\n余额预警状态：service_unavailable"

    @staticmethod
    def _friendly_account_error(error: Exception, operation: str = "查询网站账号用量") -> str:
        """把站点错误翻译成可直接反馈给用户的原因，便于定位问题。"""

        if not isinstance(error, KinghtAPIError):
            return f"{operation}失败，请稍后重试。\n账号状态：service_unavailable"
        status = error.status_code
        code = str(error.code or "").strip()
        code_upper = code.upper()
        metadata = error.metadata if isinstance(error.metadata, Mapping) else {}
        metadata_status = str(metadata.get("status") or "").strip().casefold()
        if code.casefold() == "account_not_bound":
            return "当前用户尚未绑定网站账号，请先发送 /绑定账号 <绑定码>。\n账号状态：not_bound"
        if metadata_status in {"not_bound", "account_not_bound"}:
            return "当前用户尚未绑定网站账号，请先发送 /绑定账号 <绑定码>。\n账号状态：not_bound"
        if metadata_status in {"binding_invalid", "invalid_binding"}:
            return "网站账号绑定已失效，请重新生成绑定码并绑定。\n账号状态：binding_invalid"
        if metadata_status in {"binding_not_found"}:
            return "网站没有找到当前机器人绑定记录，请重新绑定网站账号。\n账号状态：binding_not_found"
        if metadata_status in {"unauthorized", "authentication_required"}:
            return "网站账号认证已失效，请重新生成绑定码并绑定。\n账号状态：unauthorized"
        if metadata_status in {"account_inactive", "inactive"}:
            return "绑定的网站账号已停用，请联系网站管理员。\n账号状态：account_inactive"
        if metadata_status in {"forbidden", "permission_denied"}:
            return f"{operation}被网站拒绝，请检查绑定权限。\n账号状态：forbidden"
        if metadata_status in {"rate_limited", "too_many_requests"}:
            return f"{operation}过于频繁，网站已限流，请稍后再试。\n账号状态：rate_limited"
        if metadata_status in {"service_unavailable", "unavailable"}:
            return f"网站服务暂时不可用，请稍后重试或联系网站管理员。\n账号状态：service_unavailable"
        if code_upper == "BOT_BINDING_CODE_INVALID":
            return "绑定码无效、已过期或已使用，请回网站重新生成绑定码后再试。\n账号状态：binding_code_invalid"
        if code_upper == "BOT_BINDING_PLATFORM_REQUIRED":
            return "无法识别聊天平台，请在 QQ 私聊或群聊中重新发送绑定命令。\n账号状态：platform_required"
        if code_upper == "BOT_BINDING_EXTERNAL_ID_REQUIRED":
            return "无法识别当前 QQ 用户，请在 QQ 私聊或群聊中重新发送绑定命令。\n账号状态：external_id_required"
        if code_upper == "BOT_BINDING_LIMIT_REACHED":
            return "该网站账号的机器人绑定数量已达到上限，请先在网站撤销旧绑定。\n账号状态：binding_limit_reached"
        if code_upper == "BOT_BINDING_ACCOUNT_INACTIVE":
            return "网站账号已停用，无法使用机器人绑定，请联系网站管理员。\n账号状态：account_inactive"
        if code_upper == "BOT_BINDING_NOT_FOUND":
            return "网站没有找到当前机器人绑定记录，请重新绑定网站账号。\n账号状态：binding_not_found"
        if code_upper == "BOT_BINDING_UNAVAILABLE":
            return "网站机器人绑定服务暂时不可用，请稍后重试。\n账号状态：service_unavailable"
        if code_upper == "INVALID_ADMIN_KEY":
            return "插件未配置或配置的网站管理员 API Key 无效，请联系管理员检查插件配置。\n账号状态：configuration_error"
        if code_upper in {"INVALID_AUTH_HEADER", "EMPTY_TOKEN", "BOT_BINDING_INVALID", "TOKEN_REVOKED"}:
            return "网站账号绑定已失效，请重新生成绑定码并绑定。\n账号状态：binding_invalid"
        if code_upper in {"UNAUTHORIZED", "AUTHORIZATION_REQUIRED", "BOT_AUTH_REQUIRED"}:
            return "网站账号认证已失效，请重新生成绑定码并绑定。\n账号状态：unauthorized"
        if code_upper in {"USER_NOT_FOUND"}:
            return "网站账号已不存在或绑定已失效，请重新绑定网站账号。\n账号状态：binding_invalid"
        if code_upper in {"BOT_BINDING_INVALID", "TOKEN_REVOKED", "EMPTY_TOKEN", "INVALID_AUTH_HEADER"} or status == 401:
            return "网站账号绑定已失效，请重新生成绑定码并绑定。\n账号状态：binding_invalid"
        if code_upper in {"USER_INACTIVE", "BOT_BINDING_ACCOUNT_INACTIVE"}:
            return "绑定的网站账号已被停用，请联系网站管理员。\n账号状态：account_inactive"
        if code_upper in {"USER_UNAVAILABLE", "BOT_BINDING_UNAVAILABLE"}:
            return "网站账号服务暂时不可用，请稍后重试。\n账号状态：service_unavailable"
        if code_upper in {"INVALID_RESPONSE", "MALFORMED_RESPONSE"}:
            return f"{operation}返回数据无法识别，请联系网站管理员。\n账号状态：invalid_response"
        if status == 400:
            return f"{operation}参数有误，请检查命令格式或绑定码。\n账号状态：invalid_request"
        if status == 403:
            return f"{operation}被网站拒绝（HTTP 403），请检查绑定权限。\n账号状态：forbidden"
        if status == 404:
            return f"网站暂未启用{operation}接口，请联系管理员。\n账号状态：not_found"
        if status == 429:
            return f"{operation}过于频繁，网站已限流，请稍后再试。\n账号状态：rate_limited"
        if status == 503:
            return f"网站服务暂时不可用（HTTP 503），请稍后再试或联系网站管理员。\n账号状态：service_unavailable"
        if status is not None and 500 <= status < 600:
            return f"网站服务器出错（HTTP {status}），请稍后再试或联系网站管理员。\n账号状态：server_error"
        if status is not None:
            return f"{operation}失败（HTTP {status}）。\n账号状态：http_error"
        if "超时" in error.message:
            return f"{operation}超时，请稍后重试。\n账号状态：timeout"
        if "连接" in error.message or "网络" in error.message:
            return f"无法连接网站，请稍后重试。\n账号状态：network_error"
        if "无法解析" in error.message:
            return f"网站返回的不是 JSON 数据，可能被网关拦截，请联系网站管理员。\n账号状态：invalid_response"
        return f"{operation}失败，请稍后重试。\n账号状态：service_unavailable"

    @HookHandler(
        "chat.receive.after_process",
        name="route_custom_triggers",
        description="将插件配置中的自定义触发词转换为标准命令",
    )
    async def handle_custom_triggers(self, message: Any = None, **kwargs: Any):
        """在 MaiBot 命令匹配前处理自定义触发词。"""

        del kwargs
        if not isinstance(message, dict):
            return None
        original_text = _text(message.get("processed_plain_text"), "").strip()
        rewritten_text = self._rewrite_custom_trigger_text(original_text)
        if not rewritten_text or rewritten_text == original_text:
            return None
        modified_message = dict(message)
        modified_message["processed_plain_text"] = rewritten_text
        return {
            "action": "continue",
            "modified_kwargs": {"message": modified_message},
        }

    @Command(
        "channel_status",
        description="查询网站渠道状态",
        pattern=r"^/渠道状态(?:\s+(?P<group_keyword>.+))?$",
    )
    async def handle_channel_status(self, stream_id: str = "", **kwargs: Any):
        if not self._command_enabled("enable_channel_status"):
            return True, None, False
        stream_id = stream_id or _text(kwargs.get("stream_id"), "")
        permission_error = self._permission_error(stream_id, kwargs)
        if permission_error:
            return await self._send(stream_id, permission_error, success=False, kwargs=kwargs)
        group_keyword = self._groups(kwargs).get("group_keyword", "")
        try:
            payload = await self._channel_data(_text(group_keyword, ""))
            return await self._send(
                stream_id,
                self._format_channels(payload, _text(group_keyword, "")),
                kwargs=kwargs,
            )
        except Exception as exc:
            return await self._send(stream_id, self._friendly_error(exc), success=False, kwargs=kwargs)

    @Command(
        "first_token_status",
        description="查询网站首 Token 状态",
        pattern=r"^/(?:首字状态|首Token状态)(?:\s+(?P<group_keyword>.+))?$",
    )
    async def handle_first_token_status(self, stream_id: str = "", **kwargs: Any):
        if not self._command_enabled("enable_first_token_status"):
            return True, None, False
        stream_id = stream_id or _text(kwargs.get("stream_id"), "")
        permission_error = self._permission_error(stream_id, kwargs)
        if permission_error:
            return await self._send(stream_id, permission_error, success=False, kwargs=kwargs)
        group_keyword = _text(self._groups(kwargs).get("group_keyword"), "")
        try:
            configured_source = _text(getattr(self.config, "first_token_source", "public"), "public")
            source_override = (
                configured_source
                if configured_source.casefold() not in {"admin", "admin_overview", "overview", "models", "admin_models"}
                or self._is_admin_user(stream_id, kwargs)
                else "public"
            )
            datasets = await self._first_token_data(group_keyword, source_override=source_override)
            if not datasets:
                message = f"⚡ 首字（首 Token）状态｜分组：{group_keyword}\n未找到匹配的分组。"
            else:
                messages = []
                for payload, time_range, source, group_name in datasets:
                    messages.append(
                        self._format_model_first_token(payload, time_range, group_name or group_keyword)
                        if source == "admin_models"
                        else self._format_first_token(payload, time_range, group_name or group_keyword)
                    )
                message = "\n\n".join(messages)
            return await self._send(stream_id, message, kwargs=kwargs)
        except Exception as exc:
            return await self._send(stream_id, self._friendly_error(exc), success=False, kwargs=kwargs)

    @Command(
        "kinght_status",
        description="查询网站渠道监控状态",
        pattern=r"^/站点状态(?:\s+(?P<range>90m|24h|7d|30d))?$",
    )
    async def handle_site_status(self, stream_id: str = "", **kwargs: Any):
        if not self._command_enabled("enable_site_status"):
            return True, None, False
        stream_id = stream_id or _text(kwargs.get("stream_id"), "")
        permission_error = self._permission_error(stream_id, kwargs)
        if permission_error:
            return await self._send(stream_id, permission_error, success=False, kwargs=kwargs)
        requested_range = _text(self._groups(kwargs).get("range"), "90m")
        try:
            payload = await self._channel_data(time_range=requested_range)
            message = self._format_channels(payload, time_range=requested_range)
        except Exception as exc:
            message = f"📡 渠道监控\n{self._friendly_error(exc)}"
        return await self._send(stream_id, message, kwargs=kwargs)


def create_plugin() -> KinghtStatusPlugin:
    """创建插件实例。"""

    return KinghtStatusPlugin()
