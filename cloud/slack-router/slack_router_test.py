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


if __name__ == "__main__":
    unittest.main()
