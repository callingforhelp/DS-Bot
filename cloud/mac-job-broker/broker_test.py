#!/usr/bin/env python3
import http.client
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from broker import (
    BrokerStore,
    ThreadingHTTPServer,
    ThreadingUnixStreamServer,
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

    def test_pre_migration_decisions_schema_upgrade(self) -> None:
        legacy_db = os.path.join(self.tmpdir.name, "legacy_decisions.db")
        conn = sqlite3.connect(legacy_db)
        conn.executescript(
            """
            CREATE TABLE decisions (
                decision_id TEXT PRIMARY KEY,
                idempotency_key TEXT UNIQUE,
                title TEXT NOT NULL,
                context TEXT NOT NULL DEFAULT '',
                options TEXT NOT NULL DEFAULT '[]',
                source_env TEXT NOT NULL DEFAULT 'aws',
                source_room TEXT,
                source_bot TEXT,
                aws_session_id TEXT,
                status TEXT NOT NULL DEFAULT 'pending',
                choice TEXT,
                note TEXT,
                resolved_by TEXT,
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL,
                resolved_at REAL
            );
            INSERT INTO decisions (
                decision_id, idempotency_key, title, context, options,
                source_env, source_bot, status, created_at, updated_at
            ) VALUES (
                'dec_legacy1', 'legacy-k1', 'Legacy Choice', 'Legacy ctx',
                '["Yes", "No"]', 'aws', 'Chief', 'pending', 100.0, 100.0
            );
            """
        )
        conn.commit()
        conn.close()

        upgraded = BrokerStore(legacy_db)
        try:
            cols = {
                row["name"]
                for row in upgraded.conn.execute("PRAGMA table_info(decisions)").fetchall()
            }
            self.assertTrue({"kind", "card_id", "resume_job_id"}.issubset(cols))
            legacy = upgraded.get_decision("dec_legacy1")
            self.assertIsNotNone(legacy)
            self.assertEqual(legacy["kind"], "decision")
            self.assertIsNone(legacy["card_id"])
            self.assertIsNone(legacy["resume_job_id"])

            created, was_created = upgraded.create_decision(
                {
                    "title": "New card",
                    "kind": "question",
                    "card_id": "q_new_1",
                    "source_env": "mac_waiting",
                    "source_bot": "Chief",
                }
            )
            self.assertTrue(was_created)
            self.assertEqual(created["kind"], "question")
            self.assertEqual(created["card_id"], "q_new_1")

            resolved = upgraded.resolve_decision("dec_legacy1", "1", auto_resume=False)
            self.assertEqual(resolved["status"], "resolved")
            self.assertEqual(resolved["choice"], "Yes")
        finally:
            upgraded.close()

    def test_create_decision_mac_waiting_kind_card_id_and_refresh(self) -> None:
        st_bad, _ = self._req(
            "POST",
            "/v1/decisions",
            {"title": "Bad kind", "kind": "unknown_kind"},
            token="work-secret",
        )
        self.assertEqual(st_bad, 400)

        st_fb, fb = self._req(
            "POST",
            "/v1/decisions",
            {"title": "Fallback env", "source_env": "weird"},
            token="prod-secret",
        )
        self.assertEqual(st_fb, 201)
        self.assertEqual(fb["decision"]["source_env"], "aws")
        self.assertEqual(fb["decision"]["kind"], "decision")
        self.assertIsNone(fb["decision"]["card_id"])

        payload = {
            "title": "Deploy v2?",
            "context": "Staging green",
            "options": ["Ship", "Hold"],
            "kind": "question",
            "card_id": "card-q1",
            "source_env": "mac_waiting",
            "source_bot": "Chief",
            "idempotency_key": "dsbot_q:card-q1",
        }
        st1, d1 = self._req("POST", "/v1/decisions", payload, token="work-secret")
        self.assertEqual(st1, 201)
        self.assertTrue(d1["created"])
        dec_id = d1["decision"]["decision_id"]
        self.assertEqual(d1["decision"]["kind"], "question")
        self.assertEqual(d1["decision"]["card_id"], "card-q1")
        self.assertEqual(d1["decision"]["source_env"], "mac_waiting")
        first_updated = d1["decision"]["updated_at"]

        st2, d2 = self._req("POST", "/v1/decisions", payload, token="work-secret")
        self.assertEqual(st2, 200)
        self.assertFalse(d2["created"])
        self.assertEqual(d2["decision"]["decision_id"], dec_id)
        self.assertEqual(d2["decision"]["updated_at"], first_updated)

        time.sleep(0.01)
        refreshed_payload = {
            **payload,
            "title": "Deploy v2.1?",
            "context": "Staging green + canary ok",
            "options": ["Ship now", "Hold", "Rollback"],
            "kind": "view",
            "card_id": "card-v1",
        }
        st3, d3 = self._req("POST", "/v1/decisions", refreshed_payload, token="work-secret")
        self.assertEqual(st3, 200)
        self.assertFalse(d3["created"])
        self.assertEqual(d3["decision"]["decision_id"], dec_id)
        self.assertEqual(d3["decision"]["title"], "Deploy v2.1?")
        self.assertEqual(d3["decision"]["context"], "Staging green + canary ok")
        self.assertEqual(d3["decision"]["options"], ["Ship now", "Hold", "Rollback"])
        self.assertEqual(d3["decision"]["kind"], "view")
        self.assertEqual(d3["decision"]["card_id"], "card-v1")
        self.assertGreater(d3["decision"]["updated_at"], first_updated)

        # Resolve with auto_resume=False, then confirm closed mac_waiting row is not overwritten
        st_res, _ = self._req(
            "POST",
            f"/v1/decisions/{dec_id}/resolve",
            {"choice": "1", "auto_resume": False},
            token="prod-secret",
        )
        self.assertEqual(st_res, 200)
        st4, d4 = self._req(
            "POST",
            "/v1/decisions",
            {**refreshed_payload, "title": "Should not overwrite"},
            token="work-secret",
        )
        self.assertEqual(st4, 200)
        self.assertEqual(d4["decision"]["status"], "resolved")
        self.assertEqual(d4["decision"]["title"], "Deploy v2.1?")

        # Non-mac_waiting pending row stays immutable on duplicate idempotency_key
        st_aws1, aws1 = self._req(
            "POST",
            "/v1/decisions",
            {
                "title": "AWS decision",
                "source_env": "aws",
                "idempotency_key": "aws-immutable-1",
            },
            token="prod-secret",
        )
        self.assertEqual(st_aws1, 201)
        st_aws2, aws2 = self._req(
            "POST",
            "/v1/decisions",
            {
                "title": "AWS mutated?",
                "source_env": "aws",
                "idempotency_key": "aws-immutable-1",
            },
            token="prod-secret",
        )
        self.assertEqual(st_aws2, 200)
        self.assertEqual(aws2["decision"]["decision_id"], aws1["decision"]["decision_id"])
        self.assertEqual(aws2["decision"]["title"], "AWS decision")

    def test_worker_decisions_reconcile(self) -> None:
        st_unauth, _ = self._req(
            "POST", "/v1/worker/decisions/reconcile", {"active_keys": []}
        )
        self.assertEqual(st_unauth, 401)
        st_prod, _ = self._req(
            "POST",
            "/v1/worker/decisions/reconcile",
            {"active_keys": []},
            token="prod-secret",
        )
        self.assertEqual(st_prod, 403)

        for bad_body in [{}, {"active_keys": "not-a-list"}, {"active_keys": [1, 2]}]:
            st_bad, _ = self._req(
                "POST",
                "/v1/worker/decisions/reconcile",
                bad_body,
                token="work-secret",
            )
            self.assertEqual(st_bad, 400)

        _, keep_d = self._req(
            "POST",
            "/v1/decisions",
            {
                "title": "Keep active",
                "kind": "question",
                "card_id": "keep-1",
                "source_env": "mac_waiting",
                "source_bot": "Chief",
                "idempotency_key": "dsbot_q:keep-1",
            },
            token="work-secret",
        )
        _, drop_d = self._req(
            "POST",
            "/v1/decisions",
            {
                "title": "Dropped locally",
                "kind": "approval",
                "card_id": "drop-1",
                "source_env": "mac_waiting",
                "source_bot": "Chief",
                "idempotency_key": "dsbot_a:drop-1",
            },
            token="work-secret",
        )
        _, null_key_d = self._req(
            "POST",
            "/v1/decisions",
            {
                "title": "Legacy mac_waiting without key",
                "kind": "view",
                "source_env": "mac_waiting",
                "source_bot": "Chief",
            },
            token="work-secret",
        )
        _, aws_d = self._req(
            "POST",
            "/v1/decisions",
            {
                "title": "AWS pending",
                "source_env": "aws",
                "source_bot": "Chief",
                "idempotency_key": "aws-keep",
            },
            token="prod-secret",
        )
        _, mac_d = self._req(
            "POST",
            "/v1/decisions",
            {
                "title": "Mac non-waiting pending",
                "source_env": "mac",
                "source_bot": "Chief",
                "idempotency_key": "mac-keep",
            },
            token="work-secret",
        )

        st_rec, rec = self._req(
            "POST",
            "/v1/worker/decisions/reconcile",
            {"active_keys": ["dsbot_q:keep-1"]},
            token="work-secret",
        )
        self.assertEqual(st_rec, 200)
        self.assertTrue(rec["ok"])
        self.assertEqual(rec["count"], 2)
        resolved_ids = {d["decision_id"] for d in rec["resolved"]}
        self.assertEqual(
            resolved_ids,
            {drop_d["decision"]["decision_id"], null_key_d["decision"]["decision_id"]},
        )
        for item in rec["resolved"]:
            self.assertEqual(item["status"], "resolved")
            self.assertEqual(item["choice"], "(answered in DS Bot.app)")
            self.assertEqual(item["note"], "Closed locally in DS Bot desktop UI")
            self.assertEqual(item["resolved_by"], "mac-dsbot-ui")
            self.assertIsNotNone(item["resolved_at"])
            self.assertIsNone(item["resume_job_id"])

        for untouched in (keep_d, aws_d, mac_d):
            dec_id = untouched["decision"]["decision_id"]
            st_g, got = self._req("GET", f"/v1/decisions/{dec_id}", token="prod-secret")
            self.assertEqual(st_g, 200)
            self.assertEqual(got["decision"]["status"], "pending")

        st_jobs, jobs = self._req("GET", "/v1/jobs?limit=20", token="prod-secret")
        self.assertEqual(st_jobs, 200)
        self.assertEqual(jobs["jobs"], [])

        # Shrinking active_keys to [] closes remaining mac_waiting row
        st_rec2, rec2 = self._req(
            "POST",
            "/v1/worker/decisions/reconcile",
            {"active_keys": []},
            token="work-secret",
        )
        self.assertEqual(st_rec2, 200)
        self.assertEqual(rec2["count"], 1)
        self.assertEqual(
            rec2["resolved"][0]["decision_id"], keep_d["decision"]["decision_id"]
        )

    def test_resolve_decision_numeric_expansion_resume_wakeup_and_guards(self) -> None:
        st_nf, _ = self._req(
            "POST",
            "/v1/decisions/dec_missing/resolve",
            {"choice": "1"},
            token="prod-secret",
        )
        self.assertEqual(st_nf, 404)

        _, appr = self._req(
            "POST",
            "/v1/decisions",
            {
                "title": "Allow bash tool?",
                "kind": "approval",
                "card_id": "appr-1",
                "source_env": "mac_waiting",
                "source_bot": "Coder",
                "options": ["Approve", "Deny"],
            },
            token="work-secret",
        )
        appr_id = appr["decision"]["decision_id"]
        st_conflict, conflict = self._req(
            "POST",
            f"/v1/decisions/{appr_id}/resolve",
            {"choice": "1", "resolved_by": "slack:U1"},
            token="prod-secret",
        )
        self.assertEqual(st_conflict, 409)
        self.assertFalse(conflict["ok"])
        self.assertIn("DS Bot.app", conflict["error"])
        _, appr_check = self._req("GET", f"/v1/decisions/{appr_id}", token="prod-secret")
        self.assertEqual(appr_check["decision"]["status"], "pending")

        # Question decision: numeric option expansion + atomic resume job + long-poll wakeup
        _, q_created = self._req(
            "POST",
            "/v1/decisions",
            {
                "title": "Which DB engine?",
                "context": "Pick storage backend",
                "options": ["Postgres", "SQLite"],
                "kind": "question",
                "card_id": "q-42",
                "source_env": "mac_waiting",
                "source_bot": "Planner",
                "aws_session_id": "slack:C100:1.0",
            },
            token="work-secret",
        )
        q_id = q_created["decision"]["decision_id"]

        claim_results: dict[str, object] = {}

        def wait_worker() -> None:
            t0 = time.monotonic()
            st_w, data_w = self._req(
                "POST",
                "/v1/worker/claim",
                {"worker_id": "mac-resume", "hostname": "mini", "wait_sec": 5.0},
                token="work-secret",
            )
            claim_results["elapsed"] = time.monotonic() - t0
            claim_results["status"] = st_w
            claim_results["data"] = data_w

        wt = threading.Thread(target=wait_worker, daemon=True)
        wt.start()
        time.sleep(0.15)

        st_res, res = self._req(
            "POST",
            f"/v1/decisions/{q_id}/resolve",
            {
                "choice": "2",
                "note": "Need local file portability",
                "resolved_by": "slack:U42",
                "aws_session_id": "slack:C100:2.0",
            },
            token="prod-secret",
        )
        self.assertEqual(st_res, 200)
        dec = res["decision"]
        self.assertEqual(dec["status"], "resolved")
        self.assertEqual(dec["choice"], "SQLite")
        self.assertEqual(dec["note"], "Need local file portability")
        self.assertEqual(dec["resolved_by"], "slack:U42")
        resume_job_id = dec["resume_job_id"]
        self.assertTrue(resume_job_id)

        wt.join(timeout=3.0)
        self.assertFalse(wt.is_alive())
        self.assertEqual(claim_results["status"], 200)
        self.assertLess(claim_results["elapsed"], 1.5)
        claimed_job = claim_results["data"]["job"]
        self.assertEqual(claimed_job["job_id"], resume_job_id)
        self.assertEqual(claimed_job["target"], "dsbot")
        self.assertEqual(claimed_job["role"], "decision_resume")
        self.assertEqual(claimed_job["bot"], "Planner")
        self.assertIsNone(claimed_job["group_name"])
        self.assertEqual(claimed_job["aws_session_id"], "slack:C100:2.0")
        self.assertEqual(claimed_job["idempotency_key"], f"decision_resume:{q_id}")
        self.assertEqual(
            claimed_job["task"],
            "\n".join(
                [
                    f"[USER_DECISION_RESOLVED decision_id={q_id} kind=question card_id=q-42]",
                    "Question: Which DB engine?",
                    "Selected answer: SQLite",
                    "Note: Need local file portability",
                    "",
                    "Proceed with this decision and report the outcome.",
                ]
            ),
        )

        # Idempotent second resolve returns existing row without duplicate job
        st_res2, res2 = self._req(
            "POST",
            f"/v1/decisions/{q_id}/resolve",
            {"choice": "1", "note": "Should be ignored"},
            token="prod-secret",
        )
        self.assertEqual(st_res2, 200)
        self.assertEqual(res2["decision"]["choice"], "SQLite")
        self.assertEqual(res2["decision"]["resume_job_id"], resume_job_id)
        st_jobs, jobs = self._req("GET", "/v1/jobs?limit=20", token="prod-secret")
        self.assertEqual(st_jobs, 200)
        self.assertEqual(len(jobs["jobs"]), 1)

        # Group decision with no card_id, no aws_session_id, and empty note
        _, grp_d = self._req(
            "POST",
            "/v1/decisions",
            {
                "title": "Merge release PR?",
                "options": ["Merge", "Wait"],
                "source_env": "mac",
                "source_room": "1+1 Routing",
                "source_bot": "Chief",
            },
            token="work-secret",
        )
        grp_id = grp_d["decision"]["decision_id"]
        st_grp, grp_res = self._req(
            "POST",
            f"/v1/decisions/{grp_id}/resolve",
            {"choice": "1"},
            token="prod-secret",
        )
        self.assertEqual(st_grp, 200)
        grp_job_id = grp_res["decision"]["resume_job_id"]
        self.assertTrue(grp_job_id)
        st_gj, gj = self._req("GET", f"/v1/jobs/{grp_job_id}", token="prod-secret")
        self.assertEqual(st_gj, 200)
        self.assertEqual(gj["job"]["group"], "1+1 Routing")
        self.assertIsNone(gj["job"]["bot"])
        self.assertEqual(gj["job"]["aws_session_id"], f"decision:{grp_id}")
        self.assertEqual(
            gj["job"]["task"],
            "\n".join(
                [
                    f"[USER_DECISION_RESOLVED decision_id={grp_id} kind=decision card_id=none]",
                    "Question: Merge release PR?",
                    "Selected answer: Merge",
                    "",
                    "Proceed with this decision and report the outcome.",
                ]
            ),
        )

        # auto_resume=False resolves without creating any resume job
        _, nores_d = self._req(
            "POST",
            "/v1/decisions",
            {
                "title": "FYI choice",
                "options": ["Ack"],
                "source_env": "mac_waiting",
                "source_bot": "Chief",
            },
            token="work-secret",
        )
        nores_id = nores_d["decision"]["decision_id"]
        st_nr, nr = self._req(
            "POST",
            f"/v1/decisions/{nores_id}/resolve",
            {"choice": "1", "auto_resume": False},
            token="prod-secret",
        )
        self.assertEqual(st_nr, 200)
        self.assertEqual(nr["decision"]["choice"], "Ack")
        self.assertIsNone(nr["decision"]["resume_job_id"])
        st_jobs_end, jobs_end = self._req("GET", "/v1/jobs?limit=20", token="prod-secret")
        self.assertEqual(st_jobs_end, 200)
        self.assertEqual(len(jobs_end["jobs"]), 2)

    def test_mcp_bridge_decision_contract(self) -> None:
        sock_path = os.path.join(self.tmpdir.name, "broker.sock")
        if len(sock_path.encode("utf-8")) >= 100:
            self.skipTest("temp socket path exceeds macOS AF_UNIX limit")
        unix_handler = make_handler(
            self.store,
            producer_token="prod-secret",
            worker_token="work-secret",
            team_memory_dir=self.team_mem_dir,
        )
        unix_server = ThreadingUnixStreamServer(sock_path, unix_handler)
        unix_thread = threading.Thread(target=unix_server.serve_forever, daemon=True)
        unix_thread.start()
        try:
            mcp_path = os.path.join(
                os.path.dirname(os.path.abspath(__file__)), "mac-broker-mcp.mjs"
            )
            requests = [
                {
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "tools/call",
                    "params": {
                        "name": "decision_create",
                        "arguments": {
                            "title": "MCP Question",
                            "options": ["Alpha", "Beta"],
                            "kind": "question",
                            "card_id": "mcp-card-1",
                            "source_bot": "Chief",
                        },
                    },
                }
            ]
            env = {
                **os.environ,
                "BROKER_UNIX_SOCK": sock_path,
                "BROKER_PRODUCER_TOKEN": "prod-secret",
            }
            proc = subprocess.run(
                ["node", mcp_path],
                input=json.dumps(requests[0]) + "\n",
                text=True,
                capture_output=True,
                env=env,
                timeout=10,
                check=True,
            )
            create_resp = json.loads(proc.stdout.strip().splitlines()[-1])
            create_body = json.loads(create_resp["result"]["content"][0]["text"])
            self.assertFalse(create_resp["result"]["isError"])
            dec_id = create_body["decision"]["decision_id"]
            self.assertEqual(create_body["decision"]["kind"], "question")
            self.assertEqual(create_body["decision"]["card_id"], "mcp-card-1")

            resolve_req = {
                "jsonrpc": "2.0",
                "id": 2,
                "method": "tools/call",
                "params": {
                    "name": "decision_resolve",
                    "arguments": {
                        "decision_id": dec_id,
                        "choice": "2",
                        "aws_session_id": "sess-mcp-99",
                        "auto_resume": True,
                    },
                },
            }
            proc2 = subprocess.run(
                ["node", mcp_path],
                input=json.dumps(resolve_req) + "\n",
                text=True,
                capture_output=True,
                env=env,
                timeout=10,
                check=True,
            )
            res_resp = json.loads(proc2.stdout.strip().splitlines()[-1])
            res_body = json.loads(res_resp["result"]["content"][0]["text"])
            self.assertFalse(res_resp["result"]["isError"])
            self.assertTrue(res_body["resume_job_id"])
            self.assertEqual(
                res_body["resume_job_id"], res_body["decision"]["resume_job_id"]
            )
            self.assertEqual(res_body["decision"]["choice"], "Beta")
        finally:
            unix_server.shutdown()
            unix_server.server_close()


if __name__ == "__main__":
    unittest.main()
