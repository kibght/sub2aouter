"""客户端状态接口访问层。

这个模块只依赖 Python 标准库，方便直接放进 MaiBot 插件目录使用。
"""

from __future__ import annotations

import asyncio
import functools
import json
from dataclasses import dataclass
from typing import Any, Callable, Mapping
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit, urlunsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


@dataclass
class KinghtAPIError(Exception):
    """站点 API 请求失败。"""

    message: str
    status_code: int | None = None
    code: str | int | None = None
    # Sub2API 的错误信封会在 metadata.status 中返回业务状态，例如
    # ``insufficient_usage``。保留该字段，供机器人按业务状态回复。
    metadata: Mapping[str, Any] | None = None

    def __str__(self) -> str:
        if self.status_code is None:
            return self.message
        return f"HTTP {self.status_code}: {self.message}"


def normalize_base_url(value: str) -> str:
    """将用户输入的站点地址转换为 API 根地址。"""

    value = (value or "").strip().rstrip("/")
    if not value:
        value = "https://api.kinght.top"
    if value.endswith("/api/v1"):
        return value
    if value.endswith("/api"):
        return f"{value}/v1"
    return f"{value}/api/v1"


def _envelope_data(payload: Any) -> Any:
    """解析 Sub2API 的 response.Success 包装。"""

    if isinstance(payload, dict) and "code" in payload:
        code = payload.get("code")
        if code not in (0, "0", None):
            normalized_code = str(code).strip().casefold()
            status_code = 401 if normalized_code in {
                "401",
                "unauthorized",
                "authentication_required",
                "token_expired",
            } else None
            if status_code is None and normalized_code.isdigit():
                numeric_code = int(normalized_code)
                if 100 <= numeric_code <= 599:
                    status_code = numeric_code
            raise KinghtAPIError(
                str(payload.get("message") or payload.get("reason") or payload.get("detail") or "站点接口返回失败"),
                status_code=status_code,
                code=payload.get("reason") or code,
                metadata=_payload_metadata(payload),
            )
        if "data" in payload:
            return payload.get("data")
    return payload


def _payload_metadata(payload: Any) -> Mapping[str, Any] | None:
    """读取最新 Sub2API 错误信封中的业务元数据。"""

    if not isinstance(payload, Mapping):
        return None
    metadata = payload.get("metadata")
    if isinstance(metadata, Mapping):
        return dict(metadata)
    return None


class _NoRedirectHandler(HTTPRedirectHandler):
    """Prevent credentials from being forwarded to a redirect target."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class KinghtAPIClient:
    """调用 api.kinght.top 的用户和管理员状态接口。"""

    def __init__(
        self,
        base_url: str = "https://api.kinght.top/api/v1",
        email: str = "",
        password: str = "",
        timeout: float = 10.0,
        access_token: str = "",
        refresh_token: str = "",
        bot_token: str = "",
        bot_binding_token: str = "",
        admin_api_key: str = "",
        on_tokens_updated: Callable[[str, str], None] | None = None,
    ) -> None:
        self.base_url = normalize_base_url(base_url)
        self.email = (email or "").strip()
        self.password = password or ""
        # 绑定账号令牌使用独立请求头，避免被误认为网站 JWT；兼容旧服务端
        # 返回 access_token 的响应格式。
        self.bot_binding_token = (bot_binding_token or bot_token or "").strip()
        # Sub2API 的机器人路由同时要求管理员认证和 Bot 绑定认证。
        # 管理员 API Key 使用独立的 x-api-key 头，避免覆盖 Authorization: Bot。
        self.admin_api_key = (admin_api_key or "").strip()
        self.access_token = (access_token or "").strip()
        self.refresh_token = (refresh_token or "").strip()
        self.on_tokens_updated = on_tokens_updated
        self.timeout = max(1.0, min(float(timeout), 60.0))
        self._auth_lock = asyncio.Lock()

        parsed = urlsplit(self.base_url)
        api_path = parsed.path.rstrip("/")
        if api_path.endswith("/api/v1"):
            api_path = api_path[: -len("/api/v1")]
        elif api_path.endswith("/api"):
            api_path = api_path[: -len("/api")]
        self.root_url = urlunsplit((parsed.scheme, parsed.netloc, api_path or "/", "", "")).rstrip("/")

    def _build_url(self, path: str, *, root: bool = False) -> str:
        if path.startswith(("http://", "https://")):
            return path
        base = self.root_url if root else self.base_url
        return f"{base}/{path.lstrip('/')}"

    @staticmethod
    def _parse_json(raw: bytes) -> Any:
        if not raw:
            return {}
        try:
            return json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise KinghtAPIError("站点返回了无法解析的数据") from exc

    @staticmethod
    def _error_from_payload(payload: Any, fallback: str) -> tuple[str, str | int | None]:
        if isinstance(payload, dict):
            message = (
                payload.get("message")
                or payload.get("reason")
                or payload.get("error")
                or payload.get("detail")
            )
            code = payload.get("reason") or payload.get("code")
            if isinstance(message, str) and message.strip():
                return message.strip(), code
        return fallback, None

    def _request_sync(
        self,
        method: str,
        path: str,
        *,
        params: Mapping[str, Any] | None = None,
        payload: Any = None,
        include_auth: bool = True,
        root: bool = False,
    ) -> Any:
        url = self._build_url(path, root=root)
        if params:
            query = [(key, value) for key, value in params.items() if value is not None and value != ""]
            if query:
                url = f"{url}?{urlencode(query, doseq=True)}"

        headers = {
            "Accept": "application/json",
            "Accept-Language": "zh-CN,zh;q=0.9",
            "User-Agent": "MaiBot-KinghtStatus/1.4.12",
        }
        if include_auth and self.bot_binding_token:
            headers["Authorization"] = f"Bot {self.bot_binding_token}"
        elif include_auth and self.access_token:
            headers["Authorization"] = f"Bearer {self.access_token}"
        if include_auth and self.admin_api_key:
            headers["x-api-key"] = self.admin_api_key

        body: bytes | None = None
        if payload is not None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            headers["Content-Type"] = "application/json"

        request = Request(url, data=body, headers=headers, method=method.upper())
        try:
            opener = build_opener(_NoRedirectHandler())
            with opener.open(request, timeout=self.timeout) as response:  # noqa: S310 - 站点地址由管理员配置
                status_code = int(getattr(response, "status", 200))
                parsed = self._parse_json(response.read())
        except HTTPError as exc:
            try:
                parsed = self._parse_json(exc.read())
            except Exception:
                parsed = {}
            message, code = self._error_from_payload(parsed, exc.reason or "站点请求失败")
            raise KinghtAPIError(
                message,
                status_code=exc.code,
                code=code,
                metadata=_payload_metadata(parsed),
            ) from exc
        except URLError as exc:
            reason = getattr(exc, "reason", None)
            raise KinghtAPIError(f"无法连接站点：{reason or '网络错误'}") from exc
        except TimeoutError as exc:
            raise KinghtAPIError("站点请求超时") from exc
        except OSError as exc:
            raise KinghtAPIError(f"站点请求失败：{exc}") from exc

        if status_code < 200 or status_code >= 300:
            message, code = self._error_from_payload(parsed, "站点请求失败")
            raise KinghtAPIError(
                message,
                status_code=status_code,
                code=code,
                metadata=_payload_metadata(parsed),
            )

        return _envelope_data(parsed)

    async def request_json(
        self,
        method: str,
        path: str,
        *,
        params: Mapping[str, Any] | None = None,
        payload: Any = None,
        include_auth: bool = True,
        root: bool = False,
        retry_auth: bool = True,
    ) -> Any:
        """异步请求 JSON，并在令牌失效时刷新或重新登录一次。"""

        auth_path = path.rstrip("/").endswith(("/auth/login", "/auth/refresh", "/auth/login/2fa"))
        if include_auth and not auth_path:
            await self._ensure_authenticated()
        failed_access_token = self.access_token

        try:
            call = functools.partial(
                self._request_sync,
                method,
                path,
                params=params,
                payload=payload,
                include_auth=include_auth,
                root=root,
            )
            # MaiBot 旧版运行环境可能仍是 Python 3.8，没有 asyncio.to_thread。
            if hasattr(asyncio, "to_thread"):
                return await asyncio.to_thread(call)
            loop = asyncio.get_running_loop()
            return await loop.run_in_executor(None, call)
        except KinghtAPIError as exc:
            # Bot binding tokens are scoped and cannot be refreshed through the
            # website JWT login flow. Let the caller remove an invalid binding.
            if include_auth and self.bot_binding_token:
                raise
            if include_auth and exc.status_code == 401 and retry_auth and not auth_path:
                await self._recover_auth(failed_access_token)
                return await self.request_json(
                    method,
                    path,
                    params=params,
                    payload=payload,
                    include_auth=include_auth,
                    root=root,
                    retry_auth=False,
                )
            raise

    def _ensure_secure_login_transport(self) -> None:
        parsed = urlsplit(self.base_url)
        if parsed.scheme == "https":
            return
        if parsed.scheme == "http" and parsed.hostname in {"localhost", "127.0.0.1", "::1"}:
            return
        raise KinghtAPIError("Account login requires an HTTPS API URL")

    async def _ensure_authenticated(self) -> None:
        if self.bot_binding_token or self.access_token or self.admin_api_key:
            return
        async with self._auth_lock:
            if self.access_token:
                return
            if self.refresh_token:
                try:
                    await self._refresh_access_token_unlocked()
                    return
                except KinghtAPIError as exc:
                    self.access_token = ""
                    self.refresh_token = ""
                    if not self.email or not self.password:
                        raise KinghtAPIError(
                            "Configured session tokens are expired or invalid",
                            code="session_tokens_invalid",
                        ) from exc
            await self._login_unlocked()

    async def _recover_auth(self, failed_access_token: str) -> None:
        if self.bot_binding_token:
            raise KinghtAPIError("机器人绑定令牌已失效", status_code=401, code="bot_binding_invalid")
        async with self._auth_lock:
            if self.access_token and self.access_token != failed_access_token:
                return
            if self.refresh_token:
                try:
                    await self._refresh_access_token_unlocked()
                    return
                except KinghtAPIError as exc:
                    self.access_token = ""
                    self.refresh_token = ""
                    if not self.email or not self.password:
                        raise KinghtAPIError(
                            "Configured session tokens are expired or invalid",
                            code="session_tokens_invalid",
                        ) from exc
            elif failed_access_token and (not self.email or not self.password):
                raise KinghtAPIError(
                    "Configured session tokens are expired or invalid",
                    code="session_tokens_invalid",
                )
            await self._login_unlocked()

    async def _login_unlocked(self) -> None:
        if not self.email or not self.password:
            raise KinghtAPIError("Account email and password are not configured", code="credentials_missing")
        self._ensure_secure_login_transport()
        data = await self.request_json(
            "POST",
            "/auth/login",
            payload={"email": self.email, "password": self.password},
            include_auth=False,
            retry_auth=False,
        )
        if isinstance(data, dict) and data.get("requires_2fa"):
            raise KinghtAPIError("Account requires two-factor verification", code="two_factor_required")
        if not isinstance(data, dict) or not data.get("access_token"):
            raise KinghtAPIError("Account login did not return an access token")
        self.access_token = str(data["access_token"])
        self.refresh_token = str(data.get("refresh_token") or "")
        self._notify_tokens_updated()

    async def refresh_access_token(self) -> None:
        """Refresh an access token in memory."""

        async with self._auth_lock:
            await self._refresh_access_token_unlocked()

    async def _refresh_access_token_unlocked(self) -> None:
        """Refresh an access token without reacquiring the authentication lock."""

        if not self.refresh_token:
            raise KinghtAPIError("No refresh token is available")
        data = await self.request_json(
            "POST",
            "/auth/refresh",
            payload={"refresh_token": self.refresh_token},
            include_auth=False,
            retry_auth=False,
        )
        if not isinstance(data, dict) or not data.get("access_token"):
            raise KinghtAPIError("Token refresh did not return an access token")
        self.access_token = str(data["access_token"])
        if data.get("refresh_token"):
            self.refresh_token = str(data["refresh_token"])
        self._notify_tokens_updated()

    def _notify_tokens_updated(self) -> None:
        if self.on_tokens_updated is not None:
            self.on_tokens_updated(self.access_token, self.refresh_token)

    async def get_health(self) -> Any:
        return await self.request_json("GET", "/health", include_auth=False, root=True)

    async def get_public_settings(self) -> Any:
        return await self.request_json("GET", "/settings/public", include_auth=False)

    async def redeem_bot_binding_code(
        self,
        code: str,
        platform: str,
        external_id: str,
    ) -> Any:
        """用网站个人中心生成的一次性绑定码兑换机器人会话令牌。"""

        return await self.request_json(
            "POST",
            "/admin/bot-bindings/redeem",
            payload={
                "code": str(code or "").strip(),
                "platform": str(platform or "").strip(),
                "external_id": str(external_id or "").strip(),
            },
            # 新版网站要求兑换接口也携带管理员认证；x-api-key 与 Bot
            # 绑定令牌分开传输，因此不会覆盖网站 JWT 或 Bot 头。
            include_auth=True,
            retry_auth=False,
        )

    async def revoke_bot_binding(self) -> Any:
        """撤销当前机器人账号绑定令牌。"""

        return await self.request_json("POST", "/admin/bot/unbind", payload={})

    async def check_in(self) -> Any:
        """为当前绑定账号签到并领取余额奖励。"""

        return await self.request_json("POST", "/admin/bot/check-in", payload={})

    async def get_bot_recharge_options(self) -> Any:
        return await self.request_json("GET", "/admin/bot/recharge/options")

    async def create_bot_recharge_order(self, amount: float, payment_type: str, request_id: str) -> Any:
        return await self.request_json(
            "POST",
            "/admin/bot/recharge/orders",
            payload={"amount": amount, "payment_type": payment_type, "request_id": request_id},
            retry_auth=False,
        )

    async def get_bot_recharge_order(self, order_id: int | str | None = None) -> Any:
        normalized_id = str(order_id or "").strip()
        path = f"/admin/bot/recharge/orders/{normalized_id}" if normalized_id else "/admin/bot/recharge/orders/latest"
        return await self.request_json("GET", path)

    async def get_bot_recharge_notifications(self) -> Any:
        return await self.request_json("GET", "/admin/bot/recharge/notifications")

    async def ack_bot_recharge_notification(self, notification_id: int | str) -> Any:
        normalized_id = str(notification_id or "").strip()
        if not normalized_id:
            raise ValueError("充值通知 ID 不能为空")
        return await self.request_json(
            "POST", f"/admin/bot/recharge/notifications/{normalized_id}/ack", payload={}
        )

    async def get_lottery(self) -> Any:
        return await self.request_json("GET", "/admin/bot/lottery")

    async def draw_lottery(self, request_id: str) -> Any:
        return await self.request_json(
            "POST", "/admin/bot/lottery/draw", payload={"request_id": request_id}, retry_auth=False
        )

    async def get_lottery_records(self) -> Any:
        return await self.request_json("GET", "/admin/bot/lottery/records")

    async def grant_lottery_plays(
        self, target: str, count: int, notes: str, request_id: str
    ) -> Any:
        return await self.request_json(
            "POST",
            "/admin/bot/lottery/grants",
            payload={"target": target, "count": count, "notes": notes, "request_id": request_id},
            retry_auth=False,
        )

    async def get_lottery_grant_batch(self, batch_id: int | str) -> Any:
        normalized_id = str(batch_id or "").strip()
        if not normalized_id:
            raise ValueError("抽奖发放批次 ID 不能为空")
        return await self.request_json("GET", f"/admin/bot/lottery/grant-batches/{normalized_id}")

    async def get_balance_alerts(self) -> Any:
        """领取当前 QQ 绑定对应的待发送余额预警。"""

        return await self.request_json("GET", "/admin/bot/balance-alerts")

    async def ack_balance_alert(self, alert_id: int | str) -> Any:
        """确认当前 QQ 绑定已经成功发送一条余额预警。"""

        normalized_id = str(alert_id or "").strip()
        if not normalized_id:
            raise ValueError("余额预警 ID 不能为空")
        return await self.request_json("POST", f"/admin/bot/balance-alerts/{normalized_id}/ack", payload={})

    async def get_usage_dashboard_stats(self) -> Any:
        return await self.request_json("GET", "/admin/bot/usage/dashboard/stats")

    async def get_usage_stats(self, period: str = "month", timezone_name: str = "Asia/Shanghai") -> Any:
        return await self.request_json(
            "GET",
            "/admin/bot/usage/stats",
            params={"period": period, "timezone": timezone_name},
        )

    async def get_user_profile(self) -> Any:
        return await self.request_json("GET", "/admin/bot/profile")

    async def get_personal_info(self) -> Any:
        return await self.request_json("GET", "/admin/bot/personal-info")

    async def get_api_keys(self, page_size: int = 100) -> Any:
        """获取当前账号的 API Key 元数据，不读取或显示完整密钥。"""

        return await self.request_json(
            "GET",
            "/admin/bot/api-keys",
            params={"page": 1, "page_size": max(1, min(int(page_size), 100))},
        )

    async def get_api_keys_usage(self, api_key_ids: list[int | str]) -> Any:
        ids = [item for item in api_key_ids if item is not None and str(item).strip()]
        return await self.request_json(
            "POST",
            "/admin/bot/usage/dashboard/api-keys-usage",
            payload={"api_key_ids": ids},
        )

    async def get_api_key_daily_usage(
        self,
        api_key_id: int | str,
        days: int = 30,
        timezone_name: str = "Asia/Shanghai",
    ) -> Any:
        return await self.request_json(
            "GET",
            f"/admin/bot/user/api-keys/{api_key_id}/usage/daily",
            params={"days": max(1, min(int(days), 90)), "timezone": timezone_name},
        )

    async def get_available_groups(self) -> Any:
        """Return the groups visible to the authenticated user, including rate multipliers."""

        return await self.request_json("GET", "/groups/available")

    async def find_admin_user_by_email(self, email: str) -> bool:
        """按邮箱精确核对网站用户列表中的账号。"""

        normalized_email = str(email or "").strip().casefold()
        if not normalized_email:
            return False
        payload = await self.request_json(
            "GET",
            "/admin/users",
            params={"search": normalized_email, "page": 1, "page_size": 100},
        )
        if not isinstance(payload, Mapping):
            return False
        # Sub2API 当前返回分页 data.items；request_json 通常已经拆包，
        # 但保留嵌套解析以兼容旧版宿主或自定义 HTTP 适配器。
        data = payload.get("data") if isinstance(payload.get("data"), Mapping) else payload
        items = data.get("items") if isinstance(data, Mapping) else None
        if not isinstance(items, list):
            return False
        return any(
            isinstance(item, Mapping)
            and str(item.get("email") or "").strip().casefold() == normalized_email
            for item in items
        )

    async def get_channel_monitors(self) -> Any:
        return await self.request_json("GET", "/channel-monitors")

    async def get_channel_monitor_v2_snapshot(
        self,
        time_range: str = "24h",
        *,
        group_id: int | str | None = None,
        group_name: str = "",
    ) -> Any:
        params: dict[str, Any] = {"range": time_range}
        if group_id is not None and group_id != "":
            params["group_id"] = group_id
        if group_name.strip():
            params["group_name"] = group_name.strip()
        return await self.request_json(
            "GET",
            "/channel-monitor-v2/snapshot",
            params=params,
        )

    async def get_channel_monitor_v2_dimensions(self, time_range: str = "24h") -> Any:
        """Return the groups visible to the authenticated user."""

        return await self.request_json(
            "GET",
            "/channel-monitor-v2/dimensions",
            params={"range": time_range},
        )

    async def get_channel_monitor_v2_matrix(
        self,
        time_range: str = "24h",
        *,
        group_by: str = "platform_group",
    ) -> Any:
        """Return monitor metrics grouped by platform and group."""

        return await self.request_json(
            "GET",
            "/channel-monitor-v2/matrix",
            params={"range": time_range, "group_by": group_by},
        )

    async def get_admin_overview(
        self,
        time_range: str = "24h",
        *,
        group_id: int | str | None = None,
    ) -> Any:
        params: dict[str, Any] = {"time_range": time_range}
        if group_id is not None and group_id != "":
            params["group_id"] = group_id
        return await self.request_json(
            "GET",
            "/admin/ops/dashboard/overview",
            params=params,
        )

    async def get_admin_token_stats(
        self,
        time_range: str = "1d",
        top_n: int = 10,
        *,
        group_id: int | str | None = None,
    ) -> Any:
        params: dict[str, Any] = {
            "time_range": time_range,
            "top_n": top_n,
            "page": 1,
            "page_size": top_n,
        }
        if group_id is not None and group_id != "":
            params["group_id"] = group_id
        return await self.request_json(
            "GET",
            "/admin/ops/dashboard/openai-token-stats",
            params=params,
        )

    async def get_admin_groups(self, search: str = "", page_size: int = 100) -> Any:
        """按分组名称查询管理员可见的分组。"""

        return await self.request_json(
            "GET",
            "/admin/groups",
            params={"search": search.strip(), "page": 1, "page_size": max(1, min(int(page_size), 100))},
        )
