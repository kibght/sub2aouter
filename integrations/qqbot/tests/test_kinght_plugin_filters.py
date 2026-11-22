import asyncio
import importlib.util
import json
import tempfile
import sys
import types
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


PLUGIN_DIR = Path(__file__).resolve().parents[1] / "kinght_status_plugin"


def _load_plugin_module():
    sdk = types.ModuleType("maibot_sdk")

    class _ConfigBase:
        pass

    class _PluginBase:
        def __init__(self):
            self.config = SimpleNamespace()

        def get_components(self):
            components = []
            for attr_name in dir(self):
                attribute = getattr(self, attr_name)
                info = getattr(attribute, "__maibot_component_info__", None)
                if info is None:
                    continue
                metadata = {
                    **info.metadata,
                    **info.model_dump(mode="json", exclude={"name", "type", "metadata"}),
                    "handler_name": attr_name,
                }
                components.append(
                    {"name": info.name, "type": info.type.value, "metadata": metadata}
                )
            return components

    class _Field:
        def __new__(cls, default=None, **_kwargs):
            return default

    def _command(*_args, **_kwargs):
        return lambda function: function

    sdk.Command = _command
    sdk.Field = _Field
    sdk.MaiBotPlugin = _PluginBase
    sdk.PluginConfigBase = _ConfigBase
    sys.modules["maibot_sdk"] = sdk

    package = types.ModuleType("kinght_status_plugin")
    package.__path__ = [str(PLUGIN_DIR)]
    sys.modules["kinght_status_plugin"] = package

    client_spec = importlib.util.spec_from_file_location(
        "kinght_status_plugin.client", str(PLUGIN_DIR / "client.py")
    )
    assert client_spec is not None and client_spec.loader is not None
    client_module = importlib.util.module_from_spec(client_spec)
    sys.modules["kinght_status_plugin.client"] = client_module
    client_spec.loader.exec_module(client_module)

    plugin_spec = importlib.util.spec_from_file_location(
        "kinght_status_plugin.plugin", str(PLUGIN_DIR / "plugin.py")
    )
    assert plugin_spec is not None and plugin_spec.loader is not None
    plugin_module = importlib.util.module_from_spec(plugin_spec)
    sys.modules["kinght_status_plugin.plugin"] = plugin_module
    plugin_spec.loader.exec_module(plugin_module)
    return plugin_module


plugin = _load_plugin_module()


class KinghtPluginFilterTests(unittest.TestCase):
    def setUp(self):
        self.instance = object.__new__(plugin.KinghtStatusPlugin)
        self.instance.config = SimpleNamespace(
            max_channels=20,
            max_model_rows=10,
            admin_user_ids="1001,1002",
            allowed_group_ids="2001,2002",
        )

    def test_client_is_reused_until_account_configuration_changes(self):
        self.instance.config = SimpleNamespace(
            api_base_url="https://api.kinght.top/api/v1",
            email="member@example.test",
            password="test-pass",
            request_timeout_seconds=10,
        )
        self.instance._client = None
        self.instance._client_config_key = None
        class FakeClient:
            def __init__(self, **kwargs):
                self.password = kwargs["password"]
                self.access_token = ""

        with patch.object(plugin, "KinghtAPIClient", FakeClient):
            first = self.instance._get_client()
            first.access_token = "cached-session"
            self.assertIs(self.instance._get_client(), first)
            self.assertEqual(self.instance._get_client().access_token, "cached-session")

            self.instance.config.password = "updated-pass"
            updated = self.instance._get_client()
            self.assertIsNot(updated, first)
            self.assertEqual(updated.password, "updated-pass")

    def test_client_passes_admin_api_key(self):
        self.instance.config = SimpleNamespace(
            api_base_url="https://api.kinght.top/api/v1",
            email="",
            password="",
            access_token="",
            refresh_token="",
            admin_api_key="admin-secret",
            request_timeout_seconds=10,
        )
        self.instance._client = None
        self.instance._client_config_key = None

        class FakeClient:
            def __init__(self, **kwargs):
                self.admin_api_key = kwargs["admin_api_key"]

        with patch.object(plugin, "KinghtAPIClient", FakeClient):
            configured = self.instance._get_client()
        self.assertEqual(configured.admin_api_key, "admin-secret")

    def test_admin_key_rotation_rebuilds_clients_and_preserves_bound_token(self):
        self.instance.config = SimpleNamespace(
            api_base_url="https://api.kinght.top/api/v1", admin_api_key="old-admin",
            request_timeout_seconds=10,
        )
        self.instance._client = None
        self.instance._client_config_key = None
        record = {"bot_token": "unchanged-binding"}

        class FakeClient:
            def __init__(self, **kwargs):
                self.admin_api_key = kwargs["admin_api_key"]
                self.bot_binding_token = kwargs.get("bot_binding_token", "")

        with patch.object(plugin, "KinghtAPIClient", FakeClient):
            first = self.instance._get_client()
            self.assertIs(self.instance._get_client(), first)
            before = self.instance._make_bound_client("qq:42", record)
            self.instance.config.admin_api_key = "new-admin"
            updated = self.instance._get_client()
            after = self.instance._make_bound_client("qq:42", record)
        self.assertIsNot(updated, first)
        self.assertEqual((first.admin_api_key, updated.admin_api_key), ("old-admin", "new-admin"))
        self.assertEqual((before.admin_api_key, after.admin_api_key), ("old-admin", "new-admin"))
        self.assertEqual(before.bot_binding_token, after.bot_binding_token)
        self.assertEqual(record, {"bot_token": "unchanged-binding"})

    def test_bound_client_passes_admin_api_key(self):
        self.instance.config = SimpleNamespace(
            api_base_url="https://api.kinght.top/api/v1",
            request_timeout_seconds=10,
            admin_api_key="admin-secret",
        )

        class FakeClient:
            def __init__(self, **kwargs):
                self.admin_api_key = kwargs["admin_api_key"]
                self.bot_binding_token = kwargs["bot_binding_token"]

        with patch.object(plugin, "KinghtAPIClient", FakeClient):
            configured = self.instance._make_bound_client(
                "qq:42", {"bot_token": "bound-token"}
            )
        self.assertEqual(configured.admin_api_key, "admin-secret")
        self.assertEqual(configured.bot_binding_token, "bound-token")

    def test_invalid_admin_key_does_not_delete_binding(self):
        with tempfile.TemporaryDirectory() as data_dir:
            self.instance.ctx = SimpleNamespace(paths=SimpleNamespace(data_dir=data_dir))
            self.instance._write_bindings(
                {"qq:42": {"bot_token": "bound-token", "platform": "qq", "external_id": "42"}}
            )
            self.instance._clear_invalid_binding(
                "qq:42",
                plugin.KinghtAPIError("invalid", status_code=401, code="INVALID_ADMIN_KEY"),
            )
            self.assertIn("qq:42", self.instance._read_bindings())

    def test_rotated_tokens_persist_in_plugin_data_directory(self):
        with tempfile.TemporaryDirectory() as data_dir:
            config = SimpleNamespace(
                api_base_url="https://api.kinght.top/api/v1",
                email="",
                password="",
                access_token="configured-access",
                refresh_token="configured-refresh",
                request_timeout_seconds=10,
            )
            first = object.__new__(plugin.KinghtStatusPlugin)
            first.config = config
            first.ctx = SimpleNamespace(paths=SimpleNamespace(data_dir=data_dir))
            first._client = None
            first._client_config_key = None

            async def get_first_client():
                return first._get_client()

            first_client = asyncio.run(get_first_client())
            first_client.access_token = "rotated-access"
            first_client.refresh_token = "rotated-refresh"
            first_client._notify_tokens_updated()

            restarted = object.__new__(plugin.KinghtStatusPlugin)
            restarted.config = config
            restarted.ctx = SimpleNamespace(paths=SimpleNamespace(data_dir=data_dir))
            restarted._client = None
            restarted._client_config_key = None

            async def get_restarted_client():
                return restarted._get_client()

            restored = asyncio.run(get_restarted_client())

            self.assertEqual(restored.access_token, "rotated-access")
            self.assertEqual(restored.refresh_token, "rotated-refresh")

    def test_turnstile_error_explains_browser_token_setup(self):
        error = plugin.KinghtAPIError(
            "turnstile verification failed",
            code="TURNSTILE_VERIFICATION_FAILED",
        )
        message = plugin.KinghtStatusPlugin._friendly_error(error)
        self.assertIn("Cloudflare Turnstile", message)
        self.assertIn("access_token", message)
        self.assertIn("refresh_token", message)

    def test_channel_status_only_matches_group_name(self):
        payload = {
            "items": [
                {"name": "海外渠道", "provider": "openai", "group_name": "海外模型"},
                {"name": "国内渠道", "provider": "openai", "group_name": "国内模型"},
            ]
        }
        message = self.instance._format_channels(payload, "海外")
        self.assertIn("海外渠道", message)
        self.assertNotIn("国内渠道", message)
        self.assertNotIn("openai", self.instance._format_channels(payload, "渠道"))

    def test_default_trigger_rewrites_to_static_command(self):
        self.assertEqual(
            self.instance._rewrite_custom_trigger_text("/渠道 海外"),
            "/渠道状态 海外",
        )
        self.assertEqual(
            self.instance._rewrite_custom_trigger_text("/首Token"),
            "/首字状态",
        )

    def test_custom_trigger_rewrites_and_preserves_group_keyword(self):
        self.instance.config.triggers = SimpleNamespace(
            enable_channel_status=True,
            channel_status_triggers="健康查询，health\n渠道状态",
            enable_first_token_status=True,
            first_token_status_triggers="首字指标",
            enable_site_status=True,
            site_status_triggers="网站监控|站点状态",
        )
        self.assertIsNone(self.instance._rewrite_custom_trigger_text("/health 海外模型"))
        self.assertEqual(
            self.instance._rewrite_custom_trigger_text("/健康查询 海外模型"),
            "/渠道状态 海外模型",
        )
        self.assertEqual(
            self.instance._rewrite_custom_trigger_text("/首字指标 国内"),
            "/首字状态 国内",
        )
        self.assertEqual(
            self.instance._rewrite_custom_trigger_text("/网站监控 7d"),
            "/站点状态 7d",
        )

    def test_unknown_trigger_is_not_rewritten(self):
        self.assertIsNone(self.instance._rewrite_custom_trigger_text("/some_other_command"))

    def test_disabled_trigger_is_not_rewritten(self):
        self.instance.config.triggers = SimpleNamespace(
            enable_channel_status=False,
            channel_status_triggers="健康查询",
            enable_first_token_status=True,
            first_token_status_triggers="首字状态",
            enable_site_status=True,
            site_status_triggers="站点状态",
        )
        self.assertIsNone(self.instance._rewrite_custom_trigger_text("/健康查询"))

    def test_custom_trigger_hook_returns_mutated_message(self):
        self.instance.config.triggers = SimpleNamespace(
            enable_channel_status=True,
            channel_status_triggers="健康查询",
            enable_first_token_status=True,
            first_token_status_triggers="首字状态",
            enable_site_status=True,
            site_status_triggers="站点状态",
        )
        result = asyncio.run(
            self.instance.handle_custom_triggers(
                message={"processed_plain_text": "/健康查询 海外模型", "message_id": "m1"}
            )
        )
        self.assertEqual(result["action"], "continue")
        self.assertEqual(
            result["modified_kwargs"]["message"]["processed_plain_text"],
            "/渠道状态 海外模型",
        )

    def test_custom_trigger_hook_is_registered_as_component(self):
        components = self.instance.get_components()
        hook = next(component for component in components if component["name"] == "route_custom_triggers")

        self.assertEqual(hook["type"], "HOOK_HANDLER")
        self.assertEqual(hook["metadata"]["hook"], "chat.receive.after_process")
        self.assertEqual(hook["metadata"]["handler_name"], "handle_custom_triggers")

    def test_v2_snapshot_formats_monitor_overview_for_regular_users(self):
        payload = {
            "health": {"overall": "healthy", "score": 95, "ttft": "healthy"},
            "metrics": {
                "request_count": 0,
                "success_requests": 0,
                "error_requests": 0,
                "success_rate": 0.75,
                "error_rate": 0.25,
                "cache_rate": 0.5,
                "ttft": {"p50_ms": 120, "p90_ms": 250, "p95_ms": 300, "avg_ms": 130},
            },
            "coverage": {"coverage_complete": True},
        }
        message = self.instance._format_channels(payload)
        self.assertIn("📡 渠道监控 24h", message)
        self.assertIn("整体：✅ 正常｜评分 95｜覆盖：完整", message)
        self.assertIn("总计：成功 75.00%｜错误 25.00%｜缓存 50.00%", message)
        self.assertIn("首 TOKEN：0.1s", message)
        self.assertNotIn("请求数：0 次", message)
        self.assertNotIn("暂无请求统计", message)

    def test_channel_snapshot_formats_success_cache_and_first_token_by_group(self):
        payload = {
            "health": {"overall": "healthy", "score": 93},
            "metrics": {"request_count": 0},
            "groups": [
                {
                    "group_name": "海外模型",
                    "metrics": {
                        "request_count": 12,
                        "success_rate": 0.9,
                        "cache_rate": 0.4,
                        "ttft_success_rate": 0.8,
                        "ttft": {"p50_ms": 110, "p95_ms": 300},
                    },
                },
                {
                    "group_name": "国内模型",
                    "metrics": {
                        "request_count": 8,
                        "success_rate": 1,
                        "cache_rate": 0.25,
                        "ttft": {"p50_ms": 90},
                    },
                },
            ],
        }

        message = self.instance._format_channels(payload)

        self.assertIn("━━━━━━━━━━【海外模型】", message)
        self.assertIn("成功 90.00%｜错误 -｜缓存 40.00%", message)
        self.assertIn("首 TOKEN：0.1s", message)
        self.assertIn("━━━━━━━━━━【国内模型】", message)
        self.assertIn("成功 100.00%｜错误 -｜缓存 25.00%", message)
        self.assertIn("首 TOKEN：0.1s", message)

    def test_channel_snapshot_compact_format_marks_missing_group_ttft(self):
        payload = {
            "health": {"overall": "healthy", "score": 93.13},
            "metrics": {
                "success_rate": 0.5352,
                "error_rate": 0.0028,
                "cache_rate": 0.816,
                "ttft": {"p50_ms": 5000, "p90_ms": 15000, "p95_ms": 30000, "avg_ms": 6862.75},
            },
            "coverage": {"coverage_complete": True},
            "groups": [
                {
                    "group_name": "image2超分高质量1-8k生图组-0.09",
                    "metrics": {"success_rate": 0.0957, "error_rate": 0.1826, "cache_rate": 0},
                }
            ],
        }

        message = self.instance._format_channels(payload)

        self.assertIn("📡 渠道监控 24h", message)
        self.assertIn("整体：✅ 正常｜评分 93.13｜覆盖：完整", message)
        self.assertIn("总计：成功 99.72%｜错误 0.28%｜缓存 81.60%", message)
        self.assertIn("首 TOKEN：5.0s", message)
        self.assertNotIn("P50", message)
        self.assertIn("━━━━━━━━━━【image2超分高质量1-8k生图组-0.09】", message)
        self.assertIn("成功 81.74%｜错误 18.26%｜缓存 0.00%", message)
        self.assertIn("首 TOKEN：-", message)

    def test_site_status_only_displays_channel_monitor(self):
        payload = {
            "health": {"overall": "healthy", "score": 93},
            "metrics": {"request_count": 0, "ttft": {"p50_ms": 120}},
        }
        requested = {}

        async def channel_data(group_keyword="", time_range="24h"):
            requested["group_keyword"] = group_keyword
            requested["time_range"] = time_range
            return payload

        async def send(_stream_id, message, *, success=True, kwargs=None):
            return success, message, True

        self.instance._permission_error = lambda _stream_id, _kwargs: None
        self.instance._channel_data = channel_data
        self.instance._send = send

        result = asyncio.run(
            self.instance.handle_site_status(
                "stream",
                matched_groups={"range": "7d"},
            )
        )

        self.assertEqual(requested["time_range"], "7d")
        self.assertIn("📡 渠道监控 7d", result[1])
        self.assertNotIn("服务：", result[1])
        self.assertNotIn("首 Token 状态", result[1])
        self.assertIn("首 TOKEN：0.1s", result[1])

    def test_channel_data_uses_v2_snapshot_when_site_mode_is_v2(self):
        class FakeClient:
            def __init__(self):
                self.requested_group = None
                self.requested_range = None

            async def get_public_settings(self):
                return {"channel_monitor_mode": "v2"}

            async def get_channel_monitor_v2_snapshot(self, time_range, *, group_name=""):
                self.requested_group = group_name
                self.requested_range = time_range
                return {"health": {}, "metrics": {}}

            async def get_channel_monitor_v2_dimensions(self, time_range):
                self.requested_range = time_range
                return {"groups": [{"id": 7, "name": "海外模型", "platform": "openai"}]}

            async def get_channel_monitor_v2_matrix(self, time_range, *, group_by):
                self.requested_range = time_range
                self.asserted_group_by = group_by
                return {
                    "items": [
                        {
                            "group_id": 7,
                            "group_name": "海外模型",
                            "platform": "openai",
                            "metrics": {
                                "success_rate": 0.9,
                                "cache_rate": 0.4,
                                "ttft": {"p50_ms": 110, "p95_ms": 300},
                            },
                        }
                    ]
                }

            async def get_available_groups(self):
                return {
                    "groups": [
                        {
                            "id": 7,
                            "name": "海外模型",
                            "platform": "openai",
                            "rate_multiplier": 0.08,
                        }
                    ]
                }

            async def get_channel_monitors(self):
                raise AssertionError("the v1 endpoint must not be used in v2 mode")

        fake_client = FakeClient()
        self.instance._get_client = lambda: fake_client
        payload = asyncio.run(self.instance._channel_data("海外", "7d"))
        self.assertIn("metrics", payload)
        self.assertEqual(fake_client.requested_group, "海外")
        self.assertEqual(fake_client.requested_range, "7d")
        self.assertEqual(fake_client.asserted_group_by, "platform_group")
        message = self.instance._format_channels(payload, "海外", "7d")
        self.assertIn("成功 90.00%｜错误 -｜缓存 40.00%", message)
        self.assertIn("倍率 0.08x", message)
        self.assertIn("首 TOKEN：0.1s", message)

    def test_site_status_combines_total_snapshot_with_each_group_matrix(self):
        class FakeClient:
            async def get_public_settings(self):
                return {"channel_monitor_mode": "v2"}

            async def get_channel_monitor_v2_snapshot(self, time_range, *, group_name=""):
                return {
                    "health": {"overall": "healthy", "score": 93},
                    "metrics": {
                        "request_count": 0,
                        "success_rate": 0.75,
                        "cache_rate": 0.5,
                        "ttft": {"p50_ms": 120, "p95_ms": 300},
                    },
                }

            async def get_channel_monitor_v2_dimensions(self, time_range):
                return {
                    "groups": [
                        {"id": 7, "name": "海外模型", "platform": "openai"},
                        {"id": 8, "name": "国内模型", "platform": "openai"},
                    ]
                }

            async def get_channel_monitor_v2_matrix(self, time_range, *, group_by):
                return {
                    "items": [
                        {
                            "group_id": 7,
                            "group_name": "海外模型",
                            "platform": "openai",
                            "metrics": {
                                "request_count": 0,
                                "success_rate": 0.9,
                                "cache_rate": 0.4,
                                "ttft": {"p50_ms": 110, "p90_ms": 220, "p95_ms": 300, "avg_ms": 150},
                            },
                        },
                        {
                            "group_id": 8,
                            "group_name": "国内模型",
                            "platform": "openai",
                            "metrics": {
                                "request_count": 0,
                                "success_rate": 0.8,
                                "cache_rate": 0.25,
                                "ttft": {"p50_ms": 90, "p95_ms": 200},
                            },
                        },
                    ]
                }

        self.instance._get_client = lambda: FakeClient()
        payload = asyncio.run(self.instance._channel_data(time_range="24h"))
        message = self.instance._format_channels(payload)

        self.assertIn("整体：✅ 正常｜评分 93｜覆盖：-", message)
        self.assertIn("总计：成功 75.00%｜错误 -｜缓存 50.00%", message)
        self.assertIn("首 TOKEN：0.1s", message)
        self.assertIn("━━━━━━━━━━【海外模型】", message)
        self.assertIn("成功 90.00%｜错误 -｜缓存 40.00%", message)
        self.assertIn("首 TOKEN：0.1s", message)
        self.assertIn("━━━━━━━━━━【国内模型】", message)
        self.assertIn("成功 80.00%｜错误 -｜缓存 25.00%", message)
        self.assertIn("首 TOKEN：0.1s", message)
        self.assertNotIn("请求数：0 次", message)
        self.assertNotIn("请求数 0 次", message)

    def test_first_token_status_matches_group_name_and_empty_means_all(self):
        payload = {
            "groups": [
                {"group_name": "海外模型", "status": "healthy", "metrics": {"p50_ms": 100}},
                {"group_name": "国内模型", "status": "degraded", "metrics": {"p50_ms": 200}},
            ]
        }
        all_message = self.instance._format_first_token(payload, "24h")
        filtered_message = self.instance._format_first_token(payload, "24h", "海外")
        self.assertIn("海外模型", all_message)
        self.assertIn("国内模型", all_message)
        self.assertIn("海外模型", filtered_message)
        self.assertNotIn("国内模型", filtered_message)

    def test_admin_and_group_whitelist(self):
        allowed = {"message": {"user_info": {"user_id": "1001"}, "group_info": {"group_id": "2001"}}}
        wrong_user = {"message": {"user_info": {"user_id": "9999"}, "group_info": {"group_id": "2001"}}}
        wrong_group = {"message": {"user_info": {"user_id": "1001"}, "group_info": {"group_id": "3001"}}}
        self.assertIsNone(self.instance._permission_error("stream", allowed))
        self.assertIsNone(self.instance._permission_error("stream", wrong_user))
        self.assertIn("白名单", self.instance._permission_error("stream", wrong_group))

    def test_all_account_triggers_rewrite_to_static_commands(self):
        self.instance.config.triggers = SimpleNamespace(
            bind_account_triggers="绑定，绑定账号",
            unbind_account_triggers="解除绑定",
            binding_status_triggers="账号状态",
            binding_help_triggers="账号帮助",
            binding_diagnose_triggers="账号诊断",
            personal_info_triggers="我的资料",
            my_usage_triggers="消耗",
            key_usage_triggers="密钥消耗",
            balance_alerts_triggers="余额提醒",
            check_in_triggers="每日奖励",
            channel_status_triggers="渠道状态",
            first_token_status_triggers="首字状态",
            site_status_triggers="站点状态",
            enable_channel_status=True,
            enable_first_token_status=True,
            enable_site_status=True,
        )
        cases = {
            "/绑定 ABCD": "/绑定账号 ABCD",
            "/解除绑定": "/解绑账号",
            "/账号状态": "/绑定状态",
            "/账号帮助": "/绑定帮助",
            "/账号诊断": "/绑定诊断",
            "/我的资料": "/个人信息",
            "/消耗": "/我的用量",
            "/密钥消耗": "/Key用量",
            "/余额提醒": "/余额预警",
            "/每日奖励": "/签到",
        }
        for source, expected in cases.items():
            with self.subTest(source=source):
                self.assertEqual(self.instance._rewrite_custom_trigger_text(source), expected)

    def test_balance_alert_delivery_acknowledges_only_successful_messages(self):
        sent = []
        acknowledged = []

        class FakeSend:
            async def text(self, message, stream_id):
                sent.append((message, stream_id))
                return len(sent) == 1

        class FakeClient:
            async def ack_balance_alert(self, alert_id):
                acknowledged.append(alert_id)

        self.instance.ctx = SimpleNamespace(send=FakeSend())
        payload = {
            "items": [
                {"id": 1, "current_balance": 2, "threshold": 5, "site_name": "Example"},
                {"id": 2, "current_balance": 1, "threshold": 5, "site_name": "Example"},
            ]
        }
        delivered = asyncio.run(
            self.instance._deliver_balance_alerts(FakeClient(), payload, "private-stream")
        )
        self.assertEqual(delivered, 1)
        self.assertEqual(acknowledged, [1])
        self.assertEqual(len(sent), 2)

    def test_balance_alert_poll_only_handles_qq_bindings(self):
        sent = []
        looked_up = []
        acknowledged = []

        class FakeSend:
            async def text(self, message, stream_id):
                sent.append((message, stream_id))
                return True

        class FakeChat:
            async def get_private_streams(self, **kwargs):
                looked_up.append(kwargs)
                return {"success": True, "streams": [{
                    "stream_id": "private-42", "platform": "qq", "user_id": "42",
                    "account_id": "bot-1", "scope": "adapter-1", "chat_type": "private",
                }]}

        class FakeClient:
            def __init__(self, **_kwargs):
                pass

            async def get_balance_alerts(self):
                return {
                    "items": [
                        {
                            "id": 7,
                            "current_balance": 1,
                            "threshold": 5,
                            "site_name": "Example",
                        }
                    ]
                }

            async def ack_balance_alert(self, alert_id):
                acknowledged.append(alert_id)

        with tempfile.TemporaryDirectory() as data_dir:
            self.instance.ctx = SimpleNamespace(
                paths=SimpleNamespace(data_dir=data_dir),
                send=FakeSend(),
                chat=FakeChat(),
            )
            self.instance.config.api_base_url = "https://api.kinght.top/api/v1"
            self.instance.config.request_timeout_seconds = 10
            self.instance._write_bindings(
                {
                    "qq:42": {
                        "bot_token": "qq-token",
                        "platform": "qq",
                        "external_id": "42",
                    },
                    "telegram:99": {
                        "bot_token": "telegram-token",
                        "platform": "telegram",
                        "external_id": "99",
                    },
                }
            )
            with patch.object(plugin, "KinghtAPIClient", FakeClient):
                delivered = asyncio.run(self.instance._poll_balance_alerts())

        self.assertEqual(delivered, 1)
        self.assertEqual(acknowledged, [7])
        self.assertEqual(looked_up, [{"platform": "qq"}])
        self.assertEqual(sent[0][1], "private-42")

    def test_balance_alert_command_reads_site_setting_in_group(self):
        sent = []

        class FakeSend:
            async def hybrid(self, segments, stream_id):
                sent.append((segments, stream_id))

            async def text(self, message, stream_id):
                sent.append((message, stream_id))

        class FakeClient:
            async def get_public_settings(self):
                return {"balance_low_notify_enabled": True}

        self.instance.ctx = SimpleNamespace(send=FakeSend())
        self.instance._account_command_context = lambda *_args, **_kwargs: (
            "qq", "42", "qq:42", True, None
        )
        async def fake_account_client(_key):
            return FakeClient()

        self.instance._account_client = fake_account_client
        context = {
            "message": {
                "message_type": "group",
                "user_info": {"user_id": "42"},
                "group_info": {"group_id": "9001"},
            }
        }
        result = asyncio.run(self.instance.handle_balance_alerts("group-stream", **context))
        self.assertTrue(result[0])
        self.assertEqual(sent[-1][0][0], {"type": "at", "data": {"target_user_id": "42"}})
        self.assertIn("网站余额预警总开关：已开启", sent[-1][0][1]["data"])
        self.assertIn("余额预警状态：已开启", sent[-1][0][1]["data"])

    def test_balance_alert_command_distinguishes_disabled_and_unsupported_platform(self):
        sent = []

        class FakeSend:
            async def hybrid(self, segments, stream_id):
                sent.append((segments, stream_id))

            async def text(self, message, stream_id):
                sent.append((message, stream_id))

        class FakeClient:
            async def get_public_settings(self):
                return {"balance_low_notify_enabled": "false"}

        self.instance.ctx = SimpleNamespace(send=FakeSend())
        async def fake_account_client(_key):
            return FakeClient()

        self.instance._account_client = fake_account_client
        self.instance._account_command_context = lambda *_args, **_kwargs: (
            "qq", "42", "qq:42", False, None
        )
        result = asyncio.run(self.instance.handle_balance_alerts("private-stream"))
        self.assertTrue(result[0])
        self.assertIn("余额预警状态：未开启", sent[-1][0])

        self.instance._account_command_context = lambda *_args, **_kwargs: (
            "telegram", "42", "telegram:42", False, None
        )
        result = asyncio.run(self.instance.handle_balance_alerts("private-stream"))
        self.assertFalse(result[0])
        self.assertIn("余额预警状态：不支持的平台", sent[-1][0])

    def test_binding_diagnose_requires_configured_admin_and_mentions_group_user(self):
        sent = []

        class FakeSend:
            async def hybrid(self, segments, stream_id):
                sent.append((segments, stream_id))

            async def text(self, message, stream_id):
                sent.append((message, stream_id))

        self.instance.ctx = SimpleNamespace(send=FakeSend())
        self.instance.config.admin_user_ids = "1001"
        context = {
            "message": {
                "message_type": "group",
                "user_info": {"user_id": "42"},
                "group_info": {"group_id": "9001"},
            }
        }
        result = asyncio.run(self.instance.handle_account_binding_diagnose("group-stream", **context))
        self.assertFalse(result[0])
        self.assertEqual(sent[-1][0][0], {"type": "at", "data": {"target_user_id": "42"}})
        self.assertIn("管理员", sent[-1][0][1]["data"])

    def test_binding_diagnose_hides_paths_and_exception_details(self):
        sent = []

        class FakeSend:
            async def hybrid(self, segments, stream_id):
                sent.append((segments, stream_id))

            async def text(self, message, stream_id):
                sent.append((message, stream_id))

        class FakeClient:
            async def get_user_profile(self):
                raise plugin.KinghtAPIError(
                    r"C:\\secret\\private.py /api/v1/private", status_code=500, code="SERVER_FAIL"
                )

            async def get_usage_dashboard_stats(self):
                raise RuntimeError(r"C:\\secret\\dashboard.log")

            async def get_usage_stats(self, _period):
                raise plugin.KinghtAPIError(
                    r"https://example.test/api/v1/private", status_code=403, code="FORBIDDEN"
                )

        with tempfile.TemporaryDirectory() as data_dir:
            self.instance.ctx = SimpleNamespace(
                paths=SimpleNamespace(data_dir=data_dir),
                send=FakeSend(),
            )
            self.instance.config.admin_user_ids = "1001"
            self.instance.config.onebot_api_base = ""
            self.instance.config.onebot_access_token = ""
            self.instance._write_bindings(
                {
                    "qq:1001": {
                        "bot_token": "qq-token",
                        "platform": "qq",
                        "external_id": "1001",
                    }
                }
            )
            self.instance._make_bound_client = lambda _key, _record: FakeClient()
            context = {"message": {"user_info": {"user_id": "1001"}}}
            result = asyncio.run(
                self.instance.handle_account_binding_diagnose("private-stream", **context)
            )

        self.assertFalse(result[0])
        message = sent[-1][0]
        self.assertNotIn("C:\\secret", message)
        self.assertNotIn("/api/v1", message)
        self.assertNotIn("https://", message)
        self.assertIn("HTTP 500", message)

    def test_user_facing_account_errors_do_not_echo_exception_paths(self):
        secret = r"C:\\app\\secret.py /api/v1/private"
        self.assertNotIn(secret, plugin.KinghtStatusPlugin._friendly_account_error(RuntimeError(secret)))
        self.assertNotIn(secret, plugin.KinghtStatusPlugin._friendly_balance_alert_error(RuntimeError(secret)))
        self.assertNotIn(
            secret,
            plugin.KinghtStatusPlugin._friendly_account_error(
                plugin.KinghtAPIError(secret, status_code=503, code="SERVER_ERROR")
            ),
        )

    def test_account_commands_require_private_chat(self):
        context = {
            "message": {
                "user_info": {"user_id": "42"},
                "group_info": {"group_id": "9001"},
            }
        }
        _platform, _user_id, _key, is_group, error = self.instance._account_command_context("stream", context)
        self.assertTrue(is_group)
        self.assertIn("私聊", error)

    def test_account_commands_detect_group_message_type_without_group_info(self):
        context = {"message": {"message_type": "group", "user_info": {"user_id": "42"}}}
        _platform, _user_id, _key, is_group, error = self.instance._account_command_context("stream", context)
        self.assertTrue(is_group)
        self.assertIn("私聊", error)

    def test_usage_commands_require_private_chat(self):
        context = {
            "message": {
                "message_type": "group",
                "user_info": {"user_id": "42"},
                "group_info": {"group_id": "9001"},
            }
        }
        _platform, _user_id, _key, is_group, error = self.instance._account_command_context("stream", context)
        self.assertTrue(is_group)
        self.assertIn("私聊", error)
        _platform, _user_id, _key, is_group, error = self.instance._account_command_context(
            "stream", context, group_error="我的用量查询请私聊机器人执行。"
        )
        self.assertTrue(is_group)
        self.assertEqual(error, "我的用量查询请私聊机器人执行。")

    def test_group_usage_errors_mention_current_user(self):
        sent = []

        class FakeSend:
            async def hybrid(self, segments, stream_id):
                sent.append((segments, stream_id))

            async def text(self, message, stream_id):
                sent.append((message, stream_id))

        self.instance.ctx = SimpleNamespace(send=FakeSend())
        context = {
            "message": {
                "message_type": "group",
                "user_info": {"user_id": "42"},
                "group_info": {"group_id": "9001"},
            }
        }
        for handler in (self.instance.handle_my_usage, self.instance.handle_key_usage):
            result = asyncio.run(handler("group-stream", **context))
            self.assertFalse(result[0])
            self.assertEqual(sent[-1][0][0], {"type": "at", "data": {"target_user_id": "42"}})
            self.assertIn("私聊", sent[-1][0][1]["data"])
            self.assertIn("账号状态：会话信息无效", sent[-1][0][1]["data"])

    def test_account_error_metadata_status_and_latest_auth_codes_are_distinct(self):
        self.assertIn(
            "账号状态：binding_invalid",
            self.instance._friendly_account_error(
                plugin.KinghtAPIError(
                    "绑定失效", status_code=401, code="USER_NOT_FOUND"
                )
            ),
        )
        self.assertIn(
            "账号状态：unauthorized",
            self.instance._friendly_account_error(
                plugin.KinghtAPIError(
                    "未授权", status_code=401, code="BOT_AUTH_REQUIRED"
                )
            ),
        )
        self.assertIn(
            "余额预警状态：binding_not_found",
            self.instance._friendly_balance_alert_error(
                plugin.KinghtAPIError(
                    "绑定不存在", status_code=404, code="BOT_BINDING_NOT_FOUND"
                )
            ),
        )
        self.assertIn(
            "余额预警状态：forbidden",
            self.instance._friendly_balance_alert_error(
                plugin.KinghtAPIError(
                    "无权限", status_code=403, metadata={"status": "forbidden"}
                )
            ),
        )

    def test_group_account_reply_mentions_current_user(self):
        sent = []

        class FakeSend:
            async def hybrid(self, segments, stream_id):
                sent.append((segments, stream_id))

            async def text(self, message, stream_id):
                sent.append((message, stream_id))

        self.instance.ctx = SimpleNamespace(send=FakeSend())
        result = asyncio.run(
            self.instance._send_account_reply(
                "group-stream",
                "绑定成功",
                user_id="42",
                is_group=True,
            )
        )
        self.assertTrue(result[0])
        self.assertEqual(sent[0][0][0], {"type": "at", "data": {"target_user_id": "42"}})
        self.assertIn("绑定成功", sent[0][0][1]["data"])

    def test_group_binding_help_mentions_user_and_lists_checkin(self):
        sent = []

        class FakeSend:
            async def hybrid(self, segments, stream_id):
                sent.append((segments, stream_id))

        self.instance.ctx = SimpleNamespace(send=FakeSend())
        context = {
            "message": {
                "message_type": "group",
                "user_info": {"user_id": "42"},
                "group_info": {"group_id": "9001"},
            }
        }

        result = asyncio.run(self.instance.handle_account_binding_help("group-stream", **context))

        self.assertTrue(result[0])
        self.assertEqual(sent[0][0][0], {"type": "at", "data": {"target_user_id": "42"}})
        self.assertIn("签到：", sent[0][0][1]["data"])
        self.assertIn("/签到", sent[0][0][1]["data"])
        self.assertNotIn("/check_in", sent[0][0][1]["data"])
        self.assertNotIn("签到（私聊）", sent[0][0][1]["data"])
        self.assertIn("站点状态：", sent[0][0][1]["data"])
        self.assertIn("绑定流程：", sent[0][0][1]["data"])
        self.assertIn("个人信息（私聊）：", sent[0][0][1]["data"])
        self.assertIn("/个人信息", sent[0][0][1]["data"])
        self.assertNotIn("/personal_info", sent[0][0][1]["data"])
        self.assertNotIn("/bind_help", sent[0][0][1]["data"])
        self.assertIn("帮助：/绑定帮助", sent[0][0][1]["data"])
        self.assertIn("/Key用量", sent[0][0][1]["data"])

    def test_checkin_is_available_in_group_and_mentions_user(self):
        sent = []

        class FakeSend:
            async def hybrid(self, segments, stream_id):
                sent.append((segments, stream_id))

        class FakeClient:
            async def check_in(self):
                return {
                    "checked_in": True,
                    "reward": 0.19,
                    "balance": 1.19,
                    "streak_day": 1,
                    "month_checked_days": 1,
                    "month_total_days": 30,
                    "week_checked_days": 1,
                    "consecutive_days": 1,
                }

        async def fake_account_client(_key):
            return FakeClient()

        self.instance.ctx = SimpleNamespace(send=FakeSend())
        self.instance._account_client = fake_account_client
        context = {
            "message": {
                "message_type": "group",
                "user_info": {"user_id": "42"},
                "group_info": {"group_id": "9001"},
            }
        }

        result = asyncio.run(self.instance.handle_check_in("group-stream", **context))

        self.assertTrue(result[0])
        self.assertEqual(sent[0][0][0], {"type": "at", "data": {"target_user_id": "42"}})
        message = sent[0][0][1]["data"]
        self.assertEqual(
            message.strip(),
            "赠送金额：$0.19\n本月签到：1/30天\n本周签到：1/7天\n连续签到：1天\n签到状态：成功",
        )
        self.assertNotIn("账户余额", message)

    def test_duplicate_checkin_keeps_reward_and_streak_without_balance(self):
        sent = []

        class FakeSend:
            async def hybrid(self, segments, stream_id):
                sent.append((segments, stream_id))

        class FakeClient:
            async def check_in(self):
                return {
                    "checked_in": False,
                    "reward": 0,
                    "balance": 9.99,
                    "streak_day": 4,
                    "month_checked_days": 13,
                    "month_total_days": 30,
                    "week_checked_days": 4,
                    "consecutive_days": 11,
                }

        async def fake_account_client(_key):
            return FakeClient()

        self.instance.ctx = SimpleNamespace(send=FakeSend())
        self.instance._account_client = fake_account_client
        context = {
            "message": {
                "message_type": "group",
                "user_info": {"user_id": "42"},
                "group_info": {"group_id": "9001"},
            }
        }

        result = asyncio.run(self.instance.handle_check_in("group-stream", **context))

        self.assertTrue(result[0])
        self.assertEqual(sent[0][0][0], {"type": "at", "data": {"target_user_id": "42"}})
        message = sent[0][0][1]["data"]
        self.assertEqual(
            message.strip(),
            "今日已签到\n已领取金额：$0\n本月签到：13/30天\n本周签到：4/7天\n连续签到：11天\n签到状态：已签到",
        )
        self.assertNotIn("账户余额", message)

    def test_checkin_statistics_are_unavailable_for_legacy_response(self):
        for status in ("success", "already_checked_in"):
            with self.subTest(status=status):
                message = self.instance._format_check_in_result(
                    {"status": status, "reward": 0.19, "streak_day": 4}
                )
                self.assertIn("本月签到：暂无数据", message)
                self.assertIn("本周签到：暂无数据", message)
                self.assertIn("连续签到：暂无数据", message)
                self.assertNotIn("4天", message)

    def test_checkin_statistics_preserve_available_fields_when_partially_missing(self):
        cases = (
            ({"month_checked_days": 2}, ("暂无数据", "暂无数据", "暂无数据")),
            ({"month_total_days": 30}, ("暂无数据", "暂无数据", "暂无数据")),
            (
                {"month_checked_days": 2, "month_total_days": 30, "week_checked_days": None, "consecutive_days": 8},
                ("2/30天", "暂无数据", "8天"),
            ),
            ({"week_checked_days": 3}, ("暂无数据", "3/7天", "暂无数据")),
        )
        for statistics, expected in cases:
            with self.subTest(statistics=statistics):
                message = self.instance._format_check_in_result(
                    {"status": "success", "reward": 0.19, **statistics}
                )
                for label, value in zip(("本月签到", "本周签到", "连续签到"), expected):
                    self.assertIn(f"{label}：{value}", message)

    def test_checkin_statistics_preserve_zero_values(self):
        message = self.instance._format_check_in_result(
            {
                "status": "success",
                "reward": 0,
                "month_checked_days": 0,
                "month_total_days": 30,
                "week_checked_days": 0,
                "consecutive_days": 0,
            }
        )
        self.assertEqual(
            message,
            "赠送金额：$0\n本月签到：0/30天\n本周签到：0/7天\n连续签到：0天\n签到状态：success",
        )

    def test_checkin_statistics_use_site_month_length_and_true_consecutive_days(self):
        for month_total in (28, 29, 30, 31):
            with self.subTest(month_total=month_total):
                message = self.instance._format_check_in_result(
                    {
                        "status": "success",
                        "reward": 0.19,
                        "streak_day": 4,
                        "month_checked_days": "2",
                        "month_total_days": str(month_total),
                        "week_checked_days": "5",
                        "consecutive_days": "32",
                    }
                )
                self.assertIn(f"本月签到：2/{month_total}天", message)
                self.assertIn("本周签到：5/7天", message)
                self.assertIn("连续签到：32天", message)

    def test_checkin_statistics_reject_invalid_day_counts(self):
        for invalid in (None, True, -1, 1.5, "invalid", "nan", "inf"):
            with self.subTest(invalid=invalid):
                message = self.instance._format_check_in_result(
                    {
                        "status": "success",
                        "reward": 0.19,
                        "month_checked_days": invalid,
                        "month_total_days": 30,
                        "week_checked_days": invalid,
                        "consecutive_days": invalid,
                    }
                )
                self.assertIn("本月签到：暂无数据", message)
                self.assertIn("本周签到：暂无数据", message)
                self.assertIn("连续签到：暂无数据", message)

    def test_checkin_unbound_reports_binding_instruction(self):
        sent = []

        class FakeSend:
            async def hybrid(self, segments, stream_id):
                sent.append((segments, stream_id))

        async def fake_account_client(_key):
            raise plugin.KinghtAPIError("账号尚未绑定", code="account_not_bound")

        self.instance.ctx = SimpleNamespace(send=FakeSend())
        self.instance._account_client = fake_account_client
        context = {
            "message": {
                "message_type": "group",
                "user_info": {"user_id": "42"},
                "group_info": {"group_id": "9001"},
            }
        }

        result = asyncio.run(self.instance.handle_check_in("group-stream", **context))

        self.assertFalse(result[0])
        self.assertEqual(
            sent[0][0][1]["data"].strip(),
            "当前用户尚未绑定网站账号，请先发送 /绑定账号 <绑定码>。\n签到状态：未绑定",
        )

    def test_checkin_duplicate_api_error_reports_already_checked_in(self):
        message = self.instance._friendly_check_in_error(
            plugin.KinghtAPIError("already checked in", status_code=409, code="already_checked_in")
        )

        self.assertEqual(
            plugin._localize_status_values(message),
            "今日已签到\n签到状态：已签到",
        )

    def test_checkin_latest_business_statuses_are_distinct(self):
        cases = (
            ("success", True, "赠送金额", "签到状态：成功"),
            ("already_checked_in", True, "今日已签到", "签到状态：已签到"),
            ("disabled", False, "签到功能当前未开启", "签到状态：未开启"),
            ("insufficient_usage", False, "今日 Token 使用量不足", "签到状态：用量不足"),
            ("account_inactive", False, "网站账号已停用", "签到状态：账号已停用"),
        )

        for status, expected_success, expected_text, expected_status in cases:
            sent = []

            class FakeSend:
                async def hybrid(self, segments, stream_id):
                    sent.append((segments, stream_id))

            class FakeClient:
                async def check_in(self):
                    return {
                        "status": status,
                        "checked_in": status == "success",
                        "already_checked_in": status == "already_checked_in",
                        "reward": 0.12 if status == "success" else 0,
                        "streak_day": 2,
                        "today_tokens": 900_000,
                        "required_tokens": 1_000_000,
                    }

            async def fake_account_client(_key):
                return FakeClient()

            self.instance.ctx = SimpleNamespace(send=FakeSend())
            self.instance._account_client = fake_account_client
            context = {
                "message": {
                    "message_type": "group",
                    "user_info": {"user_id": "42"},
                    "group_info": {"group_id": "9001"},
                }
            }

            result = asyncio.run(self.instance.handle_check_in("group-stream", **context))
            message = sent[0][0][1]["data"]
            self.assertEqual(result[0], expected_success)
            self.assertIn(expected_text, message)
            self.assertIn(expected_status, plugin._localize_status_values(message))

    def test_checkin_error_metadata_status_is_preserved(self):
        message = self.instance._friendly_check_in_error(
            plugin.KinghtAPIError(
                "今日 token 使用量不足",
                status_code=403,
                code="BOT_CHECKIN_USAGE_REQUIRED",
                metadata={"status": "insufficient_usage"},
            )
        )

        self.assertIn("今日 Token 使用量不足", message)
        self.assertIn("签到状态：用量不足", plugin._localize_status_values(message))

    def test_checkin_amount_requirement_reports_progress_and_mentions_group_user(self):
        cases = (
            (0.04, 0.07, "$0.04/$0.07"),
            ("0.04000000", "0.07000000", "$0.04/$0.07"),
            (0.00000001, 0.00000002, "$0.00000001/$0.00000002"),
        )
        for today_amount, required_amount, expected_progress in cases:
            with self.subTest(today_amount=today_amount, required_amount=required_amount):
                sent = []

                class FakeSend:
                    async def hybrid(self, segments, stream_id):
                        sent.append((segments, stream_id))

                class FakeClient:
                    async def check_in(self):
                        return {
                            "status": "insufficient_usage",
                            "usage_requirement": "amount",
                            "today_amount": today_amount,
                            "required_amount": required_amount,
                            "today_tokens": 900_000,
                            "required_tokens": 1_000_000,
                        }

                async def fake_account_client(_key):
                    return FakeClient()

                self.instance.ctx = SimpleNamespace(send=FakeSend())
                self.instance._account_client = fake_account_client
                context = {
                    "message": {
                        "message_type": "group",
                        "user_info": {"user_id": "42"},
                        "group_info": {"group_id": "9001"},
                    }
                }

                result = asyncio.run(self.instance.handle_check_in("group-stream", **context))

                self.assertFalse(result[0])
                self.assertEqual(sent[0][0][0], {"type": "at", "data": {"target_user_id": "42"}})
                message = sent[0][0][1]["data"]
                self.assertIn("今日消费金额不足", message)
                self.assertIn(expected_progress, message)
                self.assertNotIn("Token", message)
                self.assertIn("签到状态：用量不足", message)

    def test_checkin_tokens_requirement_and_legacy_response_preserve_token_progress(self):
        for usage_requirement in ("tokens", None):
            with self.subTest(usage_requirement=usage_requirement):
                payload = {
                    "status": "insufficient_usage",
                    "today_tokens": 900_000,
                    "required_tokens": 1_000_000,
                    "today_amount": 0.04,
                    "required_amount": 0.07,
                }
                if usage_requirement is not None:
                    payload["usage_requirement"] = usage_requirement

                message = self.instance._format_check_in_result(payload)

                self.assertIn("今日 Token 使用量不足", message)
                self.assertIn("900000/1000000", message)
                self.assertNotIn("$", message)
                self.assertIn("签到状态：用量不足", plugin._localize_status_values(message))

    def test_checkin_amount_requirement_keeps_success_and_duplicate_rewards_as_money(self):
        cases = (
            ("success", "赠送金额", "赠送金额：$0.12"),
            ("already_checked_in", "今日已签到", "已领取金额：$0.12"),
        )
        for status, expected_status_text, expected_reward in cases:
            with self.subTest(status=status):
                message = self.instance._format_check_in_result(
                    {
                        "status": status,
                        "usage_requirement": "amount",
                        "today_amount": 0.04,
                        "required_amount": 0.07,
                        "reward": 0.12,
                        "streak_day": 3,
                    }
                )

                self.assertIn(expected_status_text, message)
                self.assertIn(expected_reward, message)
                self.assertIn("连续签到：暂无数据", message)
                self.assertNotIn("不足", message)
                self.assertNotIn("$0.04", message)
                self.assertNotIn("$0.07", message)
                self.assertIn(f"签到状态：{status}", message)

    def test_checkin_error_metadata_amount_requirement_preserves_amount_progress(self):
        cases = (
            ("0.04000000", "0.07000000", "$0.04/$0.07"),
            ("0.00000001", "0.00000002", "$0.00000001/$0.00000002"),
        )
        for today_amount, required_amount, expected_progress in cases:
            with self.subTest(today_amount=today_amount, required_amount=required_amount):
                message = self.instance._friendly_check_in_error(
                    plugin.KinghtAPIError(
                        "insufficient usage",
                        status_code=403,
                        code="BOT_CHECKIN_USAGE_REQUIRED",
                        metadata={
                            "status": "insufficient_usage",
                            "usage_requirement": "amount",
                            "today_amount": today_amount,
                            "required_amount": required_amount,
                            "today_tokens": "900000",
                            "required_tokens": "1000000",
                        },
                    )
                )

                self.assertIn("今日消费金额不足", message)
                self.assertIn(expected_progress, message)
                self.assertNotIn("Token", message)
                self.assertIn("签到状态：用量不足", plugin._localize_status_values(message))

    def test_checkin_error_metadata_token_requirement_preserves_token_reason(self):
        for metadata in (
            {"status": "insufficient_usage"},
            {
                "status": "insufficient_usage",
                "usage_requirement": "tokens",
                "today_tokens": "900000",
                "required_tokens": "1000000",
                "today_amount": "0.04",
                "required_amount": "0.07",
            },
        ):
            with self.subTest(metadata=metadata):
                message = self.instance._friendly_check_in_error(
                    plugin.KinghtAPIError(
                        "insufficient usage",
                        status_code=403,
                        code="BOT_CHECKIN_USAGE_REQUIRED",
                        metadata=metadata,
                    )
                )

                self.assertIn("今日 Token 使用量不足", message)
                self.assertNotIn("$", message)
                self.assertIn("签到状态：用量不足", plugin._localize_status_values(message))

    def test_join_request_rejects_missing_invalid_and_unknown_email_with_reasons(self):
        calls = []

        class FakeClient:
            async def find_admin_user_by_email(self, _email):
                return False

        async def fake_action(action, payload):
            calls.append((action, payload))
            return {"status": "ok", "retcode": 0}

        self.instance.config = SimpleNamespace(
            group_join_approval_group_ids="",
            reject_invalid_group_join_requests=True,
        )
        self.instance._join_request_seen = {}
        self.instance._get_client = lambda: FakeClient()
        self.instance._onebot_action = fake_action

        for flag, comment in (
            ("missing", "我想加入"),
            ("invalid", "邮箱：member@example"),
            ("unknown", "邮箱：member@example.test"),
        ):
            result = asyncio.run(
                self.instance._approve_join_request_if_known(
                    {"sub_type": "add", "flag": flag, "group_id": "9001", "comment": comment}
                )
            )
            self.assertFalse(result)

        self.assertEqual(len(calls), 3)
        reasons = [payload["reason"] for _action, payload in calls]
        self.assertIn("未填写邮箱", reasons[0])
        self.assertIn("邮箱格式不正确", reasons[1])
        self.assertIn("没有找到该邮箱用户", reasons[2])
        self.assertTrue(all(payload["approve"] is False for _action, payload in calls))

    def test_join_request_is_approved_only_after_exact_email_match(self):
        calls = []

        class FakeClient:
            async def find_admin_user_by_email(self, email):
                self.email = email
                return email == "member@example.test"

        async def fake_action(action, payload):
            calls.append((action, payload))
            return {"status": "ok", "retcode": 0}

        self.instance.config = SimpleNamespace(
            group_join_approval_group_ids="9001",
            onebot_api_base="http://127.0.0.1:3000",
        )
        self.instance._join_request_seen = {}
        self.instance._get_client = lambda: FakeClient()
        self.instance._onebot_action = fake_action

        result = asyncio.run(
            self.instance._approve_join_request_if_known(
                {
                    "request_type": "group",
                    "request_id": "req-1",
                    "group_id": "9001",
                    "requester_add_msg": "邮箱：MEMBER@example.test",
                }
            )
        )

        self.assertTrue(result)
        self.assertEqual(calls, [("set_group_add_request", {
            "flag": "req-1",
            "sub_type": "add",
            "approve": True,
            "reason": "",
        })])
        self.assertIn("9001:req-1", self.instance._join_request_seen)

    def test_join_request_extracts_email_from_onebot_message_format(self):
        calls = []

        class FakeClient:
            async def find_admin_user_by_email(self, email):
                self.email = email
                return email == "81352791@qq.com"

        async def fake_action(action, payload):
            calls.append((action, payload))
            if action == "get_group_system_msg":
                return {
                    "status": "ok",
                    "retcode": 0,
                    "data": {
                        "join_requests": [
                            {
                                "request_id": "req-form-1",
                                "group_id": "9001",
                                "message": "问题：请填写您的邮箱 答案： 81352791@qq.com",
                            }
                        ]
                    },
                }
            return {"status": "ok", "retcode": 0}

        self.instance.config = SimpleNamespace(
            enable_group_join_approval=True,
            group_join_approval_group_ids="9001",
            onebot_api_base="http://127.0.0.1:3000",
        )
        self.instance._join_request_seen = {}
        self.instance._join_request_lock = None
        self.instance._get_client = lambda: FakeClient()
        self.instance._onebot_action = fake_action

        approved = asyncio.run(self.instance._poll_group_join_requests())

        self.assertEqual(approved, 1)
        self.assertEqual(calls[0], ("get_group_system_msg", {}))
        self.assertEqual(
            calls[1],
            (
                "set_group_add_request",
                {"flag": "req-form-1", "sub_type": "add", "approve": True, "reason": ""},
            ),
        )
        self.assertIn("9001:req-form-1", self.instance._join_request_seen)

    def test_join_request_uses_snowluma_api_without_onebot_http_config(self):
        calls = []

        class FakeAPI:
            async def call(self, api_name, *, version, params):
                calls.append((api_name, version, params))
                if api_name.endswith("get_group_system_msg"):
                    return {
                        "status": "ok",
                        "retcode": 0,
                        "data": {
                            "join_requests": [
                                {
                                    "request_id": "req-snowluma-1",
                                    "group_id": "9001",
                                    "message": "答案：member@example.test",
                                }
                            ]
                        },
                    }
                return {"status": "ok", "retcode": 0, "data": {} }

        class FakeClient:
            async def find_admin_user_by_email(self, email):
                return email == "member@example.test"

        self.instance.config = SimpleNamespace(
            enable_group_join_approval=True,
            group_join_approval_group_ids="9001",
            onebot_api_base="",
        )
        self.instance.ctx = SimpleNamespace(api=FakeAPI())
        self.instance._join_request_seen = {}
        self.instance._join_request_lock = None
        self.instance._get_client = lambda: FakeClient()

        approved = asyncio.run(self.instance._poll_group_join_requests())

        self.assertEqual(approved, 1)
        self.assertEqual(
            calls,
            [
                (
                    "adapter.napcat.group.get_group_system_msg",
                    "1",
                    {},
                ),
                (
                    "adapter.napcat.group.set_group_add_request",
                    "1",
                    {
                        "flag": "req-snowluma-1",
                        "sub_type": "add",
                        "approve": True,
                        "reason": "",
                    },
                ),
            ],
        )

    def test_join_request_rejects_unmatched_email_but_ignores_invite(self):
        calls = []

        class FakeClient:
            async def find_admin_user_by_email(self, _email):
                return False

        async def fake_action(action, payload):
            calls.append((action, payload))
            return {"status": "ok", "retcode": 0}

        self.instance.config = SimpleNamespace(group_join_approval_group_ids="")
        self.instance._join_request_seen = {}
        self.instance._get_client = lambda: FakeClient()
        self.instance._onebot_action = fake_action

        unmatched = asyncio.run(
            self.instance._approve_join_request_if_known(
                {"sub_type": "add", "flag": "req-2", "group_id": "9001", "comment": "other@example.test"}
            )
        )
        invite = asyncio.run(
            self.instance._approve_join_request_if_known(
                {"sub_type": "invite", "flag": "req-3", "group_id": "9001", "comment": "member@example.test"}
            )
        )

        self.assertFalse(unmatched)
        self.assertFalse(invite)
        self.assertEqual(
            calls,
            [
                (
                    "set_group_add_request",
                    {
                        "flag": "req-2",
                        "sub_type": "add",
                        "approve": False,
                        "reason": "拒绝：没有找到该邮箱用户，请先注册网站账号后再申请入群。",
                    },
                )
            ],
        )

    def test_join_request_rejects_missing_or_invalid_email_with_reason(self):
        calls = []

        async def fake_action(action, payload):
            calls.append((action, payload))
            return {"status": "ok", "retcode": 0}

        self.instance.config = SimpleNamespace(group_join_approval_group_ids="")
        self.instance._join_request_seen = {}
        self.instance._onebot_action = fake_action

        result = asyncio.run(
            self.instance._approve_join_request_if_known(
                {"sub_type": "add", "flag": "req-invalid", "group_id": "9001", "comment": "邮箱：not-an-email"}
            )
        )

        self.assertFalse(result)
        self.assertEqual(
            calls,
            [
                (
                    "set_group_add_request",
                    {
                        "flag": "req-invalid",
                        "sub_type": "add",
                        "approve": False,
                        "reason": "拒绝：入群申请中的邮箱格式不正确，请填写已注册的网站邮箱。",
                    },
                )
            ],
        )

    def test_checked_join_request_is_skipped(self):
        calls = []

        async def fake_action(action, payload):
            calls.append((action, payload))
            return {}

        self.instance.config = SimpleNamespace(group_join_approval_group_ids="")
        self.instance._join_request_seen = {}
        self.instance._onebot_action = fake_action

        result = asyncio.run(
            self.instance._approve_join_request_if_known(
                {
                    "checked": True,
                    "request_id": "req-checked",
                    "group_id": "9001",
                    "message": "member@example.test",
                }
            )
        )

        self.assertFalse(result)
        self.assertEqual(calls, [])

    def test_empty_onebot_action_response_is_success(self):
        self.assertTrue(self.instance._onebot_result_ok({}))
        self.assertTrue(self.instance._onebot_result_ok({"code": 0}))
        self.assertTrue(self.instance._onebot_result_ok({"data": {}}))
        self.assertFalse(self.instance._onebot_result_ok({"status": "failed", "retcode": 100}))
        self.assertFalse(self.instance._onebot_result_ok(None))

    def test_snowluma_adapter_action_uses_configured_websocket(self):
        calls = []

        class FakeWebSocket:
            def __init__(self):
                self.echo = ""

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_args):
                return None

            async def send(self, raw):
                payload = json.loads(raw)
                self.echo = payload["echo"]
                calls.append((payload, raw))

            async def recv(self):
                return json.dumps({"status": "ok", "retcode": 0, "echo": self.echo, "data": {}})

        def connect(url, **kwargs):
            calls.append((url, kwargs))
            return FakeWebSocket()

        async def get_plugin(_plugin_id):
            return {
                "client": {
                    "server": "103.52.155.128",
                    "port": "3001",
                    "token": "adapter-secret",
                }
            }

        self.instance.ctx = SimpleNamespace(
            config=SimpleNamespace(get_plugin=get_plugin),
        )
        fake_websockets = types.SimpleNamespace(connect=connect)
        with patch.dict(sys.modules, {"websockets": fake_websockets}):
            result = asyncio.run(self.instance._snowluma_action("get_group_system_msg", {}))

        self.assertEqual(result["retcode"], 0)
        self.assertEqual(calls[0][0], "ws://103.52.155.128:3001")
        self.assertEqual(calls[0][1]["additional_headers"], {"Authorization": "Bearer adapter-secret"})
        self.assertEqual(calls[1][0]["action"], "get_group_system_msg")

    def test_group_status_reply_mentions_current_user(self):
        sent = []

        class FakeSend:
            async def hybrid(self, segments, stream_id):
                sent.append((segments, stream_id))

            async def text(self, message, stream_id):
                sent.append((message, stream_id))

        self.instance.ctx = SimpleNamespace(send=FakeSend())
        context = {
            "message": {
                "message_type": "group",
                "user_info": {"user_id": "42"},
                "group_info": {"group_id": "9001"},
            }
        }
        result = asyncio.run(self.instance._send("group-stream", "状态结果", kwargs=context))
        self.assertTrue(result[0])
        self.assertEqual(sent[0][0][0], {"type": "at", "data": {"target_user_id": "42"}})

    def test_group_reply_does_not_fallback_to_unmentioned_text(self):
        sent_text = []

        class FakeSend:
            async def hybrid(self, segments, stream_id):
                raise RuntimeError("hybrid unavailable")

            async def text(self, message, stream_id):
                sent_text.append((message, stream_id))

        self.instance.ctx = SimpleNamespace(send=FakeSend())
        result = asyncio.run(
            self.instance._send_account_reply(
                "group-stream", "状态结果", user_id="42", is_group=True
            )
        )
        self.assertFalse(result[0])
        self.assertEqual(sent_text, [])

    def test_binding_status_masks_user_identifier(self):
        masked = plugin._mask_identifier("alice@example.test")
        self.assertNotIn("alice@example.test", masked)
        self.assertEqual(masked, "a***")

    def test_sensitive_binding_message_recall_uses_adapter_api(self):
        recalled = []

        class FakeAdapter:
            async def delete_msg(self, message_id):
                recalled.append(message_id)
                return True

        context = {
            "message": {"message_id": "platform-message-1"},
            "adapter": FakeAdapter(),
        }
        self.assertTrue(asyncio.run(self.instance._recall_sensitive_message(context)))
        self.assertEqual(recalled, ["platform-message-1"])

    def test_sensitive_binding_message_recall_uses_host_tool(self):
        calls = []

        class FakeContext:
            async def call_capability(self, capability, **kwargs):
                calls.append((capability, kwargs))
                return {"success": True}

        self.instance.ctx = FakeContext()
        context = {
            "platform": "qq",
            "message": {
                "message_id": "platform-message-2",
                "message_info": {
                    "user_info": {"user_id": "42"},
                    "group_info": {"group_id": "2001"},
                },
            },
        }
        self.assertTrue(asyncio.run(self.instance._recall_sensitive_message(context, "group-stream")))
        self.assertEqual(len(calls), 1)
        capability, arguments = calls[0]
        self.assertEqual(capability, "tool.invoke")
        self.assertEqual(arguments["tool_name"], "recall_message")
        self.assertEqual(arguments["arguments"], {"message_id": "platform-message-2"})
        self.assertEqual(arguments["provider_plugin_id"], "maibot-team.snowluma-adapter")
        self.assertEqual(arguments["context"]["group_id"], "2001")

    def test_snowluma_recall_is_skipped_without_adapter_config(self):
        class FakeConfig:
            async def get_plugin(self, _plugin_name):
                return {}

        self.instance.ctx = SimpleNamespace(config=FakeConfig())
        self.assertFalse(asyncio.run(self.instance._recall_via_snowluma("message-3")))

    def test_snowluma_recall_uses_configured_websocket(self):
        sent = []

        class FakeSocket:
            def __init__(self):
                self.echo = ""
                self.receives = 0

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_args):
                return None

            async def send(self, payload):
                sent.append(payload)
                self.echo = __import__("json").loads(payload)["echo"]

            async def recv(self):
                self.receives += 1
                if self.receives == 1:
                    return '{"post_type":"meta_event"}'
                return __import__("json").dumps({"status": "ok", "retcode": 0, "echo": self.echo})

        class FakeWebsockets:
            @staticmethod
            def connect(_url, **_kwargs):
                return FakeSocket()

        class FakeConfig:
            async def get_plugin(self, _plugin_name):
                return {"client": {"server": "127.0.0.1", "port": 3001, "token": "secret"}}

        self.instance.ctx = SimpleNamespace(config=FakeConfig())
        with patch.dict(sys.modules, {"websockets": FakeWebsockets}):
            self.assertTrue(asyncio.run(self.instance._recall_via_snowluma("message-4")))
        self.assertTrue(any('"message_id": "message-4"' in item for item in sent))

    def test_my_usage_handler_survives_profile_failure(self):
        sent = []

        class FakeSend:
            async def text(self, message, stream_id):
                sent.append(message)

            async def hybrid(self, segments, stream_id):
                sent.append(segments[1]["data"])

        class FakeClient:
            async def get_usage_dashboard_stats(self):
                return {
                    "total_requests": 5,
                    "total_tokens": 900,
                    "today_requests": 2,
                    "today_tokens": 300,
                    "today_actual_cost": 0.02,
                }

            async def get_user_profile(self):
                raise plugin.KinghtAPIError("boom", status_code=500)

        async def fake_account_client(_key):
            return FakeClient()

        self.instance.ctx = SimpleNamespace(
            send=FakeSend(), paths=SimpleNamespace(data_dir=tempfile.mkdtemp())
        )
        self.instance._account_client = fake_account_client
        context = {"message": {"message_info": {"user_info": {"user_id": "42"}}}}
        result = asyncio.run(self.instance.handle_my_usage("stream-1", **context))
        self.assertTrue(result[0])
        self.assertIn("我的用量", sent[0])
        self.assertIn("请求 5", sent[0])

    def test_personal_info_default_triggers_and_hook(self):
        for source in ("/个人信息",):
            with self.subTest(source=source):
                self.assertEqual(self.instance._rewrite_custom_trigger_text(source), "/个人信息")
        self.assertIsNone(self.instance._rewrite_custom_trigger_text("/personal_info"))
        self.assertIsNone(self.instance._rewrite_custom_trigger_text("/PERSONAL_INFO"))
        self.instance.config.triggers = SimpleNamespace(personal_info_triggers="我的资料")
        result = asyncio.run(self.instance.handle_custom_triggers(
            message={"processed_plain_text": "/我的资料"}
        ))
        self.assertEqual(result["modified_kwargs"]["message"]["processed_plain_text"], "/个人信息")

    def test_personal_info_returns_current_bound_account_and_localized_reply(self):
        sent = []
        bound_keys = []

        class FakeSend:
            async def text(self, message, stream_id):
                sent.append((message, stream_id))

        class FakeClient:
            async def get_personal_info(self):
                return {
                    "id": 123,
                    "username": "示例昵称",
                    "balance": 12.5,
                    "concurrency": 10,
                    "current_concurrency": 2,
                    "current_rpm": 6,
                    "rpm_window_seconds": 60,
                    "email": "private@example.test",
                    "token": "private-token",
                }

        def bound_client(key):
            bound_keys.append(key)
            return FakeClient()

        self.instance.ctx = SimpleNamespace(send=FakeSend())
        self.instance._get_bound_client = bound_client
        context = {"message": {"platform": "qq", "user_info": {"user_id": "42"}}}
        result = asyncio.run(self.instance.handle_personal_info("private-stream", **context))

        self.assertEqual(bound_keys, ["qq:42"])
        self.assertTrue(result[0])
        self.assertEqual(sent, [(
            "👤 个人信息\n昵称：示例昵称\n用户 ID：123\n账户余额：$12.5\n"
            "总并发：10\n当前并发：2\n当前 RPM（近 60 秒）：6\n账号状态：已绑定",
            "private-stream",
        )])

    def test_personal_info_omits_missing_or_invalid_metrics_and_preserves_zero(self):
        for missing in ({}, {"balance": None, "concurrency": None,
                             "current_concurrency": None, "current_rpm": None},
                        {"balance": "bad", "concurrency": float("inf"),
                         "current_concurrency": True, "current_rpm": float("nan")}):
            with self.subTest(profile=missing):
                message = self.instance._format_personal_info(missing)
                self.assertEqual(message, "👤 个人信息\n昵称：未设置\n账号状态：bound")

        for limit in (0, -1):
            with self.subTest(limit=limit):
                message = self.instance._format_personal_info({
                    "id": 0,
                    "username": "  ",
                    "balance": 0,
                    "concurrency": limit,
                    "current_concurrency": 0,
                    "current_rpm": 0,
                })
                self.assertIn("昵称：未设置", message)
                self.assertIn("用户 ID：0", message)
                self.assertIn("账户余额：$0", message)
                self.assertIn("总并发：不限制", message)
                self.assertIn("当前并发：0", message)
                self.assertIn("当前 RPM（近 60 秒）：0", message)
                self.assertNotIn("暂不可用", message)

        message = self.instance._format_personal_info({"concurrency": 0, "current_concurrency": 3})
        self.assertIn("当前并发：3", message)

    def test_personal_info_money_has_up_to_six_decimal_places(self):
        for value, expected in ((12.5, "$12.5"), (0.1234567, "$0.123457"),
                                (0.000001, "$0.000001"), (-1.25, "$-1.25")):
            with self.subTest(value=value):
                message = self.instance._format_personal_info({"balance": value})
                self.assertIn(f"账户余额：{expected}\n", message)

    def test_personal_info_group_request_only_mentions_user_without_querying(self):
        sent = []

        class FakeSend:
            async def hybrid(self, segments, stream_id):
                sent.append((segments, stream_id))

        self.instance.ctx = SimpleNamespace(send=FakeSend())
        context = {"message": {"message_type": "group", "user_info": {"user_id": "42"},
                               "group_info": {"group_id": "9001"}}}
        with patch.object(self.instance, "_get_bound_client") as get_client:
            result = asyncio.run(self.instance.handle_personal_info("group-stream", **context))
            get_client.assert_not_called()

        self.assertFalse(result[0])
        self.assertEqual(sent[0][0][0], {"type": "at", "data": {"target_user_id": "42"}})
        self.assertIn("个人信息查询请私聊机器人执行。", sent[0][0][1]["data"])
        self.assertNotIn("账户余额", sent[0][0][1]["data"])

    def test_personal_info_unbound_guides_binding(self):
        sent = []

        class FakeSend:
            async def text(self, message, stream_id):
                sent.append(message)

        self.instance.ctx = SimpleNamespace(send=FakeSend())
        self.instance._get_bound_client = lambda _key: None
        result = asyncio.run(self.instance.handle_personal_info(
            "private-stream", message={"user_info": {"user_id": "42"}}
        ))

        self.assertFalse(result[0])
        self.assertIn("/绑定账号 <绑定码>", sent[0])
        self.assertIn("账号状态：未绑定", sent[0])

    def test_personal_info_errors_distinguish_missing_endpoint_and_invalid_binding(self):
        cases = [
            (plugin.KinghtAPIError("missing", status_code=404), "网站尚未提供个人信息接口", False),
            (plugin.KinghtAPIError("missing", status_code=404, code="BOT_BINDING_NOT_FOUND"),
             "账号状态：未找到绑定记录", True),
            (plugin.KinghtAPIError("missing", status_code=404, code="USER_NOT_FOUND"),
             "账号状态：绑定已失效", True),
            (plugin.KinghtAPIError("missing", status_code=404, metadata={"status": "binding_not_found"}),
             "账号状态：未找到绑定记录", False),
            (plugin.KinghtAPIError("expired", status_code=401, code="BOT_BINDING_INVALID"),
             "账号状态：绑定已失效", True),
            (plugin.KinghtAPIError("admin", status_code=401, code="INVALID_ADMIN_KEY"),
             "账号状态：配置错误", False),
            (plugin.KinghtAPIError("limited", status_code=429), "账号状态：请求过于频繁", False),
            (plugin.KinghtAPIError("查询超时"), "账号状态：请求超时", False),
            (plugin.KinghtAPIError("网络连接失败"), "账号状态：网络连接失败", False),
            (plugin.KinghtAPIError("failure", status_code=503), "账号状态：服务暂不可用", False),
        ]
        for error, expected, should_remove in cases:
            with self.subTest(error=error, expected=expected):
                sent = []
                removed = []

                class FakeSend:
                    async def text(self, message, stream_id):
                        sent.append(message)

                class FakeClient:
                    async def get_personal_info(self):
                        raise error

                self.instance.ctx = SimpleNamespace(send=FakeSend())
                self.instance._get_bound_client = lambda _key: FakeClient()
                self.instance._remove_binding = removed.append
                result = asyncio.run(self.instance.handle_personal_info(
                    "private-stream", message={"user_info": {"user_id": "42"}}
                ))

                self.assertFalse(result[0])
                self.assertIn(expected, sent[0])
                self.assertEqual(removed, ["qq:42"] if should_remove else [])

    def test_personal_info_rejects_malformed_response(self):
        sent = []

        class FakeSend:
            async def text(self, message, stream_id):
                sent.append(message)

        class FakeClient:
            async def get_personal_info(self):
                return []

        self.instance.ctx = SimpleNamespace(send=FakeSend())
        self.instance._get_bound_client = lambda _key: FakeClient()
        result = asyncio.run(self.instance.handle_personal_info(
            "private-stream", message={"user_info": {"user_id": "42"}}
        ))

        self.assertFalse(result[0])
        self.assertIn("账号状态：返回数据异常", sent[0])

    def test_usage_format_skips_missing_balance_and_shows_rpm(self):
        message = self.instance._format_account_usage(
            {
                "total_requests": 3,
                "total_tokens": 120,
                "today_requests": 1,
                "today_tokens": 40,
                "today_actual_cost": 0.01,
                "rpm": 2,
            },
            {},
        )
        self.assertIn("我的用量", message)
        self.assertNotIn("账户余额", message)
        self.assertIn("RPM 2", message)

    def test_status_values_are_localized_for_user_replies(self):
        cases = {
            "账号状态：bound": "账号状态：已绑定",
            "签到状态：success": "签到状态：成功",
            "签到状态：insufficient_usage": "签到状态：用量不足",
            "余额预警状态：platform_unsupported": "余额预警状态：不支持的平台",
            "诊断状态：unknown_backend_state": "诊断状态：未知状态",
        }
        for source, expected in cases.items():
            with self.subTest(source=source):
                self.assertEqual(plugin._localize_status_values(source), expected)

    def test_unknown_monitor_status_does_not_echo_english(self):
        self.assertEqual(plugin._status("maintenance_pending"), "未知")
        self.assertEqual(plugin._status("维护中"), "维护中")

    def test_account_error_messages_expose_status_and_reason(self):
        expectations = {
            429: "限流",
            503: "暂时不可用",
            500: "服务器出错",
            401: "绑定已失效",
        }
        for status_code, expected in expectations.items():
            message = self.instance._friendly_account_error(
                plugin.KinghtAPIError("站点返回失败", status_code=status_code)
            )
            self.assertIn(expected, message)

    def test_recall_is_skipped_without_onebot_configuration(self):
        self.instance.config = SimpleNamespace(onebot_api_base="", onebot_access_token="")
        self.assertFalse(asyncio.run(self.instance._recall_via_onebot("12345")))

    def test_key_usage_format_never_echoes_full_key(self):
        secret = "sk-super-secret-value"
        message = self.instance._format_key_usage(
            {"items": [{"id": 7, "name": "主 Key", "key": secret, "key_masked": "****alue"}]},
            {"stats": {"7": {"today_actual_cost": 0.5, "total_actual_cost": 1.25}}},
        )
        self.assertNotIn(secret, message)
        self.assertIn("主 Key", message)


if __name__ == "__main__":
    unittest.main()
