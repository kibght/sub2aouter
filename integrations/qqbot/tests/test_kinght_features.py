import ast
import asyncio
import re
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from test_kinght_plugin_filters import plugin


class FeatureTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.sent = []
        self.images = []
        self.instance = object.__new__(plugin.KinghtStatusPlugin)
        self.instance.config = SimpleNamespace(admin_user_ids="1001", allowed_group_ids="2001")

        async def text(message, stream):
            self.sent.append((message, stream))

        async def hybrid(segments, stream):
            self.images.append((segments, stream))

        self.instance.ctx = SimpleNamespace(
            paths=SimpleNamespace(data_dir=self.directory.name),
            send=SimpleNamespace(text=text, hybrid=hybrid),
        )
        self.context = {"message": {"user_info": {"user_id": "1001"}, "message_id": "original-1"}}
        self.group_context = {"message": {
            "user_info": {"user_id": "1001"}, "message_id": "original-1",
            "message_type": "group", "group_info": {"group_id": "2001"},
        }}

    def client(self, **methods):
        async def positive_balance():
            return {"balance": 1}
        methods.setdefault("get_personal_info", positive_balance)
        client = SimpleNamespace(**methods)

        async def bound(key):
            self.assertEqual(key, "qq:1001")
            return client

        self.instance._account_client = bound
        return client

    def test_all_english_aliases_are_removed_from_regex_and_legacy_config(self):
        tree = ast.parse(Path(plugin.__file__).read_text(encoding="utf-8"))
        patterns = []
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "Command":
                patterns += [re.compile(ast.literal_eval(item.value)) for item in node.keywords if item.arg == "pattern"]
        aliases = (
            "bind_account", "unbind_account", "account_binding_status", "bind_help", "bind_diagnose",
            "personal_info", "my_usage", "key_usage", "balance_alerts", "check_in", "check-in",
            "channel_status", "first_token_status", "kinght_status",
        )
        for alias in aliases:
            self.assertFalse(any(pattern.fullmatch("/" + alias) for pattern in patterns), alias)
        self.assertTrue(any(pattern.fullmatch("/Key用量") for pattern in patterns))
        self.assertTrue(any(pattern.fullmatch("/首Token状态") for pattern in patterns))
        self.assertEqual(plugin._configured_triggers("绑定账号,bind_account,BIND_ACCOUNT,Key用量,首Token", ""),
                         {"绑定账号", "Key用量", "首Token"})

    def test_help_filters_old_english_aliases_and_preserves_key_name(self):
        self.instance.config.triggers = SimpleNamespace(
            binding_help_triggers="绑定帮助,bind_help", key_usage_triggers="Key用量,key_usage",
            bind_account_triggers="绑定账号,bind_account", check_in_triggers="签到,check_in",
        )
        result = asyncio.run(self.instance.handle_account_binding_help("private", **self.context))
        self.assertTrue(result[0])
        message = self.sent[-1][0]
        for alias in ("/bind_help", "/key_usage", "/bind_account", "/check_in"):
            self.assertNotIn(alias, message)
        self.assertIn("/Key用量", message)
        self.assertIn("<QQ号或全部>", message)

    def test_recharge_is_rejected_in_group_before_any_client_request(self):
        async def forbidden(_key):
            self.fail("A group recharge must not access the client")
        self.instance._account_client = forbidden
        result = asyncio.run(self.instance.handle_recharge("group", **self.group_context))
        self.assertFalse(result[0])
        self.assertIn("私聊", result[1])

    def test_recharge_sends_existing_qr_and_uses_chinese_channel(self):
        calls = []
        async def create(amount, method, request_id):
            calls.append((amount, method, request_id))
            return {"order_id": 12, "status": "PENDING", "pay_amount": 10, "currency": "CNY",
                    "credited_amount": 1.4, "credited_currency": "USD", "qr_code_png_base64": "png",
                    "qr_code": "weixin://pay", "expires_at": "2026-11-21T15:00:00+08:00"}
        self.client(create_bot_recharge_order=create)
        result = asyncio.run(self.instance.handle_recharge(
            "private", matched_groups={"argument": "10 微信"}, **self.context))
        self.assertTrue(result[0])
        self.assertEqual(calls[0][:2], (10, "wxpay"))
        self.assertEqual(self.images[0][0][0]["binary_data_base64"], "png")
        self.assertIn("10 CNY", result[1])
        self.assertIn("1.4 USD", result[1])
        self.assertEqual(self.instance._read_pending_operations(), {})

    def test_recharge_options_distinguish_input_limits_from_channel_payment_limits(self):
        async def options():
            return {"enabled": True, "min_amount": 5, "max_amount": 100,
                    "methods": {"alipay": {"currency": "CNY", "min": 0, "max": 0}}}
        self.client(get_bot_recharge_options=options)
        result = asyncio.run(self.instance.handle_recharge("private", **self.context))
        self.assertTrue(result[0])
        self.assertIn("充值金额范围：5 至 100", result[1])
        self.assertIn("支付宝单笔支付范围：0 至 不限 CNY", result[1])

    def test_write_without_original_message_id_does_not_call_server(self):
        async def forbidden(_request_id):
            self.fail("A write without message identity must fail before network")
        self.client(draw_lottery=forbidden)
        result = asyncio.run(self.instance.handle_lottery(
            "private", message={"user_info": {"user_id": "1001"}}))
        self.assertFalse(result[0])

    def test_incomplete_success_payload_keeps_original_request_for_recovery(self):
        async def incomplete(_request_id):
            return {}
        self.client(draw_lottery=incomplete)
        result = asyncio.run(self.instance.handle_lottery("private", **self.context))
        self.assertFalse(result[0])
        self.assertIn("lottery:qq:1001", self.instance._read_pending_operations())

    def test_notification_and_batch_workers_are_cancelled_on_unload(self):
        instance = plugin.KinghtStatusPlugin()
        instance._get_client = lambda: None
        async def wait_forever():
            await asyncio.Event().wait()
        instance._balance_alert_loop = wait_forever
        instance._recharge_notification_loop = wait_forever
        instance._lottery_batch_loop = wait_forever
        instance._join_request_loop = wait_forever
        async def lifecycle():
            await instance.on_load()
            tasks = [instance._balance_alert_task, instance._recharge_notification_task,
                     instance._lottery_batch_task, instance._join_request_task]
            await instance.on_unload()
            self.assertTrue(all(task.done() for task in tasks))
            self.assertIsNone(instance._lottery_batch_task)
            self.assertIsNone(instance._recharge_notification_task)
        asyncio.run(lifecycle())

    def test_write_is_not_submitted_when_pending_record_cannot_be_saved(self):
        async def forbidden(_request_id):
            self.fail("Durable request identity must exist before the write")
        self.client(draw_lottery=forbidden)
        self.instance._write_pending_operations = lambda _pending: False
        result = asyncio.run(self.instance.handle_lottery("private", **self.context))
        self.assertFalse(result[0])
        self.assertIn("尚未提交", result[1])

    def test_qr_send_failure_preserves_order_and_explains_recovery(self):
        calls = []
        async def create(amount, method, request_id):
            calls.append(request_id)
            return {"order_id": 12, "status": "PENDING", "pay_amount": amount, "currency": "CNY",
                    "credited_amount": 1, "credited_currency": "USD", "qr_code_png_base64": "png",
                    "qr_code": "weixin://pay"}
        async def fail_image(_segments, _stream):
            return False
        self.client(create_bot_recharge_order=create)
        self.instance.ctx.send.hybrid = fail_image
        result = asyncio.run(self.instance.handle_recharge(
            "private", matched_groups={"argument": "10 微信"}, **self.context))
        self.assertTrue(result[0])
        self.assertIn("二维码暂时无法发送", result[1])
        self.assertIn("/充值订单 12", result[1])
        self.assertEqual(len(calls), 1)

    def test_lottery_timeout_survives_restart_and_reuses_original_request(self):
        request_ids = []
        async def timeout(request_id):
            request_ids.append(request_id)
            raise plugin.KinghtAPIError("站点请求超时")
        self.client(draw_lottery=timeout)
        first = asyncio.run(self.instance.handle_lottery("private", **self.context))
        self.assertFalse(first[0])
        restored = object.__new__(plugin.KinghtStatusPlugin)
        restored.ctx = self.instance.ctx
        restored.config = self.instance.config
        self.instance = restored
        async def recover(request_id):
            request_ids.append(request_id)
            return {"status": "success", "prize_name": "余额奖励", "reward": 0.12345678, "remaining": 1,
                    "replayed": True}
        self.client(draw_lottery=recover)
        changed_context = {"message": {"user_info": {"user_id": "1001"}, "message_id": "original-2"}}
        second = asyncio.run(self.instance.handle_lottery("private", **changed_context))
        self.assertTrue(second[0])
        self.assertEqual(request_ids[0], request_ids[1])
        self.assertIn("0.12345678", second[1])

    def test_unknown_write_is_not_replayed_into_a_different_binding(self):
        async def timeout(_request_id):
            raise plugin.KinghtAPIError("站点请求超时")
        self.instance._write_bindings({"qq:1001": {"bot_token": "first-binding"}})
        self.client(draw_lottery=timeout)
        asyncio.run(self.instance.handle_lottery("private", **self.context))
        self.instance._write_bindings({"qq:1001": {"bot_token": "new-binding"}})
        async def forbidden(_request_id):
            self.fail("The old operation must not be submitted under a new binding")
        self.client(draw_lottery=forbidden)
        result = asyncio.run(self.instance.handle_lottery("private", **self.context))
        self.assertFalse(result[0])
        self.assertIn("绑定已变更", result[1])

    def test_group_lottery_mentions_user_without_publishing_balance(self):
        async def draw(_request_id):
            return {"prize_name": "余额奖励", "reward": 0.5, "remaining": 0, "balance": 9876}
        self.client(draw_lottery=draw)
        result = asyncio.run(self.instance.handle_lottery("group", **self.group_context))
        self.assertTrue(result[0])
        self.assertEqual(self.images[0][0][0], {"type": "at", "data": {"target_user_id": "1001"}})
        self.assertNotIn("9876", result[1])

    def test_lottery_rejects_zero_and_negative_balance_without_drawing(self):
        for balance in (0, -1, -0.00000001):
            with self.subTest(balance=balance):
                async def profile():
                    return {"balance": balance}
                async def forbidden(_request_id):
                    self.fail("A non-positive balance must never submit a draw")
                self.client(get_personal_info=profile, draw_lottery=forbidden)
                result = asyncio.run(self.instance.handle_lottery("private", **self.context))
                self.assertFalse(result[0])
                self.assertEqual(result[1], "余额不足")
                self.assertEqual(self.instance._read_pending_operations(), {})

    def test_lottery_accepts_smallest_positive_balance_after_reading_profile(self):
        calls = []
        async def profile():
            calls.append("balance")
            return {"balance": 0.00000001}
        async def draw(_request_id):
            calls.append("draw")
            return {"prize_name": "余额奖励", "reward": 0, "remaining": 1}
        self.client(get_personal_info=profile, draw_lottery=draw)
        result = asyncio.run(self.instance.handle_lottery("private", **self.context))
        self.assertTrue(result[0])
        self.assertEqual(calls, ["balance", "draw"])

    def test_lottery_fails_closed_when_balance_cannot_be_verified(self):
        for profile_value in ({}, {"balance": None}, {"balance": "NaN"}, {"balance": "Infinity"}, {"balance": True}):
            with self.subTest(profile=profile_value):
                async def profile():
                    return profile_value
                async def forbidden(_request_id):
                    self.fail("An unverified balance must never submit a draw")
                self.client(get_personal_info=profile, draw_lottery=forbidden)
                result = asyncio.run(self.instance.handle_lottery("private", **self.context))
                self.assertFalse(result[0])
                self.assertEqual(self.instance._read_pending_operations(), {})

    def test_all_user_grant_persists_and_reports_completion_after_restart(self):
        calls = []
        async def grant(target, count, notes, request_id):
            calls.append((target, count, notes, request_id))
            return {"batch_id": 7, "status": "pending", "total": 30, "success": 0, "pending": 30}
        self.client(grant_lottery_plays=grant)
        self.instance._write_bindings({"qq:1001": {"bot_token": "bound-token", "platform": "qq", "external_id": "1001"}})
        result = asyncio.run(self.instance.handle_lottery_grant(
            "private", matched_groups={"argument": "全部 3 周末活动"}, **self.context))
        self.assertTrue(result[0])
        self.assertEqual(calls[0][:3], ("all", 3, "周末活动"))
        self.assertIn("7", self.instance._read_lottery_batches())
        async def batch(_batch_id):
            return {"batch_id": 7, "status": "completed", "total": 30, "success": 29, "skipped": 1}
        client = SimpleNamespace(get_lottery_grant_batch=batch)
        self.instance._make_bound_client = lambda _key, _record: client
        async def private_stream(_platform, _user_id):
            return "private-restored"
        self.instance._private_alert_stream = private_stream
        self.assertEqual(asyncio.run(self.instance._poll_lottery_grant_batches()), 1)
        self.assertIn("成功：29", self.sent[-1][0])
        self.assertIn("跳过：1", self.sent[-1][0])
        self.assertEqual(self.instance._read_lottery_batches(), {})

    def test_non_admin_cannot_issue_grants(self):
        async def forbidden(_key):
            self.fail("Non-admin must be rejected before network")
        self.instance._account_client = forbidden
        result = asyncio.run(self.instance.handle_lottery_grant(
            "private", message={"user_info": {"user_id": "9999"}, "message_id": "m"},
            matched_groups={"argument": "全部 3"}))
        self.assertFalse(result[0])
        self.assertIn("管理员", result[1])

    def test_target_binding_not_found_does_not_remove_admin_binding(self):
        async def missing_target(*_args):
            raise plugin.KinghtAPIError("target binding missing", code="BOT_BINDING_NOT_FOUND", status_code=404)
        self.instance._write_bindings({"qq:1001": {"bot_token": "admin-binding"}})
        self.client(grant_lottery_plays=missing_target)
        result = asyncio.run(self.instance.handle_lottery_grant(
            "private", matched_groups={"argument": "98765 3"}, **self.context))
        self.assertFalse(result[0])
        self.assertIn("目标 QQ", result[1])
        self.assertIn("qq:1001", self.instance._read_bindings())

    def test_recharge_ack_happens_only_after_successful_private_send(self):
        acknowledged = []
        async def notifications():
            return {"items": [{"id": 1, "order_id": 9, "credited_amount": 1},
                              {"id": 2, "order_id": 10, "credited_amount": 2}]}
        async def ack(notification_id):
            acknowledged.append(notification_id)
        client = SimpleNamespace(get_bot_recharge_notifications=notifications, ack_bot_recharge_notification=ack)
        self.instance._write_bindings({"qq:1001": {"bot_token": "bound-token", "platform": "qq", "external_id": "1001"}})
        self.instance._make_bound_client = lambda _key, _record: client
        async def stream(_platform, _user):
            return "private"
        self.instance._private_alert_stream = stream
        count = 0
        async def send(message, _stream):
            nonlocal count
            count += 1
            return count == 2
        self.instance.ctx.send.text = send
        self.assertEqual(asyncio.run(self.instance._poll_recharge_notifications()), 1)
        self.assertEqual(acknowledged, [2])


if __name__ == "__main__":
    unittest.main()
