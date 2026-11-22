import asyncio
import unittest
from types import SimpleNamespace

from test_kinght_plugin_filters import plugin


class PrivateRouteTests(unittest.TestCase):
    def setUp(self):
        self.instance = object.__new__(plugin.KinghtStatusPlugin)
        self.opened = []
        self.looked_up = []

        async def open_session(**kwargs):
            self.opened.append(kwargs)
            raise AssertionError("Private alert routing must not create a session")

        async def getter(user_id, platform="qq"):
            self.looked_up.append((user_id, platform))
            raise AssertionError("Enumeration must not fall back to an arbitrary first stream")

        self.chat = SimpleNamespace(open_session=open_session, get_stream_by_user_id=getter)
        self.instance.ctx = SimpleNamespace(chat=self.chat)

    def tearDown(self):
        self.assertEqual(self.opened, [])

    @staticmethod
    def row(stream_id="owned-session", **overrides):
        return {
            "stream_id": stream_id,
            "platform": "qq",
            "user_id": "42",
            "account_id": "bot-1",
            "scope": "adapter-1",
            "chat_type": "private",
            "group_id": None,
            "is_group_session": False,
            **overrides,
        }

    def enumerate(self, payload):
        async def get_private_streams(platform="qq"):
            self.assertEqual(platform, "qq")
            return payload

        self.chat.get_private_streams = get_private_streams

    def resolve(self, platform="qq", user_id="42"):
        return asyncio.run(self.instance._private_alert_stream(platform, user_id))

    def legacy(self, payload):
        async def get_stream_by_user_id(user_id, platform="qq"):
            self.assertEqual((user_id, platform), ("42", "qq"))
            return payload

        self.chat.get_stream_by_user_id = get_stream_by_user_id

    def test_reuses_the_existing_owned_private_stream_without_opening_a_session(self):
        row = self.row()
        self.enumerate({"success": True, "streams": [row]})
        self.assertEqual(self.resolve(), "owned-session")
        self.assertEqual(row["account_id"], "bot-1")
        self.assertEqual(row["scope"], "adapter-1")
        self.assertEqual(self.looked_up, [])

    def test_filters_other_users_platforms_and_group_sessions(self):
        self.enumerate({"success": True, "streams": [
            self.row("wrong-user", user_id="99"),
            self.row("wrong-platform", platform="telegram"),
            self.row("group-id", group_id="100"),
            self.row("group-flag", is_group_session=True),
            self.row("group-type", chat_type="group"),
            self.row(),
        ]})
        self.assertEqual(self.resolve(), "owned-session")

    def test_prefers_owned_session_over_modern_unowned_sessions(self):
        self.enumerate({"success": True, "streams": [
            self.row("unowned-empty", account_id=""),
            self.row("unowned-null", account_id=None),
            self.row(),
        ]})
        self.assertEqual(self.resolve(), "owned-session")

    def test_rejects_empty_or_unrelated_enumeration_without_falling_back(self):
        for rows in ([], [self.row(user_id="99")], [self.row(account_id="")], [self.row(account_id=None)]):
            with self.subTest(rows=rows):
                self.enumerate({"success": True, "streams": rows})
                with self.assertRaises(RuntimeError):
                    self.resolve()
        self.assertEqual(self.looked_up, [])

    def test_rejects_multiple_bot_accounts_for_the_same_recipient(self):
        self.enumerate({"success": True, "streams": [
            self.row(), self.row("other-account", account_id="bot-2"),
        ]})
        with self.assertRaises(RuntimeError):
            self.resolve()
        self.assertEqual(self.looked_up, [])

    def test_rejects_multiple_scopes_for_the_same_bot_account(self):
        self.enumerate({"success": True, "streams": [
            self.row(), self.row("other-scope", scope="adapter-2"),
        ]})
        with self.assertRaises(RuntimeError):
            self.resolve()

    def test_deduplicates_identical_stream_entries(self):
        self.enumerate({"success": True, "streams": [self.row(), self.row()]})
        self.assertEqual(self.resolve(), "owned-session")

    def test_rejects_conflicting_ownership_for_the_same_stream_id(self):
        self.enumerate({"success": True, "streams": [self.row(), self.row(account_id="bot-2")]})
        with self.assertRaises(RuntimeError):
            self.resolve()

    def test_rejects_failed_or_malformed_enumeration(self):
        for payload in (
            {"success": False, "error": "denied", "streams": [self.row()]},
            {"error": "denied", "stream_id": "fake-session"},
            {"success": True}, {"success": True, "streams": None},
            {"success": True, "streams": "owned-session"},
            "{'success': False, 'error': 'denied'}", "42", False, None,
        ):
            with self.subTest(payload=payload):
                self.enumerate(payload)
                with self.assertRaises(RuntimeError):
                    self.resolve()
        self.assertEqual(self.looked_up, [])

    def test_lookup_exception_is_not_hidden_by_opening_a_session(self):
        async def get_private_streams(platform="qq"):
            raise RuntimeError("permission denied")

        self.chat.get_private_streams = get_private_streams
        with self.assertRaisesRegex(RuntimeError, "permission denied"):
            self.resolve()
        self.assertEqual(self.looked_up, [])

    def test_accepts_legacy_private_stream_list_without_account_fields(self):
        self.enumerate([{"id": "legacy-session", "platform": "qq", "user_id": 42}])
        self.assertEqual(self.resolve(), "legacy-session")

    def test_rejects_legacy_list_without_verified_recipient_metadata(self):
        for row in ({"stream_id": "unknown-session"}, "unknown-session", 42):
            with self.subTest(row=row):
                self.enumerate([row])
                with self.assertRaises(RuntimeError):
                    self.resolve()

    def test_accepts_legacy_getter_ids_and_mapping_envelopes(self):
        for payload in (
            "legacy-session", {"stream_id": "legacy-session"},
            {"success": True, "stream": {"session_id": "legacy-session"}},
            {"id": "legacy-session", "platform": "qq", "user_id": 42},
        ):
            with self.subTest(payload=payload):
                self.legacy(payload)
                self.assertEqual(self.resolve(), "legacy-session")

    def test_rejects_account_aware_singular_lookup_without_enumeration(self):
        for payload in (
            self.row(), self.row(account_id=""), self.row(account_id=None),
            {"success": True, "stream": self.row()},
            {"account_id": "", "stream": "legacy-session"},
        ):
            with self.subTest(payload=payload):
                self.legacy(payload)
                with self.assertRaises(RuntimeError):
                    self.resolve()

    def test_rejects_failed_lookup_dicts_serialized_dicts_raw_qq_and_non_ids(self):
        for payload in (
            {"success": False, "stream_id": "fake-session"},
            {"error": "lookup failed"}, {"success": True, "stream": None},
            "{'success': False, 'error': 'denied'}", "42", "99999", 42, True, False, None,
            "error", "none", "null", "failed", "bad stream id", object(),
            {"stream_id": ["fake-session"]},
        ):
            with self.subTest(payload=payload):
                self.legacy(payload)
                with self.assertRaises(RuntimeError):
                    self.resolve()

    def test_rejects_mismatched_legacy_getter_recipient_and_group_metadata(self):
        for payload in (
            {"id": "legacy-session", "platform": "telegram"},
            {"id": "legacy-session", "user_id": "99"},
            {"id": "legacy-session", "group_id": "100"},
            {"id": "legacy-session", "chat_type": "group"},
        ):
            with self.subTest(payload=payload):
                self.legacy(payload)
                with self.assertRaises(RuntimeError):
                    self.resolve()

    def test_supports_synchronous_legacy_getter(self):
        self.chat.get_stream_by_user_id = lambda user_id, platform="qq": "legacy-session"
        self.assertEqual(self.resolve(), "legacy-session")

    def test_requires_a_nonempty_recipient(self):
        for platform, user_id in (("", "42"), ("qq", ""), ("qq", "   ")):
            with self.subTest(platform=platform, user_id=user_id):
                with self.assertRaises(RuntimeError):
                    self.resolve(platform, user_id)

    def test_recharge_notification_uses_owned_stream_and_acks_only_after_send(self):
        self.enumerate({"success": True, "streams": [self.row()]})
        calls = []

        async def notifications():
            return {"items": [{"id": 7, "order_id": 12, "credited_amount": 1.4}]}

        async def send(message, stream):
            calls.append(("send", stream))
            return True

        async def ack(notification_id):
            calls.append(("ack", notification_id))

        self.instance._read_bindings = lambda: {"qq:42": {"platform": "qq", "external_id": "42"}}
        self.instance._make_bound_client = lambda *_args: SimpleNamespace(
            get_bot_recharge_notifications=notifications, ack_bot_recharge_notification=ack,
        )
        self.instance.ctx.send = SimpleNamespace(text=send)
        self.assertEqual(asyncio.run(self.instance._poll_recharge_notifications()), 1)
        self.assertEqual(calls, [("send", "owned-session"), ("ack", 7)])

    def test_unroutable_recharge_notification_is_neither_sent_nor_acknowledged(self):
        self.enumerate({"success": True, "streams": [self.row(account_id="")]})
        calls = []

        async def notifications():
            return {"items": [{"id": 7, "order_id": 12, "credited_amount": 1.4}]}

        async def forbidden(*args):
            calls.append(args)
            raise AssertionError("An unroutable notification must not be sent or acknowledged")

        self.instance._read_bindings = lambda: {"qq:42": {"platform": "qq", "external_id": "42"}}
        self.instance._make_bound_client = lambda *_args: SimpleNamespace(
            get_bot_recharge_notifications=notifications, ack_bot_recharge_notification=forbidden,
        )
        self.instance.ctx.send = SimpleNamespace(text=forbidden)
        self.assertEqual(asyncio.run(self.instance._poll_recharge_notifications()), 0)
        self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main()
