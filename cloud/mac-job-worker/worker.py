#!/usr/bin/env python3
"""Outbound Mac mini job worker polling AWS mac-job-broker over SSM."""

from __future__ import annotations

import argparse
import fcntl
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


def run_dsbot_via_local_mcp(
    job: dict[str, Any],
    mcp_url: str,
    mcp_token: str,
    *,
    empty_done_grace_sec: float = 45.0,
    poll_sleep_sec: float = 1.0,
) -> dict[str, Optional[str]]:
    task = str(job["task"])
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
        w_res = _mcp_call_tool(mcp_url, mcp_token, "list_waiting", {}, timeout=15.0)
        wanted = match_key[1].lower()
        return [
            item
            for item in (w_res.get("waiting") or [])
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
        summary_parts.append(
            "[LOCAL_DSBOT_WAITING] "
            + json.dumps(waiting_for_target, ensure_ascii=False)
        )

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
            return run_dsbot_via_local_mcp(job, resolved_url, resolved_token)
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
    ) -> None:
        self.broker = broker
        self.worker_id = worker_id
        self.state_dir = state_dir
        os.makedirs(self.state_dir, exist_ok=True)
        self.dsbot_runner = dsbot_runner
        self.git_sync_runner = git_sync_runner
        self.hostname = hostname or socket.gethostname()
        self.heartbeat_interval = heartbeat_interval

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
            "result_summary": redact_secrets(res.get("result_summary") or ""),
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
        code, data = self.broker.post(
            "/v1/worker/claim",
            {
                "worker_id": self.worker_id,
                "hostname": self.hostname,
                "capabilities": ["dsbot", "git_sync"],
            },
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
    )

    stop_event = threading.Event()
    if handoff_tunnel is not None:
        handoff_probe_sec = float(os.environ.get("CLOUD_HANDOFF_PROBE_SEC", "20"))
        start_tunnel_watchdog(
            handoff_tunnel, stop_event, interval_sec=handoff_probe_sec
        )

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
            except Exception as exc:
                sys.stderr.write(f"[worker] reconcile error: {exc}\n")
                stop_event.wait(poll_interval)
                continue

        try:
            flushed = worker.flush_pending_decisions(spool_file)
            if flushed:
                sys.stderr.write(f"[worker] carried over {flushed} local decision(s) to cloud\n")
        except Exception as exc:
            sys.stderr.write(f"[worker] decision flush error: {exc}\n")

        try:
            did = worker.poll_once()
            if did is not None:
                continue
        except Exception as exc:
            sys.stderr.write(f"[worker] poll error: {exc}\n")
        stop_event.wait(poll_interval)

    tunnel.stop()
    if handoff_tunnel is not None:
        handoff_tunnel.stop()


if __name__ == "__main__":
    main()
