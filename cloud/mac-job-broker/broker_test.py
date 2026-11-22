#!/usr/bin/env python3
import http.client
import json
import os
import sys
import tempfile
import threading
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from broker import (
    BrokerStore,
    ThreadingHTTPServer,
    make_handler,
    redact_secrets,
    sync_new_bot_capabilities,
)


class BrokerTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmpdir = tempfile.TemporaryDirectory()
        self.db_path = os.path.join(self.tmpdir.name, "jobs.db")
        self.team_mem_dir = os.path.join(self.tmpdir.name, "team_mem")
        self.store = BrokerStore(self.db_path)
        self.delivered = []
        handler = make_handler(
            self.store,
            producer_token="prod-secret",
            worker_token="work-secret",
            deliver_fn=lambda job: (
                self.delivered.append(job["job_id"]),
                self.store.mark_delivery(job["job_id"], True),
            ),
            team_memory_dir=self.team_mem_dir,
        )
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.store.close()
        self.tmpdir.cleanup()

    def _req(self, method: str, path: str, body=None, token=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        headers = {"Content-Type": "application/json"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        data = json.dumps(body) if body is not None else None
        conn.request(method, path, body=data, headers=headers)
        resp = conn.getresponse()
        raw = resp.read().decode("utf-8")
        conn.close()
        return resp.status, json.loads(raw)

    def test_auth_split_and_offline_queue(self) -> None:
        st, _ = self._req("POST", "/v1/jobs", {"task": "hi", "aws_session_id": "s1"})
        self.assertEqual(st, 401)
        st, _ = self._req(
            "POST",
            "/v1/jobs",
            {"task": "hi", "aws_session_id": "s1"},
            token="work-secret",
        )
        self.assertEqual(st, 403)
        st, data = self._req(
            "POST",
            "/v1/jobs",
            {
                "task": "build mac app",
                "aws_session_id": "s1",
                "idempotency_key": "idem-1",
            },
            token="prod-secret",
        )
        self.assertEqual(st, 201)
        self.assertFalse(data["mac_online"])
        self.assertEqual(data["job"]["target"], "dsbot")
        job_id = data["job"]["job_id"]

        # Idempotent duplicate returns 200 with same job_id
        st2, data2 = self._req(
            "POST",
            "/v1/jobs",
            {
                "task": "build mac app",
                "aws_session_id": "s1",
                "idempotency_key": "idem-1",
            },
            token="prod-secret",
        )
        self.assertEqual(st2, 200)
        self.assertEqual(data2["job"]["job_id"], job_id)

    def test_claim_heartbeat_complete_and_redaction(self) -> None:
        st, data = self._req(
            "POST",
            "/v1/jobs",
            {"target": "dsbot", "task": "check xcode", "aws_session_id": "s1"},
            token="prod-secret",
        )
        self.assertEqual(st, 201)
        job_id = data["job"]["job_id"]

        st, claim = self._req(
            "POST",
            "/v1/worker/claim",
            {"worker_id": "mac-1", "hostname": "mini"},
            token="work-secret",
        )
        self.assertEqual(st, 200)
        self.assertEqual(claim["job"]["job_id"], job_id)
        self.assertEqual(claim["job"]["status"], "running")

        st, hb = self._req(
            "POST",
            "/v1/worker/heartbeat",
            {"job_id": job_id, "worker_id": "mac-1"},
            token="work-secret",
        )
        self.assertEqual(st, 200)
        self.assertTrue(hb["ok"])

        st, done = self._req(
            "POST",
            "/v1/worker/complete",
            {
                "job_id": job_id,
                "worker_id": "mac-1",
                "status": "succeeded",
                "result_summary": "Done with token sk-1234567890abcdef1234",
            },
            token="work-secret",
        )
        self.assertEqual(st, 200)
        self.assertEqual(done["job"]["status"], "succeeded")
        self.assertIn("[REDACTED]", done["job"]["result_summary"])
        time.sleep(0.05)
        self.assertIn(job_id, self.delivered)

    def test_sweep_lease_lost(self) -> None:
        job, _ = self.store.enqueue_job(
            {"target": "dsbot", "task": "t", "aws_session_id": "s1"}
        )
        claimed = self.store.claim_next_job("mac-1", lease_ttl_sec=-5)
        self.assertIsNotNone(claimed)
        res = self.store.sweep()
        self.assertEqual(res["lease_lost"], 1)
        after = self.store.get_job(job["job_id"])
        self.assertEqual(after["status"], "lease_lost")

    def test_redact_secrets(self) -> None:
        s = redact_secrets("ghp_abcdef1234567890abcdef123456 and Bearer mysecretbearertoken12345")
        self.assertNotIn("ghp_abcdef", s)
        self.assertNotIn("mysecretbearertoken", s)

    def test_sync_new_bot_capabilities_inherits_once(self) -> None:
        state_file = os.path.join(self.tmpdir.name, "state.json")
        with open(state_file, "w") as f:
            json.dump(
                {
                    "capabilities": {
                        "items": {
                            "mac-bridge": {"name": "mac-bridge"},
                            "mac-dispatch-routing": {"name": "mac-dispatch-routing"},
                        }
                    },
                    "bots": {
                        "bot-1": {"id": "bot-1", "capabilities": ["mac-bridge", "mac-dispatch-routing"]},
                        "bot-2": {"id": "bot-2", "capabilities": []},
                    },
                },
                f,
            )

        calls = []

        class FakeClient:
            def post_bot_api(self, ep, payload=None):
                calls.append((ep, payload))
                return {"ok": True}

        n1 = sync_new_bot_capabilities(self.store, FakeClient(), state_file)
        self.assertEqual(n1, 2)
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0][1]["botId"], "bot-2")
        # Subsequent sweep must not re-attach even if user later detaches on bot-2
        n2 = sync_new_bot_capabilities(self.store, FakeClient(), state_file)
        self.assertEqual(n2, 0)
        self.assertEqual(len(calls), 2)


    def test_decision_mailbox_shared_auth_and_resolve(self) -> None:
        st, created = self._req(
            "POST",
            "/v1/decisions",
            {
                "title": "Approve PR #12?",
                "context": "Ready to merge to main",
                "options": ["Approve", "Reject"],
                "source_env": "mac",
                "source_room": "1+1 Routing",
                "source_bot": "Planner",
                "idempotency_key": "dec-idem-1",
            },
            token="work-secret",
        )
        self.assertEqual(st, 201)
        dec_id = created["decision"]["decision_id"]

        st, listed = self._req("GET", "/v1/decisions?status=pending", token="prod-secret")
        self.assertEqual(st, 200)
        self.assertEqual(len(listed["decisions"]), 1)
        self.assertEqual(listed["decisions"][0]["decision_id"], dec_id)

        st, resolved = self._req(
            "POST",
            f"/v1/decisions/{dec_id}/resolve",
            {"choice": "Approve", "note": "Ship it", "resolved_by": "pixel9"},
            token="prod-secret",
        )
        self.assertEqual(st, 200)
        self.assertEqual(resolved["decision"]["status"], "resolved")
        self.assertEqual(resolved["decision"]["choice"], "Approve")

    def test_git_sync_target_accepted(self) -> None:
        st, data = self._req(
            "POST",
            "/v1/jobs",
            {
                "target": "git_sync",
                "task": json.dumps({"action": "push", "repo": "demo-app", "create_if_missing": True}),
                "repo": "demo-app",
                "branch": "main",
                "aws_session_id": "s1",
            },
            token="prod-secret",
        )
        self.assertEqual(st, 201)
        self.assertEqual(data["job"]["target"], "git_sync")
        self.assertEqual(data["job"]["repo"], "demo-app")

    def test_job_optional_fields_roundtrip(self) -> None:
        st, data = self._req(
            "POST",
            "/v1/jobs",
            {
                "task": "follow up on local task",
                "aws_session_id": "s1",
                "cwd": "/Users/chief/projects/local-app",
                "local_only": True,
                "bot": "Chief",
            },
            token="prod-secret",
        )
        self.assertEqual(st, 201)
        job = data["job"]
        self.assertEqual(job["target"], "dsbot")
        self.assertEqual(job["cwd"], "/Users/chief/projects/local-app")
        self.assertIs(job["local_only"], True)
        self.assertEqual(job["bot"], "Chief")
        job_id = job["job_id"]

        st, got = self._req("GET", f"/v1/jobs/{job_id}", token="prod-secret")
        self.assertEqual(st, 200)
        self.assertEqual(got["job"]["cwd"], "/Users/chief/projects/local-app")
        self.assertIs(got["job"]["local_only"], True)

        st, listed = self._req("GET", "/v1/jobs?limit=5", token="prod-secret")
        self.assertEqual(st, 200)
        self.assertEqual(listed["jobs"][0]["job_id"], job_id)

        st, claim = self._req(
            "POST",
            "/v1/worker/claim",
            {"worker_id": "mac-1", "hostname": "mini"},
            token="work-secret",
        )
        self.assertEqual(st, 200)
        claimed = claim["job"]
        self.assertEqual(claimed["job_id"], job_id)
        self.assertEqual(claimed["cwd"], "/Users/chief/projects/local-app")
        self.assertIs(claimed["local_only"], True)
        self.assertEqual(claimed["bot"], "Chief")

    def test_default_target_dsbot_and_paradev_rejected(self) -> None:
        st_default, data_default = self._req(
            "POST",
            "/v1/jobs",
            {"task": "check local mac status", "aws_session_id": "s1"},
            token="prod-secret",
        )
        self.assertEqual(st_default, 201)
        self.assertEqual(data_default["job"]["target"], "dsbot")

        for removed in ("paradev", "paradev_register"):
            st_bad, err_bad = self._req(
                "POST",
                "/v1/jobs",
                {"target": removed, "task": "legacy", "aws_session_id": "s1"},
                token="prod-secret",
            )
            self.assertEqual(st_bad, 400)
            self.assertIn("ParaDev has been removed", err_bad.get("error", ""))

        st_sess, _ = self._req("GET", "/v1/paradev/sessions", token="prod-secret")
        self.assertEqual(st_sess, 404)

    def test_preupgrade_row_mark_delivery_preserves_completed_at(self) -> None:
        old_ts = time.time() - 100
        with self.store._lock:
            self.store.conn.execute(
                """
                INSERT INTO jobs (
                    job_id, target, task, repo, branch, timeout_sec,
                    aws_session_id, status, attempt, worker_id,
                    workspace_id, terminal_id, role,
                    delivery_state, delivery_attempts,
                    created_at, updated_at, expires_at
                ) VALUES (?, 'dsbot', 'old task', 'demo-app', 'main', 900,
                          's1', 'succeeded', 1, 'mac-1',
                          NULL, NULL, 'worker',
                          'delivered', 1, ?, ?, ?)
                """,
                ("mac_oldjob1", old_ts, old_ts, old_ts + 86400),
            )
            self.store.conn.commit()

        self.store.mark_delivery("mac_oldjob1", True)
        old_job = self.store.get_job("mac_oldjob1")
        self.assertEqual(old_job["completed_at"], old_ts)
        self.assertGreater(old_job["updated_at"], old_job["completed_at"])

    def test_dsbot_bot_and_group_fields_roundtrip(self) -> None:
        st, data = self._req(
            "POST",
            "/v1/jobs",
            {
                "target": "dsbot",
                "task": "check local status",
                "aws_session_id": "s1",
                "bot": "Coder",
                "group": "Ops",
            },
            token="prod-secret",
        )
        self.assertEqual(st, 201)
        job_id = data["job"]["job_id"]
        self.assertEqual(data["job"]["bot"], "Coder")
        self.assertEqual(data["job"]["group"], "Ops")

        st, got = self._req("GET", f"/v1/jobs/{job_id}", token="prod-secret")
        self.assertEqual(st, 200)
        self.assertEqual(got["job"]["bot"], "Coder")
        self.assertEqual(got["job"]["group"], "Ops")

        st, claim = self._req(
            "POST",
            "/v1/worker/claim",
            {"worker_id": "mac-1", "hostname": "mini"},
            token="work-secret",
        )
        self.assertEqual(st, 200)
        self.assertEqual(claim["job"]["job_id"], job_id)
        self.assertEqual(claim["job"]["bot"], "Coder")
        self.assertEqual(claim["job"]["group"], "Ops")

    def test_long_poll_claim_wakes_immediately_on_enqueue(self) -> None:
        results: dict[str, object] = {}

        def poll_worker() -> None:
            t0 = time.monotonic()
            st, data = self._req(
                "POST",
                "/v1/worker/claim",
                {"worker_id": "mac-lp", "hostname": "mini", "wait_sec": 5.0},
                token="work-secret",
            )
            results["elapsed"] = time.monotonic() - t0
            results["status"] = st
            results["data"] = data

        wt = threading.Thread(target=poll_worker, daemon=True)
        wt.start()
        time.sleep(0.15)
        st, created = self._req(
            "POST",
            "/v1/jobs",
            {"target": "dsbot", "task": "wake up fast", "aws_session_id": "s-lp"},
            token="prod-secret",
        )
        self.assertEqual(st, 201)
        wt.join(timeout=3.0)
        self.assertFalse(wt.is_alive())
        self.assertEqual(results["status"], 200)
        self.assertLess(results["elapsed"], 1.5)
        self.assertEqual(results["data"]["job"]["job_id"], created["job"]["job_id"])

    def test_context_snapshot_scrubs_secrets_and_links_memory_md(self) -> None:
        os.makedirs(self.team_mem_dir, exist_ok=True)
        mem_md = os.path.join(self.team_mem_dir, "MEMORY.md")
        with open(mem_md, "w", encoding="utf-8") as f:
            f.write("# Memory\n\n## Index\n- [[shared]]\n")

        payload = {
            "markdown": "# Mac Mirror\n- Project: DS-Bot\n- Bad: xoxb-123456789012345678 xapp-1-ABCDEF-1234567890 sk-abcdefghijklmnopqrst\n"
        }
        st, res = self._req(
            "POST", "/v1/worker/context-snapshot", payload, token="work-secret"
        )
        self.assertEqual(st, 200)
        self.assertTrue(res["written"])
        # Repeat write to confirm idempotent linking in MEMORY.md.
        st2, _ = self._req(
            "POST", "/v1/worker/context-snapshot", payload, token="work-secret"
        )
        self.assertEqual(st2, 200)

        with open(os.path.join(self.team_mem_dir, "mac-mirror.md"), "r", encoding="utf-8") as f:
            mirrored = f.read()
        self.assertIn("Project: DS-Bot", mirrored)
        self.assertNotIn("xoxb-123456789012345678", mirrored)
        self.assertNotIn("xapp-1-ABCDEF-1234567890", mirrored)
        self.assertNotIn("sk-abcdefghijklmnopqrst", mirrored)

        with open(mem_md, "r", encoding="utf-8") as f:
            idx = f.read()
        self.assertIn("- [[shared]]", idx)
        self.assertEqual(idx.count("- [[mac-mirror]]"), 1)

    def test_cloud_notes_roundtrip_and_ack(self) -> None:
        st, created = self._req(
            "POST",
            "/v1/cloud-notes",
            {
                "channel": "D0CKFEVJF0X",
                "thread_ts": "1700.1",
                "bot_name": "Chief",
                "prompt_excerpt": "Check repo with Bearer secret_token_abcdef123456",
                "reply_excerpt": "PR merged with sk-abcdefghijklmnopqrstuv",
            },
            token="prod-secret",
        )
        self.assertEqual(st, 201)
        nid = created["note"]["note_id"]

        st, listed = self._req(
            "GET", "/v1/worker/cloud-notes?since_id=0&limit=10", token="work-secret"
        )
        self.assertEqual(st, 200)
        self.assertEqual(len(listed["notes"]), 1)
        self.assertEqual(listed["latest_id"], nid)
        self.assertNotIn("secret_token_abcdef123456", listed["recent_markdown"])
        self.assertNotIn("sk-abcdefghijklmnopqrstuv", listed["recent_markdown"])
        self.assertIn("PR merged", listed["recent_markdown"])

        st, ack = self._req(
            "POST",
            "/v1/worker/cloud-notes/ack",
            {"up_to_id": nid},
            token="work-secret",
        )
        self.assertEqual(st, 200)
        self.assertEqual(ack["acked"], 1)

        st, listed2 = self._req(
            "GET", f"/v1/worker/cloud-notes?since_id={nid}&limit=10", token="work-secret"
        )
        self.assertEqual(st, 200)
        self.assertEqual(listed2["notes"], [])


if __name__ == "__main__":
    unittest.main()
