#!/usr/bin/env python3
"""Outbound Mac mini job worker polling AWS mac-job-broker over SSM."""

from __future__ import annotations

import argparse
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

DEFAULT_ALLOWED_ROOTS = (
    "/Users/chief/flinter-cnc-tabletop",
    "/Users/chief/devin-agent-work",
    "/Users/chief/ds-bot-dev",
    "/Users/chief/.gemini/antigravity/scratch",
    "/Users/chief/.paradev/worktrees",
)
FORBIDDEN_HOME_SUBDIRS = {
    ".ssh",
    ".aws",
    ".gnupg",
    ".mac-job-worker",
    "Library",
    ".Trash",
}
DEFAULT_SESSIONS_FILE = "/Users/chief/.mac-job-worker/state/paradev_sessions.json"


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


class SsmTunnelManager:
    def __init__(
        self,
        broker: BrokerClient,
        profile: str,
        region: str,
        instance_id: str,
        remote_port: int = 13090,
        local_port: int = 13090,
    ) -> None:
        self.broker = broker
        self.profile = profile
        self.region = region
        self.instance_id = instance_id
        self.remote_port = remote_port
        self.local_port = local_port
        self.proc: Optional[subprocess.Popen[str]] = None
        self._backoff_idx = 0
        self._backoffs = [2, 5, 10, 30]

    def is_healthy(self) -> bool:
        return self.broker.healthz(timeout=3.0) is not None

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
                f"[worker] starting SSM tunnel {self.local_port}->{self.remote_port}\n"
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
                        f"[worker] SSM process exited early ({self.proc.returncode}): {out}\n"
                    )
                    break
                if self.is_healthy():
                    self._backoff_idx = 0
                    sys.stderr.write("[worker] SSM tunnel healthy\n")
                    return True
                time.sleep(0.5)

            self.stop()
            wait_s = self._backoffs[min(self._backoff_idx, len(self._backoffs) - 1)]
            self._backoff_idx += 1
            sys.stderr.write(f"[worker] retrying SSM tunnel in {wait_s}s\n")
            stop_event.wait(wait_s)
        return False


def _find_paradev_project(
    repo_hint: str, paradev_bin: str
) -> Optional[dict[str, Any]]:
    needle = repo_hint.strip().lower()
    if not needle:
        return None
    short = needle.rstrip("/").removesuffix(".git").split("/")[-1]
    proj_res = subprocess.run(
        [paradev_bin, "projects", "list", "--local", "--json"],
        capture_output=True,
        text=True,
        timeout=20,
        check=False,
    )
    if proj_res.returncode != 0 or not proj_res.stdout.strip():
        return None
    try:
        projects = json.loads(proj_res.stdout)
    except Exception:
        return None
    for p in projects:
        hay = " ".join(
            str(p.get(k) or "") for k in ("id", "name", "repo", "path")
        ).lower()
        if needle in hay or (short and str(p.get("name") or "").lower() == short):
            return p
    return None


def is_authorized_local_path(
    path: str, paradev_bin: str = "", parent_dir: str = "/Users/chief"
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

    if paradev_bin and os.path.exists(paradev_bin):
        try:
            proj_res = subprocess.run(
                [paradev_bin, "projects", "list", "--local", "--json"],
                capture_output=True,
                text=True,
                timeout=20,
                check=False,
            )
            if proj_res.returncode == 0 and proj_res.stdout.strip():
                for p in json.loads(proj_res.stdout):
                    proj_path = str(p.get("path") or "").strip()
                    if not proj_path:
                        continue
                    proj_lower = os.path.realpath(
                        os.path.expanduser(proj_path)
                    ).lower()
                    if real_lower == proj_lower or real_lower.startswith(
                        proj_lower + os.sep
                    ):
                        return True
        except Exception:
            pass

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


def _remote_github_exists(clone_url: str) -> bool:
    env = os.environ.copy()
    env["GIT_TERMINAL_PROMPT"] = "0"
    try:
        res = subprocess.run(
            ["git", "ls-remote", "--exit-code", clone_url, "HEAD"],
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
            env=env,
        )
    except Exception:
        return False
    return res.returncode == 0


def ensure_paradev_project(
    repo_hint: str,
    paradev_bin: str,
    parent_dir: str = "/Users/chief",
    local_only: bool = False,
    cwd: Optional[str] = None,
) -> tuple[Optional[dict[str, Any]], bool]:
    """Check ParaDev projects first; if missing, import local repo or clone GitHub repo."""
    if not (repo_hint or "").strip() and not (cwd or "").strip():
        return None, False
    raw = (repo_hint or cwd or "").strip()
    short_name = raw.rstrip("/").removesuffix(".git").split("/")[-1]

    existing = _find_paradev_project(raw, paradev_bin)
    if existing is None and cwd:
        existing = _find_paradev_project(cwd, paradev_bin)
    if existing is not None:
        if existing.get("path") and not is_authorized_local_path(
            str(existing["path"]), paradev_bin, parent_dir=parent_dir
        ):
            raise RuntimeError(f"Unauthorized local path: {existing['path']}")
        if cwd and cwd.strip() and not is_authorized_local_path(
            os.path.expanduser(cwd.strip()), paradev_bin, parent_dir=parent_dir
        ):
            raise RuntimeError(
                f"Unauthorized local path: {os.path.expanduser(cwd.strip())}"
            )
        return existing, True

    if cwd and cwd.strip():
        local_candidate = os.path.expanduser(cwd.strip())
    elif raw.startswith(("/", "~")) or os.path.isdir(os.path.expanduser(raw)):
        local_candidate = os.path.expanduser(raw)
    else:
        local_candidate = os.path.join(parent_dir, short_name)

    if not is_authorized_local_path(local_candidate, paradev_bin, parent_dir=parent_dir):
        raise RuntimeError(f"Unauthorized local path: {local_candidate}")

    if os.path.isdir(local_candidate):
        _ensure_local_git_repo(local_candidate, short_name)
        cmd = [
            paradev_bin,
            "projects",
            "create",
            "--local",
            "--name",
            short_name,
            "--import",
            local_candidate,
            "--json",
        ]
    else:
        if raw.startswith(("http://", "https://", "git@", "ssh://")):
            clone_url = raw
        elif "/" in raw:
            clone_url = f"https://github.com/{raw.strip('/')}.git"
        else:
            clone_url = f"https://github.com/callingforhelp/{short_name}.git"
        if local_only or not _remote_github_exists(clone_url):
            _ensure_local_git_repo(local_candidate, short_name)
            cmd = [
                paradev_bin,
                "projects",
                "create",
                "--local",
                "--name",
                short_name,
                "--import",
                local_candidate,
                "--json",
            ]
        else:
            cmd = [
                paradev_bin,
                "projects",
                "create",
                "--local",
                "--name",
                short_name,
                "--clone",
                clone_url,
                "--parent-dir",
                parent_dir,
                "--json",
            ]

    created = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        timeout=90,
        check=False,
    )
    if created.returncode != 0:
        raise RuntimeError(
            f"paradev projects create failed ({created.returncode}): {created.stderr or created.stdout}"
        )
    adopted = _find_paradev_project(short_name, paradev_bin)
    if adopted is None:
        try:
            adopted = json.loads(created.stdout)
        except Exception:
            adopted = {"name": short_name}
    return adopted, False


def default_paradev_register_runner(
    job: dict[str, Any], paradev_bin: str
) -> dict[str, Optional[str]]:
    repo = str(job.get("repo") or job.get("cwd") or "").strip()
    cwd = str(job.get("cwd") or "").strip() or None
    local_only = bool(job.get("local_only"))
    if not repo:
        return {
            "status": "failed",
            "result_summary": "",
            "pr_url": None,
            "error": "repo is required for paradev_register",
        }
    proj, already = ensure_paradev_project(
        repo, paradev_bin, local_only=local_only, cwd=cwd
    )
    return {
        "status": "succeeded",
        "result_summary": json.dumps(
            {"already_registered": already, "project": proj}, ensure_ascii=False
        ),
        "pr_url": None,
        "error": None,
    }


def paradev_session_key(
    repo: Optional[str] = None,
    cwd: Optional[str] = None,
    workspace_id: Optional[str] = None,
    branch: Optional[str] = None,
) -> str:
    return f"{(repo or cwd or workspace_id or 'default').strip()}:{(branch or 'default').strip()}"


class ParadevSessionStore:
    def __init__(self, path: str = DEFAULT_SESSIONS_FILE) -> None:
        self.path = path

    def _load(self) -> dict[str, Any]:
        try:
            with open(self.path, "r", encoding="utf-8") as f:
                data = json.load(f)
            return data if isinstance(data, dict) else {}
        except Exception:
            return {}

    def _save(self, data: dict[str, Any]) -> None:
        parent = os.path.dirname(self.path)
        if parent:
            os.makedirs(parent, exist_ok=True)
        tmp = f"{self.path}.tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, sort_keys=True)
        os.replace(tmp, self.path)

    def get(self, key: str) -> Optional[dict[str, Any]]:
        entry = self._load().get(key)
        return entry if isinstance(entry, dict) else None

    def set(self, key: str, entry: dict[str, Any]) -> None:
        data = self._load()
        data[key] = entry
        self._save(data)

    def upsert(self, key: str, updates: dict[str, Any]) -> None:
        data = self._load()
        ws = updates.get("workspace_id")
        if ws:
            for k, existing in data.items():
                if isinstance(existing, dict) and existing.get("workspace_id") == ws:
                    key = k
                    break
        existing = data.get(key)
        merged = dict(existing) if isinstance(existing, dict) else {}
        existing_ws = merged.get("workspace_id")
        if existing_ws and ws and str(existing_ws) != str(ws):
            for stale in ("worker_terminal_id", "reviewer_terminal_id", "worktree_path"):
                merged.pop(stale, None)
        merged.update(updates)
        data[key] = merged
        self._save(data)

    def find_by_workspace(self, ws_id: str) -> Optional[dict[str, Any]]:
        for entry in self._load().values():
            if isinstance(entry, dict) and str(entry.get("workspace_id") or "") == ws_id:
                return entry
        return None


def _is_terminal_alive(paradev_bin: str, ws_id: str, term_id: str) -> bool:
    try:
        res = subprocess.run(
            [
                paradev_bin,
                "terminals",
                "list",
                "--local",
                "--workspace",
                ws_id,
                "--json",
            ],
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
        if res.returncode != 0 or not res.stdout.strip():
            return False
        data = json.loads(res.stdout)
    except Exception:
        return False
    for entry in data.get("sessions") or []:
        if (
            entry.get("terminalId") == term_id or entry.get("id") == term_id
        ) and not entry.get("exited", False):
            return True
    return False


def _get_workspace_info(
    paradev_bin: str,
    ws_id: Optional[str] = None,
    project_id: Optional[str] = None,
    branch: Optional[str] = None,
) -> Optional[dict[str, Any]]:
    try:
        res = subprocess.run(
            [paradev_bin, "ws", "list", "--local", "--json"],
            capture_output=True,
            text=True,
            timeout=20,
            check=False,
        )
        if res.returncode != 0 or not res.stdout.strip():
            return None
        workspaces = json.loads(res.stdout)
    except Exception:
        return None
    if not isinstance(workspaces, list):
        return None
    if ws_id:
        for w in workspaces:
            if w.get("id") == ws_id and not w.get("archivedAt"):
                return w
        return None
    if project_id:
        for w in workspaces:
            if w.get("archivedAt"):
                continue
            pid = w.get("projectId") or w.get("project_id")
            if not pid:
                proj = w.get("project")
                if isinstance(proj, dict):
                    pid = proj.get("id")
                elif isinstance(proj, str):
                    pid = proj
            if str(pid or "") != str(project_id):
                continue
            if branch and w.get("branch") != branch:
                continue
            return w
    return None


def _read_agent_output(paradev_bin: str, ws_id: str, term_id: str) -> str:
    read_res = subprocess.run(
        [
            paradev_bin,
            "agents",
            "read",
            "--local",
            "--workspace",
            ws_id,
            "--terminal",
            term_id,
            "--json",
        ],
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    raw_text = read_res.stdout
    if read_res.returncode == 0:
        try:
            parsed = json.loads(read_res.stdout)
            if isinstance(parsed, dict) and "text" in parsed:
                raw_text = str(parsed.get("text") or "")
        except Exception:
            pass
    if read_res.returncode == 0 and raw_text.strip():
        return raw_text
    term_res = subprocess.run(
        [
            paradev_bin,
            "terminals",
            "read",
            "--local",
            "--workspace",
            ws_id,
            "--terminal",
            term_id,
            "--json",
        ],
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    if term_res.returncode != 0:
        raise RuntimeError(
            f"paradev terminals read failed ({term_res.returncode}): {term_res.stderr or term_res.stdout or read_res.stderr}"
        )
    raw_text = term_res.stdout
    try:
        parsed = json.loads(term_res.stdout)
        if isinstance(parsed, dict) and "text" in parsed:
            raw_text = str(parsed.get("text") or "")
    except Exception:
        pass
    if not raw_text.strip():
        raise RuntimeError(
            f"paradev agents read and terminals read returned no transcript: {read_res.stderr or read_res.stdout or term_res.stdout}"
        )
    return raw_text


def _agent_result(
    raw_text: str,
    ws_id: str,
    term_id: str,
    agent: str,
    role: str = "worker",
    worktree_path: Optional[str] = None,
) -> dict[str, Optional[str]]:
    if "\nAssistant:" in raw_text:
        summary = raw_text.rsplit("\nAssistant:", 1)[1].strip()
    elif raw_text.startswith("Assistant:"):
        summary = raw_text[len("Assistant:") :].strip()
    else:
        summary = raw_text.strip()
    summary += f"\n\n[paradev workspace_id={ws_id} terminal_id={term_id} role={role} agent={agent}]"
    return {
        "status": "succeeded",
        "result_summary": redact_secrets(summary),
        "pr_url": extract_pr_url(summary),
        "error": None,
        "workspace_id": ws_id,
        "terminal_id": term_id,
        "role": role,
        "agent": agent,
        "worktree_path": worktree_path,
    }


def _wait_agent_settled(
    paradev_bin: str, ws_id: str, term_id: str, timeout_sec: int
) -> None:
    wait_res = subprocess.run(
        [
            paradev_bin,
            "agents",
            "wait",
            "--local",
            "--workspace",
            ws_id,
            "--terminal",
            term_id,
            "--until",
            "settled",
            "--timeout",
            str(timeout_sec),
            "--json",
        ],
        capture_output=True,
        text=True,
        timeout=timeout_sec + 30,
        check=False,
    )
    if wait_res.returncode != 0:
        raise RuntimeError(
            f"paradev agents wait failed ({wait_res.returncode}): {wait_res.stderr or wait_res.stdout}"
        )


def default_paradev_runner(
    job: dict[str, Any],
    paradev_bin: str,
    dsh_bin: str = "/usr/local/bin/dsh",
    headless_patch: str = "/Users/chief/.mac-job-worker/headless.patch.yml",
    sessions_file: Optional[str] = None,
) -> dict[str, Optional[str]]:
    task = str(job["task"])
    timeout_sec = int(job.get("timeout_sec") or 900)
    repo_hint = str(job.get("repo") or "").strip()
    branch = str(job.get("branch") or "").strip()
    ws_id = str(job.get("workspace_id") or "").strip() or None
    term_id = str(job.get("terminal_id") or "").strip() or None
    agent = str(job.get("agent") or "codex").strip() or "codex"
    cwd = str(job.get("cwd") or "").strip() or None
    local_only = bool(job.get("local_only"))
    role = str(job.get("role") or "worker").strip().lower() or "worker"

    if cwd and not is_authorized_local_path(cwd, paradev_bin):
        raise RuntimeError(f"Unauthorized local path: {cwd}")

    ws_info = None
    if ws_id and ws_id != "local":
        ws_info = _get_workspace_info(paradev_bin, ws_id=ws_id)
        wt_path = str((ws_info or {}).get("worktreePath") or "").strip()
        if wt_path:
            if not is_authorized_local_path(wt_path, paradev_bin):
                raise RuntimeError(f"Unauthorized local path: {wt_path}")
        elif "MAC_WORKER_ALLOWED_ROOTS" in os.environ:
            raise RuntimeError(
                f"Workspace worktree path could not be verified under strict roots: {ws_id}"
            )

    if agent == "dsbot":
        worktree_path: Optional[str] = None
        if ws_id:
            if ws_info:
                worktree_path = (
                    ws_info.get("worktreePath")
                    or ws_info.get("worktree_path")
                    or ws_info.get("path")
                )
        elif repo_hint or cwd:
            proj, _ = ensure_paradev_project(
                repo_hint or (cwd or ""),
                paradev_bin,
                local_only=local_only,
                cwd=cwd,
            )
            if proj is not None:
                ws = _get_workspace_info(
                    paradev_bin, project_id=proj.get("id"), branch=branch or None
                )
                if ws:
                    ws_id = ws.get("id") or ws_id
                    worktree_path = (
                        ws.get("worktreePath")
                        or ws.get("worktree_path")
                        or ws.get("path")
                    )
                else:
                    worktree_path = proj.get("path") or cwd
        if not worktree_path:
            worktree_path = cwd or "/Users/chief/.gemini/antigravity/scratch"
        res = default_dsbot_runner(
            {**job, "cwd": worktree_path, "workspace_id": ws_id},
            dsh_bin,
            headless_patch,
        )
        summary = res.get("result_summary") or ""
        summary += f"\n\n[paradev workspace_id={ws_id or 'local'} terminal_id=dsbot-headless role={role} agent=dsbot]"
        res.update(
            {
                "result_summary": summary,
                "workspace_id": ws_id,
                "terminal_id": "dsbot-headless",
                "role": role,
                "agent": "dsbot",
                "worktree_path": worktree_path,
            }
        )
        return res

    sessions_path = (
        sessions_file
        or os.environ.get("PARADEV_SESSIONS_FILE")
        or os.path.join(
            os.environ.get("WORKER_STATE_DIR", "/Users/chief/.mac-job-worker/state"),
            "paradev_sessions.json",
        )
    ).strip()
    store = ParadevSessionStore(sessions_path) if sessions_path else None
    session_key = paradev_session_key(
        repo=repo_hint, cwd=cwd, workspace_id=ws_id, branch=branch
    )
    saved_entry: Optional[dict[str, Any]] = None

    if store is not None:
        if not ws_id:
            saved_entry = store.get(session_key)
            saved_ws = str((saved_entry or {}).get("workspace_id") or "").strip()
            if saved_ws and _get_workspace_info(paradev_bin, ws_id=saved_ws) is not None:
                ws_id = saved_ws
        if ws_id and not term_id:
            if saved_entry is None or str(
                saved_entry.get("workspace_id") or ""
            ) != ws_id:
                by_ws = store.find_by_workspace(ws_id)
                if by_ws is not None:
                    saved_entry = by_ws
            if saved_entry is not None:
                saved_term = str(
                    saved_entry.get(f"{role}_terminal_id") or ""
                ).strip()
                if saved_term and _is_terminal_alive(paradev_bin, ws_id, saved_term):
                    term_id = saved_term

    if store is not None and saved_entry is None and ws_id:
        saved_entry = store.find_by_workspace(ws_id)

    def _persist_session(
        ws: Optional[str], term: Optional[str], worktree: Optional[str] = None
    ) -> None:
        if store is None or not ws:
            return
        try:
            entry = dict(saved_entry or {})
            existing_ws = entry.get("workspace_id")
            if existing_ws and str(existing_ws) != str(ws):
                for stale in (
                    "worker_terminal_id",
                    "reviewer_terminal_id",
                    "worktree_path",
                ):
                    entry.pop(stale, None)
            entry["workspace_id"] = ws
            entry["agent"] = agent
            entry["updated_at"] = time.time()
            if worktree:
                entry["worktree_path"] = worktree
            if term:
                term_key = (
                    "worker_terminal_id"
                    if role == "worker"
                    else "reviewer_terminal_id"
                )
                if term == "dsbot-headless":
                    entry.setdefault(term_key, term)
                else:
                    entry[term_key] = term
            store.upsert(session_key, entry)
        except Exception:
            pass

    if ws_id and term_id:
        send_res = subprocess.run(
            [
                paradev_bin,
                "terminals",
                "send",
                "--local",
                "--workspace",
                ws_id,
                "--terminal",
                term_id,
                "--text",
                task,
                "--wait",
                "--until",
                "settled",
                "--timeout",
                str(timeout_sec),
                "--json",
            ],
            capture_output=True,
            text=True,
            timeout=timeout_sec + 30,
            check=False,
        )
        if send_res.returncode != 0:
            raise RuntimeError(
                f"paradev terminals send failed ({send_res.returncode}): {send_res.stderr or send_res.stdout}"
            )
        _persist_session(ws_id, term_id)
        raw_text = _read_agent_output(paradev_bin, ws_id, term_id)
        return _agent_result(raw_text, ws_id, term_id, agent, role=role)

    if ws_id:
        create_res = subprocess.run(
            [
                paradev_bin,
                "agents",
                "create",
                "--local",
                "--workspace",
                ws_id,
                "--agent",
                agent,
                "--prompt",
                task,
                "--json",
            ],
            capture_output=True,
            text=True,
            timeout=90,
            check=False,
        )
        if create_res.returncode != 0:
            raise RuntimeError(
                f"paradev agents create failed ({create_res.returncode}): {create_res.stderr or create_res.stdout}"
            )
        info = json.loads(create_res.stdout)
        term_id = (
            info.get("sessionId")
            or info.get("terminalId")
            or info.get("id")
            or (info.get("agents") or [{}])[0].get("sessionId")
        )
        if not term_id:
            raise RuntimeError(
                f"paradev agents create returned no terminal id: {create_res.stdout}"
            )
        term_id = str(term_id)
        _persist_session(ws_id, term_id)
        _wait_agent_settled(paradev_bin, ws_id, term_id, timeout_sec)
        raw_text = _read_agent_output(paradev_bin, ws_id, term_id)
        return _agent_result(raw_text, ws_id, term_id, agent, role=role)

    project_id = None
    if repo_hint or cwd:
        proj, _ = ensure_paradev_project(
            repo_hint or (cwd or ""),
            paradev_bin,
            local_only=local_only,
            cwd=cwd,
        )
        if proj is not None:
            project_id = proj.get("id")

    create_cmd = [
        paradev_bin,
        "ws",
        "create",
        "--local",
        "--agent",
        agent,
        "--prompt",
        task,
        "--json",
    ]
    is_session = project_id is None
    if is_session:
        create_cmd.append("--session")
    else:
        create_cmd.extend(["--project", project_id])
        if branch:
            create_cmd.extend(["--branch", branch])
        else:
            create_cmd.extend(["--checkout", "local"])

    created = subprocess.run(
        create_cmd,
        capture_output=True,
        text=True,
        timeout=90,
        check=False,
    )
    if created.returncode != 0:
        raise RuntimeError(
            f"paradev ws create failed ({created.returncode}): {created.stderr or created.stdout}"
        )

    info = json.loads(created.stdout)
    ws_id = info["workspace"]["id"]
    agents = info.get("agents") or []
    if not agents or not agents[0].get("sessionId"):
        raise RuntimeError(f"paradev ws create returned no agent terminal: {created.stdout}")
    term_id = agents[0]["sessionId"]
    worktree = (info.get("workspace") or {}).get("worktreePath")
    _persist_session(ws_id, term_id, worktree=worktree)

    try:
        _wait_agent_settled(paradev_bin, ws_id, term_id, timeout_sec)
        raw_text = _read_agent_output(paradev_bin, ws_id, term_id)
        return _agent_result(
            raw_text, ws_id, term_id, agent, role=role, worktree_path=worktree
        )
    finally:
        if is_session:
            subprocess.run(
                [paradev_bin, "ws", "archive", "--local", ws_id, "--json"],
                capture_output=True,
                text=True,
                timeout=30,
                check=False,
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


def _current_branch_name(repo_path: str) -> Optional[str]:
    sym = _run_git(["symbolic-ref", "--quiet", "HEAD"], cwd=repo_path)
    if sym.returncode == 0:
        ref = sym.stdout.strip()
        if ref.startswith("refs/heads/"):
            return ref[len("refs/heads/"):]
        if ref:
            return ref
    br_res = _run_git(["rev-parse", "--abbrev-ref", "HEAD"], cwd=repo_path)
    if br_res.returncode == 0 and br_res.stdout.strip():
        return br_res.stdout.strip()
    return None


def _resolve_mac_repo_path(
    repo_hint: str, paradev_bin: str, parent_dir: str = "/Users/chief"
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

    if paradev_bin and os.path.exists(paradev_bin):
        proj = _find_paradev_project(raw, paradev_bin)
        if proj and proj.get("path") and os.path.isdir(str(proj["path"])):
            return str(proj["path"]), short_name or str(proj.get("name") or short_name)

    return os.path.join(parent_dir, short_name), short_name


def default_git_sync_runner(
    job: dict[str, Any],
    paradev_bin: str,
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

    repo_path, short_name = _resolve_mac_repo_path(repo_hint, paradev_bin, parent_dir=parent_dir)

    if not is_authorized_local_path(repo_path, paradev_bin, parent_dir=parent_dir):
        return {
            "status": "failed",
            "result_summary": "",
            "pr_url": None,
            "error": f"Unauthorized local path: {repo_path}",
        }

    if action == "pull":
        if not os.path.exists(os.path.join(repo_path, ".git")):
            clone_src = remote_hint
            if not clone_src and paradev_bin and os.path.exists(paradev_bin):
                proj, _ = ensure_paradev_project(repo_hint, paradev_bin, parent_dir=parent_dir)
                if proj and proj.get("path") and os.path.isdir(str(proj["path"])):
                    repo_path = str(proj["path"])
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
        if req_branch:
            _run_git(["fetch", "origin", req_branch], cwd=repo_path, timeout=90)

        st = _run_git(["status", "--porcelain"], cwd=repo_path)
        dirty = bool(st.stdout.strip())
        pulled = False
        dirty_skipped = False
        if req_branch:
            if dirty:
                dirty_skipped = True
            else:
                has_local_branch = (
                    _run_git(
                        ["show-ref", "--verify", "--quiet", f"refs/heads/{req_branch}"],
                        cwd=repo_path,
                    ).returncode
                    == 0
                )
                if has_local_branch:
                    co = _run_git(["checkout", req_branch], cwd=repo_path)
                else:
                    co = _run_git(
                        ["checkout", "-B", req_branch, f"origin/{req_branch}"],
                        cwd=repo_path,
                    )
                if co.returncode != 0:
                    return {
                        "status": "failed",
                        "result_summary": "",
                        "pr_url": None,
                        "error": redact_secrets(co.stderr or co.stdout or f"git checkout {req_branch} failed"),
                    }
                ff = _run_git(["pull", "--ff-only", "origin", req_branch], cwd=repo_path, timeout=90)
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
            "branch": _current_branch_name(repo_path) or (req_branch or None),
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

    cur_branch = _current_branch_name(repo_path) or "main"
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
        has_branch = (
            _run_git(
                ["show-ref", "--verify", "--quiet", f"refs/heads/{req_branch}"],
                cwd=repo_path,
            ).returncode
            == 0
        )
        if has_branch:
            co = _run_git(["checkout", req_branch], cwd=repo_path)
        else:
            co = _run_git(["checkout", "-B", req_branch], cwd=repo_path)
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
            [gh_bin, "repo", "create", short_name, "--private", "--source=.", "--remote=origin", "--push"],
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
    if not remote_created:
        push_res = _run_git(
            ["push", "-u", "origin", f"refs/heads/{active_branch}"],
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


def default_dsbot_runner(
    job: dict[str, Any], dsh_bin: str, headless_patch: str
) -> dict[str, Optional[str]]:
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
    env["PARADEV_WORKSPACE_ID"] = str(job.get("workspace_id") or "")
    env["PATH"] = os.pathsep.join(
        ["/Users/chief/.paradev/bin", env.get("PATH", "")]
    )
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
        paradev_runner: Callable[[dict[str, Any]], dict[str, Optional[str]]],
        dsbot_runner: Callable[[dict[str, Any]], dict[str, Optional[str]]],
        paradev_register_runner: Optional[
            Callable[[dict[str, Any]], dict[str, Optional[str]]]
        ] = None,
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
        self.paradev_runner = paradev_runner
        self.dsbot_runner = dsbot_runner
        self.paradev_register_runner = paradev_register_runner
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
                "capabilities": ["paradev", "dsbot", "git_sync"],
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
            if target == "paradev":
                res = self.paradev_runner(job)
            elif target == "paradev_register":
                if self.paradev_register_runner is None:
                    res = {
                        "status": "failed",
                        "result_summary": "",
                        "pr_url": None,
                        "error": "paradev_register_runner not configured",
                    }
                else:
                    res = self.paradev_register_runner(job)
            elif target == "dsbot":
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
                    "error": f"Unsupported target: {target}",
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
        flush_lock_dir = f"{spool_path}.flush.lock"
        _acquire_dir_lock(flush_lock_dir, timeout_sec=15.0, stale_sec=60.0)
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
            _release_dir_lock(flush_lock_dir)

    def poll_once(self) -> Optional[dict[str, Any]]:
        code, data = self.broker.post(
            "/v1/worker/claim",
            {
                "worker_id": self.worker_id,
                "hostname": self.hostname,
                "capabilities": ["paradev", "dsbot", "git_sync"],
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
    paradev_bin = os.environ.get("PARADEV_BIN", "/Users/chief/.paradev/bin/paradev")
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
    worker = MacJobWorker(
        broker=broker,
        worker_id=worker_id,
        state_dir=state_dir,
        paradev_runner=lambda job: default_paradev_runner(
            job, paradev_bin, dsh_bin=dsh_bin, headless_patch=headless_patch
        ),
        dsbot_runner=lambda job: default_dsbot_runner(job, dsh_bin, headless_patch),
        paradev_register_runner=lambda job: default_paradev_register_runner(
            job, paradev_bin
        ),
        git_sync_runner=lambda job: default_git_sync_runner(job, paradev_bin),
        heartbeat_interval=heartbeat_interval,
    )

    stop_event = threading.Event()

    def handle_sig(signum: int, _frame: Any) -> None:
        sys.stderr.write(f"[worker] received signal {signum}, shutting down\n")
        stop_event.set()
        tunnel.stop()

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


if __name__ == "__main__":
    main()
