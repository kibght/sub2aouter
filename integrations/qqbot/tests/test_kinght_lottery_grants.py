import asyncio
import tempfile
import unittest
from types import SimpleNamespace

from test_kinght_plugin_filters import plugin


class LotteryGrantContextTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.instance = object.__new__(plugin.KinghtStatusPlugin)
        self.instance.config = SimpleNamespace(admin_user_ids="1001", allowed_group_ids="2001")
        self.texts = []
        self.hybrids = []
        self.clients = []
        self.calls = []

        async def text(message, stream):
            self.texts.append((message, stream))
            return True

        async def hybrid(segments, stream):
            self.hybrids.append((segments, stream))
            return True

        async def grant(target, count, notes, request_id):
            self.calls.append(("grant", target, count, notes, request_id))
            if target == "all":
                return {"batch_id": 7, "status": "pending", "count": count,
                        "total": 3, "success": 0, "pending": 3}
            return {"status": "success", "count": count, "remaining": 5}

        async def batch(batch_id):
            self.calls.append(("query", batch_id))
            return {"batch_id": 7, "status": "completed", "count": 3,
                    "total": 3, "success": 3, "skipped": 0, "pending": 0}

        async def account_client(key):
            self.clients.append(key)
            return SimpleNamespace(grant_lottery_plays=grant, get_lottery_grant_batch=batch)

        self.instance.ctx = SimpleNamespace(
            paths=SimpleNamespace(data_dir=directory.name),
            send=SimpleNamespace(text=text, hybrid=hybrid),
        )
        self.instance._account_client = account_client

    @staticmethod
    def context(*, group=False, user_id="1001", group_id="2001"):
        message = {"user_info": {"user_id": user_id}, "message_id": "original-1"}
        if group:
            message.update(message_type="group", group_info={"group_id": group_id})
        return {"message": message}

    def invoke(self, argument, **context_options):
        return asyncio.run(self.instance.handle_lottery_grant(
            "group-stream" if context_options.get("group") else "private-stream",
            matched_groups={"argument": argument}, **self.context(**context_options),
        ))

    def assert_group_reply(self, result, user_id="1001"):
        self.assertEqual(self.texts, [])
        self.assertEqual(len(self.hybrids), 1)
        segments, stream = self.hybrids[0]
        self.assertEqual(stream, "group-stream")
        self.assertEqual(segments[0], {"type": "at", "data": {"target_user_id": user_id}})
        self.assertEqual(segments[1], {"type": "text", "data": f" {result[1]}"})

    def test_admin_group_single_grant_uses_the_operator_binding_and_mentions_operator(self):
        result = self.invoke("98765 3 event", group=True)
        self.assertTrue(result[0])
        self.assertEqual(self.clients, ["qq:1001"])
        self.assertEqual(self.calls[0][:4], ("grant", "98765", 3, "event"))
        self.assertTrue(self.calls[0][4])
        self.assert_group_reply(result)

    def test_admin_group_all_user_grant_preserves_actor_for_private_completion(self):
        result = self.invoke("全部 3 event", group=True)
        self.assertTrue(result[0])
        self.assertEqual(self.clients, ["qq:1001"])
        self.assertEqual(self.calls[0][:4], ("grant", "all", 3, "event"))
        self.assertEqual(self.instance._read_lottery_batches()["7"], {
            "binding_key": "qq:1001", "platform": "qq", "external_id": "1001", "count": "3",
        })
        self.assert_group_reply(result)

    def test_admin_group_batch_query_mentions_operator_without_creating_a_grant(self):
        result = self.invoke("查询 7", group=True)
        self.assertTrue(result[0])
        self.assertEqual(self.clients, ["qq:1001"])
        self.assertEqual(self.calls, [("query", "7")])
        self.assertEqual(self.instance._read_pending_operations(), {})
        self.assert_group_reply(result)

    def test_admin_private_grant_and_query_remain_available(self):
        for argument in ("98765 3 event", "全部 3 event", "查询 7"):
            with self.subTest(argument=argument):
                self.clients.clear()
                self.calls.clear()
                self.texts.clear()
                result = self.invoke(argument)
                self.assertTrue(result[0])
                self.assertEqual(self.clients, ["qq:1001"])
                self.assertEqual(len(self.calls), 1)
                self.assertEqual(self.hybrids, [])
                self.assertEqual(self.texts, [(result[1], "private-stream")])

    def test_non_admin_group_and_private_grants_and_queries_make_no_api_calls(self):
        for group in (False, True):
            for argument in ("98765 3 event", "全部 3 event", "查询 7"):
                with self.subTest(group=group, argument=argument):
                    self.texts.clear()
                    self.hybrids.clear()
                    result = self.invoke(argument, group=group, user_id="9999")
                    self.assertFalse(result[0])
                    self.assertIn("管理员", result[1])
                    self.assertEqual(self.clients, [])
                    self.assertEqual(self.calls, [])
                    if group:
                        self.assert_group_reply(result, "9999")
                    else:
                        self.assertEqual(self.texts, [(result[1], "private-stream")])

    def test_admin_outside_group_whitelist_cannot_grant_or_query(self):
        for argument in ("98765 3 event", "全部 3 event", "查询 7"):
            with self.subTest(argument=argument):
                self.hybrids.clear()
                result = self.invoke(argument, group=True, group_id="9001")
                self.assertFalse(result[0])
                self.assertIn("白名单", result[1])
                self.assertEqual(self.clients, [])
                self.assertEqual(self.calls, [])
                self.assert_group_reply(result)

    def test_group_reply_failure_does_not_publish_an_unmentioned_plain_reply(self):
        async def failed_hybrid(segments, stream):
            self.hybrids.append((segments, stream))
            return False

        self.instance.ctx.send.hybrid = failed_hybrid
        result = self.invoke("查询 7", group=True)
        self.assertFalse(result[0])
        self.assertFalse(result[2])
        self.assertEqual(self.calls, [("query", "7")])
        self.assert_group_reply(result)

    def test_help_describes_both_admin_commands_as_group_and_private(self):
        result = asyncio.run(self.instance.handle_account_binding_help(
            "private-stream", **self.context(),
        ))
        self.assertTrue(result[0])
        self.assertEqual(result[1].count("（管理员，群聊和私聊都可以）"), 2)
        self.assertNotIn("（管理员私聊）", result[1])
        self.assertEqual(self.clients, [])
        self.assertEqual(self.calls, [])


if __name__ == "__main__":
    unittest.main()
