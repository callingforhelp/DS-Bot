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
                "target": "paradev",
                "task": "build mac app",
                "aws_session_id": "s1",
                "idempotency_key": "idem-1",
            },
            token="prod-secret",
        )
        self.assertEqual(st, 201)
        self.assertFalse(data["mac_online"])
        job_id = data["job"]["job_id"]

        # Idempotent duplicate returns 200 with same job_id
        st2, data2 = self._req(
            "POST",
            "/v1/jobs",
            {
                "target": "paradev",
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
            {"target": "paradev", "task": "t", "aws_session_id": "s1"}
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
                "target": "paradev",
                "task": "follow up in existing workspace",
                "aws_session_id": "s1",
                "workspace_id": "ws-abc123",
                "terminal_id": "term-9",
                "agent": "devin",
                "cwd": "/Users/chief/projects/local-app",
                "local_only": True,
            },
            token="prod-secret",
        )
        self.assertEqual(st, 201)
        job = data["job"]
        self.assertEqual(job["workspace_id"], "ws-abc123")
        self.assertEqual(job["terminal_id"], "term-9")
        self.assertEqual(job["agent"], "devin")
        self.assertEqual(job["cwd"], "/Users/chief/projects/local-app")
        self.assertIs(job["local_only"], True)
        job_id = job["job_id"]

        st, got = self._req("GET", f"/v1/jobs/{job_id}", token="prod-secret")
        self.assertEqual(st, 200)
        self.assertEqual(got["job"]["workspace_id"], "ws-abc123")
        self.assertIs(got["job"]["local_only"], True)

        st, listed = self._req("GET", "/v1/jobs?limit=5", token="prod-secret")
        self.assertEqual(st, 200)
        self.assertEqual(listed["jobs"][0]["job_id"], job_id)
        self.assertEqual(listed["jobs"][0]["terminal_id"], "term-9")

        st, claim = self._req(
            "POST",
            "/v1/worker/claim",
            {"worker_id": "mac-1", "hostname": "mini"},
            token="work-secret",
        )
        self.assertEqual(st, 200)
        claimed = claim["job"]
        self.assertEqual(claimed["job_id"], job_id)
        self.assertEqual(claimed["workspace_id"], "ws-abc123")
        self.assertEqual(claimed["terminal_id"], "term-9")
        self.assertEqual(claimed["agent"], "devin")
        self.assertEqual(claimed["cwd"], "/Users/chief/projects/local-app")
        self.assertIs(claimed["local_only"], True)

    def test_paradev_sessions_worker_and_reviewer(self) -> None:
        st, data = self._req(
            "POST",
            "/v1/jobs",
            {
                "target": "paradev",
                "task": "implement feature",
                "aws_session_id": "s1",
                "repo": "demo-app",
                "branch": "main",
            },
            token="prod-secret",
        )
        self.assertEqual(st, 201)
        worker_job_id = data["job"]["job_id"]
        self.assertEqual(data["job"]["role"], "worker")

        st, claim = self._req(
            "POST",
            "/v1/worker/claim",
            {"worker_id": "mac-1", "hostname": "mini"},
            token="work-secret",
        )
        self.assertEqual(st, 200)
        self.assertEqual(claim["job"]["job_id"], worker_job_id)

        # Worker reports workspace/terminal via [paradev ...] trailer fallback
        st, done = self._req(
            "POST",
            "/v1/worker/complete",
            {
                "job_id": worker_job_id,
                "worker_id": "mac-1",
                "status": "succeeded",
                "result_summary": "Done [paradev workspace_id=ws-1 terminal_id=term-worker role=worker agent=codex]",
            },
            token="work-secret",
        )
        self.assertEqual(st, 200)
        self.assertEqual(done["job"]["workspace_id"], "ws-1")
        self.assertEqual(done["job"]["terminal_id"], "term-worker")

        st, data = self._req(
            "POST",
            "/v1/jobs",
            {
                "target": "paradev",
                "task": "review the change",
                "aws_session_id": "s1",
                "repo": "demo-app",
                "branch": "main",
                "workspace_id": "ws-1",
                "role": "reviewer",
            },
            token="prod-secret",
        )
        self.assertEqual(st, 201)
        reviewer_job_id = data["job"]["job_id"]
        self.assertEqual(data["job"]["role"], "reviewer")

        st, claim = self._req(
            "POST",
            "/v1/worker/claim",
            {"worker_id": "mac-1", "hostname": "mini"},
            token="work-secret",
        )
        self.assertEqual(st, 200)
        self.assertEqual(claim["job"]["job_id"], reviewer_job_id)

        # Reviewer reports via explicit payload fields
        st, done = self._req(
            "POST",
            "/v1/worker/complete",
            {
                "job_id": reviewer_job_id,
                "worker_id": "mac-1",
                "status": "succeeded",
                "result_summary": "Review posted",
                "workspace_id": "ws-1",
                "terminal_id": "term-reviewer",
                "role": "reviewer",
            },
            token="work-secret",
        )
        self.assertEqual(st, 200)

        st, sessions = self._req("GET", "/v1/paradev/sessions", token="prod-secret")
        self.assertEqual(st, 200)
        self.assertEqual(len(sessions["sessions"]), 1)
        sess = sessions["sessions"][0]
        self.assertEqual(sess["workspace_id"], "ws-1")
        self.assertEqual(sess["worker_terminal_id"], "term-worker")
        self.assertEqual(sess["reviewer_terminal_id"], "term-reviewer")
        self.assertEqual(sess["repo"], "demo-app")
        self.assertEqual(sess["branch"], "main")
        self.assertEqual(sess["last_job_id"], reviewer_job_id)

    def test_paradev_session_key_reuse_and_headless_guard(self) -> None:
        # Job 1: worker enqueued with repo/branch anchors the session
        st, data = self._req(
            "POST",
            "/v1/jobs",
            {
                "target": "paradev",
                "task": "implement feature",
                "aws_session_id": "s1",
                "repo": "demo-app",
                "branch": "main",
            },
            token="prod-secret",
        )
        self.assertEqual(st, 201)
        job1_id = data["job"]["job_id"]

        st, claim = self._req(
            "POST",
            "/v1/worker/claim",
            {"worker_id": "mac-1", "hostname": "mini"},
            token="work-secret",
        )
        self.assertEqual(claim["job"]["job_id"], job1_id)

        st, _ = self._req(
            "POST",
            "/v1/worker/complete",
            {
                "job_id": job1_id,
                "worker_id": "mac-1",
                "status": "succeeded",
                "result_summary": "done",
                "workspace_id": "ws-1",
                "terminal_id": "term-w",
                "role": "worker",
            },
            token="work-secret",
        )
        self.assertEqual(st, 200)

        # Job 2: workspace-only reviewer follow-up must reuse demo-app:main
        st, data = self._req(
            "POST",
            "/v1/jobs",
            {
                "target": "paradev",
                "task": "review the change",
                "aws_session_id": "s1",
                "workspace_id": "ws-1",
                "role": "reviewer",
            },
            token="prod-secret",
        )
        self.assertEqual(st, 201)
        job2_id = data["job"]["job_id"]

        st, claim = self._req(
            "POST",
            "/v1/worker/claim",
            {"worker_id": "mac-1", "hostname": "mini"},
            token="work-secret",
        )
        self.assertEqual(claim["job"]["job_id"], job2_id)

        st, _ = self._req(
            "POST",
            "/v1/worker/complete",
            {
                "job_id": job2_id,
                "worker_id": "mac-1",
                "status": "succeeded",
                "result_summary": "review done",
                "workspace_id": "ws-1",
                "terminal_id": "term-r",
                "role": "reviewer",
            },
            token="work-secret",
        )
        self.assertEqual(st, 200)

        # Job 3: headless dsbot job in same workspace must not clobber terminals
        st, data = self._req(
            "POST",
            "/v1/jobs",
            {
                "target": "paradev",
                "task": "headless dsbot pass",
                "aws_session_id": "s1",
                "workspace_id": "ws-1",
            },
            token="prod-secret",
        )
        self.assertEqual(st, 201)
        job3_id = data["job"]["job_id"]

        st, claim = self._req(
            "POST",
            "/v1/worker/claim",
            {"worker_id": "mac-1", "hostname": "mini"},
            token="work-secret",
        )
        self.assertEqual(claim["job"]["job_id"], job3_id)

        st, _ = self._req(
            "POST",
            "/v1/worker/complete",
            {
                "job_id": job3_id,
                "worker_id": "mac-1",
                "status": "succeeded",
                "result_summary": "headless pass done",
                "workspace_id": "ws-1",
                "terminal_id": "dsbot-headless",
                "agent": "dsbot",
            },
            token="work-secret",
        )
        self.assertEqual(st, 200)

        st, sessions = self._req("GET", "/v1/paradev/sessions", token="prod-secret")
        self.assertEqual(st, 200)
        self.assertEqual(len(sessions["sessions"]), 1)
        sess = sessions["sessions"][0]
        self.assertEqual(sess["session_key"], "demo-app:main")
        self.assertEqual(sess["workspace_id"], "ws-1")
        self.assertEqual(sess["worker_terminal_id"], "term-w")
        self.assertEqual(sess["reviewer_terminal_id"], "term-r")

    def _run_paradev_job(self, enqueue_fields, complete_fields):
        st, data = self._req(
            "POST",
            "/v1/jobs",
            {
                "target": "paradev",
                "task": "t",
                "aws_session_id": "s1",
                **enqueue_fields,
            },
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
        self.assertEqual(claim["job"]["job_id"], job_id)
        st, done = self._req(
            "POST",
            "/v1/worker/complete",
            {
                "job_id": job_id,
                "worker_id": "mac-1",
                "status": "succeeded",
                "result_summary": "done",
                **complete_fields,
            },
            token="work-secret",
        )
        self.assertEqual(st, 200)
        return job_id

    def test_paradev_session_workspace_rotation_clears_stale_terminals(self) -> None:
        self._run_paradev_job(
            {"repo": "demo-app", "branch": "main"},
            {"workspace_id": "ws-old", "terminal_id": "term-w-old", "role": "worker"},
        )
        self._run_paradev_job(
            {"workspace_id": "ws-old", "role": "reviewer"},
            {"workspace_id": "ws-old", "terminal_id": "term-r-old", "role": "reviewer"},
        )
        st, sessions = self._req("GET", "/v1/paradev/sessions", token="prod-secret")
        self.assertEqual(st, 200)
        self.assertEqual(len(sessions["sessions"]), 1)
        self.assertEqual(sessions["sessions"][0]["reviewer_terminal_id"], "term-r-old")

        # Same repo:branch rotates to a brand-new workspace -> stale reviewer cleared
        job3_id = self._run_paradev_job(
            {"repo": "demo-app", "branch": "main"},
            {"workspace_id": "ws-new", "terminal_id": "term-new-w", "role": "worker"},
        )
        st, sessions = self._req("GET", "/v1/paradev/sessions", token="prod-secret")
        self.assertEqual(st, 200)
        self.assertEqual(len(sessions["sessions"]), 1)
        sess = sessions["sessions"][0]
        self.assertEqual(sess["session_key"], "demo-app:main")
        self.assertEqual(sess["workspace_id"], "ws-new")
        self.assertEqual(sess["worker_terminal_id"], "term-new-w")
        self.assertIsNone(sess["reviewer_terminal_id"])

        # Idempotent retry of the same completion still leaves the session correct
        st, done = self._req(
            "POST",
            "/v1/worker/complete",
            {
                "job_id": job3_id,
                "worker_id": "mac-1",
                "status": "succeeded",
                "result_summary": "done",
            },
            token="work-secret",
        )
        self.assertEqual(st, 200)
        st, sessions = self._req("GET", "/v1/paradev/sessions", token="prod-secret")
        self.assertEqual(st, 200)
        self.assertEqual(len(sessions["sessions"]), 1)
        self.assertEqual(sessions["sessions"][0]["workspace_id"], "ws-new")
        self.assertEqual(sessions["sessions"][0]["worker_terminal_id"], "term-new-w")
        self.assertIsNone(sessions["sessions"][0]["reviewer_terminal_id"])

    def test_out_of_order_retry_does_not_clobber_newer_workspace(self) -> None:
        job1_id = self._run_paradev_job(
            {"repo": "demo-app", "branch": "main"},
            {"workspace_id": "ws-old", "terminal_id": "term-old", "role": "worker"},
        )
        self._run_paradev_job(
            {"repo": "demo-app", "branch": "main"},
            {"workspace_id": "ws-new", "terminal_id": "term-new", "role": "worker"},
        )
        self._run_paradev_job(
            {"workspace_id": "ws-new", "role": "reviewer"},
            {"workspace_id": "ws-new", "terminal_id": "term-rev", "role": "reviewer"},
        )

        # Delayed idempotent retry of job1's completion must not roll back ws-new
        st, done = self._req(
            "POST",
            "/v1/worker/complete",
            {
                "job_id": job1_id,
                "worker_id": "mac-1",
                "status": "succeeded",
                "result_summary": "done",
                "workspace_id": "ws-old",
                "terminal_id": "term-old",
            },
            token="work-secret",
        )
        self.assertEqual(st, 200)
        self.assertTrue(done["ok"])

        st, sessions = self._req("GET", "/v1/paradev/sessions", token="prod-secret")
        self.assertEqual(st, 200)
        self.assertEqual(len(sessions["sessions"]), 1)
        sess = sessions["sessions"][0]
        self.assertEqual(sess["session_key"], "demo-app:main")
        self.assertEqual(sess["workspace_id"], "ws-new")
        self.assertEqual(sess["worker_terminal_id"], "term-new")
        self.assertEqual(sess["reviewer_terminal_id"], "term-rev")


if __name__ == "__main__":
    unittest.main()
