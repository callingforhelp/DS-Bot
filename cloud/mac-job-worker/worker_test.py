#!/usr/bin/env python3
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler
from unittest.mock import patch

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
sys.path.insert(0, os.path.abspath(os.path.join(_HERE, "..", "mac-job-broker")))
from broker import BrokerStore, ThreadingHTTPServer, make_handler

from worker import (
    BrokerClient,
    MacJobWorker,
    ParadevSessionStore,
    _acquire_dir_lock,
    _ensure_local_git_repo,
    _read_agent_output,
    _release_dir_lock,
    default_dsbot_runner,
    default_git_sync_runner,
    default_paradev_runner,
    ensure_paradev_project,
    is_authorized_local_path,
    run_dsbot_via_local_mcp,
)


class WorkerTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmpdir = tempfile.TemporaryDirectory()
        self.db_path = os.path.join(self.tmpdir.name, "jobs.db")
        self.state_dir = os.path.join(self.tmpdir.name, "state")
        self.store = BrokerStore(self.db_path)
        self.delivered = []
        handler = make_handler(
            self.store,
            producer_token="prod-tok",
            worker_token="work-tok",
            deliver_fn=lambda job: (
                self.delivered.append(job["job_id"]),
                self.store.mark_delivery(job["job_id"], True),
            ),
        )
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.broker_client = BrokerClient(f"http://127.0.0.1:{self.port}", "work-tok")

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.store.close()
        self.tmpdir.cleanup()

    def test_reconcile_resubmits_cached_and_fails_uncached(self) -> None:
        j_cached, _ = self.store.enqueue_job(
            {"target": "dsbot", "task": "cached", "aws_session_id": "s1"}
        )
        j_uncached, _ = self.store.enqueue_job(
            {"target": "paradev", "task": "uncached", "aws_session_id": "s1"}
        )
        self.store.claim_next_job("mac-test")
        self.store.claim_next_job("mac-test")

        worker = MacJobWorker(
            broker=self.broker_client,
            worker_id="mac-test",
            state_dir=self.state_dir,
            paradev_runner=lambda job: {"status": "succeeded", "result_summary": "ok"},
            dsbot_runner=lambda job: {"status": "succeeded", "result_summary": "ok"},
        )
        worker.save_cached_result(
            j_cached["job_id"],
            {
                "job_id": j_cached["job_id"],
                "worker_id": "mac-test",
                "status": "succeeded",
                "result_summary": "CACHED_DONE",
                "pr_url": None,
                "error": None,
            },
        )
        count = worker.reconcile()
        self.assertEqual(count, 2)

        after_cached = self.store.get_job(j_cached["job_id"])
        after_uncached = self.store.get_job(j_uncached["job_id"])
        self.assertEqual(after_cached["status"], "succeeded")
        self.assertEqual(after_cached["result_summary"], "CACHED_DONE")
        self.assertEqual(after_uncached["status"], "failed")
        self.assertIn("not auto-retried", after_uncached["error"])

    def test_claim_adapter_routing_pr_extraction_and_redaction(self) -> None:
        calls = []
        self.store.enqueue_job(
            {"target": "paradev", "task": "open pr", "aws_session_id": "s1"}
        )
        self.store.enqueue_job(
            {"target": "dsbot", "task": "check mac", "aws_session_id": "s1"}
        )

        def fake_paradev(job):
            calls.append(("paradev", job["job_id"]))
            return {
                "status": "succeeded",
                "result_summary": "Opened https://github.com/callingforhelp/app/pull/42 with token sk-1234567890abcdef1234",
                "pr_url": "https://github.com/callingforhelp/app/pull/42",
                "error": None,
            }

        def fake_dsbot(job):
            calls.append(("dsbot", job["job_id"]))
            return {
                "status": "succeeded",
                "result_summary": "DSBOT_DONE",
                "pr_url": None,
                "error": None,
            }

        worker = MacJobWorker(
            broker=self.broker_client,
            worker_id="mac-test",
            state_dir=self.state_dir,
            paradev_runner=fake_paradev,
            dsbot_runner=fake_dsbot,
            heartbeat_interval=0.05,
        )
        r1 = worker.poll_once()
        r2 = worker.poll_once()
        self.assertIsNotNone(r1)
        self.assertIsNotNone(r2)
        self.assertEqual(calls[0][0], "paradev")
        self.assertEqual(calls[1][0], "dsbot")
        self.assertEqual(r1["pr_url"], "https://github.com/callingforhelp/app/pull/42")
        self.assertIn("[REDACTED]", r1["result_summary"])
        self.assertIsNone(worker.poll_once())

    def test_git_sync_push_and_pull(self) -> None:
        bare_dir = os.path.join(self.tmpdir.name, "remote.git")
        subprocess.run(["git", "init", "--bare", "-b", "main", bare_dir], check=True, capture_output=True)

        src_dir = os.path.join(self.tmpdir.name, "demo-app")
        subprocess.run(["git", "init", "-b", "main", src_dir], check=True, capture_output=True)
        subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=src_dir, check=True)
        subprocess.run(["git", "config", "user.name", "Test User"], cwd=src_dir, check=True)
        with open(os.path.join(src_dir, "README.md"), "w", encoding="utf-8") as f:
            f.write("# demo-app\n")
        subprocess.run(["git", "add", "-A"], cwd=src_dir, check=True)
        subprocess.run(["git", "commit", "-m", "init"], cwd=src_dir, check=True, capture_output=True)
        subprocess.run(["git", "remote", "add", "origin", bare_dir], cwd=src_dir, check=True)
        subprocess.run(["git", "push", "-u", "origin", "main"], cwd=src_dir, check=True, capture_output=True)

        # Make dirty edits on Mac and trigger git_sync push via MacJobWorker
        with open(os.path.join(src_dir, "feature.txt"), "w", encoding="utf-8") as f:
            f.write("from mac\n")

        self.store.enqueue_job(
            {
                "target": "git_sync",
                "task": json.dumps({"action": "push", "repo": src_dir, "branch": "feat/mac-sync"}),
                "repo": src_dir,
                "branch": "feat/mac-sync",
                "aws_session_id": "s1",
            }
        )
        worker = MacJobWorker(
            broker=self.broker_client,
            worker_id="mac-test",
            state_dir=self.state_dir,
            paradev_runner=lambda job: {"status": "succeeded", "result_summary": "ok"},
            dsbot_runner=lambda job: {"status": "succeeded", "result_summary": "ok"},
            git_sync_runner=lambda job: default_git_sync_runner(job, "/nonexistent", parent_dir=self.tmpdir.name),
        )
        push_res = worker.poll_once()
        self.assertIsNotNone(push_res)
        self.assertEqual(push_res["status"], "succeeded")
        push_meta = json.loads(push_res["result_summary"])
        self.assertEqual(push_meta["action"], "push")
        self.assertEqual(push_meta["branch"], "feat/mac-sync")
        self.assertTrue(push_meta["dirty_committed"])
        self.assertEqual(push_meta["remote_url"], bare_dir)

        # Simulate cloud updating feat/mac-sync via another clone, then git_sync pull on Mac
        cloud_dir = os.path.join(self.tmpdir.name, "cloud-clone")
        subprocess.run(["git", "clone", "-b", "feat/mac-sync", bare_dir, cloud_dir], check=True, capture_output=True)
        subprocess.run(["git", "config", "user.email", "cloud@example.com"], cwd=cloud_dir, check=True)
        subprocess.run(["git", "config", "user.name", "Cloud User"], cwd=cloud_dir, check=True)
        with open(os.path.join(cloud_dir, "from_cloud.txt"), "w", encoding="utf-8") as f:
            f.write("updated in daytona\n")
        subprocess.run(["git", "add", "-A"], cwd=cloud_dir, check=True)
        subprocess.run(["git", "commit", "-m", "cloud update"], cwd=cloud_dir, check=True, capture_output=True)
        subprocess.run(["git", "push", "origin", "feat/mac-sync"], cwd=cloud_dir, check=True, capture_output=True)

        self.store.enqueue_job(
            {
                "target": "git_sync",
                "task": json.dumps({"action": "pull", "repo": src_dir, "branch": "feat/mac-sync"}),
                "repo": src_dir,
                "branch": "feat/mac-sync",
                "aws_session_id": "s1",
            }
        )
        pull_res = worker.poll_once()
        self.assertIsNotNone(pull_res)
        self.assertEqual(pull_res["status"], "succeeded")
        pull_meta = json.loads(pull_res["result_summary"])
        self.assertTrue(pull_meta["pulled"])
        self.assertTrue(os.path.exists(os.path.join(src_dir, "from_cloud.txt")))

    def test_git_sync_branchless_pull_and_new_push_branch(self) -> None:
        bare_dir = os.path.join(self.tmpdir.name, "remote2.git")
        subprocess.run(["git", "init", "--bare", "-b", "main", bare_dir], check=True, capture_output=True)

        src_dir = os.path.join(self.tmpdir.name, "repo-two")
        subprocess.run(["git", "init", "-b", "main", src_dir], check=True, capture_output=True)
        subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=src_dir, check=True)
        subprocess.run(["git", "config", "user.name", "Test User"], cwd=src_dir, check=True)
        with open(os.path.join(src_dir, "README.md"), "w", encoding="utf-8") as f:
            f.write("# repo-two\n")
        subprocess.run(["git", "add", "-A"], cwd=src_dir, check=True)
        subprocess.run(["git", "commit", "-m", "init"], cwd=src_dir, check=True, capture_output=True)
        subprocess.run(["git", "remote", "add", "origin", bare_dir], cwd=src_dir, check=True)
        subprocess.run(["git", "push", "-u", "origin", "main"], cwd=src_dir, check=True, capture_output=True)

        cloud_dir = os.path.join(self.tmpdir.name, "cloud-two")
        subprocess.run(["git", "clone", bare_dir, cloud_dir], check=True, capture_output=True)
        subprocess.run(["git", "config", "user.email", "cloud@example.com"], cwd=cloud_dir, check=True)
        subprocess.run(["git", "config", "user.name", "Cloud User"], cwd=cloud_dir, check=True)
        with open(os.path.join(cloud_dir, "new.txt"), "w", encoding="utf-8") as f:
            f.write("from cloud\n")
        subprocess.run(["git", "add", "-A"], cwd=cloud_dir, check=True)
        subprocess.run(["git", "commit", "-m", "cloud commit"], cwd=cloud_dir, check=True, capture_output=True)
        subprocess.run(["git", "push", "origin", "main"], cwd=cloud_dir, check=True, capture_output=True)

        runner = lambda job: default_git_sync_runner(
            job, "/nonexistent", parent_dir=self.tmpdir.name
        )

        pull_res = runner(
            {
                "task": json.dumps({"action": "pull", "repo": src_dir}),
                "repo": src_dir,
            }
        )
        self.assertEqual(pull_res["status"], "succeeded")
        pull_meta = json.loads(pull_res["result_summary"])
        self.assertTrue(pull_meta["pulled"])
        self.assertEqual(pull_meta["branch"], "main")
        self.assertTrue(os.path.exists(os.path.join(src_dir, "new.txt")))

        push_res = runner(
            {
                "task": json.dumps(
                    {"action": "push", "repo": src_dir, "branch": "feat/new"}
                ),
                "repo": src_dir,
                "branch": "feat/new",
            }
        )
        self.assertEqual(push_res["status"], "succeeded")
        push_meta = json.loads(push_res["result_summary"])
        self.assertEqual(push_meta["branch"], "feat/new")
        ls = subprocess.run(
            ["git", "ls-remote", "--exit-code", bare_dir, "refs/heads/feat/new"],
            capture_output=True,
            check=False,
        )
        self.assertEqual(ls.returncode, 0)

    def test_git_sync_pull_no_upstream_fails(self) -> None:
        src_dir = os.path.join(self.tmpdir.name, "no-upstream")
        subprocess.run(["git", "init", "-b", "main", src_dir], check=True, capture_output=True)
        subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=src_dir, check=True)
        subprocess.run(["git", "config", "user.name", "Test User"], cwd=src_dir, check=True)
        with open(os.path.join(src_dir, "README.md"), "w", encoding="utf-8") as f:
            f.write("# no-upstream\n")
        subprocess.run(["git", "add", "-A"], cwd=src_dir, check=True)
        subprocess.run(["git", "commit", "-m", "init"], cwd=src_dir, check=True, capture_output=True)

        res = default_git_sync_runner(
            {
                "task": json.dumps({"action": "pull", "repo": src_dir}),
                "repo": src_dir,
            },
            "/nonexistent",
            parent_dir=self.tmpdir.name,
        )
        self.assertEqual(res["status"], "failed")
        self.assertIn("tracking information", res["error"])

    def test_git_sync_push_branch_colliding_with_tag(self) -> None:
        bare_dir = os.path.join(self.tmpdir.name, "tag-remote.git")
        subprocess.run(["git", "init", "--bare", "-b", "main", bare_dir], check=True, capture_output=True)

        src_dir = os.path.join(self.tmpdir.name, "tag-repo")
        subprocess.run(["git", "init", "-b", "main", src_dir], check=True, capture_output=True)
        subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=src_dir, check=True)
        subprocess.run(["git", "config", "user.name", "Test User"], cwd=src_dir, check=True)
        with open(os.path.join(src_dir, "README.md"), "w", encoding="utf-8") as f:
            f.write("# tag-repo\n")
        subprocess.run(["git", "add", "-A"], cwd=src_dir, check=True)
        subprocess.run(["git", "commit", "-m", "init"], cwd=src_dir, check=True, capture_output=True)
        subprocess.run(["git", "remote", "add", "origin", bare_dir], cwd=src_dir, check=True)
        subprocess.run(["git", "push", "-u", "origin", "main"], cwd=src_dir, check=True, capture_output=True)
        subprocess.run(["git", "tag", "v1"], cwd=src_dir, check=True, capture_output=True)

        res = default_git_sync_runner(
            {
                "task": json.dumps(
                    {"action": "push", "repo": src_dir, "branch": "v1"}
                ),
                "repo": src_dir,
                "branch": "v1",
            },
            "/nonexistent",
            parent_dir=self.tmpdir.name,
        )
        self.assertEqual(res["status"], "succeeded")
        meta = json.loads(res["result_summary"])
        self.assertEqual(meta["branch"], "v1")

        def git(*args):
            return subprocess.check_output(["git", "-C", src_dir, *args], text=True).strip()

        self.assertEqual(git("symbolic-ref", "HEAD"), "refs/heads/v1")
        self.assertTrue(git("ls-remote", "--exit-code", bare_dir, "refs/heads/v1"))
        branchless = default_git_sync_runner(
            {"task": "push", "repo": src_dir}, "/nonexistent", parent_dir=self.tmpdir.name
        )
        self.assertEqual(branchless["status"], "succeeded", branchless["error"])
        self.assertEqual(json.loads(branchless["result_summary"])["branch"], "v1")

        branch_tip = git("rev-parse", "HEAD")
        tag_tip = git("commit-tree", "HEAD^{tree}", "-m", "Tag-only commit")
        git("tag", "--force", "v1", tag_tip)
        git("push", "origin", "refs/tags/v1")
        for local_exists in (True, False):
            with self.subTest(local_exists=local_exists):
                git("switch", "main")
                if not local_exists:
                    git("branch", "-D", "v1")
                pull = default_git_sync_runner(
                    {"task": "pull", "repo": src_dir, "branch": "v1"},
                    "/nonexistent",
                    parent_dir=self.tmpdir.name,
                )
                self.assertEqual(pull["status"], "succeeded", pull["error"])
                self.assertEqual(git("symbolic-ref", "HEAD"), "refs/heads/v1")
                self.assertEqual(git("rev-parse", "HEAD"), branch_tip)

    def _make_tag_collision_repo(self) -> tuple:
        bare_dir = os.path.join(self.tmpdir.name, "tag-collide-remote.git")
        subprocess.run(["git", "init", "--bare", "-b", "main", bare_dir], check=True, capture_output=True)
        src_dir = os.path.join(self.tmpdir.name, "tag-collide-repo")
        subprocess.run(["git", "init", "-b", "main", src_dir], check=True, capture_output=True)
        subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=src_dir, check=True)
        subprocess.run(["git", "config", "user.name", "Test User"], cwd=src_dir, check=True)
        with open(os.path.join(src_dir, "README.md"), "w", encoding="utf-8") as f:
            f.write("# tag-collide\n")
        subprocess.run(["git", "add", "-A"], cwd=src_dir, check=True)
        subprocess.run(["git", "commit", "-m", "init"], cwd=src_dir, check=True, capture_output=True)
        subprocess.run(["git", "remote", "add", "origin", bare_dir], cwd=src_dir, check=True)
        subprocess.run(["git", "push", "-u", "origin", "main"], cwd=src_dir, check=True, capture_output=True)
        return bare_dir, src_dir

    def test_git_sync_pull_branch_colliding_with_tag(self) -> None:
        bare_dir, src_dir = self._make_tag_collision_repo()
        subprocess.run(["git", "checkout", "-B", "v1"], cwd=src_dir, check=True, capture_output=True)
        subprocess.run(["git", "push", "-u", "origin", "v1"], cwd=src_dir, check=True, capture_output=True)
        subprocess.run(["git", "checkout", "main"], cwd=src_dir, check=True, capture_output=True)
        subprocess.run(["git", "branch", "-D", "v1"], cwd=src_dir, check=True, capture_output=True)
        subprocess.run(["git", "tag", "v1"], cwd=src_dir, check=True, capture_output=True)

        res = default_git_sync_runner(
            {
                "task": json.dumps(
                    {"action": "pull", "repo": src_dir, "branch": "v1"}
                ),
                "repo": src_dir,
                "branch": "v1",
            },
            "/nonexistent",
            parent_dir=self.tmpdir.name,
        )
        self.assertEqual(res["status"], "succeeded")
        meta = json.loads(res["result_summary"])
        self.assertTrue(meta["pulled"])
        self.assertEqual(meta["branch"], "v1")
        ab = subprocess.run(
            ["git", "-C", src_dir, "rev-parse", "--abbrev-ref", "HEAD"],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertIn(ab.stdout.strip(), ("v1", "heads/v1"))

    def test_git_sync_branchless_push_on_tag_named_branch(self) -> None:
        bare_dir, src_dir = self._make_tag_collision_repo()
        subprocess.run(["git", "tag", "v1"], cwd=src_dir, check=True, capture_output=True)
        subprocess.run(["git", "checkout", "-B", "v1"], cwd=src_dir, check=True, capture_output=True)

        res = default_git_sync_runner(
            {
                "task": json.dumps({"action": "push", "repo": src_dir}),
                "repo": src_dir,
            },
            "/nonexistent",
            parent_dir=self.tmpdir.name,
        )
        self.assertEqual(res["status"], "succeeded")
        meta = json.loads(res["result_summary"])
        self.assertEqual(meta["branch"], "v1")
        ls = subprocess.run(
            ["git", "ls-remote", "--exit-code", bare_dir, "refs/heads/v1"],
            capture_output=True,
            check=False,
        )
        self.assertEqual(ls.returncode, 0)
        ab = subprocess.run(
            ["git", "-C", src_dir, "rev-parse", "--abbrev-ref", "HEAD"],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertIn(ab.stdout.strip(), ("v1", "heads/v1"))


FAKE_PARADEV_SCRIPT = r"""#!/usr/bin/env python3
import json
import os
import sys

log = os.environ.get("FAKE_PARADEV_LOG")
if log:
    with open(log, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(sys.argv[1:]) + "\n")

args = sys.argv[1:]
cmd = args[:2]
if cmd == ["projects", "list"]:
    print(os.environ.get("FAKE_PARADEV_PROJECTS_JSON") or "[]")
elif cmd == ["projects", "create"]:
    name = args[args.index("--name") + 1] if "--name" in args else "proj"
    print(json.dumps({"id": "proj-fake", "name": name}))
elif cmd == ["terminals", "send"]:
    print(json.dumps({"ok": True}))
elif cmd == ["terminals", "list"]:
    print(json.dumps({"sessions": [{"terminalId": "term-fake-1", "exited": False}]}))
elif cmd == ["ws", "list"]:
    print(os.environ.get("FAKE_PARADEV_WS_JSON") or "[]")
elif cmd == ["agents", "create"]:
    print(json.dumps({"sessionId": "term-fake-1"}))
elif cmd == ["agents", "wait"]:
    print(json.dumps({"status": "settled"}))
elif cmd == ["agents", "read"]:
    if os.environ.get("FAKE_PARADEV_AGENTS_READ_FAIL"):
        sys.stderr.write("Error: No transcript for that terminal\n")
        sys.exit(2)
    print(json.dumps({"text": "User: first task\nAssistant: first answer\nUser: follow up\nAssistant: latest answer"}))
elif cmd == ["terminals", "read"]:
    if os.environ.get("FAKE_PARADEV_TERMINALS_READ_FAIL"):
        sys.stderr.write("Error: terminals read unavailable\n")
        sys.exit(3)
    print(json.dumps({"text": "devin terminal transcript"}))
elif cmd == ["ws", "create"]:
    print(json.dumps({"workspace": {"id": "ws-new-1"}, "agents": [{"sessionId": "term-new-1"}]}))
elif cmd == ["ws", "archive"]:
    print(json.dumps({"ok": True}))
else:
    print(json.dumps({"ok": True}))
"""


FAKE_DSH_SCRIPT = r"""#!/usr/bin/env python3
import json
import os
import sys

log = os.environ.get("FAKE_DSH_LOG")
if log:
    with open(log, "a", encoding="utf-8") as fh:
        fh.write(json.dumps({
            "cwd": os.getcwd(),
            "ws": os.environ.get("PARADEV_WORKSPACE_ID", ""),
            "argv": sys.argv[1:],
        }) + "\n")
print("dsh headless output")
"""


class _StubBroker:
    def __init__(self) -> None:
        self.completed = []

    def post(self, path, payload, timeout=15.0):
        if path == "/v1/worker/complete":
            self.completed.append(payload)
        return 200, {"ok": True}


class ParaDevRunnerTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmpdir = tempfile.TemporaryDirectory()
        self.fake_bin = os.path.join(self.tmpdir.name, "paradev")
        with open(self.fake_bin, "w", encoding="utf-8") as f:
            f.write(FAKE_PARADEV_SCRIPT)
        os.chmod(self.fake_bin, 0o755)
        self.log_path = os.path.join(self.tmpdir.name, "paradev_calls.jsonl")
        self._saved_env = {
            k: os.environ.get(k)
            for k in (
                "FAKE_PARADEV_LOG",
                "FAKE_PARADEV_WS_JSON",
                "FAKE_PARADEV_PROJECTS_JSON",
                "FAKE_PARADEV_AGENTS_READ_FAIL",
                "FAKE_PARADEV_TERMINALS_READ_FAIL",
                "FAKE_DSH_LOG",
                "PARADEV_SESSIONS_FILE",
                "WORKER_STATE_DIR",
                "MAC_WORKER_ALLOWED_ROOTS",
            )
        }
        os.environ["FAKE_PARADEV_LOG"] = self.log_path
        os.environ["PARADEV_SESSIONS_FILE"] = os.path.join(
            self.tmpdir.name, "paradev_sessions.json"
        )
        for k in (
            "FAKE_PARADEV_WS_JSON",
            "FAKE_PARADEV_PROJECTS_JSON",
            "FAKE_PARADEV_AGENTS_READ_FAIL",
            "FAKE_PARADEV_TERMINALS_READ_FAIL",
            "FAKE_DSH_LOG",
            "WORKER_STATE_DIR",
            "MAC_WORKER_ALLOWED_ROOTS",
        ):
            os.environ.pop(k, None)

    def tearDown(self) -> None:
        for k, v in self._saved_env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        self.tmpdir.cleanup()

    def _calls(self) -> list:
        if not os.path.exists(self.log_path):
            return []
        with open(self.log_path, "r", encoding="utf-8") as f:
            return [json.loads(ln) for ln in f if ln.strip()]

    def test_followup_existing_workspace_terminal(self) -> None:
        job = {
            "task": "follow up please",
            "workspace_id": "ws-42",
            "terminal_id": "term-7",
            "timeout_sec": 60,
        }
        res = default_paradev_runner(job, self.fake_bin)
        self.assertEqual(res["status"], "succeeded")
        calls = self._calls()
        sends = [c for c in calls if c[:2] == ["terminals", "send"]]
        self.assertEqual(len(sends), 1)
        cmd = sends[0]
        self.assertEqual(cmd[cmd.index("--workspace") + 1], "ws-42")
        self.assertEqual(cmd[cmd.index("--terminal") + 1], "term-7")
        self.assertEqual(cmd[cmd.index("--text") + 1], "follow up please")
        self.assertIn("--wait", cmd)
        self.assertEqual(cmd[cmd.index("--until") + 1], "settled")
        self.assertFalse(any(c[:2] == ["ws", "create"] for c in calls))
        self.assertFalse(any(c[:2] == ["ws", "archive"] for c in calls))
        summary = res["result_summary"]
        self.assertIn("latest answer", summary)
        self.assertNotIn("first answer", summary)
        self.assertIn(
            "[paradev workspace_id=ws-42 terminal_id=term-7 role=worker agent=codex]",
            summary,
        )

    def test_agents_create_in_existing_workspace(self) -> None:
        job = {
            "task": "new agent task",
            "workspace_id": "ws-9",
            "agent": "devin",
            "timeout_sec": 60,
        }
        res = default_paradev_runner(job, self.fake_bin)
        self.assertEqual(res["status"], "succeeded")
        calls = self._calls()
        creates = [c for c in calls if c[:2] == ["agents", "create"]]
        self.assertEqual(len(creates), 1)
        cmd = creates[0]
        self.assertEqual(cmd[cmd.index("--workspace") + 1], "ws-9")
        self.assertEqual(cmd[cmd.index("--agent") + 1], "devin")
        self.assertEqual(cmd[cmd.index("--prompt") + 1], "new agent task")
        self.assertNotIn("--model", cmd)
        waits = [c for c in calls if c[:2] == ["agents", "wait"]]
        self.assertEqual(len(waits), 1)
        self.assertEqual(waits[0][waits[0].index("--terminal") + 1], "term-fake-1")
        self.assertFalse(any(c[:2] == ["ws", "create"] for c in calls))
        self.assertFalse(any(c[:2] == ["ws", "archive"] for c in calls))
        self.assertIn(
            "[paradev workspace_id=ws-9 terminal_id=term-fake-1 role=worker agent=devin]",
            res["result_summary"],
        )

    def test_ws_create_session_archived(self) -> None:
        job = {"task": "one shot", "timeout_sec": 60}
        res = default_paradev_runner(job, self.fake_bin)
        self.assertEqual(res["status"], "succeeded")
        calls = self._calls()
        creates = [c for c in calls if c[:2] == ["ws", "create"]]
        self.assertEqual(len(creates), 1)
        self.assertIn("--session", creates[0])
        archives = [c for c in calls if c[:2] == ["ws", "archive"]]
        self.assertEqual(len(archives), 1)
        self.assertIn(
            "[paradev workspace_id=ws-new-1 terminal_id=term-new-1 role=worker agent=codex]",
            res["result_summary"],
        )

    def test_ensure_paradev_project_local_bootstrap(self) -> None:
        target = os.path.join(self.tmpdir.name, "local-proj")
        os.makedirs(target)
        proj, already = ensure_paradev_project(
            target, self.fake_bin, parent_dir=self.tmpdir.name, local_only=True
        )
        self.assertFalse(already)
        self.assertIsNotNone(proj)
        self.assertTrue(os.path.isdir(os.path.join(target, ".git")))
        with open(os.path.join(target, "README.md"), "r", encoding="utf-8") as f:
            self.assertEqual(f.read(), "# local-proj\n")
        head = subprocess.run(
            ["git", "-C", target, "rev-parse", "--verify", "HEAD"],
            capture_output=True,
            check=False,
        )
        self.assertEqual(head.returncode, 0)
        creates = [c for c in self._calls() if c[:2] == ["projects", "create"]]
        self.assertEqual(len(creates), 1)
        self.assertIn("--import", creates[0])
        self.assertNotIn("--clone", creates[0])
        self.assertEqual(creates[0][creates[0].index("--import") + 1], target)
        self.assertEqual(creates[0][creates[0].index("--name") + 1], "local-proj")

    def test_ensure_paradev_project_local_only_new_dir(self) -> None:
        target = os.path.join(self.tmpdir.name, "fresh-proj")
        proj, already = ensure_paradev_project(
            "fresh-proj", self.fake_bin, parent_dir=self.tmpdir.name, local_only=True
        )
        self.assertFalse(already)
        self.assertIsNotNone(proj)
        self.assertTrue(os.path.isdir(os.path.join(target, ".git")))
        creates = [c for c in self._calls() if c[:2] == ["projects", "create"]]
        self.assertEqual(len(creates), 1)
        self.assertIn("--import", creates[0])
        self.assertNotIn("--clone", creates[0])

    def test_unauthorized_paths_rejected(self) -> None:
        with self.assertRaises(RuntimeError):
            ensure_paradev_project("/Users/chief/.ssh", self.fake_bin)
        with self.assertRaises(RuntimeError):
            default_dsbot_runner(
                {"task": "x", "cwd": "/Users/chief/.ssh"}, "dsh", "patch.yml"
            )
        self.assertFalse(is_authorized_local_path("/Users/chief/.ssh"))
        self.assertFalse(is_authorized_local_path("/Users/chief/.aws"))
        self.assertFalse(is_authorized_local_path("/Users/chief/Library"))
        self.assertFalse(is_authorized_local_path("/Users/chief/library/foo"))
        self.assertFalse(is_authorized_local_path("/Users/chief/.SSH"))
        self.assertFalse(is_authorized_local_path("/Users/chief/LIBRARY/Preferences"))
        self.assertFalse(is_authorized_local_path("/Users/chief/.hidden-dir"))
        self.assertFalse(is_authorized_local_path("/etc/passwd"))
        self.assertFalse(is_authorized_local_path("/Users/chief"))
        self.assertTrue(is_authorized_local_path("/Users/chief/some-project"))
        self.assertTrue(
            is_authorized_local_path("/Users/chief/some-project/nested/dir")
        )
        self.assertTrue(
            is_authorized_local_path("/Users/chief/devin-agent-work/job-1")
        )
        self.assertTrue(
            is_authorized_local_path(
                "/Users/chief/.gemini/antigravity/scratch/mac-job-worker"
            )
        )

    def test_reviewer_role_agents_create_and_payload(self) -> None:
        stub = _StubBroker()
        worker = MacJobWorker(
            broker=stub,
            worker_id="mac-test",
            state_dir=os.path.join(self.tmpdir.name, "state"),
            paradev_runner=lambda job: default_paradev_runner(job, self.fake_bin),
            dsbot_runner=lambda job: {"status": "succeeded", "result_summary": "ok"},
        )
        payload = worker.execute_job(
            {
                "job_id": "job-rev",
                "target": "paradev",
                "task": "review this change",
                "workspace_id": "ws-9",
                "role": "reviewer",
                "agent": "codex",
                "timeout_sec": 60,
            }
        )
        calls = self._calls()
        creates = [c for c in calls if c[:2] == ["agents", "create"]]
        self.assertEqual(len(creates), 1)
        self.assertEqual(creates[0][creates[0].index("--workspace") + 1], "ws-9")
        self.assertFalse(any(c[:2] == ["terminals", "send"] for c in calls))
        self.assertEqual(payload["status"], "succeeded")
        self.assertEqual(payload["role"], "reviewer")
        self.assertEqual(payload["agent"], "codex")
        self.assertEqual(payload["workspace_id"], "ws-9")
        self.assertEqual(payload["terminal_id"], "term-fake-1")
        self.assertIn(
            "[paradev workspace_id=ws-9 terminal_id=term-fake-1 role=reviewer agent=codex]",
            payload["result_summary"],
        )
        self.assertEqual(len(stub.completed), 1)
        self.assertEqual(stub.completed[0]["role"], "reviewer")
        self.assertEqual(stub.completed[0]["workspace_id"], "ws-9")

    def test_dsbot_agent_uses_worktree(self) -> None:
        worktree = os.path.join(self.tmpdir.name, "worktree")
        os.makedirs(worktree)
        os.environ["MAC_WORKER_ALLOWED_ROOTS"] = self.tmpdir.name
        os.environ["FAKE_PARADEV_WS_JSON"] = json.dumps(
            [{"id": "ws-wt", "projectId": "proj-x", "worktreePath": worktree}]
        )
        fake_dsh = os.path.join(self.tmpdir.name, "dsh")
        with open(fake_dsh, "w", encoding="utf-8") as f:
            f.write(FAKE_DSH_SCRIPT)
        os.chmod(fake_dsh, 0o755)
        dsh_log = os.path.join(self.tmpdir.name, "dsh_calls.jsonl")
        os.environ["FAKE_DSH_LOG"] = dsh_log

        res = default_paradev_runner(
            {
                "task": "check worktree",
                "target": "paradev",
                "workspace_id": "ws-wt",
                "agent": "dsbot",
                "timeout_sec": 60,
            },
            self.fake_bin,
            dsh_bin=fake_dsh,
            headless_patch="patch.yml",
        )
        self.assertEqual(res["status"], "succeeded")
        self.assertIn("dsh headless output", res["result_summary"])
        self.assertIn(
            "[paradev workspace_id=ws-wt terminal_id=dsbot-headless role=worker agent=dsbot]",
            res["result_summary"],
        )
        self.assertEqual(res["workspace_id"], "ws-wt")
        self.assertEqual(res["terminal_id"], "dsbot-headless")
        self.assertEqual(res["worktree_path"], worktree)
        self.assertFalse(any(c[:2] == ["agents", "create"] for c in self._calls()))
        self.assertFalse(any(c[:2] == ["terminals", "send"] for c in self._calls()))
        with open(dsh_log, "r", encoding="utf-8") as f:
            entry = json.loads(f.readline())
        self.assertEqual(os.path.realpath(entry["cwd"]), os.path.realpath(worktree))
        self.assertEqual(entry["ws"], "ws-wt")

    def test_session_store_reuses_saved_terminal(self) -> None:
        sessions_path = os.path.join(self.tmpdir.name, "sessions.json")
        ParadevSessionStore(sessions_path).set(
            "proj-x:main",
            {"workspace_id": "ws-9", "worker_terminal_id": "term-fake-1"},
        )
        os.environ["FAKE_PARADEV_WS_JSON"] = json.dumps([{"id": "ws-9"}])
        res = default_paradev_runner(
            {"task": "resume work", "repo": "proj-x", "branch": "main", "timeout_sec": 60},
            self.fake_bin,
            sessions_file=sessions_path,
        )
        self.assertEqual(res["status"], "succeeded")
        calls = self._calls()
        sends = [c for c in calls if c[:2] == ["terminals", "send"]]
        self.assertEqual(len(sends), 1)
        self.assertEqual(sends[0][sends[0].index("--workspace") + 1], "ws-9")
        self.assertEqual(sends[0][sends[0].index("--terminal") + 1], "term-fake-1")
        self.assertFalse(any(c[:2] == ["ws", "create"] for c in calls))
        self.assertFalse(any(c[:2] == ["agents", "create"] for c in calls))
        entry = ParadevSessionStore(sessions_path).get("proj-x:main")
        self.assertEqual(entry["workspace_id"], "ws-9")
        self.assertEqual(entry["worker_terminal_id"], "term-fake-1")

    def test_session_store_merges_roles_by_workspace(self) -> None:
        sessions_path = os.environ["PARADEV_SESSIONS_FILE"]
        os.environ["FAKE_PARADEV_PROJECTS_JSON"] = json.dumps(
            [{"id": "proj-foo", "name": "foo", "path": "/tmp/foo"}]
        )
        res1 = default_paradev_runner(
            {"task": "do work", "repo": "foo", "timeout_sec": 60},
            self.fake_bin,
        )
        self.assertEqual(res1["status"], "succeeded")
        self.assertEqual(res1["workspace_id"], "ws-new-1")
        entry = ParadevSessionStore(sessions_path).get("foo:default")
        self.assertIsNotNone(entry)
        self.assertEqual(entry["workspace_id"], "ws-new-1")
        self.assertEqual(entry["worker_terminal_id"], "term-new-1")

        res2 = default_paradev_runner(
            {
                "task": "review it",
                "workspace_id": "ws-new-1",
                "role": "reviewer",
                "timeout_sec": 60,
            },
            self.fake_bin,
        )
        self.assertEqual(res2["status"], "succeeded")
        calls = self._calls()
        creates = [c for c in calls if c[:2] == ["agents", "create"]]
        self.assertEqual(len(creates), 1)
        store = ParadevSessionStore(sessions_path)
        self.assertIsNone(store.get("ws-new-1:default"))
        entry = store.get("foo:default")
        self.assertEqual(entry["workspace_id"], "ws-new-1")
        self.assertEqual(entry["worker_terminal_id"], "term-new-1")
        self.assertEqual(entry["reviewer_terminal_id"], "term-fake-1")
        self.assertEqual(list(store._load().keys()), ["foo:default"])

    def test_ensure_local_git_repo_gitfile_is_noop(self) -> None:
        d = os.path.join(self.tmpdir.name, "linked-wt")
        os.makedirs(d)
        gitfile = os.path.join(d, ".git")
        with open(gitfile, "w", encoding="utf-8") as f:
            f.write("gitdir: /private/tmp/real/.git/worktrees/linked-wt\n")
        _ensure_local_git_repo(d, "linked-wt")
        with open(gitfile, "r", encoding="utf-8") as f:
            self.assertTrue(f.read().startswith("gitdir:"))
        self.assertEqual(os.listdir(d), [".git"])

    def test_allowed_roots_env_disables_home_fallback(self) -> None:
        os.environ["MAC_WORKER_ALLOWED_ROOTS"] = self.tmpdir.name
        self.assertTrue(
            is_authorized_local_path(os.path.join(self.tmpdir.name, "proj"))
        )
        self.assertFalse(is_authorized_local_path("/Users/chief/some-project"))
        self.assertFalse(
            is_authorized_local_path("/Users/chief/devin-agent-work/job-1")
        )
        self.assertFalse(
            is_authorized_local_path("/Users/chief/.gemini/antigravity/scratch/x")
        )

    def test_read_agent_output_falls_back_to_terminals_read(self) -> None:
        os.environ["FAKE_PARADEV_AGENTS_READ_FAIL"] = "1"
        text = _read_agent_output(self.fake_bin, "ws-1", "term-devin")
        self.assertEqual(text, "devin terminal transcript")
        calls = self._calls()
        self.assertTrue(any(c[:2] == ["agents", "read"] for c in calls))
        self.assertTrue(any(c[:2] == ["terminals", "read"] for c in calls))
        res = default_paradev_runner(
            {
                "task": "follow up",
                "workspace_id": "ws-1",
                "terminal_id": "term-devin",
                "agent": "devin",
                "timeout_sec": 60,
            },
            self.fake_bin,
        )
        self.assertEqual(res["status"], "succeeded")
        self.assertIn("devin terminal transcript", res["result_summary"])
        self.assertNotIn("latest answer", res["result_summary"])

    def test_read_agent_output_raises_when_both_fail(self) -> None:
        os.environ["FAKE_PARADEV_AGENTS_READ_FAIL"] = "1"
        os.environ["FAKE_PARADEV_TERMINALS_READ_FAIL"] = "1"
        with self.assertRaises(RuntimeError) as ctx:
            _read_agent_output(self.fake_bin, "ws-1", "term-1")
        self.assertIn("terminals read failed", str(ctx.exception))

    def test_authorized_local_path_case_insensitive(self) -> None:
        self.assertTrue(is_authorized_local_path("/USERS/CHIEF/some-new-project"))
        self.assertFalse(is_authorized_local_path("/Users/Chief/.SSH"))
        self.assertFalse(is_authorized_local_path("/users/chief/LIBRARY/foo"))
        os.environ["MAC_WORKER_ALLOWED_ROOTS"] = "/Users/CHIEF/Devin-Agent-Work"
        try:
            self.assertTrue(
                is_authorized_local_path("/users/chief/devin-agent-work/job-9")
            )
            self.assertFalse(is_authorized_local_path("/Users/chief/other-dir"))
        finally:
            os.environ.pop("MAC_WORKER_ALLOWED_ROOTS", None)

    def test_paradev_runner_rejects_unauthorized_worktree(self) -> None:
        os.environ["FAKE_PARADEV_WS_JSON"] = json.dumps(
            [
                {
                    "id": "ws-evil",
                    "projectId": "p",
                    "worktreePath": "/Users/chief/.ssh",
                }
            ]
        )
        with self.assertRaises(RuntimeError) as ctx:
            default_paradev_runner(
                {
                    "task": "x",
                    "workspace_id": "ws-evil",
                    "terminal_id": "t-1",
                    "timeout_sec": 60,
                },
                self.fake_bin,
            )
        self.assertIn("Unauthorized local path", str(ctx.exception))
        self.assertFalse(
            any(c[:2] == ["terminals", "send"] for c in self._calls())
        )

    def test_flush_recovers_claim_and_preserves_appends(self) -> None:
        spool = os.path.join(self.tmpdir.name, "decisions.jsonl")
        claim = f"{spool}.flushing"
        with open(claim, "w", encoding="utf-8") as f:
            f.write(json.dumps({"d": "claimed"}) + "\n")
        with open(spool, "w", encoding="utf-8") as f:
            f.write(json.dumps({"d": "spooled"}) + "\n")

        posted: list = []
        appended: list = []

        class AppendBroker(_StubBroker):
            def post(self, path, payload, timeout=15.0):
                if path == "/v1/decisions":
                    posted.append(payload)
                    if not appended:
                        appended.append(True)
                        with open(spool, "a", encoding="utf-8") as af:
                            af.write(json.dumps({"d": "concurrent"}) + "\n")
                return super().post(path, payload, timeout)

        worker = MacJobWorker(
            broker=AppendBroker(),
            worker_id="mac-test",
            state_dir=os.path.join(self.tmpdir.name, "state"),
            paradev_runner=lambda job: {"status": "succeeded", "result_summary": "ok"},
            dsbot_runner=lambda job: {"status": "succeeded", "result_summary": "ok"},
        )
        n = worker.flush_pending_decisions(spool)
        self.assertEqual(n, 2)
        self.assertEqual(posted, [{"d": "claimed"}, {"d": "spooled"}])
        self.assertFalse(os.path.exists(claim))
        self.assertTrue(os.path.exists(spool))
        with open(spool, "r", encoding="utf-8") as f:
            self.assertEqual(
                [json.loads(ln) for ln in f if ln.strip()], [{"d": "concurrent"}]
            )
        self.assertEqual(worker.flush_pending_decisions(spool), 1)
        self.assertFalse(os.path.exists(spool))

    def test_strict_roots_fail_closed_when_worktree_unverifiable(self) -> None:
        os.environ["MAC_WORKER_ALLOWED_ROOTS"] = self.tmpdir.name
        with self.assertRaises(RuntimeError) as ctx:
            default_paradev_runner(
                {
                    "task": "x",
                    "workspace_id": "ws-unknown",
                    "terminal_id": "t-1",
                    "timeout_sec": 60,
                },
                self.fake_bin,
            )
        self.assertIn("could not be verified", str(ctx.exception))
        self.assertFalse(
            any(c[:2] == ["terminals", "send"] for c in self._calls())
        )

    def test_dir_lock_timeout_and_stale_reclaim(self) -> None:
        lock = os.path.join(self.tmpdir.name, "x.lock")
        os.mkdir(lock)
        with self.assertRaises(TimeoutError):
            _acquire_dir_lock(lock, timeout_sec=0.05, stale_sec=60.0)
        old = time.time() - 120
        os.utime(lock, (old, old))
        _acquire_dir_lock(lock, timeout_sec=1.0, stale_sec=30.0)
        _release_dir_lock(lock)
        self.assertFalse(os.path.exists(lock))

    def test_dsbot_strict_roots_fail_closed(self) -> None:
        os.environ["MAC_WORKER_ALLOWED_ROOTS"] = self.tmpdir.name
        fake_dsh = os.path.join(self.tmpdir.name, "dsh")
        with open(fake_dsh, "w", encoding="utf-8") as f:
            f.write(FAKE_DSH_SCRIPT)
        os.chmod(fake_dsh, 0o755)
        with self.assertRaises(RuntimeError) as ctx:
            default_paradev_runner(
                {
                    "task": "x",
                    "workspace_id": "ws-unknown",
                    "agent": "dsbot",
                    "timeout_sec": 60,
                },
                self.fake_bin,
                dsh_bin=fake_dsh,
            )
        self.assertIn("could not be verified", str(ctx.exception))

    def test_flush_concurrent_calls_no_loss(self) -> None:
        spool = os.path.join(self.tmpdir.name, "decisions.jsonl")
        claim = f"{spool}.flushing"
        with open(spool, "w", encoding="utf-8") as f:
            f.write(json.dumps({"d": "first"}) + "\n")
            f.write(json.dumps({"d": "second"}) + "\n")

        calls: list = []
        release = threading.Event()

        class FlakyBroker(_StubBroker):
            def post(self, path, payload, timeout=15.0):
                if path == "/v1/decisions":
                    calls.append(payload)
                    if len(calls) == 1:
                        release.wait(5)
                        return 500, {"ok": False}
                return super().post(path, payload, timeout)

        worker = MacJobWorker(
            broker=FlakyBroker(),
            worker_id="mac-test",
            state_dir=os.path.join(self.tmpdir.name, "state"),
            paradev_runner=lambda job: {"status": "succeeded", "result_summary": "ok"},
            dsbot_runner=lambda job: {"status": "succeeded", "result_summary": "ok"},
        )
        results: list = []
        t1 = threading.Thread(
            target=lambda: results.append(worker.flush_pending_decisions(spool))
        )
        t1.start()
        time.sleep(0.2)
        t2 = threading.Thread(
            target=lambda: results.append(worker.flush_pending_decisions(spool))
        )
        t2.start()
        release.set()
        t1.join(timeout=10)
        t2.join(timeout=20)
        self.assertEqual(sorted(results), [0, 2])
        self.assertEqual(
            calls, [{"d": "first"}, {"d": "first"}, {"d": "second"}]
        )
        self.assertFalse(os.path.exists(claim))
        self.assertFalse(os.path.exists(spool))

    def test_strict_roots_check_workspace_restored_from_session_store(self) -> None:
        allowed = os.path.join(self.tmpdir.name, "allowed")
        os.mkdir(allowed)
        os.environ["MAC_WORKER_ALLOWED_ROOTS"] = allowed
        os.environ["FAKE_PARADEV_WS_JSON"] = json.dumps(
            [{"id": "ws-outside", "worktreePath": self.tmpdir.name}]
        )
        store = ParadevSessionStore(os.environ["PARADEV_SESSIONS_FILE"])
        store.upsert(
            "demo:main",
            {"workspace_id": "ws-outside", "worker_terminal_id": "term-fake-1"},
        )
        with self.assertRaisesRegex(RuntimeError, "Unauthorized local path"):
            default_paradev_runner(
                {"task": "x", "repo": "demo", "branch": "main"},
                self.fake_bin,
            )
        self.assertFalse(any(c[:2] == ["terminals", "send"] for c in self._calls()))

    def test_dsbot_does_not_fall_back_from_unverified_workspace(self) -> None:
        os.environ["MAC_WORKER_ALLOWED_ROOTS"] = self.tmpdir.name
        for workspace in (
            [],
            [{"id": "ws-1", "path": self.tmpdir.name}],
            [{"id": "ws-1", "worktreePath": os.path.join(self.tmpdir.name, "missing")}],
        ):
            with self.subTest(workspace=workspace), patch("worker.default_dsbot_runner") as run:
                os.environ["FAKE_PARADEV_WS_JSON"] = json.dumps(workspace)
                with self.assertRaisesRegex(RuntimeError, "could not be verified"):
                    default_paradev_runner(
                        {
                            "task": "x",
                            "workspace_id": "ws-1",
                            "agent": "dsbot",
                            "cwd": self.tmpdir.name,
                        },
                        self.fake_bin,
                    )
                run.assert_not_called()

    def test_git_sync_push_fails_on_detached_head(self) -> None:
        bare_dir = os.path.join(self.tmpdir.name, "detached-remote.git")
        subprocess.run(["git", "init", "--bare", "-b", "main", bare_dir], check=True, capture_output=True)
        src_dir = os.path.join(self.tmpdir.name, "detached-repo")
        subprocess.run(["git", "init", "-b", "main", src_dir], check=True, capture_output=True)
        subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=src_dir, check=True)
        subprocess.run(["git", "config", "user.name", "Test User"], cwd=src_dir, check=True)
        with open(os.path.join(src_dir, "README.md"), "w", encoding="utf-8") as f:
            f.write("# detached\n")
        subprocess.run(["git", "add", "-A"], cwd=src_dir, check=True)
        subprocess.run(["git", "commit", "-m", "init"], cwd=src_dir, check=True, capture_output=True)
        subprocess.run(["git", "remote", "add", "origin", bare_dir], cwd=src_dir, check=True)
        subprocess.run(["git", "checkout", "--detach", "HEAD"], cwd=src_dir, check=True, capture_output=True)

        res = default_git_sync_runner(
            {"task": json.dumps({"action": "push", "repo": src_dir}), "repo": src_dir},
            "/nonexistent",
            parent_dir=self.tmpdir.name,
        )
        self.assertEqual(res["status"], "failed")
        self.assertIn("detached HEAD", res["error"])

    def test_git_sync_rejects_invalid_branch_name(self) -> None:
        src_dir = os.path.join(self.tmpdir.name, "invalid-branch-repo")
        os.mkdir(src_dir)
        for bad_branch in ("--evil", "bad..name"):
            with self.subTest(branch=bad_branch):
                res = default_git_sync_runner(
                    {
                        "task": json.dumps({"action": "pull", "repo": src_dir, "branch": bad_branch}),
                        "repo": src_dir,
                        "branch": bad_branch,
                    },
                    "/nonexistent",
                    parent_dir=self.tmpdir.name,
                )
                self.assertEqual(res["status"], "failed")
                self.assertIn("Invalid Git branch name", res["error"])

    def test_dsbot_runner_local_mcp_bot_and_group_waiting(self) -> None:
        calls: list[tuple[str, dict]] = []
        mode = {"scenario": "bot"}

        class FakeMcpHandler(BaseHTTPRequestHandler):
            def log_message(self, fmt: str, *args) -> None:
                return

            def do_POST(self) -> None:
                if self.headers.get("Authorization") != "Bearer test-mcp-tok":
                    self.send_response(401)
                    self.end_headers()
                    return
                length = int(self.headers.get("Content-Length") or 0)
                req = json.loads(self.rfile.read(length).decode("utf-8"))
                method = req.get("method")
                params = req.get("params") or {}
                tool_name = params.get("name")
                args = params.get("arguments") or {}
                calls.append((tool_name or method, args))

                if tool_name == "list_bots":
                    result = {
                        "bots": [
                            {"id": "helper", "name": "Helper", "main": False, "working": False},
                            {"id": "chief", "name": "Chief", "main": True, "working": False},
                        ]
                    }
                elif tool_name == "send_to_bot":
                    result = {"sent": True, "after": 1000}
                elif tool_name == "send_to_group":
                    result = {"sent": True, "after": 2000}
                elif tool_name == "wait_for_reply":
                    if mode["scenario"] == "bot":
                        result = {
                            "done": True,
                            "working": False,
                            "after": 1500,
                            "messages": [
                                {
                                    "kind": "assistant",
                                    "from": "Chief",
                                    "text": "Opened PR https://github.com/callingforhelp/DS-Bot/pull/99",
                                    "time": 1500,
                                }
                            ],
                        }
                    else:
                        result = {"done": False, "working": True, "after": 2000, "messages": []}
                elif tool_name == "list_waiting":
                    if mode["scenario"] == "group_waiting":
                        result = {
                            "waiting": [
                                {
                                    "kind": "approval",
                                    "bot": "Coder",
                                    "group": "Ops",
                                    "tool": "bash",
                                    "reason": "run deploy",
                                }
                            ],
                            "answerIn": "DS Bot on this computer",
                        }
                    else:
                        result = {"waiting": [], "answerIn": "DS Bot on this computer"}
                else:
                    result = {}

                body = json.dumps(
                    {
                        "jsonrpc": "2.0",
                        "id": req.get("id"),
                        "result": {
                            "content": [{"type": "text", "text": json.dumps(result)}],
                            "structuredContent": result,
                        },
                    }
                ).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        srv = ThreadingHTTPServer(("127.0.0.1", 0), FakeMcpHandler)
        t = threading.Thread(target=srv.serve_forever, daemon=True)
        t.start()
        try:
            mcp_url = f"http://127.0.0.1:{srv.server_address[1]}/mcp"
            with patch("worker.subprocess.run") as sub_run:
                res = default_dsbot_runner(
                    {"task": "check PR", "timeout_sec": 30},
                    "/nonexistent/dsh",
                    "/nonexistent/patch.yml",
                    mcp_url=mcp_url,
                    mcp_token="test-mcp-tok",
                )
                sub_run.assert_not_called()
            self.assertEqual(res["status"], "succeeded")
            self.assertEqual(res["pr_url"], "https://github.com/callingforhelp/DS-Bot/pull/99")
            self.assertIn("[Chief] Opened PR", res["result_summary"])
            self.assertEqual([c[0] for c in calls[:3]], ["list_bots", "send_to_bot", "wait_for_reply"])
            self.assertEqual(calls[1][1]["bot"], "Chief")

            calls.clear()
            mode["scenario"] = "group_waiting"
            with patch("worker.subprocess.run") as sub_run:
                res_g = default_dsbot_runner(
                    {"task": "@Coder deploy", "group": "Ops", "timeout_sec": 30},
                    "/nonexistent/dsh",
                    "/nonexistent/patch.yml",
                    mcp_url=mcp_url,
                    mcp_token="test-mcp-tok",
                )
                sub_run.assert_not_called()
            self.assertEqual(res_g["status"], "succeeded")
            self.assertIn("[LOCAL_DSBOT_WAITING]", res_g["result_summary"])
            self.assertIn("run deploy", res_g["result_summary"])
            self.assertEqual(calls[0], ("send_to_group", {"group": "Ops", "text": "@Coder deploy"}))
        finally:
            srv.shutdown()
            srv.server_close()

    def test_dsbot_runner_fallback_only_before_send(self) -> None:
        # Unreachable MCP fails before send -> safe fallback to headless CLI
        headless_ok = subprocess.CompletedProcess(
            args=["dsh"], returncode=0, stdout="headless reply", stderr=""
        )
        with patch("worker.subprocess.run", return_value=headless_ok) as sub_run:
            res = default_dsbot_runner(
                {"task": "fallback task", "bot": "Chief", "timeout_sec": 10},
                "/usr/local/bin/dsh",
                "/tmp/patch.yml",
                mcp_url="http://127.0.0.1:1/mcp",
                mcp_token="test-mcp-tok",
            )
            sub_run.assert_called_once()
        self.assertEqual(res["status"], "succeeded")
        self.assertEqual(res["result_summary"], "headless reply")

        # Post-send wait error must NOT fall back to headless CLI (prevents duplicate execution)
        class FailWaitHandler(BaseHTTPRequestHandler):
            def log_message(self, fmt: str, *args) -> None:
                return

            def do_POST(self) -> None:
                length = int(self.headers.get("Content-Length") or 0)
                req = json.loads(self.rfile.read(length).decode("utf-8"))
                tool_name = (req.get("params") or {}).get("name")
                if tool_name == "send_to_bot":
                    result = {"sent": True, "after": 1000}
                    body = json.dumps(
                        {
                            "jsonrpc": "2.0",
                            "id": req.get("id"),
                            "result": {
                                "content": [{"type": "text", "text": json.dumps(result)}],
                                "structuredContent": result,
                            },
                        }
                    ).encode("utf-8")
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                else:
                    self.send_response(500)
                    self.end_headers()
                    self.wfile.write(b"wait failed")

        srv = ThreadingHTTPServer(("127.0.0.1", 0), FailWaitHandler)
        t = threading.Thread(target=srv.serve_forever, daemon=True)
        t.start()
        try:
            with patch("worker.subprocess.run") as sub_run:
                res_err = default_dsbot_runner(
                    {"task": "do once", "bot": "Chief", "timeout_sec": 10},
                    "/usr/local/bin/dsh",
                    "/tmp/patch.yml",
                    mcp_url=f"http://127.0.0.1:{srv.server_address[1]}/mcp",
                    mcp_token="test-mcp-tok",
                )
                sub_run.assert_not_called()
            self.assertEqual(res_err["status"], "failed")
            self.assertIn("MCP HTTP 500", res_err["error"])
        finally:
            srv.shutdown()
            srv.server_close()

    def test_dsbot_runner_retries_empty_done_during_cold_rollover(self) -> None:
        wait_calls = 0

        class RolloverHandler(BaseHTTPRequestHandler):
            def log_message(self, fmt: str, *args) -> None:
                return

            def do_POST(self) -> None:
                nonlocal wait_calls
                length = int(self.headers.get("Content-Length") or 0)
                req = json.loads(self.rfile.read(length).decode("utf-8"))
                tool_name = (req.get("params") or {}).get("name")
                if tool_name == "send_to_bot":
                    result = {"sent": True, "after": 1000}
                elif tool_name == "wait_for_reply":
                    wait_calls += 1
                    if wait_calls == 1:
                        result = {"done": True, "working": False, "after": 1000, "messages": []}
                    else:
                        result = {
                            "done": True,
                            "working": False,
                            "after": 1600,
                            "messages": [
                                {"kind": "bot", "from": "Chief", "text": "COLD_ROLLOVER_OK", "time": 1600}
                            ],
                        }
                elif tool_name == "read_chat":
                    result = {"working": False, "messages": []}
                elif tool_name == "list_waiting":
                    result = {"waiting": [], "answerIn": "DS Bot on this computer"}
                else:
                    result = {}

                body = json.dumps(
                    {
                        "jsonrpc": "2.0",
                        "id": req.get("id"),
                        "result": {
                            "content": [{"type": "text", "text": json.dumps(result)}],
                            "structuredContent": result,
                        },
                    }
                ).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        srv = ThreadingHTTPServer(("127.0.0.1", 0), RolloverHandler)
        t = threading.Thread(target=srv.serve_forever, daemon=True)
        t.start()
        try:
            res = run_dsbot_via_local_mcp(
                {"task": "hi", "bot": "Chief", "timeout_sec": 10},
                f"http://127.0.0.1:{srv.server_address[1]}/mcp",
                "test-mcp-tok",
                empty_done_grace_sec=5.0,
                poll_sleep_sec=0.05,
            )
            self.assertEqual(res["status"], "succeeded")
            self.assertIn("COLD_ROLLOVER_OK", res["result_summary"])
            self.assertGreaterEqual(wait_calls, 2)
        finally:
            srv.shutdown()
            srv.server_close()


if __name__ == "__main__":
    unittest.main()
