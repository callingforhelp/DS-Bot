#!/usr/bin/env python3
"""Outbound Mac mini job worker polling AWS mac-job-broker over SSM."""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import http.client
import json
import os
import re
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from typing import Any, Callable, Optional

SECRET_PATTERNS = [
    re.compile(r"\bsk-[A-Za-z0-9_-]{16,}\b"),
    re.compile(r"\bgh[pousr]_[A-Za-z0-9_]{20,}\b"),
    re.compile(r"\bAIza[0-9A-Za-z_-]{20,}\b"),
    re.compile(r"\bx(?:app|oxb|oxp|oxa)-[A-Za-z0-9-]{16,}\b"),
    re.compile(r"(?i)\b(bearer\s+)[A-Za-z0-9._~+/-]{16,}=*"),
    re.compile(r"(?i)\b(AKIA[0-9A-Z]{16})\b"),
]
PR_URL_RE = re.compile(r"https://github\.com/[^\s)\"'<>]+/pull/\d+")
_FLUSH_THREAD_LOCK = threading.Lock()

DEFAULT_ALLOWED_ROOTS = (
    "/Users/chief/flinter-cnc-tabletop",
    "/Users/chief/devin-agent-work",
    "/Users/chief/ds-bot-dev",
    "/Users/chief/.gemini/antigravity/scratch",
)
FORBIDDEN_HOME_SUBDIRS = {
    ".ssh",
    ".aws",
    ".gnupg",
    ".mac-job-worker",
    "Library",
    ".Trash",
}


def redact_secrets(text: str) -> str:
    if not text:
        return text
    out = text
    for pat in SECRET_PATTERNS:
        if pat.groups >= 1:
            out = pat.sub(r"\1[REDACTED]", out)
        else:
            out = pat.sub("[REDACTED]", out)
    return out


def extract_pr_url(text: str) -> Optional[str]:
    if not text:
        return None
    m = PR_URL_RE.search(text)
    return m.group(0) if m else None


def load_env_file(path: str) -> dict[str, str]:
    loaded: dict[str, str] = {}
    if not path or not os.path.exists(path):
        return loaded
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            k = k.strip()
            v = v.strip()
            if k and k not in os.environ:
                os.environ[k] = v
            if k:
                loaded[k] = os.environ[k]
    return loaded


class BrokerClient:
    def __init__(self, base_url: str, worker_token: str) -> None:
        self.base_url = base_url.rstrip("/")
        self.worker_token = worker_token

    def healthz(self, timeout: float = 4.0) -> Optional[dict[str, Any]]:
        req = urllib.request.Request(f"{self.base_url}/healthz", method="GET")
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except Exception:
            return None

    def post(
        self, path: str, payload: dict[str, Any], timeout: float = 15.0
    ) -> tuple[int, dict[str, Any]]:
        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            f"{self.base_url}{path}",
            data=data,
            method="POST",
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self.worker_token}",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.status, json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            raw = exc.read().decode("utf-8", errors="replace")
            try:
                return exc.code, json.loads(raw)
            except Exception:
                return exc.code, {"ok": False, "error": raw}

    def get(self, path: str, timeout: float = 15.0) -> tuple[int, dict[str, Any]]:
        req = urllib.request.Request(
            f"{self.base_url}{path}",
            method="GET",
            headers={"Authorization": f"Bearer {self.worker_token}"},
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.status, json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            raw = exc.read().decode("utf-8", errors="replace")
            try:
                return exc.code, json.loads(raw)
            except Exception:
                return exc.code, {"ok": False, "error": raw}


class HttpHealthProbe:
    """HTTP GET readiness probe returning True iff status is 2xx."""

    def __init__(self, url: str, timeout: float = 3.0) -> None:
        self.url = url
        self.timeout = timeout

    def __call__(self) -> bool:
        try:
            req = urllib.request.Request(self.url, method="GET")
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                return 200 <= int(getattr(resp, "status", 0)) < 300
        except urllib.error.HTTPError as exc:
            try:
                exc.close()
            except Exception:
                pass
            return False
        except Exception:
            return False


class SsmTunnelManager:
    def __init__(
        self,
        broker: Optional[BrokerClient],
        profile: str,
        region: str,
        instance_id: str,
        remote_port: int = 13090,
        local_port: int = 13090,
        health_check: Optional[Callable[[], bool]] = None,
        label: str = "broker",
    ) -> None:
        self.broker = broker
        self.profile = profile
        self.region = region
        self.instance_id = instance_id
        self.remote_port = remote_port
        self.local_port = local_port
        self.health_check = health_check
        self.label = label
        self.proc: Optional[subprocess.Popen[str]] = None
        self._backoff_idx = 0
        self._backoffs = [2, 5, 10, 30]

    def _log_prefix(self) -> str:
        return "[worker]" if self.label == "broker" else f"[worker:{self.label}]"

    def is_healthy(self) -> bool:
        if self.health_check is not None:
            return bool(self.health_check())
        return self.broker is not None and self.broker.healthz(timeout=3.0) is not None

    def stop(self) -> None:
        if self.proc is not None and self.proc.poll() is None:
            try:
                os.killpg(os.getpgid(self.proc.pid), signal.SIGTERM)
                self.proc.wait(timeout=5)
            except Exception:
                try:
                    os.killpg(os.getpgid(self.proc.pid), signal.SIGKILL)
                except Exception:
                    pass
        self.proc = None

    def ensure_connected(self, stop_event: threading.Event) -> bool:
        """Return True if a new tunnel connection had to be established, False if already healthy."""
        if self.is_healthy():
            self._backoff_idx = 0
            return False

        self.stop()
        prefix = self._log_prefix()
        while not stop_event.is_set():
            params = json.dumps(
                {
                    "portNumber": [str(self.remote_port)],
                    "localPortNumber": [str(self.local_port)],
                }
            )
            cmd = [
                "aws",
                "ssm",
                "start-session",
                "--profile",
                self.profile,
                "--region",
                self.region,
                "--target",
                self.instance_id,
                "--document-name",
                "AWS-StartPortForwardingSession",
                "--parameters",
                params,
            ]
            sys.stderr.write(
                f"{prefix} starting SSM tunnel {self.local_port}->{self.remote_port}\n"
            )
            self.proc = subprocess.Popen(
                cmd,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                start_new_session=True,
            )
            deadline = time.time() + 25.0
            while time.time() < deadline and not stop_event.is_set():
                if self.proc.poll() is not None:
                    out = ""
                    if self.proc.stdout:
                        out = self.proc.stdout.read()[:500]
                    sys.stderr.write(
                        f"{prefix} SSM process exited early ({self.proc.returncode}): {out}\n"
                    )
                    break
                if self.is_healthy():
                    self._backoff_idx = 0
                    sys.stderr.write(f"{prefix} SSM tunnel healthy\n")
                    return True
                time.sleep(0.5)

            self.stop()
            wait_s = self._backoffs[min(self._backoff_idx, len(self._backoffs) - 1)]
            self._backoff_idx += 1
            sys.stderr.write(f"{prefix} retrying SSM tunnel in {wait_s}s\n")
            stop_event.wait(wait_s)
        return False


def start_tunnel_watchdog(
    tunnel: SsmTunnelManager,
    stop_event: threading.Event,
    interval_sec: float = 20.0,
) -> threading.Thread:
    """Keep a secondary SSM tunnel alive in a daemon thread."""

    def _loop() -> None:
        while not stop_event.is_set():
            try:
                tunnel.ensure_connected(stop_event)
            except Exception as exc:
                sys.stderr.write(f"{tunnel._log_prefix()} watchdog error: {exc}\n")
            stop_event.wait(interval_sec)

    t = threading.Thread(target=_loop, daemon=True)
    t.start()
    return t


def is_authorized_local_path(
    path: str, parent_dir: str = "/Users/chief"
) -> bool:
    real = os.path.realpath(os.path.expanduser(path))
    real_parent = os.path.realpath(os.path.expanduser(parent_dir))
    real_lower = real.lower()
    parent_prefix = (real_parent + os.sep).lower()
    forbidden_lower = {s.lower() for s in FORBIDDEN_HOME_SUBDIRS}
    if real_lower.startswith(parent_prefix):
        top = real[len(real_parent) + 1 :].split(os.sep, 1)[0]
        if top and top.lower() in forbidden_lower:
            return False

    env_set = "MAC_WORKER_ALLOWED_ROOTS" in os.environ
    env_roots = os.environ.get("MAC_WORKER_ALLOWED_ROOTS") or ""
    if env_set:
        roots = [r.strip() for r in env_roots.split(":") if r.strip()]
    else:
        roots = list(DEFAULT_ALLOWED_ROOTS)
    for root in roots:
        root_lower = os.path.realpath(os.path.expanduser(root)).lower()
        if real_lower == root_lower or real_lower.startswith(root_lower + os.sep):
            return True

    if env_set:
        return False

    if real_lower.startswith(parent_prefix):
        top = real[len(real_parent) + 1 :].split(os.sep, 1)[0]
        if (
            top
            and top.lower() not in forbidden_lower
            and not top.startswith(".")
        ):
            return True
    return False


def _ensure_local_git_repo(dir_path: str, short_name: str) -> None:
    os.makedirs(dir_path, exist_ok=True)
    if os.path.exists(os.path.join(dir_path, ".git")):
        return
    init_res = _run_git(["init", "-b", "main"], cwd=dir_path)
    if init_res.returncode != 0:
        _run_git(["init"], cwd=dir_path)
        _run_git(["checkout", "-B", "main"], cwd=dir_path)
    if not any(name != ".git" for name in os.listdir(dir_path)):
        with open(os.path.join(dir_path, "README.md"), "w", encoding="utf-8") as f:
            f.write(f"# {short_name}\n")
    _run_git(["add", "-A"], cwd=dir_path)
    _run_git(
        [
            "-c",
            "user.name=MacWorker",
            "-c",
            "user.email=worker@local",
            "commit",
            "-m",
            "chore: bootstrap local repository",
        ],
        cwd=dir_path,
    )


def _run_git(
    args: list[str], cwd: Optional[str] = None, timeout: int = 60
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", *args],
        cwd=cwd,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )


def _current_git_branch(repo_path: str) -> str:
    head = _run_git(["symbolic-ref", "--quiet", "HEAD"], cwd=repo_path)
    return head.stdout.strip().removeprefix("refs/heads/") if head.returncode == 0 else ""


def _resolve_mac_repo_path(
    repo_hint: str, parent_dir: str = "/Users/chief"
) -> tuple[str, str]:
    raw = os.path.expanduser((repo_hint or "").strip())
    short_name = raw.rstrip("/").removesuffix(".git").split("/")[-1]
    if raw and os.path.isdir(raw):
        return raw, short_name or os.path.basename(os.path.abspath(raw))

    candidates = [
        os.path.join(parent_dir, short_name),
        os.path.join(parent_dir, "ds-bot-dev", short_name),
    ]
    for cand in candidates:
        if os.path.exists(os.path.join(cand, ".git")):
            return cand, short_name
    for cand in candidates:
        if os.path.isdir(cand):
            return cand, short_name

    return os.path.join(parent_dir, short_name), short_name


def default_git_sync_runner(
    job: dict[str, Any],
    parent_dir: str = "/Users/chief",
    gh_bin: str = "gh",
) -> dict[str, Optional[str]]:
    raw_task = str(job.get("task") or "").strip()
    meta: dict[str, Any] = {}
    if raw_task.startswith("{"):
        try:
            parsed = json.loads(raw_task)
            if isinstance(parsed, dict):
                meta = parsed
        except Exception:
            meta = {}

    action = str(meta.get("action") or ("pull" if "pull" in raw_task.lower() else "push")).strip().lower()
    if action not in ("push", "pull"):
        action = "push"
    repo_hint = str(meta.get("repo") or job.get("repo") or "").strip()
    req_branch = str(meta.get("branch") or job.get("branch") or "").strip()
    remote_hint = str(meta.get("remote_url") or "").strip()
    create_if_missing = bool(meta.get("create_if_missing"))

    if not repo_hint:
        return {
            "status": "failed",
            "result_summary": "",
            "pr_url": None,
            "error": "repo is required for git_sync",
        }

    repo_path, short_name = _resolve_mac_repo_path(repo_hint, parent_dir=parent_dir)

    if not is_authorized_local_path(repo_path, parent_dir=parent_dir):
        return {
            "status": "failed",
            "result_summary": "",
            "pr_url": None,
            "error": f"Unauthorized local path: {repo_path}",
        }

    req_ref = f"refs/heads/{req_branch}" if req_branch else ""
    if req_branch and (
        req_branch.startswith("-") or _run_git(["check-ref-format", req_ref]).returncode != 0
    ):
        return {
            "status": "failed",
            "result_summary": "",
            "pr_url": None,
            "error": f"Invalid Git branch name: {req_branch}",
        }

    def _has_requested_branch() -> bool:
        return (
            _run_git(["show-ref", "--verify", "--quiet", req_ref], cwd=repo_path).returncode
            == 0
        )

    if action == "pull":
        if not os.path.exists(os.path.join(repo_path, ".git")):
            clone_src = remote_hint
            if not os.path.exists(os.path.join(repo_path, ".git")):
                if not clone_src:
                    return {
                        "status": "failed",
                        "result_summary": "",
                        "pr_url": None,
                        "error": f"Local repository not found at {repo_path} and no remote_url provided for pull",
                    }
                os.makedirs(os.path.dirname(os.path.abspath(repo_path)), exist_ok=True)
                cl = _run_git(["clone", clone_src, repo_path], timeout=120)
                if cl.returncode != 0:
                    return {
                        "status": "failed",
                        "result_summary": "",
                        "pr_url": None,
                        "error": redact_secrets(cl.stderr or cl.stdout or "git clone failed"),
                    }

        _run_git(["fetch", "origin", "--prune"], cwd=repo_path, timeout=90)

        st = _run_git(["status", "--porcelain"], cwd=repo_path)
        dirty = bool(st.stdout.strip())
        pulled = False
        dirty_skipped = False
        if req_branch:
            if dirty:
                dirty_skipped = True
            else:
                if _has_requested_branch():
                    co = _run_git(["switch", "--no-guess", "--", req_branch], cwd=repo_path)
                else:
                    co = _run_git(["fetch", "origin", req_ref], cwd=repo_path, timeout=90)
                    if co.returncode == 0:
                        co = _run_git(
                            [
                                "switch",
                                "--track",
                                "-c",
                                req_branch,
                                f"refs/remotes/origin/{req_branch}",
                            ],
                            cwd=repo_path,
                        )
                if co.returncode != 0:
                    return {
                        "status": "failed",
                        "result_summary": "",
                        "pr_url": None,
                        "error": redact_secrets(co.stderr or co.stdout or f"git checkout {req_branch} failed"),
                    }
                ff = _run_git(["pull", "--ff-only", "origin", req_ref], cwd=repo_path, timeout=90)
                if ff.returncode != 0:
                    return {
                        "status": "failed",
                        "result_summary": "",
                        "pr_url": None,
                        "error": redact_secrets(ff.stderr or ff.stdout or "git pull --ff-only failed"),
                    }
                pulled = True
        else:
            if dirty:
                dirty_skipped = True
            else:
                ff = _run_git(["pull", "--ff-only"], cwd=repo_path, timeout=90)
                if ff.returncode != 0:
                    return {
                        "status": "failed",
                        "result_summary": "",
                        "pr_url": None,
                        "error": redact_secrets(ff.stderr or ff.stdout or "git pull --ff-only failed"),
                    }
                pulled = True

        sha_res = _run_git(["rev-parse", "--short", "HEAD"], cwd=repo_path)
        rem_res = _run_git(["remote", "get-url", "origin"], cwd=repo_path)
        summary = {
            "action": "pull",
            "repo": short_name,
            "path": repo_path,
            "remote_url": rem_res.stdout.strip() if rem_res.returncode == 0 else (remote_hint or None),
            "branch": _current_git_branch(repo_path) or None,
            "commit": sha_res.stdout.strip() if sha_res.returncode == 0 else None,
            "pulled": pulled,
            "dirty_skipped": dirty_skipped,
        }
        return {"status": "succeeded", "result_summary": json.dumps(summary), "pr_url": None, "error": None}

    # action == "push"
    if not os.path.exists(os.path.join(repo_path, ".git")):
        if not create_if_missing:
            return {
                "status": "failed",
                "result_summary": "",
                "pr_url": None,
                "error": f"Local repository not found at {repo_path}",
            }
        os.makedirs(repo_path, exist_ok=True)
        init_res = _run_git(["init", "-b", req_branch or "main"], cwd=repo_path)
        if init_res.returncode != 0:
            _run_git(["init"], cwd=repo_path)
            _run_git(["checkout", "-B", req_branch or "main"], cwd=repo_path)

    if not any(name != ".git" for name in os.listdir(repo_path)):
        readme_path = os.path.join(repo_path, "README.md")
        with open(readme_path, "w", encoding="utf-8") as f:
            f.write(f"# {short_name}\n")

    head_chk = _run_git(["rev-parse", "--verify", "HEAD"], cwd=repo_path)
    if head_chk.returncode != 0:
        _run_git(["add", "-A"], cwd=repo_path)
        cm = _run_git(["commit", "-m", "chore: initial commit"], cwd=repo_path)
        if cm.returncode != 0:
            return {
                "status": "failed",
                "result_summary": "",
                "pr_url": None,
                "error": redact_secrets(cm.stderr or cm.stdout or "initial commit failed"),
            }

    cur_branch = _current_git_branch(repo_path)
    st = _run_git(["status", "--porcelain"], cwd=repo_path)
    dirty_committed = False
    active_branch = cur_branch
    if st.stdout.strip():
        target_branch = req_branch or f"wip/handoff-{int(time.time())}"
        if target_branch != cur_branch:
            co = _run_git(["checkout", "-B", target_branch], cwd=repo_path)
            if co.returncode != 0:
                return {
                    "status": "failed",
                    "result_summary": "",
                    "pr_url": None,
                    "error": redact_secrets(co.stderr or co.stdout or "git checkout failed"),
                }
        _run_git(["add", "-A"], cwd=repo_path)
        cm = _run_git(["commit", "-m", "wip: auto-push from Mac Mini for cloud handoff"], cwd=repo_path)
        if cm.returncode != 0:
            return {
                "status": "failed",
                "result_summary": "",
                "pr_url": None,
                "error": redact_secrets(cm.stderr or cm.stdout or "git commit failed"),
            }
        dirty_committed = True
        active_branch = target_branch
    elif req_branch and req_branch != cur_branch:
        if _has_requested_branch():
            co = _run_git(["switch", "--no-guess", "--", req_branch], cwd=repo_path)
        else:
            co = _run_git(["switch", "-c", req_branch], cwd=repo_path)
        if co.returncode != 0:
            return {
                "status": "failed",
                "result_summary": "",
                "pr_url": None,
                "error": redact_secrets(
                    co.stderr or co.stdout or f"git checkout {req_branch} failed"
                ),
            }
        active_branch = req_branch

    if not active_branch:
        return {
            "status": "failed",
            "result_summary": "",
            "pr_url": None,
            "error": "A branch is required to push from a detached HEAD",
        }

    rem_res = _run_git(["remote", "get-url", "origin"], cwd=repo_path)
    remote_created = False
    if rem_res.returncode != 0:
        if not create_if_missing:
            return {
                "status": "failed",
                "result_summary": "",
                "pr_url": None,
                "error": "No origin remote configured and create_if_missing is false",
            }
        gh_res = subprocess.run(
            [gh_bin, "repo", "create", short_name, "--private", "--source=.", "--remote=origin"],
            cwd=repo_path,
            capture_output=True,
            text=True,
            timeout=90,
            check=False,
        )
        if gh_res.returncode != 0:
            return {
                "status": "failed",
                "result_summary": "",
                "pr_url": None,
                "error": redact_secrets(gh_res.stderr or gh_res.stdout or "gh repo create failed"),
            }
        remote_created = True
        rem_res = _run_git(["remote", "get-url", "origin"], cwd=repo_path)

    remote_url = rem_res.stdout.strip() if rem_res.returncode == 0 else None
    active_ref = f"refs/heads/{active_branch}"
    push_res = _run_git(
        ["push", "-u", "origin", f"{active_ref}:{active_ref}"],
        cwd=repo_path,
        timeout=120,
    )
    if push_res.returncode != 0:
        return {
            "status": "failed",
            "result_summary": "",
            "pr_url": None,
            "error": redact_secrets(push_res.stderr or push_res.stdout or "git push failed"),
        }

    sha_res = _run_git(["rev-parse", "--short", "HEAD"], cwd=repo_path)
    summary = {
        "action": "push",
        "repo": short_name,
        "path": repo_path,
        "remote_url": remote_url,
        "branch": active_branch,
        "commit": sha_res.stdout.strip() if sha_res.returncode == 0 else None,
        "dirty_committed": dirty_committed,
        "remote_created": remote_created,
    }
    return {
        "status": "succeeded",
        "result_summary": json.dumps(summary),
        "pr_url": None,
        "error": None,
    }


class _McpBeforeSendError(RuntimeError):
    """Raised when local DS Bot MCP fails before send_to_bot/send_to_group delivers."""


def _read_mcp_token(
    mcp_token: Optional[str] = None, token_file: Optional[str] = None
) -> str:
    if mcp_token is not None and str(mcp_token).strip():
        return str(mcp_token).strip()
    env_tok = os.environ.get("LOCAL_DSBOT_MCP_TOKEN", "").strip()
    if env_tok:
        return env_tok
    path = (
        token_file
        or os.environ.get(
            "LOCAL_DSBOT_MCP_TOKEN_FILE",
            "/Users/chief/.mac-job-worker/dsbot-mcp-token",
        )
    ).strip()
    if path and os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                return f.read().strip()
        except OSError:
            return ""
    return ""


def _mcp_rpc(
    url: str,
    token: str,
    method: str,
    params: Optional[dict[str, Any]] = None,
    timeout: float = 60.0,
) -> dict[str, Any]:
    payload: dict[str, Any] = {"jsonrpc": "2.0", "id": 1, "method": method}
    if params is not None:
        payload["params"] = params
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8")
            if resp.status != 200:
                raise RuntimeError(f"MCP HTTP {resp.status} for {method}: {raw}")
    except urllib.error.HTTPError as exc:
        try:
            err_body = exc.read().decode("utf-8", errors="replace")
        finally:
            exc.close()
        raise RuntimeError(f"MCP HTTP {exc.code} for {method}: {err_body}") from exc
    data = json.loads(raw)
    if "error" in data:
        raise RuntimeError(f"MCP JSON-RPC error for {method}: {data['error']}")
    result = data.get("result")
    if not isinstance(result, dict):
        raise RuntimeError(f"Unexpected MCP result for {method}: {data!r}")
    return result


def _mcp_call_tool(
    url: str,
    token: str,
    name: str,
    arguments: Optional[dict[str, Any]] = None,
    timeout: float = 60.0,
) -> dict[str, Any]:
    res = _mcp_rpc(
        url,
        token,
        "tools/call",
        {"name": name, "arguments": arguments or {}},
        timeout=timeout,
    )
    if res.get("isError"):
        text = (res.get("content") or [{}])[0].get("text", "")
        raise RuntimeError(f"MCP tool {name} returned isError=true: {text}")
    structured = res.get("structuredContent")
    if isinstance(structured, dict):
        return structured
    text = (res.get("content") or [{}])[0].get("text", "{}")
    parsed = json.loads(text)
    return parsed if isinstance(parsed, dict) else {"value": parsed}


_INDEX_HEADING_RE = re.compile(r"^##\s+Index\s*$")
_ANY_HEADING_RE = re.compile(r"^#{1,6}\s+")


def _atomic_write_text_file(path: str, content: str) -> None:
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    tmp = f"{path}.{os.getpid()}.{threading.get_ident()}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(content)
    os.chmod(tmp, 0o644)
    os.replace(tmp, path)


def ensure_team_memory_link(memory_md_path: str, topic: str) -> None:
    link = f"- [[{topic}]]"
    existing = ""
    if os.path.exists(memory_md_path):
        with open(memory_md_path, "r", encoding="utf-8", errors="replace") as f:
            existing = f.read()
    if not existing.strip():
        _atomic_write_text_file(memory_md_path, f"# Memory\n\n## Index\n{link}\n")
        return
    lines = existing.splitlines()
    if any(ln.strip() == link or f"[[{topic}]]" in ln for ln in lines):
        return
    idx = next(
        (i for i, ln in enumerate(lines) if _INDEX_HEADING_RE.match(ln.strip())),
        -1,
    )
    if idx == -1:
        if lines and lines[-1].strip():
            lines.append("")
        lines.extend(["## Index", link])
    else:
        end = next(
            (i for i in range(idx + 1, len(lines)) if _ANY_HEADING_RE.match(lines[i])),
            len(lines),
        )
        at = end
        while at > idx + 1 and not lines[at - 1].strip():
            at -= 1
        lines.insert(at, link)
    _atomic_write_text_file(memory_md_path, "\n".join(lines) + "\n")


def write_local_cloud_mirror(dsbot_home: str, markdown: str, max_chars: int = 24000) -> str:
    team_dir = os.path.join(dsbot_home, "bot", "memory", "team")
    mirror_path = os.path.join(team_dir, "cloud-mirror.md")
    clean = redact_secrets(str(markdown or ""))[:max_chars]
    if clean and not clean.endswith("\n"):
        clean += "\n"
    _atomic_write_text_file(mirror_path, clean)
    ensure_team_memory_link(os.path.join(team_dir, "MEMORY.md"), "cloud-mirror")
    return mirror_path


def _read_safe_md(path: str, limit: int = 3500) -> str:
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            raw = f.read(limit + 200)
    except OSError:
        return ""
    text = redact_secrets(raw.strip())
    if len(text) > limit:
        text = text[:limit].rstrip() + "\n[truncated]"
    return text


def build_mac_context_markdown(
    dsbot_home: str,
    mcp_url: Optional[str] = None,
    mcp_token: Optional[str] = None,
    primary_bots: tuple[str, ...] = ("Devin Manager", "Chief"),
    max_turns: int = 10,
    max_chars: int = 20000,
) -> str:
    mem_root = os.path.join(dsbot_home, "bot", "memory")
    sections: list[str] = [
        "# Mac Context Mirror (Local DS Bot.app)",
        "Read-only snapshot of local Mac memory and recent primary bot turns.",
        "",
    ]

    team_dir = os.path.join(mem_root, "team")
    if os.path.isdir(team_dir):
        for fname in sorted(os.listdir(team_dir)):
            if not fname.endswith(".md") or fname in ("MEMORY.md", "cloud-mirror.md"):
                continue
            body = _read_safe_md(os.path.join(team_dir, fname), limit=4000)
            if body:
                sections.append(f"## Team Memory ({fname})")
                sections.append(body)
                sections.append("")

    bot_names: dict[str, str] = {}
    state_path = os.path.join(dsbot_home, "bot", "state.json")
    if os.path.isfile(state_path):
        try:
            with open(state_path, "r", encoding="utf-8") as f:
                st = json.load(f)
            for bid, bobj in (st.get("bots") or {}).items():
                if isinstance(bobj, dict) and bobj.get("name"):
                    bot_names[str(bid)] = str(bobj["name"])
        except Exception:
            pass

    bots_dir = os.path.join(mem_root, "bots")
    if os.path.isdir(bots_dir):
        for bid in sorted(os.listdir(bots_dir)):
            bpath = os.path.join(bots_dir, bid)
            if not os.path.isdir(bpath):
                continue
            label = bot_names.get(bid, bid)
            for fname in sorted(os.listdir(bpath)):
                if not fname.endswith(".md"):
                    continue
                body = _read_safe_md(os.path.join(bpath, fname), limit=1800)
                if fname == "MEMORY.md" and len(body.splitlines()) <= 4 and "## Index" in body:
                    continue
                if body:
                    sections.append(f"## Bot Memory ({label} / {fname})")
                    sections.append(body)
                    sections.append("")

    summaries_dir = os.path.join(mem_root, "summaries")
    if os.path.isdir(summaries_dir):
        md_files = [
            os.path.join(summaries_dir, fn)
            for fn in os.listdir(summaries_dir)
            if fn.endswith(".md")
        ]
        md_files.sort(key=lambda p: os.path.getmtime(p), reverse=True)
        for sp in md_files[:3]:
            body = _read_safe_md(sp, limit=1800)
            if body:
                sections.append(f"## Summary ({os.path.basename(sp)})")
                sections.append(body)
                sections.append("")

    tok = (mcp_token or "").strip()
    if mcp_url and tok and max_turns > 0:
        for bot_name in primary_bots:
            try:
                res = _mcp_call_tool(
                    mcp_url,
                    tok,
                    "read_chat",
                    {"bot": bot_name},
                    timeout=8.0,
                )
                msgs = [
                    m
                    for m in (res.get("messages") or [])
                    if isinstance(m, dict) and str(m.get("text") or "").strip()
                ]
                recent = msgs[-max_turns:]
                if recent:
                    sections.append(f"## Recent Live Turns ({bot_name})")
                    for m in recent:
                        kind = str(m.get("kind") or "msg")
                        frm = str(m.get("from") or ("User" if kind == "user" else bot_name))
                        txt = redact_secrets(str(m.get("text") or "")).replace("\n", " ").strip()[:400]
                        sections.append(f"- [{kind}] {frm}: {txt}")
                    sections.append("")
            except Exception:
                continue

    combined = redact_secrets("\n".join(sections)).strip() + "\n"
    if len(combined) > max_chars:
        combined = combined[: max_chars - 32].rstrip() + "\n\n[mac-mirror truncated]\n"
    return combined


class ContextSyncManager:
    """Keeps Mac <-> EC2 disjoint mirror files in sync over the broker HTTP tunnel."""

    def __init__(
        self,
        broker: BrokerClient,
        dsbot_home: str,
        state_dir: str,
        mcp_url: Optional[str] = None,
        mcp_token_file: Optional[str] = None,
        mcp_token: Optional[str] = None,
        primary_bots: tuple[str, ...] = ("Devin Manager", "Chief"),
    ) -> None:
        self.broker = broker
        self.dsbot_home = dsbot_home
        self.state_dir = state_dir
        self.mcp_url = mcp_url
        self.mcp_token_file = mcp_token_file
        self.mcp_token = mcp_token
        self.primary_bots = primary_bots
        self._lock = threading.Lock()
        self._last_uploaded_sha = ""
        self._cursor_path = os.path.join(self.state_dir, "cloud-notes-cursor.json")

    def _load_cursor(self) -> int:
        if not os.path.exists(self._cursor_path):
            return 0
        try:
            with open(self._cursor_path, "r", encoding="utf-8") as f:
                return int(json.load(f).get("last_note_id") or 0)
        except Exception:
            return 0

    def _save_cursor(self, last_note_id: int) -> None:
        os.makedirs(self.state_dir, exist_ok=True)
        tmp = f"{self._cursor_path}.tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"last_note_id": int(last_note_id)}, f)
        os.replace(tmp, self._cursor_path)

    def sync_to_ec2(self, force: bool = False) -> bool:
        tok = _read_mcp_token(self.mcp_token, self.mcp_token_file)
        markdown = build_mac_context_markdown(
            self.dsbot_home,
            mcp_url=self.mcp_url,
            mcp_token=tok,
            primary_bots=self.primary_bots,
        )
        digest = hashlib.sha256(markdown.encode("utf-8")).hexdigest()
        with self._lock:
            if not force and digest == self._last_uploaded_sha:
                return False
            code, data = self.broker.post(
                "/v1/worker/context-snapshot",
                {"markdown": markdown, "sha256": digest},
                timeout=15.0,
            )
            if code == 200 and data.get("ok"):
                self._last_uploaded_sha = digest
                return True
            return False

    def pull_cloud_notes(self) -> int:
        with self._lock:
            last_id = self._load_cursor()
            code, data = self.broker.get(
                f"/v1/worker/cloud-notes?since_id={last_id}&limit=50", timeout=15.0
            )
            if code != 200 or not data.get("ok"):
                return 0
            notes = data.get("notes") or []
            latest_id = int(data.get("latest_id") or 0)
            recent_md = str(data.get("recent_markdown") or "")
            if not notes and latest_id <= last_id:
                return 0
            if recent_md.strip():
                write_local_cloud_mirror(self.dsbot_home, recent_md)
            new_cursor = max(last_id, latest_id, max((int(n.get("note_id") or 0) for n in notes), default=0))
            if new_cursor > last_id:
                self._save_cursor(new_cursor)
                try:
                    self.broker.post(
                        "/v1/worker/cloud-notes/ack",
                        {"up_to_id": new_cursor},
                        timeout=10.0,
                    )
                except Exception:
                    pass
            return len(notes)


_DECISION_RESOLVED_HEADER_RE = re.compile(r"\[USER_DECISION_RESOLVED\b([^\]]*)\]")
_DECISION_CARD_ID_RE = re.compile(r"\bcard_id=([^\s\]]+)")
_DECISION_KIND_RE = re.compile(r"\bkind=([^\s\]]+)")


def _resolve_dsbot_home(dsbot_home: Optional[str] = None) -> str:
    raw = (
        os.environ.get("DSBOT_HOME", "/Users/chief/.ds-bot")
        if dsbot_home is None
        else str(dsbot_home)
    ).strip()
    return os.path.expanduser(raw) if raw else ""


def _read_dsbot_state_readonly(dsbot_home: str) -> dict[str, Any]:
    if not dsbot_home:
        return {}
    state_path = os.path.join(dsbot_home, "bot", "state.json")
    if not os.path.isfile(state_path):
        return {}
    try:
        with open(state_path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def _is_card_closed_in_state(
    state: dict[str, Any], card_id: str, kind: str = ""
) -> bool:
    if not card_id or not isinstance(state, dict):
        return False
    closed = state.get("closedCards")
    if isinstance(closed, dict):
        if card_id in closed and closed[card_id] is not False:
            return True
        for val in closed.values():
            if isinstance(val, dict) and card_id in val and val[card_id] is not False:
                return True
            if isinstance(val, list) and card_id in val:
                return True
    elif isinstance(closed, list):
        if card_id in closed:
            return True
    norm_kind = kind.strip().lower()
    if norm_kind == "question":
        questions = state.get("questions")
        if isinstance(questions, dict):
            return not any(
                isinstance(entry, dict)
                and str(entry.get("id") or "").strip() == card_id
                for entry in questions.values()
            )
    elif norm_kind == "view":
        views = state.get("views")
        if isinstance(views, dict):
            return not any(
                isinstance(entry, dict)
                and str(entry.get("id") or "").strip() == card_id
                for entry in views.values()
            )
    return False


def _extract_option_labels(raw_options: Any) -> list[str]:
    if not isinstance(raw_options, list):
        return []
    labels: list[str] = []
    seen: set[str] = set()
    for opt in raw_options:
        if isinstance(opt, str):
            label = opt.strip()
        elif isinstance(opt, dict):
            label = str(
                opt.get("label")
                or opt.get("title")
                or opt.get("text")
                or opt.get("value")
                or ""
            ).strip()
        else:
            label = ""
        if label and label not in seen:
            seen.add(label)
            labels.append(label)
    return labels


def _extract_view_options_and_detail(view_entry: dict[str, Any]) -> tuple[list[str], str]:
    options: list[str] = []
    seen_opts: set[str] = set()

    def _add_opt(label: str) -> None:
        clean = label.strip()
        if clean and clean not in seen_opts:
            seen_opts.add(clean)
            options.append(clean)

    for key in ("options", "actions", "buttons"):
        for lbl in _extract_option_labels(view_entry.get(key)):
            _add_opt(lbl)

    detail_parts: list[str] = []
    explicit_detail = str(view_entry.get("detail") or "").strip()
    if explicit_detail:
        detail_parts.append(explicit_detail)

    def _walk_node(node: Any) -> None:
        if isinstance(node, list):
            for child in node:
                _walk_node(child)
            return
        if not isinstance(node, dict):
            return
        ntype = str(node.get("type") or "").strip().lower()
        if ntype == "confirm":
            _add_opt(str(node.get("confirmLabel") or "Confirm"))
            _add_opt(str(node.get("cancelLabel") or "Cancel"))
        elif ntype == "options":
            for lbl in _extract_option_labels(node.get("options")):
                _add_opt(lbl)
        elif ntype == "submit":
            _add_opt(str(node.get("label") or "Submit"))
        elif ntype == "button":
            _add_opt(str(node.get("label") or node.get("title") or ""))
        elif ntype in ("text", "callout") and not explicit_detail:
            txt = node.get("text")
            if isinstance(txt, str) and txt.strip():
                detail_parts.append(txt.strip())
        elif ntype == "html" and not explicit_detail:
            summary = node.get("summary")
            if isinstance(summary, str) and summary.strip():
                detail_parts.append(summary.strip())

        for sub_key in ("actions", "buttons"):
            for lbl in _extract_option_labels(node.get(sub_key)):
                _add_opt(lbl)
        if "children" in node:
            _walk_node(node.get("children"))

    if "view" in view_entry:
        _walk_node(view_entry.get("view"))

    detail = "\n".join(detail_parts).strip()
    return options, detail


def _build_state_session_index(
    state: dict[str, Any],
) -> tuple[dict[str, dict[str, Any]], dict[str, list[str]], dict[str, str], dict[str, str]]:
    bot_by_id: dict[str, dict[str, Any]] = {}
    bot_name_to_ids: dict[str, list[str]] = {}
    session_to_bot_id: dict[str, str] = {}
    session_to_group: dict[str, str] = {}

    rooms = state.get("rooms")
    room_names: dict[str, str] = {}
    if isinstance(rooms, dict):
        for rkey, room in rooms.items():
            if not isinstance(room, dict):
                continue
            rid = str(room.get("id") or rkey).strip()
            rname = str(room.get("name") or "").strip()
            if rid and rname:
                room_names[rid] = rname

    bots = state.get("bots")
    if isinstance(bots, dict):
        for key, bot in bots.items():
            if not isinstance(bot, dict):
                continue
            bid = str(bot.get("id") or key).strip()
            if not bid:
                continue
            bot_by_id[bid] = bot
            key_s = str(key).strip()
            if key_s and key_s != bid:
                bot_by_id.setdefault(key_s, bot)
            bname = str(bot.get("name") or "").strip()
            if bname:
                bot_name_to_ids.setdefault(bname.lower(), []).append(bid)
            session_to_bot_id[bid] = bid
            if key_s:
                session_to_bot_id[key_s] = bid
            bsid = str(bot.get("sessionId") or "").strip()
            if bsid:
                session_to_bot_id[bsid] = bid
            for seg in bot.get("segments") or []:
                if isinstance(seg, dict) and seg.get("sessionId"):
                    session_to_bot_id[str(seg["sessionId"]).strip()] = bid
            for task in bot.get("tasks") or []:
                if not isinstance(task, dict):
                    continue
                trname = room_names.get(str(task.get("roomId") or "").strip(), "")
                tsid = str(task.get("sessionId") or "").strip()
                if tsid:
                    session_to_bot_id[tsid] = bid
                    if trname:
                        session_to_group[tsid] = trname
                for seg in task.get("segments") or []:
                    if isinstance(seg, dict) and seg.get("sessionId"):
                        segsid = str(seg["sessionId"]).strip()
                        session_to_bot_id[segsid] = bid
                        if trname:
                            session_to_group[segsid] = trname

    if isinstance(rooms, dict):
        for rkey, room in rooms.items():
            if not isinstance(room, dict):
                continue
            rname = str(room.get("name") or "").strip()
            rsessions = room.get("sessions")
            if isinstance(rsessions, dict):
                for bot_id, sid in rsessions.items():
                    sid_s = str(sid or "").strip()
                    if sid_s:
                        session_to_bot_id[sid_s] = str(bot_id).strip()
                        if rname:
                            session_to_group[sid_s] = rname
            rsegments = room.get("segments")
            if isinstance(rsegments, dict):
                for bot_id, seg_list in rsegments.items():
                    if not isinstance(seg_list, list):
                        continue
                    for seg in seg_list:
                        if isinstance(seg, dict) and seg.get("sessionId"):
                            sid_s = str(seg["sessionId"]).strip()
                            session_to_bot_id[sid_s] = str(bot_id).strip()
                            if rname:
                                session_to_group[sid_s] = rname

    sessions = state.get("sessions")
    if isinstance(sessions, dict):
        for sid, sref in sessions.items():
            sid_s = str(sid).strip()
            if not sid_s:
                continue
            if isinstance(sref, str):
                target = sref.strip()
                if target in bot_by_id:
                    session_to_bot_id.setdefault(sid_s, target)
                elif target.lower() in bot_name_to_ids:
                    session_to_bot_id.setdefault(sid_s, bot_name_to_ids[target.lower()][0])
            elif isinstance(sref, dict):
                bref = str(
                    sref.get("botId")
                    or sref.get("self")
                    or sref.get("selfId")
                    or sref.get("bot_id")
                    or sref.get("bot")
                    or ""
                ).strip()
                if bref in bot_by_id:
                    session_to_bot_id.setdefault(sid_s, bref)
                elif bref.lower() in bot_name_to_ids:
                    session_to_bot_id.setdefault(sid_s, bot_name_to_ids[bref.lower()][0])
                grp = str(
                    sref.get("group") or sref.get("room") or sref.get("roomName") or ""
                ).strip()
                if grp:
                    session_to_group.setdefault(sid_s, grp)

    return bot_by_id, bot_name_to_ids, session_to_bot_id, session_to_group


def _resolve_state_entry_owner(
    sid: str,
    entry: dict[str, Any],
    index: tuple[dict[str, dict[str, Any]], dict[str, list[str]], dict[str, str], dict[str, str]],
) -> tuple[str, str, bool, str]:
    bot_by_id, bot_name_to_ids, session_to_bot_id, session_to_group = index
    candidates = [
        str(sid).strip(),
        str(entry.get("callSessionId") or "").strip(),
        str(entry.get("sessionId") or "").strip(),
    ]
    bot_id = ""
    group_name = ""
    for cand in candidates:
        if not cand:
            continue
        if not bot_id and cand in session_to_bot_id:
            bot_id = session_to_bot_id[cand]
        if not group_name and cand in session_to_group:
            group_name = session_to_group[cand]
    if not bot_id:
        explicit_bid = str(entry.get("botId") or entry.get("self") or "").strip()
        if explicit_bid:
            bot_id = explicit_bid
    if not bot_id:
        explicit_bname = str(entry.get("bot") or "").strip().lower()
        if explicit_bname and explicit_bname in bot_name_to_ids:
            bot_id = bot_name_to_ids[explicit_bname][0]
    if not bot_id and sid.strip().lower() in bot_name_to_ids:
        bot_id = bot_name_to_ids[sid.strip().lower()][0]

    bot_obj = bot_by_id.get(bot_id)
    bot_name = (
        str(bot_obj.get("name") or "").strip()
        if bot_obj
        else str(entry.get("bot") or "").strip()
    )
    is_private = bool(bot_obj and bot_obj.get("private") is True)
    if not group_name:
        group_name = str(
            entry.get("group") or entry.get("roomName") or entry.get("room") or ""
        ).strip()
    return bot_id, bot_name, is_private, group_name


def _compute_waiting_idempotency_key(item: dict[str, Any]) -> str:
    kind = str(item.get("kind") or "").strip().lower()
    card_id = str(item.get("id") or "").strip()
    bot = str(item.get("bot") or "").strip()
    if kind == "question":
        if card_id:
            return f"dsbot_q:{card_id}"
        q_text = str(item.get("question") or "").strip()
        digest = hashlib.sha1(q_text.encode("utf-8")).hexdigest()[:12]
        return f"dsbot_q:{bot}:{digest}"
    if kind == "view":
        if card_id:
            return f"dsbot_v:{card_id}"
        title = str(item.get("title") or "").strip()
        digest = hashlib.sha1(title.encode("utf-8")).hexdigest()[:12]
        return f"dsbot_v:{bot}:{digest}"
    if kind == "approval":
        if card_id:
            return f"dsbot_a:{card_id}"
        group = str(item.get("group") or "").strip()
        tool = str(item.get("tool") or "").strip()
        reason = str(item.get("reason") or "").strip()
        digest = hashlib.sha1(reason.encode("utf-8")).hexdigest()[:12]
        return f"dsbot_a:{bot}:{group}:{tool}:{digest}"
    raw = json.dumps(item, sort_keys=True, ensure_ascii=False)
    digest = hashlib.sha1(raw.encode("utf-8")).hexdigest()[:12]
    return f"dsbot_w:{digest}"


def _match_state_entry(
    entries: Any,
    index: tuple[dict[str, dict[str, Any]], dict[str, list[str]], dict[str, str], dict[str, str]],
    *,
    card_id: str,
    bot_name: str,
    text_key: str,
    text_val: str,
    skip_issue_draft: bool = False,
    allowed_bot_ids: Optional[set[str]] = None,
) -> Optional[tuple[str, dict[str, Any], str]]:
    if not isinstance(entries, dict):
        return None
    if card_id:
        for sid, entry in entries.items():
            if not isinstance(entry, dict):
                continue
            if skip_issue_draft and entry.get("issueDraft") is not None:
                continue
            if str(entry.get("id") or "").strip() == card_id:
                resolved_bot_id, _, is_private, resolved_group = _resolve_state_entry_owner(
                    str(sid), entry, index
                )
                if is_private:
                    return None
                if allowed_bot_ids is not None and (
                    not resolved_bot_id or resolved_bot_id not in allowed_bot_ids
                ):
                    return None
                return str(sid), entry, resolved_group
        return None

    wanted_bot = bot_name.strip().lower()
    if not wanted_bot:
        return None
    wanted_text = text_val.strip()
    fallback: Optional[tuple[str, dict[str, Any], str]] = None
    for sid, entry in entries.items():
        if not isinstance(entry, dict):
            continue
        if skip_issue_draft and entry.get("issueDraft") is not None:
            continue
        resolved_bot_id, resolved_bot, is_private, resolved_group = _resolve_state_entry_owner(
            str(sid), entry, index
        )
        if is_private or resolved_bot.strip().lower() != wanted_bot:
            continue
        if allowed_bot_ids is not None and (
            not resolved_bot_id or resolved_bot_id not in allowed_bot_ids
        ):
            continue
        candidate_text = str(entry.get(text_key) or "").strip()
        if wanted_text and candidate_text == wanted_text:
            return str(sid), entry, resolved_group
        if fallback is None:
            fallback = (str(sid), entry, resolved_group)
    return fallback


def collect_local_waiting_items(
    mcp_url: str,
    mcp_token: str,
    dsbot_home: Optional[str] = None,
) -> list[dict[str, Any]]:
    """Collect normalized waiting items from local DS Bot MCP, enriched read-only from state.json."""
    waiting_res = _mcp_call_tool(mcp_url, mcp_token, "list_waiting", {}, timeout=15.0)
    raw_waiting = waiting_res.get("waiting") or []
    if not isinstance(raw_waiting, list):
        raw_waiting = []

    resolved_home = _resolve_dsbot_home(dsbot_home)
    state = _read_dsbot_state_readonly(resolved_home)
    index = _build_state_session_index(state) if state else ({}, {}, {}, {})
    state_questions = state.get("questions") if isinstance(state.get("questions"), dict) else {}
    state_views = state.get("views") if isinstance(state.get("views"), dict) else {}

    allowed_bot_ids: set[str] = set()
    allowed_bot_names: set[str] = set()
    allowed_checked = False
    if state_questions or state_views:
        try:
            bots_res = _mcp_call_tool(mcp_url, mcp_token, "list_bots", {}, timeout=15.0)
            bots_list = bots_res.get("bots")
            if isinstance(bots_list, list):
                allowed_checked = True
                for b in bots_list:
                    if not isinstance(b, dict) or b.get("private") is True:
                        continue
                    bid = str(b.get("id") or "").strip()
                    bname = str(b.get("name") or "").strip().lower()
                    if bid:
                        allowed_bot_ids.add(bid)
                    if bname:
                        allowed_bot_names.add(bname)
        except Exception:
            allowed_checked = False

    scoped_allowed_ids = allowed_bot_ids if (allowed_checked and allowed_bot_ids) else None

    normalized: list[dict[str, Any]] = []
    seen_keys: set[str] = set()
    seen_view_sids: set[str] = set()
    seen_view_ids: set[str] = set()

    for raw in raw_waiting:
        if not isinstance(raw, dict):
            continue
        kind = str(raw.get("kind") or "").strip().lower()
        if not kind:
            continue
        bot = str(raw.get("bot") or "").strip()
        group = str(raw.get("group") or "").strip()
        card_id = str(raw.get("id") or "").strip()

        if kind == "question":
            q_text = str(raw.get("question") or "").strip()
            matched = _match_state_entry(
                state_questions,
                index,
                card_id=card_id,
                bot_name=bot,
                text_key="question",
                text_val=q_text,
                allowed_bot_ids=scoped_allowed_ids,
            )
            state_q = matched[1] if matched else {}
            if not card_id and state_q.get("id"):
                card_id = str(state_q["id"]).strip()
            if not q_text and state_q.get("question"):
                q_text = str(state_q["question"]).strip()
            if not group and matched and matched[2]:
                group = matched[2]
            detail = str(raw.get("detail") or state_q.get("detail") or "").strip()
            options = _extract_option_labels(raw.get("options"))
            if not options:
                options = _extract_option_labels(state_q.get("options"))
            multi_select = (
                bool(raw["multiSelect"])
                if "multiSelect" in raw
                else bool(state_q.get("multiSelect") is True)
            )
            allow_custom = (
                bool(raw["allowCustom"])
                if "allowCustom" in raw
                else bool(state_q.get("allowCustom") is not False)
            )
            item: dict[str, Any] = {
                "kind": "question",
                "bot": bot,
                "question": q_text,
                "options": options,
                "multiSelect": multi_select,
                "allowCustom": allow_custom,
            }
            if card_id:
                item["id"] = card_id
            if group:
                item["group"] = group
            if detail:
                item["detail"] = detail

        elif kind == "view":
            title = str(raw.get("title") or "").strip()
            matched = _match_state_entry(
                state_views,
                index,
                card_id=card_id,
                bot_name=bot,
                text_key="title",
                text_val=title,
                skip_issue_draft=True,
                allowed_bot_ids=scoped_allowed_ids,
            )
            state_v = matched[1] if matched else {}
            if matched:
                seen_view_sids.add(matched[0])
            if not card_id and state_v.get("id"):
                card_id = str(state_v["id"]).strip()
            if not title and state_v.get("title"):
                title = str(state_v["title"]).strip()
            if not group and matched and matched[2]:
                group = matched[2]
            state_opts, state_detail = (
                _extract_view_options_and_detail(state_v) if state_v else ([], "")
            )
            options = _extract_option_labels(raw.get("options")) or state_opts
            detail = str(raw.get("detail") or state_detail or "").strip()
            item = {
                "kind": "view",
                "bot": bot,
                "title": title,
                "options": options,
            }
            if card_id:
                item["id"] = card_id
                seen_view_ids.add(card_id)
            if group:
                item["group"] = group
            if detail:
                item["detail"] = detail

        elif kind == "approval":
            tool = str(raw.get("tool") or "").strip()
            reason = str(raw.get("reason") or "").strip()
            item = {
                "kind": "approval",
                "bot": bot,
                "tool": tool,
                "reason": reason,
                "options": [],
            }
            if card_id:
                item["id"] = card_id
            if group:
                item["group"] = group
        else:
            item = dict(raw)

        item["idempotency_key"] = _compute_waiting_idempotency_key(item)
        if item["idempotency_key"] not in seen_keys:
            seen_keys.add(item["idempotency_key"])
            normalized.append(item)

    if state_views and allowed_checked:
        extra_views: list[dict[str, Any]] = []
        for sid, view_obj in state_views.items():
            sid_s = str(sid)
            if sid_s in seen_view_sids or not isinstance(view_obj, dict):
                continue
            if view_obj.get("issueDraft") is not None:
                continue
            vid = str(view_obj.get("id") or "").strip()
            if vid and vid in seen_view_ids:
                continue
            bot_id, bot_name, is_private, group_name = _resolve_state_entry_owner(
                sid_s, view_obj, index
            )
            if is_private:
                continue
            if allowed_bot_ids:
                if not bot_id or bot_id not in allowed_bot_ids:
                    continue
            else:
                if not bot_name or bot_name.lower() not in allowed_bot_names:
                    continue
            title = str(view_obj.get("title") or "").strip()
            options, detail = _extract_view_options_and_detail(view_obj)
            v_item: dict[str, Any] = {
                "kind": "view",
                "bot": bot_name,
                "title": title,
                "options": options,
            }
            if vid:
                v_item["id"] = vid
            if group_name:
                v_item["group"] = group_name
            if detail:
                v_item["detail"] = detail
            v_item["idempotency_key"] = _compute_waiting_idempotency_key(v_item)
            if v_item["idempotency_key"] not in seen_keys:
                seen_keys.add(v_item["idempotency_key"])
                extra_views.append(v_item)

        extra_views.sort(
            key=lambda v: (
                str(v.get("bot") or "").lower(),
                str(v.get("title") or ""),
                v["idempotency_key"],
            )
        )
        normalized.extend(extra_views)

    return normalized


def _format_waiting_items(items: list[dict[str, Any]]) -> str:
    blocks: list[str] = []
    for item in items:
        kind = str(item.get("kind") or "waiting").strip().lower()
        bot = str(item.get("bot") or "").strip()
        group = str(item.get("group") or "").strip()
        who = (
            f"{bot} (group {group})"
            if bot and group
            else (bot or group or "DS Bot")
        )
        card_id = str(item.get("id") or "").strip()
        id_suffix = f" [id={card_id}]" if card_id else ""
        lines: list[str] = []
        if kind == "question":
            q_text = str(item.get("question") or "").strip()
            lines.append(f"Question from {who}: {q_text}{id_suffix}")
            detail = str(item.get("detail") or "").strip()
            if detail:
                lines.append(f"Detail: {detail}")
            opts = item.get("options") or []
            if opts:
                lines.append("Options:")
                for idx, opt in enumerate(opts, 1):
                    lines.append(f"{idx}. {opt}")
        elif kind == "view":
            title = str(item.get("title") or "").strip()
            lines.append(f"View from {who}: {title}{id_suffix}")
            detail = str(item.get("detail") or "").strip()
            if detail:
                lines.append(f"Detail: {detail}")
            opts = item.get("options") or []
            if opts:
                lines.append("Options:")
                for idx, opt in enumerate(opts, 1):
                    lines.append(f"{idx}. {opt}")
        elif kind == "approval":
            tool = str(item.get("tool") or "").strip()
            reason = str(item.get("reason") or "").strip()
            tool_part = f" (tool={tool})" if tool else ""
            reason_part = f": {reason}" if reason else ""
            lines.append(f"Approval needed for {who}{tool_part}{reason_part}{id_suffix}")
        else:
            lines.append(f"{kind} from {who}{id_suffix}")
        blocks.append("\n".join(lines))
    return "[LOCAL_DSBOT_WAITING] " + "\n\n".join(blocks)


class WaitingSyncManager:
    """Mirrors local DS Bot waiting cards into broker decisions and reconciles closed ones."""

    def __init__(
        self,
        broker: Optional[BrokerClient] = None,
        mcp_url: Optional[str] = None,
        mcp_token: Optional[str] = None,
        dsbot_home: Optional[str] = None,
        mcp_token_file: Optional[str] = None,
        *,
        client: Optional[BrokerClient] = None,
    ) -> None:
        resolved_broker = broker if broker is not None else client
        if resolved_broker is None:
            raise ValueError("broker/client is required")
        self.broker = resolved_broker
        self.client = resolved_broker
        self.mcp_url = (mcp_url or "").strip()
        self.mcp_token = mcp_token
        self.dsbot_home = dsbot_home
        self.mcp_token_file = mcp_token_file
        self._lock = threading.Lock()
        self._initialized = False
        self._last_snapshot_hash = ""
        self._last_active_keys: tuple[str, ...] = ()
        self._last_item_hashes: dict[str, str] = {}

    @staticmethod
    def _item_to_decision_payload(item: dict[str, Any]) -> dict[str, Any]:
        kind = str(item.get("kind") or "decision").strip().lower()
        if kind not in ("decision", "question", "view", "approval"):
            kind = "decision"
        bot = str(item.get("bot") or "").strip() or None
        group = str(item.get("group") or "").strip() or None
        card_id = str(item.get("id") or "").strip() or None
        options = [
            redact_secrets(str(o).strip())[:300]
            for o in (item.get("options") or [])
            if str(o).strip()
        ]
        if kind == "question":
            raw_title = str(item.get("question") or "").strip()
            title = redact_secrets(raw_title or f"Question from {bot or 'DS Bot'}")[:300]
            context = redact_secrets(str(item.get("detail") or "").strip())[:8000]
        elif kind == "view":
            raw_title = str(item.get("title") or "").strip()
            title = redact_secrets(raw_title or f"View from {bot or 'DS Bot'}")[:300]
            context = redact_secrets(str(item.get("detail") or "").strip())[:8000]
        elif kind == "approval":
            tool = str(item.get("tool") or "").strip()
            reason = redact_secrets(str(item.get("reason") or "").strip())
            if tool and reason:
                raw_title = f"Approve {tool}: {reason}"
            elif reason:
                raw_title = reason
            elif tool:
                raw_title = f"Approve {tool}"
            else:
                raw_title = f"Approval needed for {bot or 'DS Bot'}"
            title = redact_secrets(raw_title)[:300]
            ctx_lines = [
                p
                for p in (
                    f"Tool: {tool}" if tool else "",
                    f"Reason: {reason}" if reason else "",
                )
                if p
            ]
            context = redact_secrets("\n".join(ctx_lines))[:8000]
            options = []
        else:
            title = redact_secrets(str(item.get("title") or f"Waiting in {bot or 'DS Bot'}"))[:300]
            context = redact_secrets(str(item.get("detail") or "").strip())[:8000]

        return {
            "source_env": "mac_waiting",
            "kind": kind,
            "card_id": card_id,
            "title": title,
            "context": context,
            "options": options,
            "source_bot": bot,
            "source_room": group,
            "idempotency_key": str(item["idempotency_key"]),
        }

    def sync_once(self, force: bool = False) -> bool:
        tok = _read_mcp_token(self.mcp_token, self.mcp_token_file)
        if not self.mcp_url or not tok:
            return False

        items = collect_local_waiting_items(
            self.mcp_url, tok, dsbot_home=self.dsbot_home
        )
        payloads = sorted(
            (self._item_to_decision_payload(item) for item in items),
            key=lambda p: p["idempotency_key"],
        )
        active_keys = tuple(p["idempotency_key"] for p in payloads)
        snapshot_json = json.dumps(payloads, sort_keys=True, ensure_ascii=False)
        snapshot_hash = hashlib.sha256(snapshot_json.encode("utf-8")).hexdigest()

        with self._lock:
            if (
                not force
                and self._initialized
                and snapshot_hash == self._last_snapshot_hash
            ):
                return False

            new_item_hashes: dict[str, str] = {}
            posted_any = False
            for payload in payloads:
                key = payload["idempotency_key"]
                item_hash = hashlib.sha256(
                    json.dumps(payload, sort_keys=True, ensure_ascii=False).encode("utf-8")
                ).hexdigest()
                new_item_hashes[key] = item_hash
                if (
                    force
                    or not self._initialized
                    or self._last_item_hashes.get(key) != item_hash
                ):
                    code, data = self.broker.post(
                        "/v1/decisions", payload, timeout=10.0
                    )
                    if code not in (200, 201) or not data.get("ok"):
                        raise RuntimeError(
                            f"POST /v1/decisions failed ({code}): {redact_secrets(str(data))}"
                        )
                    self._last_item_hashes[key] = item_hash
                    posted_any = True

            reconcile_needed = (
                force
                or not self._initialized
                or active_keys != self._last_active_keys
            )
            if reconcile_needed:
                code, data = self.broker.post(
                    "/v1/worker/decisions/reconcile",
                    {"active_keys": list(active_keys)},
                    timeout=10.0,
                )
                if code != 200 or not data.get("ok"):
                    raise RuntimeError(
                        f"POST /v1/worker/decisions/reconcile failed ({code}): {redact_secrets(str(data))}"
                    )
                posted_any = True

            self._initialized = True
            self._last_snapshot_hash = snapshot_hash
            self._last_active_keys = active_keys
            self._last_item_hashes = new_item_hashes
            return posted_any

    def sync(self, force: bool = False) -> bool:
        return self.sync_once(force=force)


_PROBE_SESSION_PREFIXES = ("e2e-", "probe-", "healthcheck-")
_PROBE_BANNER_PREFIX = "[Automated healthcheck probe from mac-job-worker"


def _frame_dsbot_task(job: dict[str, Any], task: str) -> str:
    role = str(job.get("role") or "").strip().lower()
    session_id = str(job.get("aws_session_id") or "").strip()
    is_probe = role == "probe" or session_id.lower().startswith(_PROBE_SESSION_PREFIXES)
    if not is_probe or task.lstrip().startswith(_PROBE_BANNER_PREFIX):
        return task
    label = session_id or "probe"
    return (
        f"{_PROBE_BANNER_PREFIX} (session={label}): "
        "reply with only what is requested below; no extra commentary or follow-up question needed.]\n\n"
        f"{task}"
    )


def run_dsbot_via_local_mcp(
    job: dict[str, Any],
    mcp_url: str,
    mcp_token: str,
    *,
    empty_done_grace_sec: float = 45.0,
    poll_sleep_sec: float = 1.0,
    dsbot_home: Optional[str] = None,
) -> dict[str, Optional[str]]:
    if str(job.get("role") or "").strip() == "decision_resume":
        raw_task = str(job.get("task") or "")
        hdr_match = _DECISION_RESOLVED_HEADER_RE.search(raw_task)
        hdr_text = hdr_match.group(1) if hdr_match else ""
        card_match = _DECISION_CARD_ID_RE.search(hdr_text) if hdr_text else None
        kind_match = _DECISION_KIND_RE.search(hdr_text) if hdr_text else None
        card_id = card_match.group(1).strip().strip("\"'") if card_match else ""
        card_kind = kind_match.group(1).strip().strip("\"'").lower() if kind_match else ""
        if card_id and card_id.lower() != "none":
            resolved_home = _resolve_dsbot_home(dsbot_home)
            state = _read_dsbot_state_readonly(resolved_home)
            if _is_card_closed_in_state(state, card_id, kind=card_kind):
                closed_summary = (
                    f"[DECISION_ALREADY_CLOSED_LOCALLY card_id={card_id}] "
                    "Skipped duplicate resume because card was already answered in DS Bot.app."
                )
                return {
                    "status": "succeeded",
                    "result_summary": closed_summary,
                    "summary": closed_summary,
                    "pr_url": None,
                    "error": None,
                }

    task = _frame_dsbot_task(job, str(job["task"]))
    timeout_sec = max(1, int(job.get("timeout_sec") or 900))
    deadline = time.monotonic() + timeout_sec
    group_target = str(job.get("group") or job.get("group_name") or "").strip()

    if group_target:
        try:
            send_res = _mcp_call_tool(
                mcp_url,
                mcp_token,
                "send_to_group",
                {"group": group_target, "text": task},
                timeout=30.0,
            )
        except Exception as exc:
            raise _McpBeforeSendError(f"send_to_group failed: {exc}") from exc
        if send_res.get("sent") is not True:
            raise _McpBeforeSendError(
                f"send_to_group did not confirm send: {send_res!r}"
            )
        wait_args: dict[str, Any] = {"group": group_target}
        target_label = f"group:{group_target}"
        match_key = ("group", group_target)
    else:
        bot_target = str(job.get("bot") or "").strip()
        if not bot_target:
            try:
                bots_res = _mcp_call_tool(
                    mcp_url, mcp_token, "list_bots", {}, timeout=15.0
                )
            except Exception as exc:
                raise _McpBeforeSendError(f"list_bots failed: {exc}") from exc
            bots = bots_res.get("bots") or []
            chosen = next((b for b in bots if b.get("main") is True), None) or (
                bots[0] if bots else None
            )
            bot_target = (
                str(chosen.get("name") or chosen.get("id") or "Chief")
                if chosen
                else "Chief"
            )
        try:
            send_res = _mcp_call_tool(
                mcp_url,
                mcp_token,
                "send_to_bot",
                {"bot": bot_target, "text": task},
                timeout=30.0,
            )
        except Exception as exc:
            raise _McpBeforeSendError(f"send_to_bot failed: {exc}") from exc
        if send_res.get("sent") is not True:
            raise _McpBeforeSendError(
                f"send_to_bot did not confirm send: {send_res!r}"
            )
        wait_args = {"bot": bot_target}
        target_label = f"bot:{bot_target}"
        match_key = ("bot", bot_target)

    after = int(send_res.get("after") or 0)
    cur_after = after
    collected: list[dict[str, Any]] = []
    waiting_for_target: list[dict[str, Any]] = []
    empty_grace_deadline = min(deadline, time.monotonic() + max(0.0, empty_done_grace_sec))

    def _matching_waiting() -> list[dict[str, Any]]:
        items = collect_local_waiting_items(
            mcp_url, mcp_token, dsbot_home=dsbot_home
        )
        wanted = match_key[1].lower()
        return [
            item
            for item in items
            if str(item.get(match_key[0]) or "").strip().lower() == wanted
        ]

    while time.monotonic() < deadline:
        wait_sec = min(25, max(1, int(deadline - time.monotonic())))
        wait_res = _mcp_call_tool(
            mcp_url,
            mcp_token,
            "wait_for_reply",
            {**wait_args, "after": cur_after, "timeoutSeconds": wait_sec},
            timeout=float(wait_sec + 15),
        )
        msgs = [
            m
            for m in (wait_res.get("messages") or [])
            if m.get("kind") != "user"
        ]
        if msgs:
            collected.extend(msgs)
            cur_after = max(cur_after, int(wait_res.get("after") or cur_after))
        if wait_res.get("done") is True:
            if not collected:
                chat_res = _mcp_call_tool(
                    mcp_url, mcp_token, "read_chat", wait_args, timeout=15.0
                )
                collected.extend(
                    m
                    for m in (chat_res.get("messages") or [])
                    if m.get("kind") != "user" and int(m.get("time") or 0) >= after
                )
            if collected:
                break
            try:
                matched = _matching_waiting()
            except Exception:
                matched = []
            if matched:
                waiting_for_target = matched
                break
            if time.monotonic() < empty_grace_deadline:
                time.sleep(
                    min(poll_sleep_sec, max(0.0, empty_grace_deadline - time.monotonic()))
                )
                continue
            break
        try:
            matched = _matching_waiting()
        except Exception:
            matched = []
        if matched:
            waiting_for_target = matched
            break

    if not waiting_for_target:
        try:
            waiting_for_target = _matching_waiting()
        except Exception:
            pass

    summary_parts: list[str] = []
    for msg in collected:
        txt = str(msg.get("text") or "").strip()
        if txt:
            summary_parts.append(f"[{msg.get('from') or target_label}] {txt}")
    if waiting_for_target:
        summary_parts.append(_format_waiting_items(waiting_for_target))

    if not summary_parts:
        return {
            "status": "failed",
            "result_summary": "",
            "pr_url": None,
            "error": f"Timed out waiting for local DS Bot ({target_label}) reply via MCP",
        }

    joined = "\n\n".join(summary_parts)
    return {
        "status": "succeeded",
        "result_summary": redact_secrets(joined),
        "pr_url": extract_pr_url(joined),
        "error": None,
    }


def default_dsbot_runner(
    job: dict[str, Any],
    dsh_bin: str,
    headless_patch: str,
    mcp_url: Optional[str] = None,
    mcp_token: Optional[str] = None,
    dsbot_home: Optional[str] = None,
) -> dict[str, Optional[str]]:
    resolved_url = (
        mcp_url
        if mcp_url is not None
        else os.environ.get("LOCAL_DSBOT_MCP_URL", "http://127.0.0.1:8797/mcp")
    ).strip()
    resolved_token = _read_mcp_token(
        mcp_token,
        os.environ.get(
            "LOCAL_DSBOT_MCP_TOKEN_FILE",
            "/Users/chief/.mac-job-worker/dsbot-mcp-token",
        ),
    )
    engine = str(
        job.get("engine") or os.environ.get("LOCAL_DSBOT_ENGINE", "auto")
    ).strip().lower()

    if engine != "headless-cli" and resolved_url and resolved_token:
        try:
            return run_dsbot_via_local_mcp(
                job, resolved_url, resolved_token, dsbot_home=dsbot_home
            )
        except _McpBeforeSendError as exc:
            if engine == "local-mcp":
                return {
                    "status": "failed",
                    "result_summary": "",
                    "pr_url": None,
                    "error": redact_secrets(str(exc)),
                }
            sys.stderr.write(
                f"[worker] local-mcp unavailable before send ({exc}); falling back to headless dsh\n"
            )
        except Exception as exc:
            return {
                "status": "failed",
                "result_summary": "",
                "pr_url": None,
                "error": redact_secrets(str(exc)),
            }
    elif engine == "local-mcp":
        return {
            "status": "failed",
            "result_summary": "",
            "pr_url": None,
            "error": "LOCAL_DSBOT_MCP_TOKEN is not configured for engine=local-mcp",
        }

    task = str(job["task"])
    timeout_sec = int(job.get("timeout_sec") or 900)
    run_cwd: Optional[str] = None
    job_cwd = str(job.get("cwd") or "").strip()
    if job_cwd:
        run_cwd = os.path.expanduser(job_cwd)
        if not is_authorized_local_path(run_cwd):
            raise RuntimeError(f"Unauthorized local path: {run_cwd}")
        os.makedirs(run_cwd, exist_ok=True)
    env = os.environ.copy()
    env.setdefault("STUDIO_POOL_API_KEY", "local-loopback-placeholder")
    res = subprocess.run(
        [dsh_bin, "--profile", "headless", "--patch", headless_patch, task],
        capture_output=True,
        text=True,
        env=env,
        timeout=timeout_sec,
        check=False,
        cwd=run_cwd,
    )
    out = (res.stdout or "").strip()
    err = (res.stderr or "").strip()
    if res.returncode != 0:
        return {
            "status": "failed",
            "result_summary": redact_secrets(out),
            "pr_url": extract_pr_url(out),
            "error": redact_secrets(err or f"dsh exited with {res.returncode}"),
        }
    return {
        "status": "succeeded",
        "result_summary": redact_secrets(out),
        "pr_url": extract_pr_url(out),
        "error": None,
    }


def _acquire_dir_lock(
    lock_dir: str, timeout_sec: float = 2.0, stale_sec: float = 30.0
) -> None:
    os.makedirs(os.path.dirname(os.path.abspath(lock_dir)), exist_ok=True)
    deadline = time.time() + timeout_sec
    while True:
        try:
            os.mkdir(lock_dir)
            return
        except FileExistsError:
            try:
                stale = (time.time() - os.path.getmtime(lock_dir)) > stale_sec
            except OSError:
                continue
            if stale:
                try:
                    os.rmdir(lock_dir)
                except OSError:
                    pass
                continue
            if time.time() >= deadline:
                raise TimeoutError(f"Timed out acquiring lock {lock_dir}")
            time.sleep(0.01)


def _release_dir_lock(lock_dir: str) -> None:
    try:
        os.rmdir(lock_dir)
    except FileNotFoundError:
        pass


class MacJobWorker:
    def __init__(
        self,
        broker: BrokerClient,
        worker_id: str,
        state_dir: str,
        dsbot_runner: Callable[[dict[str, Any]], dict[str, Optional[str]]],
        git_sync_runner: Optional[
            Callable[[dict[str, Any]], dict[str, Optional[str]]]
        ] = None,
        hostname: Optional[str] = None,
        heartbeat_interval: float = 30.0,
        claim_wait_sec: float = 0.0,
    ) -> None:
        self.broker = broker
        self.worker_id = worker_id
        self.state_dir = state_dir
        os.makedirs(self.state_dir, exist_ok=True)
        self.dsbot_runner = dsbot_runner
        self.git_sync_runner = git_sync_runner
        self.hostname = hostname or socket.gethostname()
        self.heartbeat_interval = heartbeat_interval
        self.claim_wait_sec = max(0.0, float(claim_wait_sec))

    def _cache_path(self, job_id: str) -> str:
        safe_id = re.sub(r"[^A-Za-z0-9_.-]", "_", job_id)
        return os.path.join(self.state_dir, f"{safe_id}.json")

    def save_cached_result(self, job_id: str, payload: dict[str, Any]) -> None:
        path = self._cache_path(job_id)
        tmp = f"{path}.tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(payload, f)
        os.replace(tmp, path)

    def load_cached_result(self, job_id: str) -> Optional[dict[str, Any]]:
        path = self._cache_path(job_id)
        if not os.path.exists(path):
            return None
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)

    def remove_cached_result(self, job_id: str) -> None:
        path = self._cache_path(job_id)
        if os.path.exists(path):
            os.remove(path)

    def _submit_completion(self, payload: dict[str, Any]) -> bool:
        for attempt in range(3):
            try:
                code, _ = self.broker.post("/v1/worker/complete", payload, timeout=15.0)
                if code in (200, 404, 409):
                    self.remove_cached_result(payload["job_id"])
                    return True
            except Exception as exc:
                sys.stderr.write(
                    f"[worker] complete attempt {attempt + 1} failed: {exc}\n"
                )
            time.sleep(2)
        return False

    def reconcile(self) -> int:
        code, data = self.broker.post(
            "/v1/worker/reconcile",
            {
                "worker_id": self.worker_id,
                "hostname": self.hostname,
                "capabilities": ["dsbot", "git_sync"],
            },
        )
        if code != 200 or not data.get("ok"):
            return 0
        jobs = data.get("jobs") or []
        for job in jobs:
            job_id = job["job_id"]
            cached = self.load_cached_result(job_id)
            if cached is not None:
                self._submit_completion(cached)
            else:
                payload = {
                    "job_id": job_id,
                    "worker_id": self.worker_id,
                    "status": "failed",
                    "result_summary": "",
                    "pr_url": None,
                    "error": "Worker restarted before job finished; not auto-retried to avoid duplicate side effects.",
                }
                self.save_cached_result(job_id, payload)
                self._submit_completion(payload)
        return len(jobs)

    def execute_job(self, job: dict[str, Any]) -> dict[str, Any]:
        job_id = job["job_id"]
        target = job.get("target")
        hb_stop = threading.Event()

        def hb_loop() -> None:
            while not hb_stop.wait(self.heartbeat_interval):
                try:
                    code, resp = self.broker.post(
                        "/v1/worker/heartbeat",
                        {"job_id": job_id, "worker_id": self.worker_id},
                    )
                    if code != 200 or not resp.get("ok"):
                        hb_stop.set()
                        return
                except Exception:
                    pass

        hb_thread = threading.Thread(target=hb_loop, daemon=True)
        hb_thread.start()

        try:
            if target == "dsbot":
                res = self.dsbot_runner(job)
            elif target == "git_sync":
                if self.git_sync_runner is None:
                    res = {
                        "status": "failed",
                        "result_summary": "",
                        "pr_url": None,
                        "error": "git_sync_runner not configured",
                    }
                else:
                    res = self.git_sync_runner(job)
            else:
                res = {
                    "status": "failed",
                    "result_summary": "",
                    "pr_url": None,
                    "error": f"Unsupported target: {target} (ParaDev removed; use dsbot or git_sync)",
                }
        except Exception as exc:
            res = {
                "status": "failed",
                "result_summary": "",
                "pr_url": None,
                "error": redact_secrets(str(exc)),
            }
        finally:
            hb_stop.set()
            hb_thread.join(timeout=2)

        payload = {
            "job_id": job_id,
            "worker_id": self.worker_id,
            "status": res.get("status") or "failed",
            "result_summary": redact_secrets(
                res.get("result_summary") or res.get("summary") or ""
            ),
            "pr_url": res.get("pr_url"),
            "error": redact_secrets(res.get("error") or "") if res.get("error") else None,
            "workspace_id": res.get("workspace_id"),
            "terminal_id": res.get("terminal_id"),
            "role": res.get("role"),
            "agent": res.get("agent"),
            "worktree_path": res.get("worktree_path"),
        }
        self.save_cached_result(job_id, payload)
        self._submit_completion(payload)
        return payload

    def flush_pending_decisions(self, spool_path: str) -> int:
        if not spool_path:
            return 0
        claim_path = f"{spool_path}.flushing"
        claim_tmp = f"{claim_path}.tmp"
        lock_dir = f"{spool_path}.lock"
        flush_lock_path = f"{spool_path}.flush.lockfile"
        os.makedirs(os.path.dirname(os.path.abspath(flush_lock_path)), exist_ok=True)
        with _FLUSH_THREAD_LOCK:
            with open(flush_lock_path, "a+", encoding="utf-8") as lock_f:
                fcntl.flock(lock_f.fileno(), fcntl.LOCK_EX)
                try:
                    lines: list[str] = []
                    _acquire_dir_lock(lock_dir)
                    try:
                        if os.path.exists(claim_path):
                            with open(claim_path, "r", encoding="utf-8") as f:
                                lines.extend(ln.strip() for ln in f if ln.strip())
                        if os.path.exists(spool_path):
                            with open(spool_path, "r", encoding="utf-8") as f:
                                lines.extend(ln.strip() for ln in f if ln.strip())
                            if lines:
                                with open(claim_tmp, "w", encoding="utf-8") as f:
                                    f.write("\n".join(lines) + "\n")
                                os.replace(claim_tmp, claim_path)
                            os.remove(spool_path)
                    finally:
                        _release_dir_lock(lock_dir)
                    if not lines:
                        if os.path.exists(claim_path):
                            os.remove(claim_path)
                        return 0
                    remaining: list[str] = []
                    flushed = 0
                    for idx, ln in enumerate(lines):
                        try:
                            payload = json.loads(ln)
                            code, _ = self.broker.post(
                                "/v1/decisions", payload, timeout=10.0
                            )
                            if code in (200, 201):
                                flushed += 1
                            else:
                                remaining.extend(lines[idx:])
                                break
                        except Exception:
                            remaining.extend(lines[idx:])
                            break
                    if remaining:
                        with open(claim_tmp, "w", encoding="utf-8") as f:
                            f.write("\n".join(remaining) + "\n")
                        os.replace(claim_tmp, claim_path)
                    elif os.path.exists(claim_path):
                        os.remove(claim_path)
                    return flushed
                finally:
                    fcntl.flock(lock_f.fileno(), fcntl.LOCK_UN)

    def poll_once(self) -> Optional[dict[str, Any]]:
        payload: dict[str, Any] = {
            "worker_id": self.worker_id,
            "hostname": self.hostname,
            "capabilities": ["dsbot", "git_sync"],
        }
        if self.claim_wait_sec > 0.0:
            payload["wait_sec"] = self.claim_wait_sec
        code, data = self.broker.post(
            "/v1/worker/claim",
            payload,
            timeout=max(20.0, self.claim_wait_sec + 15.0),
        )
        if code != 200 or not data.get("ok"):
            return None
        job = data.get("job")
        if not job:
            return None
        sys.stderr.write(
            f"[worker] claimed {job['job_id']} target={job['target']}\n"
        )
        return self.execute_job(job)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--env-file",
        default=os.environ.get("WORKER_ENV_FILE", "/Users/chief/.mac-job-worker/env"),
    )
    args = parser.parse_args()
    load_env_file(args.env_file)

    worker_token = os.environ.get("BROKER_WORKER_TOKEN", "")
    if not worker_token:
        raise SystemExit("BROKER_WORKER_TOKEN must be set")

    broker_url = os.environ.get("BROKER_URL", "http://127.0.0.1:13090")
    worker_id = os.environ.get("WORKER_ID", "mac-mini-chief")
    profile = os.environ.get("AWS_PROFILE", "flinter")
    region = os.environ.get("AWS_REGION", "us-east-2")
    instance_id = os.environ.get("EC2_INSTANCE_ID", "i-0c1117f3148176425")
    dsh_bin = os.environ.get("DSH_BIN", "/usr/local/bin/dsh")
    headless_patch = os.environ.get(
        "HEADLESS_PATCH", "/Users/chief/.mac-job-worker/headless.patch.yml"
    )
    state_dir = os.environ.get("WORKER_STATE_DIR", "/Users/chief/.mac-job-worker/state")
    poll_interval = float(os.environ.get("POLL_INTERVAL_SEC", "5"))
    claim_wait_sec = float(os.environ.get("CLAIM_WAIT_SEC", "25"))
    heartbeat_interval = float(os.environ.get("HEARTBEAT_INTERVAL_SEC", "30"))

    broker = BrokerClient(broker_url, worker_token)
    tunnel = SsmTunnelManager(
        broker=broker,
        profile=profile,
        region=region,
        instance_id=instance_id,
    )
    handoff_tunnel: Optional[SsmTunnelManager] = None
    handoff_enabled = (
        os.environ.get("CLOUD_HANDOFF_TUNNEL_ENABLED", "1").strip().lower()
        not in ("0", "false", "no", "off")
    )
    if handoff_enabled:
        handoff_local_port = int(os.environ.get("CLOUD_HANDOFF_LOCAL_PORT", "8080"))
        handoff_remote_port = int(os.environ.get("CLOUD_HANDOFF_REMOTE_PORT", "8080"))
        handoff_health_url = os.environ.get(
            "CLOUD_HANDOFF_HEALTH_URL", f"http://127.0.0.1:{handoff_local_port}/ready"
        )
        handoff_tunnel = SsmTunnelManager(
            broker=None,
            health_check=HttpHealthProbe(handoff_health_url),
            profile=profile,
            region=region,
            instance_id=instance_id,
            remote_port=handoff_remote_port,
            local_port=handoff_local_port,
            label="cloud-handoff",
        )

    worker = MacJobWorker(
        broker=broker,
        worker_id=worker_id,
        state_dir=state_dir,
        dsbot_runner=lambda job: default_dsbot_runner(job, dsh_bin, headless_patch),
        git_sync_runner=lambda job: default_git_sync_runner(job),
        heartbeat_interval=heartbeat_interval,
        claim_wait_sec=claim_wait_sec,
    )

    dsbot_home = os.path.expanduser(os.environ.get("DSBOT_HOME", "/Users/chief/.ds-bot"))
    mcp_url = os.environ.get("LOCAL_DSBOT_MCP_URL", "http://127.0.0.1:8797/mcp").strip()
    mcp_token_file = os.environ.get(
        "LOCAL_DSBOT_MCP_TOKEN_FILE", "/Users/chief/.mac-job-worker/dsbot-mcp-token"
    )

    context_sync_enabled = (
        os.environ.get("CONTEXT_SYNC_ENABLED", "1").strip().lower()
        not in ("0", "false", "no", "off")
    )
    context_sync: Optional[ContextSyncManager] = None
    if context_sync_enabled:
        context_sync = ContextSyncManager(
            broker=broker,
            dsbot_home=dsbot_home,
            state_dir=state_dir,
            mcp_url=mcp_url,
            mcp_token_file=mcp_token_file,
        )

    waiting_sync_enabled = (
        os.environ.get("WAITING_SYNC_ENABLED", "1").strip().lower()
        not in ("0", "false", "no", "off")
    )
    waiting_sync_interval = max(
        0.5, float(os.environ.get("WAITING_SYNC_INTERVAL_SEC", "5.0"))
    )
    waiting_sync: Optional[WaitingSyncManager] = None
    if waiting_sync_enabled:
        waiting_sync = WaitingSyncManager(
            broker=broker,
            mcp_url=mcp_url,
            mcp_token=None,
            dsbot_home=dsbot_home,
            mcp_token_file=mcp_token_file,
        )
    last_waiting_sync = 0.0
    waiting_sync_run_lock = threading.Lock()
    connected_event = threading.Event()

    def _run_waiting_sync(phase: str, *, min_interval: float = 0.0) -> None:
        nonlocal last_waiting_sync
        if waiting_sync is None:
            return
        with waiting_sync_run_lock:
            now = time.monotonic()
            if min_interval > 0.0 and (now - last_waiting_sync) < min_interval:
                return
            try:
                waiting_sync.sync_once()
                last_waiting_sync = time.monotonic()
            except Exception as exc:
                last_waiting_sync = time.monotonic()
                sys.stderr.write(
                    f"[worker] waiting-sync {phase} error: {redact_secrets(str(exc))}\n"
                )

    stop_event = threading.Event()
    if handoff_tunnel is not None:
        handoff_probe_sec = float(os.environ.get("CLOUD_HANDOFF_PROBE_SEC", "20"))
        start_tunnel_watchdog(
            handoff_tunnel, stop_event, interval_sec=handoff_probe_sec
        )

    if context_sync is not None:
        sync_interval = max(30.0, float(os.environ.get("CONTEXT_SYNC_INTERVAL_SEC", "300")))

        def context_sync_loop() -> None:
            while not stop_event.wait(sync_interval):
                try:
                    context_sync.pull_cloud_notes()
                    context_sync.sync_to_ec2()
                except Exception as exc:
                    sys.stderr.write(f"[worker] context-sync loop error: {exc}\n")

        threading.Thread(target=context_sync_loop, daemon=True).start()

    if waiting_sync is not None:

        def waiting_sync_loop() -> None:
            while not stop_event.wait(waiting_sync_interval):
                if connected_event.is_set():
                    _run_waiting_sync("loop", min_interval=waiting_sync_interval)

        threading.Thread(target=waiting_sync_loop, daemon=True).start()

    def handle_sig(signum: int, _frame: Any) -> None:
        sys.stderr.write(f"[worker] received signal {signum}, shutting down\n")
        stop_event.set()
        tunnel.stop()
        if handoff_tunnel is not None:
            handoff_tunnel.stop()

    signal.signal(signal.SIGTERM, handle_sig)
    signal.signal(signal.SIGINT, handle_sig)

    spool_file = os.environ.get(
        "DECISION_SPOOL_FILE", "/Users/chief/.mac-job-worker/pending-decisions.jsonl"
    )
    reconciled_once = False
    while not stop_event.is_set():
        reconnected = tunnel.ensure_connected(stop_event)
        if stop_event.is_set():
            break
        if reconnected or not reconciled_once:
            try:
                n = worker.reconcile()
                sys.stderr.write(f"[worker] reconciled {n} job(s)\n")
                reconciled_once = True
                connected_event.set()
            except Exception as exc:
                sys.stderr.write(f"[worker] reconcile error: {exc}\n")
                stop_event.wait(poll_interval)
                continue
            if context_sync is not None:
                try:
                    pulled = context_sync.pull_cloud_notes()
                    pushed = context_sync.sync_to_ec2()
                    if pulled or pushed:
                        sys.stderr.write(
                            f"[worker] context-sync on connect: pulled={pulled} pushed={pushed}\n"
                        )
                except Exception as exc:
                    sys.stderr.write(f"[worker] context-sync connect error: {exc}\n")
            _run_waiting_sync("connect")

        try:
            flushed = worker.flush_pending_decisions(spool_file)
            if flushed:
                sys.stderr.write(f"[worker] carried over {flushed} local decision(s) to cloud\n")
        except Exception as exc:
            sys.stderr.write(f"[worker] decision flush error: {exc}\n")

        poll_t0 = time.monotonic()
        try:
            did = worker.poll_once()
            if did is not None:
                if context_sync is not None:
                    try:
                        context_sync.sync_to_ec2()
                    except Exception as exc:
                        sys.stderr.write(f"[worker] post-job context-sync error: {exc}\n")
                _run_waiting_sync("post-job")
                continue
            _run_waiting_sync("idle", min_interval=waiting_sync_interval)
            if claim_wait_sec > 0.0 and (time.monotonic() - poll_t0) >= min(
                claim_wait_sec * 0.5, 5.0
            ):
                continue
        except Exception as exc:
            sys.stderr.write(f"[worker] poll error: {exc}\n")
            _run_waiting_sync("idle-error", min_interval=waiting_sync_interval)
        stop_event.wait(poll_interval)

    tunnel.stop()
    if handoff_tunnel is not None:
        handoff_tunnel.stop()


if __name__ == "__main__":
    main()
