import asyncio
import importlib.util
import json
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit


CLIENT_PATH = Path(__file__).parents[1] / "kinght_status_plugin" / "client.py"
SPEC = importlib.util.spec_from_file_location("kinght_status_client", CLIENT_PATH)
assert SPEC is not None and SPEC.loader is not None
client = importlib.util.module_from_spec(SPEC)
sys.modules["kinght_status_client"] = client
SPEC.loader.exec_module(client)


class _Handler(BaseHTTPRequestHandler):
    seen_auth = []
    seen_paths = []
    seen_login_payloads = []
    refresh_count = 0
    login_count = 0
    business_auth_failure_count = 0
    bot_unbind_count = 0
    check_in_count = 0
    balance_alert_ack_ids = []
    seen_admin_api_keys = []
    feature_requests = []

    def log_message(self, *_args):
        return

    def _feature_response(self, payload=None):
        if not self.path.startswith(("/api/v1/admin/bot/recharge/", "/api/v1/admin/bot/lottery")):
            return False
        self.__class__.feature_requests.append((self.command, self.path, payload))
        if self.headers.get("Authorization") != "Bot demo-bot-token" or self.headers.get("x-api-key") != "admin-secret":
            self._write(401, {"code": "BOT_BINDING_INVALID", "message": "invalid"})
        elif isinstance(payload, dict) and payload.get("request_id") == "uncertain":
            self._write(503, {"code": "RESULT_PENDING", "message": "unknown result"})
        else:
            self._write(200, {"code": 0, "data": {"path": self.path, "payload": payload}})
        return True

    def _write(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self.__class__.seen_auth.append(self.headers.get("Authorization"))
        self.__class__.seen_admin_api_keys.append(self.headers.get("x-api-key"))
        self.__class__.seen_paths.append(self.path)
        if self._feature_response():
            return
        if self.path.startswith("/api/v1/groups/available"):
            self._write(
                200,
                {
                    "code": 0,
                    "message": "success",
                    "data": [{"id": 7, "name": "OpenAI 分组", "rate_multiplier": 0.08}],
                },
            )
            return
        if self.path == "/api/v1/admin/bot/personal-info":
            if self.headers.get("Authorization") != "Bot demo-bot-token":
                self._write(401, {"code": "BOT_BINDING_INVALID", "message": "invalid"})
                return
            self._write(
                200,
                {"code": 0, "data": {
                    "id": 123,
                    "username": "member",
                    "balance": 12.5,
                    "concurrency": 10,
                    "current_concurrency": 2,
                    "current_rpm": 6,
                    "rpm_window_seconds": 60,
                }},
            )
            return
        if self.path.startswith("/api/v1/admin/bot/profile"):
            if self.headers.get("Authorization") != "Bot demo-bot-token":
                self._write(401, {"code": "BOT_TOKEN_INVALID", "message": "invalid"})
                return
            self._write(200, {"code": 0, "data": {"balance": 1.25}})
            return
        if self.path == "/api/v1/admin/bot/balance-alerts":
            if self.headers.get("Authorization") != "Bot demo-bot-token":
                self._write(401, {"code": "BOT_TOKEN_INVALID", "message": "invalid"})
                return
            self._write(
                200,
                {
                    "code": 0,
                    "data": {
                        "items": [
                            {
                                "id": 42,
                                "current_balance": 3.5,
                                "threshold": 5,
                                "site_name": "Example",
                                "recharge_url": "https://example.com/recharge",
                                "created_at": "2026-10-26T05:00:00Z",
                            }
                        ]
                    },
                },
            )
            return
        if self.path.startswith("/api/v1/channel-monitors"):
            if self.headers.get("Authorization") not in {"Bearer fresh-token", "Bearer login-token"}:
                self._write(401, {"code": "UNAUTHORIZED", "message": "expired"})
                return
            self._write(200, {"code": 0, "message": "success", "data": {"items": [{"name": "demo"}]}})
            return
        if self.path.startswith("/api/v1/business-auth-test"):
            self.__class__.business_auth_failure_count += 1
            if self.__class__.business_auth_failure_count == 1:
                self._write(200, {"code": "UNAUTHORIZED", "message": "expired", "data": None})
            else:
                self._write(200, {"code": 0, "data": {"ok": True}})
            return
        if self.path.startswith("/api/v1/admin/ops/dashboard/overview"):
            self._write(200, {"code": 0, "message": "success", "data": {"ttft": {"p50_ms": 100}}})
            return
        if self.path.startswith("/api/v1/admin/groups"):
            self._write(200, {"code": 0, "message": "success", "data": {"items": [{"id": 7, "name": "OpenAI 分组"}]}})
            return
        if self.path.startswith("/api/v1/admin/users"):
            search = parse_qs(urlsplit(self.path).query).get("search", [""])[0]
            self._write(
                200,
                {
                    "code": 0,
                    "message": "success",
                    "data": {
                        "items": ([{"id": 9, "email": "member@example.test", "username": "member"}]
                                  if search.casefold() == "member@example.test" else []),
                        "total": 1 if search.casefold() == "member@example.test" else 0,
                    },
                },
            )
            return
        if self.path.startswith("/api/v1/channel-monitor-v2/snapshot"):
            self._write(200, {"code": 0, "message": "success", "data": {"ttft": {"p50_ms": 120}}})
            return
        if self.path.startswith("/api/v1/channel-monitor-v2/dimensions"):
            self._write(200, {"code": 0, "message": "success", "data": {"groups": [{"id": 7, "name": "OpenAI 分组", "platform": "openai"}]}})
            return
        if self.path.startswith("/api/v1/channel-monitor-v2/matrix"):
            self._write(200, {"code": 0, "message": "success", "data": {"items": [{"group_id": 7, "group_name": "OpenAI 分组", "platform": "openai", "metrics": {"success_rate": 0.9, "cache_rate": 0.4, "ttft": {"p50_ms": 110}}}]}})
            return
        self._write(404, {"code": 404, "message": "missing"})

    def do_POST(self):
        self.__class__.seen_auth.append(self.headers.get("Authorization"))
        self.__class__.seen_admin_api_keys.append(self.headers.get("x-api-key"))
        raw = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        payload = json.loads(raw.decode("utf-8")) if raw else {}
        if self._feature_response(payload):
            return
        if self.path == "/api/v1/auth/login":
            self.__class__.login_count += 1
            self.__class__.seen_login_payloads.append(payload)
            if payload.get("email") == "2fa@example.test":
                self._write(
                    200,
                    {"code": 0, "data": {"requires_2fa": True, "temp_token": "temporary-token"}},
                )
                return
            if payload.get("email") != "member@example.test" or payload.get("password") != "test-pass":
                self._write(401, {"code": "INVALID_CREDENTIALS", "message": "invalid credentials"})
                return
            self._write(
                200,
                {
                    "code": 0,
                    "message": "success",
                    "data": {"access_token": "login-token", "refresh_token": "refresh-token"},
                },
            )
            return
        if self.path == "/api/v1/admin/bot-bindings/redeem":
            self._write(
                200,
                {
                    "code": 0,
                    "data": {
                        "access_token": "demo-bot-token",
                        "token_type": "Bot",
                        "expires_at": "2099-01-01T00:00:00Z",
                    },
                },
            )
            return
        if self.path == "/api/v1/admin/bot/unbind":
            if self.headers.get("Authorization") != "Bot demo-bot-token":
                self._write(401, {"code": "BOT_TOKEN_INVALID", "message": "invalid"})
                return
            self.__class__.bot_unbind_count += 1
            self._write(200, {"code": 0, "data": {"revoked": True}})
            return
        if self.path == "/api/v1/admin/bot/check-in":
            if self.headers.get("Authorization") != "Bot demo-bot-token":
                self._write(401, {"code": "BOT_TOKEN_INVALID", "message": "invalid"})
                return
            self.__class__.check_in_count += 1
            self._write(
                200,
                {
                    "code": 0,
                    "data": {
                        "checked_in": self.__class__.check_in_count == 1,
                        "reward": 0.18,
                        "balance": 1.43,
                        "streak_day": 3,
                        "month_checked_days": 12,
                        "month_total_days": 30,
                        "week_checked_days": 4,
                        "consecutive_days": 10,
                    },
                },
            )
            return
        if self.path.startswith("/api/v1/admin/bot/balance-alerts/") and self.path.endswith("/ack"):
            if self.headers.get("Authorization") != "Bot demo-bot-token":
                self._write(401, {"code": "BOT_TOKEN_INVALID", "message": "invalid"})
                return
            alert_path = self.path[len("/api/v1/admin/bot/balance-alerts/") :]
            alert_id = alert_path[: -len("/ack")].rstrip("/")
            self.__class__.balance_alert_ack_ids.append((alert_id, payload))
            self._write(200, {"code": 0, "data": {"acknowledged": True}})
            return
        if self.path == "/api/v1/auth/refresh":
            self.__class__.refresh_count += 1
            if payload.get("refresh_token") == "expired-refresh":
                self._write(401, {"code": "UNAUTHORIZED", "message": "expired refresh token"})
                return
            self._write(
                200,
                {"code": 0, "message": "success", "data": {"access_token": "fresh-token"}},
            )
            return
        self._write(404, {"code": 404, "message": "missing"})


class KinghtClientTests(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.thread.join(timeout=2)

    def setUp(self):
        _Handler.seen_auth = []
        _Handler.seen_paths = []
        _Handler.seen_login_payloads = []
        _Handler.refresh_count = 0
        _Handler.login_count = 0
        _Handler.business_auth_failure_count = 0
        _Handler.bot_unbind_count = 0
        _Handler.check_in_count = 0
        _Handler.balance_alert_ack_ids = []
        _Handler.seen_admin_api_keys = []
        _Handler.feature_requests = []

    def _api(self, **kwargs):
        return client.KinghtAPIClient(
            f"http://127.0.0.1:{self.server.server_port}/api/v1",
            **kwargs,
        )

    async def test_logs_in_with_email_and_password(self):
        api = self._api(email="member@example.test", password="test-pass")
        payload = await api.get_channel_monitors()
        self.assertEqual(payload["items"][0]["name"], "demo")
        self.assertEqual(_Handler.login_count, 1)
        self.assertEqual(
            _Handler.seen_login_payloads,
            [{"email": "member@example.test", "password": "test-pass"}],
        )
        self.assertEqual(api.access_token, "login-token")
        self.assertEqual(_Handler.seen_auth[-1], "Bearer login-token")

    async def test_refreshes_on_401_and_unwraps_envelope(self):
        api = self._api(
            email="member@example.test",
            password="test-pass",
        )
        api.access_token = "expired-token"
        api.refresh_token = "refresh-token"
        payload = await api.get_channel_monitors()
        self.assertEqual(payload["items"][0]["name"], "demo")
        self.assertEqual(api.access_token, "fresh-token")
        self.assertEqual(_Handler.refresh_count, 1)
        self.assertEqual(_Handler.seen_auth[-1], "Bearer fresh-token")

    async def test_configured_tokens_are_used_without_password_login(self):
        api = self._api(access_token="expired-token", refresh_token="refresh-token")
        payload = await api.get_channel_monitors()
        self.assertEqual(payload["items"][0]["name"], "demo")
        self.assertEqual(_Handler.login_count, 0)
        self.assertEqual(_Handler.refresh_count, 1)
        self.assertEqual(api.access_token, "fresh-token")

    def test_error_payload_preserves_turnstile_reason(self):
        message, code = client.KinghtAPIClient._error_from_payload(
            {
                "code": 400,
                "message": "turnstile verification failed",
                "reason": "TURNSTILE_VERIFICATION_FAILED",
            },
            "fallback",
        )
        self.assertEqual(message, "turnstile verification failed")
        self.assertEqual(code, "TURNSTILE_VERIFICATION_FAILED")

    def test_error_payload_preserves_sub2api_metadata_status(self):
        metadata = client._payload_metadata(
            {
                "code": 403,
                "message": "今日 token 使用量不足",
                "reason": "BOT_CHECKIN_USAGE_REQUIRED",
                "metadata": {"status": "insufficient_usage"},
            }
        )

        self.assertEqual(metadata, {"status": "insufficient_usage"})

    async def test_refresh_failure_falls_back_to_account_login(self):
        api = self._api(
            email="member@example.test",
            password="test-pass",
        )
        api.access_token = "expired-token"
        api.refresh_token = "expired-refresh"
        payload = await api.get_channel_monitors()
        self.assertEqual(payload["items"][0]["name"], "demo")
        self.assertEqual(_Handler.refresh_count, 1)
        self.assertEqual(_Handler.login_count, 1)
        self.assertEqual(api.access_token, "login-token")

    async def test_business_envelope_unauthorized_refreshes_session(self):
        api = self._api(email="member@example.test", password="test-pass")
        api.access_token = "expired-token"
        api.refresh_token = "refresh-token"
        payload = await api.request_json("GET", "/business-auth-test")
        self.assertTrue(payload["ok"])
        self.assertEqual(_Handler.refresh_count, 1)

    async def test_concurrent_requests_share_one_login(self):
        api = self._api(email="member@example.test", password="test-pass")
        results = await asyncio.gather(api.get_channel_monitors(), api.get_channel_monitors())
        self.assertEqual(len(results), 2)
        self.assertEqual(_Handler.login_count, 1)

    async def test_invalid_credentials_report_login_error(self):
        api = self._api(email="wrong@example.test", password="wrong-pass")
        with self.assertRaises(client.KinghtAPIError) as raised:
            await api.get_channel_monitors()
        self.assertEqual(raised.exception.status_code, 401)

    async def test_bot_binding_uses_scoped_bot_authorization(self):
        api = self._api(admin_api_key="admin-secret")
        claim = await api.redeem_bot_binding_code("ABCD2345", "qq", "42")
        api.bot_binding_token = claim["access_token"]
        profile = await api.get_user_profile()
        self.assertEqual(profile["balance"], 1.25)
        await api.revoke_bot_binding()
        self.assertEqual(_Handler.bot_unbind_count, 1)
        self.assertIn("Bot demo-bot-token", _Handler.seen_auth)
        self.assertEqual(_Handler.seen_admin_api_keys[-1], "admin-secret")
        self.assertIn("admin-secret", _Handler.seen_admin_api_keys)

    async def test_bot_feature_contract_uses_scoped_identity_for_every_endpoint(self):
        api = self._api(bot_binding_token="demo-bot-token", access_token="other-account-token", admin_api_key="admin-secret")
        results = [
            await api.get_bot_recharge_options(),
            await api.create_bot_recharge_order(10, "wxpay", "request-1"),
            await api.get_bot_recharge_order(),
            await api.get_bot_recharge_order(12),
            await api.get_bot_recharge_notifications(),
            await api.ack_bot_recharge_notification(2),
            await api.get_lottery(),
            await api.draw_lottery("request-2"),
            await api.get_lottery_records(),
            await api.grant_lottery_plays("all", 3, "周末活动", "request-3"),
            await api.get_lottery_grant_batch(7),
        ]
        self.assertEqual(len(results), 11)
        self.assertTrue(all(value == "Bot demo-bot-token" for value in _Handler.seen_auth))
        self.assertTrue(all(value == "admin-secret" for value in _Handler.seen_admin_api_keys))
        self.assertEqual(results[1]["payload"], {"amount": 10, "payment_type": "wxpay", "request_id": "request-1"})
        self.assertEqual(results[2]["path"], "/api/v1/admin/bot/recharge/orders/latest")
        self.assertEqual(results[9]["payload"], {"target": "all", "count": 3, "notes": "周末活动", "request_id": "request-3"})
        self.assertEqual(_Handler.login_count, 0)
        self.assertEqual(_Handler.refresh_count, 0)

    async def test_ambiguous_bot_feature_writes_are_never_automatically_retried(self):
        api = self._api(bot_binding_token="demo-bot-token", admin_api_key="admin-secret")
        for action in (
            lambda: api.create_bot_recharge_order(10, "alipay", "uncertain"),
            lambda: api.draw_lottery("uncertain"),
            lambda: api.grant_lottery_plays("all", 3, "", "uncertain"),
        ):
            with self.assertRaises(client.KinghtAPIError) as raised:
                await action()
            self.assertEqual(raised.exception.status_code, 503)
        self.assertEqual(len(_Handler.feature_requests), 3)
        self.assertEqual(_Handler.refresh_count, 0)

    async def test_personal_info_uses_bound_bot_authorization(self):
        api = self._api(
            bot_binding_token="demo-bot-token",
            access_token="other-account-token",
            admin_api_key="admin-secret",
        )

        profile = await api.get_personal_info()

        self.assertEqual(profile["id"], 123)
        self.assertEqual(profile["balance"], 12.5)
        self.assertEqual(profile["concurrency"], 10)
        self.assertEqual(profile["current_concurrency"], 2)
        self.assertEqual(profile["current_rpm"], 6)
        self.assertEqual(profile["rpm_window_seconds"], 60)
        self.assertEqual(_Handler.seen_paths, ["/api/v1/admin/bot/personal-info"])
        self.assertEqual(_Handler.seen_auth, ["Bot demo-bot-token"])
        self.assertEqual(_Handler.seen_admin_api_keys, ["admin-secret"])
        self.assertEqual(_Handler.login_count, 0)
        self.assertEqual(_Handler.refresh_count, 0)

    async def test_personal_info_preserves_binding_error_without_password_login(self):
        api = self._api(bot_binding_token="invalid-token")

        with self.assertRaises(client.KinghtAPIError) as raised:
            await api.get_personal_info()

        self.assertEqual(raised.exception.status_code, 401)
        self.assertEqual(raised.exception.code, "BOT_BINDING_INVALID")
        self.assertEqual(_Handler.login_count, 0)
        self.assertEqual(_Handler.refresh_count, 0)

    async def test_balance_alerts_use_bot_authorization_and_ack(self):
        api = self._api(bot_binding_token="demo-bot-token", admin_api_key="admin-secret")
        alerts = await api.get_balance_alerts()
        self.assertEqual(alerts["items"][0]["id"], 42)
        self.assertEqual(_Handler.seen_auth[-1], "Bot demo-bot-token")
        self.assertEqual(_Handler.seen_admin_api_keys[-1], "admin-secret")
        acknowledged = await api.ack_balance_alert(alerts["items"][0]["id"])
        self.assertTrue(acknowledged["acknowledged"])
        self.assertEqual(_Handler.balance_alert_ack_ids, [("42", {})])
        self.assertEqual(_Handler.seen_admin_api_keys[-1], "admin-secret")

    async def test_check_in_uses_bot_authorization_and_preserves_duplicate_result(self):
        api = self._api(bot_binding_token="demo-bot-token", admin_api_key="admin-secret")
        first = await api.check_in()
        self.assertTrue(first["checked_in"])
        self.assertEqual(first["reward"], 0.18)
        self.assertEqual(first["balance"], 1.43)
        self.assertEqual(first["streak_day"], 3)
        self.assertEqual(first["month_checked_days"], 12)
        self.assertEqual(first["month_total_days"], 30)
        self.assertEqual(first["week_checked_days"], 4)
        self.assertEqual(first["consecutive_days"], 10)
        self.assertEqual(_Handler.seen_auth[-1], "Bot demo-bot-token")
        self.assertEqual(_Handler.seen_admin_api_keys[-1], "admin-secret")

        duplicate = await api.check_in()
        self.assertFalse(duplicate["checked_in"])
        self.assertEqual(duplicate["reward"], first["reward"])
        for key in ("month_checked_days", "month_total_days", "week_checked_days", "consecutive_days"):
            self.assertEqual(duplicate[key], first[key])
        self.assertEqual(_Handler.check_in_count, 2)

    async def test_balance_alert_ack_rejects_empty_id(self):
        api = self._api(bot_binding_token="demo-bot-token", admin_api_key="admin-secret")
        with self.assertRaises(ValueError):
            await api.ack_balance_alert("")

    async def test_two_factor_requirement_stops_login_safely(self):
        api = self._api(email="2fa@example.test", password="test-pass")
        with self.assertRaises(client.KinghtAPIError) as raised:
            await api.get_channel_monitors()
        self.assertEqual(raised.exception.code, "two_factor_required")
        self.assertEqual(api.access_token, "")

    async def test_admin_overview_query(self):
        api = self._api(email="member@example.test", password="test-pass")
        payload = await api.get_admin_overview("24h")
        self.assertEqual(payload["ttft"]["p50_ms"], 100)

    async def test_find_admin_user_by_email_uses_exact_email_match(self):
        api = self._api(email="member@example.test", password="test-pass", admin_api_key="admin-secret")
        self.assertTrue(await api.find_admin_user_by_email(" MEMBER@EXAMPLE.TEST "))
        self.assertFalse(await api.find_admin_user_by_email("other@example.test"))
        self.assertTrue(any("/admin/users?" in path and "search=member%40example.test" in path for path in _Handler.seen_paths))
        self.assertTrue(any("page_size=100" in path for path in _Handler.seen_paths if "/admin/users?" in path))
        self.assertEqual(_Handler.seen_admin_api_keys[-1], "admin-secret")

    async def test_group_query_parameters(self):
        api = self._api(email="member@example.test", password="test-pass")
        groups = await api.get_admin_groups("OpenAI")
        self.assertEqual(groups["items"][0]["id"], 7)
        self.assertTrue(any("search=OpenAI" in path and "page_size=100" in path for path in _Handler.seen_paths))
        await api.get_admin_overview("24h", group_id=7)
        self.assertTrue(any("time_range=24h" in path and "group_id=7" in path for path in _Handler.seen_paths))
        await api.get_channel_monitor_v2_snapshot("24h", group_name="海外模型")
        self.assertTrue(any("group_name=%E6%B5%B7%E5%A4%96%E6%A8%A1%E5%9E%8B" in path for path in _Handler.seen_paths))
        await api.get_channel_monitor_v2_dimensions("7d")
        await api.get_channel_monitor_v2_matrix("7d", group_by="platform_group")
        self.assertTrue(any("channel-monitor-v2/dimensions?range=7d" in path for path in _Handler.seen_paths))
        self.assertTrue(any("channel-monitor-v2/matrix?range=7d&group_by=platform_group" in path for path in _Handler.seen_paths))

    async def test_available_groups_include_rate_multipliers(self):
        api = self._api(email="member@example.test", password="test-pass")
        groups = await api.get_available_groups()
        self.assertEqual(groups[0]["name"], "OpenAI 分组")
        self.assertEqual(groups[0]["rate_multiplier"], 0.08)
        self.assertTrue(any(path == "/api/v1/groups/available" for path in _Handler.seen_paths))

    def test_normalize_base_url(self):
        self.assertEqual(
            client.normalize_base_url("https://api.kinght.top"),
            "https://api.kinght.top/api/v1",
        )
        self.assertEqual(
            client.normalize_base_url("https://api.kinght.top/api"),
            "https://api.kinght.top/api/v1",
        )

    def test_login_rejects_remote_http(self):
        api = client.KinghtAPIClient("http://example.com", email="member@example.test", password="test-pass")
        with self.assertRaises(client.KinghtAPIError):
            api._ensure_secure_login_transport()


if __name__ == "__main__":
    unittest.main()
