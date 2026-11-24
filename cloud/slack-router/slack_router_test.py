#!/usr/bin/env python3
import base64
import hashlib
import json
import os
import socket
import struct
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler
from typing import Any

_HERE = os.path.dirname(os.path.abspath(__file__))
_BROKER_DIR = os.path.abspath(os.path.join(_HERE, "..", "mac-job-broker"))
sys.path.insert(0, _HERE)
sys.path.insert(0, _BROKER_DIR)

from broker import BrokerStore, ThreadingHTTPServer, make_handler
from slack_router import (
    BrokerError,
    BrokerHttpClient,
    BrokerProducerClient,
    RouterConfig,
    RouterStore,
    SlackApiClient,
    SlackRouter,
    chunk_slack_text,
    has_local_only_path,
    markdown_to_mrkdwn,
    parse_incoming_command,
)
from ws_client import SimpleWebSocket


class _FakeEc2Bot:
    def __init__(self, reply: str = "EC2_CLOUD_REPLY_OK") -> None:
        self.calls: list[tuple[str, str]] = []
        self.reply = reply

    def ask(self, bot_name: str, text: str, **_kwargs: Any) -> str:
        self.calls.append((bot_name, text))
        return self.reply


class SlackRouterTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmpdir = tempfile.TemporaryDirectory()
        self.broker_db = os.path.join(self.tmpdir.name, "broker.db")
        self.router_db = os.path.join(self.tmpdir.name, "router.db")
        self.broker_store = BrokerStore(self.broker_db)
        self.broker_srv = ThreadingHTTPServer(
            ("127.0.0.1", 0),
            make_handler(self.broker_store, producer_token="prod-tok", worker_token="work-tok"),
        )
        threading.Thread(target=self.broker_srv.serve_forever, daemon=True).start()
        self.broker_url = f"http://127.0.0.1:{self.broker_srv.server_address[1]}"

        self.slack_calls: list[tuple[str, dict[str, Any]]] = []
        slack_calls = self.slack_calls

        class FakeSlackHandler(BaseHTTPRequestHandler):
            def log_message(self, fmt: str, *args: Any) -> None:
                return

            def do_POST(self) -> None:
                length = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(length).decode("utf-8")) if length else {}
                method = self.path.lstrip("/")
                slack_calls.append((method, body))
                resp: dict[str, Any] = {"ok": True}
                if method == "auth.test":
                    resp["user_id"] = "U_BOT"
                    resp["user"] = "dsbot"
                out = json.dumps(resp).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(out)))
                self.end_headers()
                self.wfile.write(out)

        self.slack_srv = ThreadingHTTPServer(("127.0.0.1", 0), FakeSlackHandler)
        threading.Thread(target=self.slack_srv.serve_forever, daemon=True).start()
        self.slack_api_base = f"http://127.0.0.1:{self.slack_srv.server_address[1]}"

        self.cfg = RouterConfig(
            slack_app_token="xapp-test-token-1234567890",
            slack_bot_token="xoxb-test-token-1234567890",
            slack_api_base=self.slack_api_base,
            broker_url=self.broker_url,
            broker_producer_token="prod-tok",
            db_path=self.router_db,
        )
        self.store = RouterStore(self.router_db)
        self.slack = SlackApiClient(self.cfg.slack_app_token, self.cfg.slack_bot_token, self.slack_api_base)
        self.broker = BrokerProducerClient(self.broker_url, "prod-tok")
        self.ec2 = _FakeEc2Bot()
        self.router = SlackRouter(
            config=self.cfg,
            store=self.store,
            slack=self.slack,
            broker=self.broker,
            ec2_dsbot=self.ec2,
            self_user_id="U_BOT",
        )

    def tearDown(self) -> None:
        self.router.stop()
        self.store.close()
        self.slack_srv.shutdown()
        self.slack_srv.server_close()
        self.broker_srv.shutdown()
        self.broker_srv.server_close()
        self.broker_store.close()
        self.tmpdir.cleanup()

    def test_ws_client_handshake_ping_pong_and_text(self) -> None:
        srv_sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        srv_sock.bind(("127.0.0.1", 0))
        srv_sock.listen(1)
        port = srv_sock.getsockname()[1]
        received: list[str] = []

        def server_fn() -> None:
            conn, _ = srv_sock.accept()
            with conn:
                req = conn.recv(4096).decode("latin-1")
                key_line = [ln for ln in req.split("\r\n") if ln.lower().startswith("sec-websocket-key:")][0]
                key = key_line.split(":", 1)[1].strip()
                accept = base64.b64encode(
                    hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()
                ).decode()
                conn.sendall(
                    f"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n".encode()
                )
                # Send ping frame first, then unmasked text frame
                conn.sendall(bytes([0x89, 2]) + b"hi")
                msg = b'{"type":"hello"}'
                conn.sendall(bytes([0x81, len(msg)]) + msg)
                # Read client pong + echo text
                conn.settimeout(2.0)
                data = conn.recv(1024)
                received.append(data.hex())

        th = threading.Thread(target=server_fn, daemon=True)
        th.start()
        try:
            ws = SimpleWebSocket.connect(f"ws://127.0.0.1:{port}/", timeout=2.0)
            try:
                txt = ws.recv_text(timeout=2.0)
                self.assertEqual(txt, '{"type":"hello"}')
                ws.send_text('{"ack":true}')
            finally:
                ws.close()
            th.join(timeout=2.0)
            self.assertTrue(received)
        finally:
            srv_sock.close()

    def test_command_parser_overrides_and_local_only_detection(self) -> None:
        c1 = parse_incoming_command(
            "<@U_BOT> @Chief check status",
            channel="C0CKX41QVRQ",
            self_user_id="U_BOT",
            known_bots=self.cfg.known_bots,
            known_groups=self.cfg.known_groups,
        )
        self.assertEqual(c1.action, "message")
        self.assertEqual(c1.bot, "Chief")
        self.assertIsNone(c1.group)
        self.assertEqual(c1.text, "check status")
        self.assertFalse(c1.local_only)

        c2 = parse_incoming_command(
            "@group:1+1 Routing audit /Users/chief/ds-bot-dev/src",
            channel="D0CKFEVJF0X",
            known_bots=self.cfg.known_bots,
            known_groups=self.cfg.known_groups,
        )
        self.assertEqual(c2.group, "1+1 Routing")
        self.assertIsNone(c2.bot)
        self.assertTrue(c2.local_only)
        self.assertTrue(has_local_only_path("open ~/Downloads/part.step"))

        c3 = parse_incoming_command("/move-to-cloud --force mac_123")
        self.assertEqual(c3.action, "move_to_cloud")
        self.assertEqual(c3.job_id, "mac_123")
        self.assertTrue(c3.force)

    def test_chunk_slack_text_and_mrkdwn(self) -> None:
        self.assertIn("*bold* and _italic_ and <https://example.com|link>", markdown_to_mrkdwn("**bold** and *italic* and [link](https://example.com)"))
        long_code = "```python\n" + ("print('x')\n" * 60) + "```"
        chunks = chunk_slack_text(long_code, limit=300)
        self.assertGreater(len(chunks), 1)
        for ch in chunks:
            self.assertLessEqual(len(ch), 310)
            self.assertEqual(ch.count("```") % 2, 0)

    def test_mac_online_allowlist_dedup_and_reply(self) -> None:
        self.broker_store.touch_worker("mac-mini", "mini", ["dsbot"])

        # Unauthorized user is silently ignored
        self.router.dispatch_envelope(
            {
                "envelope_id": "e0",
                "type": "events_api",
                "payload": {
                    "event_id": "Ev0",
                    "event": {"type": "message", "channel_type": "im", "channel": "D0CKFEVJF0X", "user": "U_STRANGER", "text": "hi", "ts": "100.1"},
                },
            },
            async_work=False,
        )
        self.assertEqual(self.broker_store.list_jobs(), [])

        # Bot-origin event is ignored
        self.router.dispatch_envelope(
            {
                "envelope_id": "e_bot",
                "type": "events_api",
                "payload": {
                    "event_id": "EvBot",
                    "event": {"type": "message", "channel_type": "im", "channel": "D0CKFEVJF0X", "user": "U0C2NC6ARAQ", "bot_id": "B1", "text": "loop", "ts": "100.2"},
                },
            },
            async_work=False,
        )
        self.assertEqual(self.broker_store.list_jobs(), [])

        # Allowed user DM routes to Devin Manager; duplicate event_id ignored
        env = {
            "envelope_id": "e1",
            "type": "events_api",
            "payload": {
                "event_id": "Ev1",
                "event": {"type": "message", "channel_type": "im", "channel": "D0CKFEVJF0X", "user": "U0C2NC6ARAQ", "text": "status update", "ts": "100.3"},
            },
        }
        self.router.dispatch_envelope(env, async_work=False)
        self.router.dispatch_envelope(env, async_work=False)
        jobs = self.broker_store.list_jobs()
        self.assertEqual(len(jobs), 1)
        self.assertEqual(jobs[0]["bot"], "Devin Manager")

        claimed = self.broker_store.claim_next_job("mac-mini")
        self.broker_store.complete_job(
            {"job_id": claimed["job_id"], "worker_id": "mac-mini", "status": "succeeded", "result_summary": "ALL_CLEAR"}
        )
        done = self.router.watch_tracked_jobs_once()
        self.assertEqual(done, 1)
        posts = [b for m, b in self.slack_calls if m == "chat.postMessage"]
        self.assertTrue(any("ALL_CLEAR" in p["text"] and p["thread_ts"] == "100.3" for p in posts))

    def test_mac_offline_queue_local_only_guard_and_move_to_cloud(self) -> None:
        # Mac offline + local path -> queued with local_only=True
        self.router.dispatch_envelope(
            {
                "envelope_id": "e2",
                "type": "events_api",
                "payload": {
                    "event_id": "Ev2",
                    "event": {"type": "message", "channel_type": "im", "channel": "D0CKFEVJF0X", "user": "U0C2NC6ARAQ", "text": "inspect /Users/chief/Desktop/part.step", "ts": "200.1"},
                },
            },
            async_work=False,
        )
        jobs = self.broker_store.list_jobs()
        self.assertEqual(len(jobs), 1)
        jid_local = jobs[0]["job_id"]
        self.assertTrue(jobs[0]["local_only"])

        # /move-to-cloud refuses local_only job without --force
        self.slack_calls.clear()
        self.router.dispatch_envelope(
            {
                "envelope_id": "e3",
                "type": "events_api",
                "payload": {
                    "event_id": "Ev3",
                    "event": {"type": "message", "channel_type": "im", "channel": "D0CKFEVJF0X", "user": "U0C2NC6ARAQ", "text": f"/move-to-cloud {jid_local}", "ts": "200.2"},
                },
            },
            async_work=False,
        )
        self.assertEqual(self.ec2.calls, [])
        posts = [b["text"] for m, b in self.slack_calls if m == "chat.postMessage"]
        self.assertTrue(any("local_only" in t for t in posts))
        self.assertEqual(self.broker_store.get_job(jid_local)["status"], "queued")

        # Enqueue non-local job while offline, then /move-to-cloud cancels it and runs on EC2 + records cloud_note
        self.router.dispatch_envelope(
            {
                "envelope_id": "e4",
                "type": "events_api",
                "payload": {
                    "event_id": "Ev4",
                    "event": {"type": "message", "channel_type": "im", "channel": "D0CKFEVJF0X", "user": "U0C2NC6ARAQ", "text": "summarize PR 21", "ts": "200.3"},
                },
            },
            async_work=False,
        )
        jid_remote = [j["job_id"] for j in self.broker_store.list_jobs() if j["job_id"] != jid_local][0]
        self.slack_calls.clear()
        self.router.dispatch_envelope(
            {
                "envelope_id": "e5",
                "type": "events_api",
                "payload": {
                    "event_id": "Ev5",
                    "event": {"type": "message", "channel_type": "im", "channel": "D0CKFEVJF0X", "user": "U0C2NC6ARAQ", "text": f"/move-to-cloud {jid_remote}", "ts": "200.4"},
                },
            },
            async_work=False,
        )
        self.assertEqual(self.broker_store.get_job(jid_remote)["status"], "cancelled")
        self.assertEqual(self.ec2.calls, [("Chief", "summarize PR 21")])
        notes = self.broker_store.list_cloud_notes()
        self.assertEqual(len(notes), 1)
        self.assertIn("EC2_CLOUD_REPLY_OK", notes[0]["reply_excerpt"])

    def test_lease_lost_notifies_without_ec2_retry(self) -> None:
        self.broker_store.touch_worker("mac-mini", "mini", ["dsbot"])
        self.router.dispatch_envelope(
            {
                "envelope_id": "e6",
                "type": "events_api",
                "payload": {
                    "event_id": "Ev6",
                    "event": {"type": "message", "channel_type": "im", "channel": "D0CKFEVJF0X", "user": "U0C2NC6ARAQ", "text": "long task", "ts": "300.1"},
                },
            },
            async_work=False,
        )
        job = self.broker_store.claim_next_job("mac-mini", lease_ttl_sec=1)
        with self.broker_store._lock:
            self.broker_store.conn.execute(
                "UPDATE jobs SET status = 'lease_lost' WHERE job_id = ?", (job["job_id"],)
            )
            self.broker_store.conn.commit()
        done = self.router.watch_tracked_jobs_once()
        self.assertEqual(done, 1)
        self.assertEqual(self.ec2.calls, [])
        posts = [b["text"] for m, b in self.slack_calls if m == "chat.postMessage"]
        self.assertTrue(any("lease_lost" in t for t in posts))

    def test_parse_decision_commands(self) -> None:
        d1 = parse_incoming_command("/decisions", self_user_id="U_BOT")
        self.assertEqual(d1.action, "decisions")
        d2 = parse_incoming_command("<@U_BOT> /waiting", self_user_id="U_BOT")
        self.assertEqual(d2.action, "decisions")

        c_num = parse_incoming_command("<@U_BOT> /decide dec_abc 2 | ship it", self_user_id="U_BOT")
        self.assertEqual(c_num.action, "decide")
        self.assertEqual(c_num.decision_id, "dec_abc")
        self.assertEqual(c_num.choice, "2")
        self.assertEqual(c_num.note, "ship it")

        c_text = parse_incoming_command("/decide dec_xyz Use Postgres | safer ACID", self_user_id="U_BOT")
        self.assertEqual(c_text.action, "decide")
        self.assertEqual(c_text.decision_id, "dec_xyz")
        self.assertEqual(c_text.choice, "Use Postgres")
        self.assertEqual(c_text.note, "safer ACID")

        c_missing = parse_incoming_command("/decide dec_only", self_user_id="U_BOT")
        self.assertEqual(c_missing.action, "decide")
        self.assertEqual(c_missing.decision_id, "dec_only")
        self.assertEqual(c_missing.choice, "")

        c_empty = parse_incoming_command("/decide", self_user_id="U_BOT")
        self.assertEqual(c_empty.action, "decide")
        self.assertEqual(c_empty.decision_id, "")
        self.assertEqual(c_empty.choice, "")

        a_default = parse_incoming_command("<@U_BOT> /approve dec_app | looks good", self_user_id="U_BOT")
        self.assertEqual(a_default.action, "decide")
        self.assertEqual(a_default.decision_id, "dec_app")
        self.assertEqual(a_default.choice, "1")
        self.assertEqual(a_default.note, "looks good")

        a_choice = parse_incoming_command("/approve dec_app 3", self_user_id="U_BOT")
        self.assertEqual(a_choice.action, "decide")
        self.assertEqual(a_choice.decision_id, "dec_app")
        self.assertEqual(a_choice.choice, "3")
        self.assertEqual(a_choice.note, "")

        a_empty = parse_incoming_command("/approve", self_user_id="U_BOT")
        self.assertEqual(a_empty.action, "decide")
        self.assertEqual(a_empty.decision_id, "")

    def test_router_config_alert_channel_from_env(self) -> None:
        saved = {
            k: os.environ.get(k)
            for k in ("SLACK_ALERT_CHANNEL", "SLACK_CHANNEL_MAP")
        }
        try:
            os.environ.pop("SLACK_ALERT_CHANNEL", None)
            os.environ["SLACK_CHANNEL_MAP"] = "C111=Chief,D222=Coder"
            cfg1 = RouterConfig.from_env()
            self.assertEqual(cfg1.alert_channel, "C111")

            os.environ["SLACK_ALERT_CHANNEL"] = "C999"
            cfg2 = RouterConfig.from_env()
            self.assertEqual(cfg2.alert_channel, "C999")

            os.environ.pop("SLACK_ALERT_CHANNEL", None)
            os.environ["SLACK_CHANNEL_MAP"] = ""
            cfg3 = RouterConfig.from_env()
            self.assertEqual(cfg3.alert_channel, "")
        finally:
            for k, v in saved.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v

    def test_broker_client_decisions_and_status_errors(self) -> None:
        self.assertIs(BrokerHttpClient, BrokerProducerClient)
        self.assertIsNone(self.broker.get_decision("dec_missing"))

        with self.assertRaises(BrokerError) as ctx_404:
            self.broker.resolve_decision("dec_missing", choice="1")
        self.assertEqual(ctx_404.exception.status_code, 404)

        dec_q, _ = self.broker_store.create_decision(
            {
                "title": "Select deploy region",
                "context": "Need low-latency region",
                "options": ["us-east-1", "us-west-2"],
                "kind": "question",
                "source_env": "mac_waiting",
                "source_bot": "Chief",
            }
        )
        got = self.broker.get_decision(dec_q["decision_id"])
        self.assertIsNotNone(got)
        self.assertEqual(got["title"], "Select deploy region")
        listed = self.broker.list_decisions(status="pending", limit=20)
        self.assertEqual([d["decision_id"] for d in listed], [dec_q["decision_id"]])

    def test_watch_pending_decisions_once_dedup_question_and_approval(self) -> None:
        d_q, _ = self.broker_store.create_decision(
            {
                "title": "Pick storage engine",
                "context": "Ledger needs transactions for multi-row updates.",
                "options": ["SQLite", "Postgres"],
                "kind": "question",
                "card_id": "card_q_1",
                "source_env": "mac_waiting",
                "source_bot": "Coder",
                "idempotency_key": "dsbot_q:card_q_1",
            }
        )
        time.sleep(0.01)
        d_app, _ = self.broker_store.create_decision(
            {
                "title": "Approve bash tool",
                "context": "Run git status in repo",
                "options": [],
                "kind": "approval",
                "card_id": "card_a_1",
                "source_env": "mac_waiting",
                "source_bot": "Devin Manager",
                "idempotency_key": "dsbot_a:card_a_1",
            }
        )

        # Disabled when alert_channel is empty
        self.assertEqual(self.router.watch_pending_decisions_once(), 0)
        self.assertEqual(self.slack_calls, [])

        self.router.config.alert_channel = "C0CKX41QVRQ"
        posted_count = self.router.watch_pending_decisions_once()
        self.assertEqual(posted_count, 2)

        posts = [b for m, b in self.slack_calls if m == "chat.postMessage"]
        self.assertEqual(len(posts), 2)
        for p in posts:
            self.assertEqual(p["channel"], "C0CKX41QVRQ")
            self.assertNotIn("thread_ts", p)

        # Oldest-first order: question then approval
        self.assertIn(d_q["decision_id"], posts[0]["text"])
        self.assertIn("[question]", posts[0]["text"])
        self.assertIn("Coder", posts[0]["text"])
        self.assertIn("Pick storage engine", posts[0]["text"])
        self.assertIn("Ledger needs transactions", posts[0]["text"])
        self.assertIn("1. SQLite", posts[0]["text"])
        self.assertIn("2. Postgres", posts[0]["text"])
        self.assertIn(f"/decide {d_q['decision_id']} 1", posts[0]["text"])

        self.assertIn(d_app["decision_id"], posts[1]["text"])
        self.assertIn("[approval]", posts[1]["text"])
        self.assertIn("Devin Manager", posts[1]["text"])
        self.assertIn("Approve bash tool", posts[1]["text"])
        self.assertIn(":lock: Approve in DS Bot.app on Mac", posts[1]["text"])
        self.assertNotIn("/decide", posts[1]["text"])

        # Deduplication: second poll posts nothing
        self.slack_calls.clear()
        self.assertEqual(self.router.watch_pending_decisions_once(), 0)
        self.assertEqual(self.slack_calls, [])

    def test_decisions_list_and_decide_resume_closed_loop(self) -> None:
        self.broker_store.touch_worker("mac-mini", "mini", ["dsbot"])
        d_q, _ = self.broker_store.create_decision(
            {
                "title": "Which DB should we use?",
                "context": "Need concurrent writes",
                "options": ["SQLite", "Postgres"],
                "kind": "question",
                "card_id": "card_db_1",
                "source_env": "mac_waiting",
                "source_bot": "Coder",
                "idempotency_key": "dsbot_q:card_db_1",
            }
        )

        # /decisions lists pending card cleanly
        self.router.dispatch_envelope(
            {
                "envelope_id": "e_dec_list",
                "type": "events_api",
                "payload": {
                    "event_id": "EvDecList",
                    "event": {
                        "type": "message",
                        "channel_type": "im",
                        "channel": "D0CKFEVJF0X",
                        "user": "U0C2NC6ARAQ",
                        "text": "/decisions",
                        "ts": "400.1",
                    },
                },
            },
            async_work=False,
        )
        posts = [b for m, b in self.slack_calls if m == "chat.postMessage"]
        self.assertEqual(len(posts), 1)
        self.assertIn(d_q["decision_id"], posts[0]["text"])
        self.assertIn("[question]", posts[0]["text"])
        self.assertIn("Coder", posts[0]["text"])
        self.assertIn("1. SQLite", posts[0]["text"])
        self.assertIn("2. Postgres", posts[0]["text"])
        self.assertIn(f"/decide {d_q['decision_id']} 1", posts[0]["text"])

        # Incomplete /decide prints usage
        self.slack_calls.clear()
        self.router.dispatch_envelope(
            {
                "envelope_id": "e_dec_usage",
                "type": "events_api",
                "payload": {
                    "event_id": "EvDecUsage",
                    "event": {
                        "type": "message",
                        "channel_type": "im",
                        "channel": "D0CKFEVJF0X",
                        "user": "U0C2NC6ARAQ",
                        "text": f"/decide {d_q['decision_id']}",
                        "ts": "400.2",
                    },
                },
            },
            async_work=False,
        )
        usage_posts = [b["text"] for m, b in self.slack_calls if m == "chat.postMessage"]
        self.assertEqual(
            usage_posts,
            ["Usage: `/decide <decision_id> <choice_or_number> [| optional note]`"],
        )

        # Unknown decision returns 404 warning
        self.slack_calls.clear()
        self.router.dispatch_envelope(
            {
                "envelope_id": "e_dec_404",
                "type": "events_api",
                "payload": {
                    "event_id": "EvDec404",
                    "event": {
                        "type": "message",
                        "channel_type": "im",
                        "channel": "D0CKFEVJF0X",
                        "user": "U0C2NC6ARAQ",
                        "text": "/decide dec_nope 1",
                        "ts": "400.3",
                    },
                },
            },
            async_work=False,
        )
        miss_posts = [b["text"] for m, b in self.slack_calls if m == "chat.postMessage"]
        self.assertEqual(miss_posts, [":warning: Decision `dec_nope` was not found."])

        # /decide <id> 2 | ship it resolves, tracks resume_job_id, and delivers Mac resume reply
        self.slack_calls.clear()
        self.router.dispatch_envelope(
            {
                "envelope_id": "e_dec_resolve",
                "type": "events_api",
                "payload": {
                    "event_id": "EvDecResolve",
                    "event": {
                        "type": "message",
                        "channel_type": "im",
                        "channel": "D0CKFEVJF0X",
                        "user": "U0C2NC6ARAQ",
                        "text": f"/decide {d_q['decision_id']} 2 | ship it",
                        "ts": "400.4",
                        "thread_ts": "400.1",
                    },
                },
            },
            async_work=False,
        )
        resolved = self.broker_store.get_decision(d_q["decision_id"])
        self.assertEqual(resolved["status"], "resolved")
        self.assertEqual(resolved["choice"], "Postgres")
        self.assertEqual(resolved["note"], "ship it")
        self.assertEqual(resolved["resolved_by"], "slack:U0C2NC6ARAQ")
        resume_job_id = resolved["resume_job_id"]
        self.assertTrue(resume_job_id)

        tracked = self.store.get_tracked_job(resume_job_id)
        self.assertIsNotNone(tracked)
        self.assertEqual(tracked["thread_ts"], "400.1")
        self.assertEqual(tracked["local_only"], 1)
        self.assertEqual(tracked["bot_name"], "Coder")

        ack_posts = [b for m, b in self.slack_calls if m == "chat.postMessage"]
        self.assertEqual(len(ack_posts), 1)
        self.assertEqual(ack_posts[0]["thread_ts"], "400.1")
        self.assertIn("Postgres", ack_posts[0]["text"])
        self.assertIn(resume_job_id, ack_posts[0]["text"])

        # Worker executes decision_resume job and completes it
        claimed = self.broker_store.claim_next_job("mac-mini")
        self.assertIsNotNone(claimed)
        self.assertEqual(claimed["job_id"], resume_job_id)
        self.assertEqual(claimed["role"], "decision_resume")
        self.assertEqual(claimed["bot"], "Coder")
        self.assertIn("Postgres", claimed["task"])
        self.assertIn("ship it", claimed["task"])

        self.broker_store.complete_job(
            {
                "job_id": resume_job_id,
                "worker_id": "mac-mini",
                "status": "succeeded",
                "result_summary": "RESUMED_WITH_POSTGRES_OK",
            }
        )
        self.slack_calls.clear()
        done = self.router.watch_tracked_jobs_once()
        self.assertEqual(done, 1)
        final_posts = [b for m, b in self.slack_calls if m == "chat.postMessage"]
        self.assertEqual(len(final_posts), 1)
        self.assertEqual(final_posts[0]["thread_ts"], "400.1")
        self.assertIn("RESUMED_WITH_POSTGRES_OK", final_posts[0]["text"])

    def test_decide_approval_returns_lock_409(self) -> None:
        d_app, _ = self.broker_store.create_decision(
            {
                "title": "Allow run_command",
                "context": "Needs host shell access",
                "options": [],
                "kind": "approval",
                "card_id": "card_lock_1",
                "source_env": "mac_waiting",
                "source_bot": "Devin Manager",
                "idempotency_key": "dsbot_a:card_lock_1",
            }
        )
        with self.assertRaises(BrokerError) as ctx_409:
            self.broker.resolve_decision(d_app["decision_id"], choice="1")
        self.assertEqual(ctx_409.exception.status_code, 409)

        self.router.dispatch_envelope(
            {
                "envelope_id": "e_app_409",
                "type": "events_api",
                "payload": {
                    "event_id": "EvApp409",
                    "event": {
                        "type": "message",
                        "channel_type": "im",
                        "channel": "D0CKFEVJF0X",
                        "user": "U0C2NC6ARAQ",
                        "text": f"/decide {d_app['decision_id']} 1",
                        "ts": "500.1",
                    },
                },
            },
            async_work=False,
        )
        posts = [b["text"] for m, b in self.slack_calls if m == "chat.postMessage"]
        self.assertEqual(
            posts,
            [
                f":lock: Cannot resolve `{d_app['decision_id']}` from Slack — host tool approvals must be approved directly in *DS Bot.app* on your Mac."
            ],
        )
        self.assertEqual(self.broker_store.get_decision(d_app["decision_id"])["status"], "pending")

        # /approve on approval also hits 409 lock message
        self.slack_calls.clear()
        self.router.dispatch_envelope(
            {
                "envelope_id": "e_app_409_b",
                "type": "events_api",
                "payload": {
                    "event_id": "EvApp409B",
                    "event": {
                        "type": "message",
                        "channel_type": "im",
                        "channel": "D0CKFEVJF0X",
                        "user": "U0C2NC6ARAQ",
                        "text": f"/approve {d_app['decision_id']}",
                        "ts": "500.2",
                    },
                },
            },
            async_work=False,
        )
        posts2 = [b["text"] for m, b in self.slack_calls if m == "chat.postMessage"]
        self.assertEqual(
            posts2,
            [
                f":lock: Cannot resolve `{d_app['decision_id']}` from Slack — host tool approvals must be approved directly in *DS Bot.app* on your Mac."
            ],
        )


if __name__ == "__main__":
    unittest.main()
