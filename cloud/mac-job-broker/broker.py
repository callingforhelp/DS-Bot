#!/usr/bin/env python3
"""Durable Mac-task broker for AWS DS Bot -> Mac mini (SSM) dispatch."""

from __future__ import annotations

import hmac
import http.cookiejar
import json
import os
import re
import socket
import socketserver
import sqlite3
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler
from typing import Any, Callable, Optional

DEFAULT_LEASE_TTL_SEC = 120
DEFAULT_JOB_EXPIRY_SEC = 24 * 3600
WORKER_ONLINE_WINDOW_SEC = 75
SWEEP_INTERVAL_SEC = 15

SECRET_PATTERNS = [
    re.compile(r"\bsk-[A-Za-z0-9_-]{16,}\b"),
    re.compile(r"\bgh[pousr]_[A-Za-z0-9_]{20,}\b"),
    re.compile(r"\bAIza[0-9A-Za-z_-]{20,}\b"),
    re.compile(r"(?i)\b(bearer\s+)[A-Za-z0-9._~+/-]{16,}=*"),
    re.compile(r"(?i)\b(AKIA[0-9A-Z]{16})\b"),
]


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


class BrokerStore:
    def __init__(self, db_path: str) -> None:
        self.db_path = db_path
        db_dir = os.path.dirname(os.path.abspath(db_path))
        if db_dir:
            os.makedirs(db_dir, exist_ok=True)
        self._lock = threading.Lock()
        self.conn = sqlite3.connect(db_path, check_same_thread=False, timeout=30.0)
        self.conn.row_factory = sqlite3.Row
        with self._lock:
            self.conn.execute("PRAGMA journal_mode=WAL;")
            self.conn.execute("PRAGMA synchronous=NORMAL;")
            self.conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS jobs (
                    job_id TEXT PRIMARY KEY,
                    idempotency_key TEXT UNIQUE,
                    target TEXT NOT NULL,
                    task TEXT NOT NULL,
                    repo TEXT,
                    branch TEXT,
                    timeout_sec INTEGER NOT NULL,
                    aws_session_id TEXT NOT NULL,
                    status TEXT NOT NULL,
                    attempt INTEGER NOT NULL DEFAULT 0,
                    lease_expires_at REAL,
                    worker_id TEXT,
                    result_summary TEXT,
                    pr_url TEXT,
                    error TEXT,
                    delivery_state TEXT NOT NULL DEFAULT 'none',
                    delivery_attempts INTEGER NOT NULL DEFAULT 0,
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL,
                    expires_at REAL NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_jobs_status_created ON jobs(status, created_at);
                CREATE INDEX IF NOT EXISTS idx_jobs_delivery ON jobs(delivery_state, updated_at);
                CREATE TABLE IF NOT EXISTS worker_state (
                    worker_id TEXT PRIMARY KEY,
                    last_seen_at REAL NOT NULL,
                    hostname TEXT,
                    capabilities TEXT
                );
                CREATE TABLE IF NOT EXISTS bot_capability_grants (
                    bot_id TEXT PRIMARY KEY,
                    granted_at REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS decisions (
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
                CREATE INDEX IF NOT EXISTS idx_decisions_status_created ON decisions(status, created_at);
                CREATE TABLE IF NOT EXISTS paradev_sessions (
                    session_key TEXT PRIMARY KEY,
                    repo TEXT,
                    cwd TEXT,
                    branch TEXT,
                    workspace_id TEXT NOT NULL,
                    worktree_path TEXT,
                    worker_terminal_id TEXT,
                    reviewer_terminal_id TEXT,
                    agent TEXT,
                    last_job_id TEXT,
                    updated_at REAL NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_paradev_sessions_updated ON paradev_sessions(updated_at DESC);
                """
            )
            for col, col_type in [
                ("workspace_id", "TEXT"),
                ("terminal_id", "TEXT"),
                ("agent", "TEXT"),
                ("cwd", "TEXT"),
                ("local_only", "INTEGER NOT NULL DEFAULT 0"),
                ("role", "TEXT"),
                ("worktree_path", "TEXT"),
            ]:
                try:
                    self.conn.execute(f"ALTER TABLE jobs ADD COLUMN {col} {col_type}")
                except sqlite3.OperationalError:
                    pass
            self.conn.commit()

    def close(self) -> None:
        with self._lock:
            self.conn.close()

    @staticmethod
    def _row_to_dict(row: Optional[sqlite3.Row]) -> Optional[dict[str, Any]]:
        if row is None:
            return None
        d = dict(row)
        if d.get("capabilities"):
            try:
                d["capabilities"] = json.loads(d["capabilities"])
            except Exception:
                pass
        if "local_only" in d and d["local_only"] is not None:
            d["local_only"] = bool(d["local_only"])
        return d

    def is_mac_online(self, now: Optional[float] = None) -> tuple[bool, Optional[float]]:
        t = now if now is not None else time.time()
        with self._lock:
            row = self.conn.execute(
                "SELECT MAX(last_seen_at) AS last_seen FROM worker_state"
            ).fetchone()
        last_seen = row["last_seen"] if row and row["last_seen"] is not None else None
        online = last_seen is not None and (t - float(last_seen)) <= WORKER_ONLINE_WINDOW_SEC
        return online, last_seen

    def touch_worker(
        self, worker_id: str, hostname: str = "", capabilities: Optional[list[str]] = None
    ) -> None:
        now = time.time()
        caps_json = json.dumps(capabilities or [])
        with self._lock:
            self.conn.execute(
                """
                INSERT INTO worker_state (worker_id, last_seen_at, hostname, capabilities)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(worker_id) DO UPDATE SET
                    last_seen_at = excluded.last_seen_at,
                    hostname = excluded.hostname,
                    capabilities = excluded.capabilities
                """,
                (worker_id, now, hostname, caps_json),
            )
            self.conn.commit()

    def enqueue_job(self, payload: dict[str, Any]) -> tuple[dict[str, Any], bool]:
        target = str(payload.get("target") or "paradev").strip()
        if target not in ("paradev", "dsbot", "shell", "paradev_register", "git_sync"):
            raise ValueError("target must be one of: paradev, dsbot, shell, paradev_register, git_sync")
        task = str(payload.get("task") or "").strip()
        if not task:
            raise ValueError("task is required")
        aws_session_id = str(payload.get("aws_session_id") or "").strip()
        if not aws_session_id:
            raise ValueError("aws_session_id is required")
        timeout_sec = int(payload.get("timeout_sec") or 900)
        timeout_sec = max(30, min(timeout_sec, 7200))
        idem = payload.get("idempotency_key")
        idem_key = str(idem).strip() if idem else None
        repo = str(payload.get("repo") or "").strip() or None
        branch = str(payload.get("branch") or "").strip() or None
        workspace_id = str(payload.get("workspace_id") or "").strip() or None
        terminal_id = str(payload.get("terminal_id") or "").strip() or None
        agent = str(payload.get("agent") or "").strip() or None
        cwd = str(payload.get("cwd") or "").strip() or None
        local_only = 1 if payload.get("local_only") else 0
        role = str(payload.get("role") or "worker").strip().lower() or "worker"

        now = time.time()
        expires_at = now + DEFAULT_JOB_EXPIRY_SEC
        job_id = f"mac_{uuid.uuid4().hex[:12]}"

        with self._lock:
            if idem_key:
                existing = self.conn.execute(
                    "SELECT * FROM jobs WHERE idempotency_key = ?", (idem_key,)
                ).fetchone()
                if existing is not None:
                    return self._row_to_dict(existing), False
            self.conn.execute(
                """
                INSERT INTO jobs (
                    job_id, idempotency_key, target, task, repo, branch,
                    timeout_sec, aws_session_id, status, attempt,
                    workspace_id, terminal_id, agent, cwd, local_only, role,
                    created_at, updated_at, expires_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    job_id,
                    idem_key,
                    target,
                    redact_secrets(task),
                    repo,
                    branch,
                    timeout_sec,
                    aws_session_id,
                    workspace_id,
                    terminal_id,
                    agent,
                    cwd,
                    local_only,
                    role,
                    now,
                    now,
                    expires_at,
                ),
            )
            self.conn.commit()
            row = self.conn.execute(
                "SELECT * FROM jobs WHERE job_id = ?", (job_id,)
            ).fetchone()
        return self._row_to_dict(row), True

    def get_job(self, job_id: str) -> Optional[dict[str, Any]]:
        with self._lock:
            row = self.conn.execute(
                "SELECT * FROM jobs WHERE job_id = ?", (job_id,)
            ).fetchone()
        return self._row_to_dict(row)

    def list_jobs(self, limit: int = 20, status: Optional[str] = None) -> list[dict[str, Any]]:
        limit = max(1, min(int(limit), 100))
        with self._lock:
            if status:
                rows = self.conn.execute(
                    "SELECT * FROM jobs WHERE status = ? ORDER BY created_at DESC LIMIT ?",
                    (status, limit),
                ).fetchall()
            else:
                rows = self.conn.execute(
                    "SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?",
                    (limit,),
                ).fetchall()
        return [self._row_to_dict(r) for r in rows]

    def cancel_job(self, job_id: str) -> Optional[dict[str, Any]]:
        now = time.time()
        with self._lock:
            row = self.conn.execute(
                "SELECT * FROM jobs WHERE job_id = ?", (job_id,)
            ).fetchone()
            if row is None:
                return None
            if row["status"] in ("queued", "running", "lease_lost"):
                self.conn.execute(
                    """
                    UPDATE jobs
                    SET status = 'cancelled', updated_at = ?, lease_expires_at = NULL
                    WHERE job_id = ?
                    """,
                    (now, job_id),
                )
                self.conn.commit()
            row = self.conn.execute(
                "SELECT * FROM jobs WHERE job_id = ?", (job_id,)
            ).fetchone()
        return self._row_to_dict(row)

    def claim_next_job(
        self,
        worker_id: str,
        hostname: str = "",
        capabilities: Optional[list[str]] = None,
        lease_ttl_sec: int = DEFAULT_LEASE_TTL_SEC,
    ) -> Optional[dict[str, Any]]:
        self.touch_worker(worker_id, hostname, capabilities)
        now = time.time()
        lease_exp = now + lease_ttl_sec
        with self._lock:
            row = self.conn.execute(
                """
                SELECT * FROM jobs
                WHERE status = 'queued' AND expires_at > ?
                ORDER BY created_at ASC
                LIMIT 1
                """,
                (now,),
            ).fetchone()
            if row is None:
                return None
            cur = self.conn.execute(
                """
                UPDATE jobs
                SET status = 'running',
                    worker_id = ?,
                    attempt = attempt + 1,
                    lease_expires_at = ?,
                    updated_at = ?
                WHERE job_id = ? AND status = 'queued'
                """,
                (worker_id, lease_exp, now, row["job_id"]),
            )
            self.conn.commit()
            if cur.rowcount == 0:
                return None
            updated = self.conn.execute(
                "SELECT * FROM jobs WHERE job_id = ?", (row["job_id"],)
            ).fetchone()
        return self._row_to_dict(updated)

    def heartbeat(
        self,
        job_id: str,
        worker_id: str,
        lease_ttl_sec: int = DEFAULT_LEASE_TTL_SEC,
    ) -> tuple[bool, Optional[dict[str, Any]]]:
        self.touch_worker(worker_id)
        now = time.time()
        lease_exp = now + lease_ttl_sec
        with self._lock:
            row = self.conn.execute(
                "SELECT * FROM jobs WHERE job_id = ?", (job_id,)
            ).fetchone()
            if row is None:
                return False, None
            if row["status"] != "running" or row["worker_id"] != worker_id:
                return False, self._row_to_dict(row)
            self.conn.execute(
                """
                UPDATE jobs
                SET lease_expires_at = ?, updated_at = ?
                WHERE job_id = ? AND worker_id = ? AND status = 'running'
                """,
                (lease_exp, now, job_id, worker_id),
            )
            self.conn.commit()
            updated = self.conn.execute(
                "SELECT * FROM jobs WHERE job_id = ?", (job_id,)
            ).fetchone()
        return True, self._row_to_dict(updated)

    def complete_job(self, payload: dict[str, Any]) -> tuple[bool, Optional[dict[str, Any]]]:
        job_id = str(payload.get("job_id") or "").strip()
        worker_id = str(payload.get("worker_id") or "").strip()
        status = str(payload.get("status") or "").strip()
        if status not in ("succeeded", "failed"):
            raise ValueError("status must be succeeded or failed")
        self.touch_worker(worker_id)
        now = time.time()
        raw_summary = str(payload.get("result_summary") or "")
        clean_summary = redact_secrets(raw_summary)[:8000]
        error = payload.get("error")
        clean_error = redact_secrets(str(error))[:2000] if error else None
        pr_url = payload.get("pr_url")
        clean_pr = str(pr_url).strip() if pr_url else None
        workspace_id = str(payload.get("workspace_id") or "").strip() or None
        terminal_id = str(payload.get("terminal_id") or "").strip() or None
        role = str(payload.get("role") or "").strip().lower() or None
        agent = str(payload.get("agent") or "").strip() or None
        worktree_path = str(payload.get("worktree_path") or "").strip() or None

        # Fallback: parse [paradev workspace_id=... terminal_id=...] trailer
        trailer = re.search(r"\[paradev ([^\]]+)\]", raw_summary)
        if trailer:
            kv = dict(re.findall(r"(\w+)=(\S+)", trailer.group(1)))
            workspace_id = workspace_id or str(kv.get("workspace_id") or "").strip() or None
            terminal_id = terminal_id or str(kv.get("terminal_id") or "").strip() or None
            role = role or str(kv.get("role") or "").strip().lower() or None
            agent = agent or str(kv.get("agent") or "").strip() or None

        with self._lock:
            row = self.conn.execute(
                "SELECT * FROM jobs WHERE job_id = ?", (job_id,)
            ).fetchone()
            if row is None:
                return False, None
            # Idempotent re-delivery from same worker if already finished
            if row["status"] in ("succeeded", "failed") and row["worker_id"] == worker_id:
                self._record_paradev_session(
                    row, workspace_id, terminal_id, role, agent, worktree_path,
                    job_id, float(row["updated_at"]),
                )
                return True, self._row_to_dict(row)
            if row["status"] not in ("running", "lease_lost") or (
                row["worker_id"] and row["worker_id"] != worker_id
            ):
                return False, self._row_to_dict(row)
            self.conn.execute(
                """
                UPDATE jobs
                SET status = ?,
                    result_summary = ?,
                    pr_url = ?,
                    error = ?,
                    lease_expires_at = NULL,
                    delivery_state = 'pending',
                    workspace_id = COALESCE(?, workspace_id),
                    terminal_id = COALESCE(?, terminal_id),
                    role = COALESCE(?, role),
                    agent = COALESCE(?, agent),
                    worktree_path = COALESCE(?, worktree_path),
                    updated_at = ?
                WHERE job_id = ?
                """,
                (
                    status,
                    clean_summary,
                    clean_pr,
                    clean_error,
                    workspace_id,
                    terminal_id,
                    role,
                    agent,
                    worktree_path,
                    now,
                    job_id,
                ),
            )
            self.conn.commit()
            updated = self.conn.execute(
                "SELECT * FROM jobs WHERE job_id = ?", (job_id,)
            ).fetchone()
            if updated is not None:
                self._record_paradev_session(
                    updated, workspace_id, terminal_id, role, agent, worktree_path,
                    job_id, now,
                )
        return True, self._row_to_dict(updated)

    def _record_paradev_session(
        self,
        job: sqlite3.Row,
        workspace_id: Optional[str],
        terminal_id: Optional[str],
        role: Optional[str],
        agent: Optional[str],
        worktree_path: Optional[str],
        job_id: str,
        now: float,
    ) -> None:
        """Upsert paradev_sessions from a finished job. Caller must hold self._lock."""
        eff_ws = workspace_id or job["workspace_id"]
        if not eff_ws or eff_ws == "local":
            return
        eff_repo = job["repo"]
        eff_cwd = job["cwd"]
        eff_branch = job["branch"]
        eff_role = role or job["role"] or "worker"
        eff_terminal = terminal_id or job["terminal_id"]
        eff_agent = agent or job["agent"]
        eff_worktree = worktree_path or job["worktree_path"]
        existing = self.conn.execute(
            """
            SELECT session_key, repo, cwd, branch
            FROM paradev_sessions
            WHERE workspace_id = ?
            ORDER BY updated_at DESC
            LIMIT 1
            """,
            (eff_ws,),
        ).fetchone()
        if existing is not None:
            session_key = existing["session_key"]
            eff_repo = eff_repo or existing["repo"]
            eff_cwd = eff_cwd or existing["cwd"]
            eff_branch = eff_branch or existing["branch"]
        else:
            session_key = f"{eff_repo or eff_cwd or eff_ws}:{eff_branch or 'default'}"
        if eff_terminal == "dsbot-headless":
            eff_terminal = None
        worker_tid = eff_terminal if eff_role != "reviewer" else None
        reviewer_tid = eff_terminal if eff_role == "reviewer" else None
        self.conn.execute(
            """
            INSERT INTO paradev_sessions (
                session_key, repo, cwd, branch, workspace_id,
                worktree_path, worker_terminal_id, reviewer_terminal_id,
                agent, last_job_id, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(session_key) DO UPDATE SET
                repo = COALESCE(excluded.repo, paradev_sessions.repo),
                cwd = COALESCE(excluded.cwd, paradev_sessions.cwd),
                branch = COALESCE(excluded.branch, paradev_sessions.branch),
                workspace_id = excluded.workspace_id,
                worktree_path = CASE
                    WHEN paradev_sessions.workspace_id = excluded.workspace_id
                    THEN COALESCE(excluded.worktree_path, paradev_sessions.worktree_path)
                    ELSE excluded.worktree_path
                END,
                worker_terminal_id = CASE
                    WHEN paradev_sessions.workspace_id = excluded.workspace_id
                    THEN COALESCE(excluded.worker_terminal_id, paradev_sessions.worker_terminal_id)
                    ELSE excluded.worker_terminal_id
                END,
                reviewer_terminal_id = CASE
                    WHEN paradev_sessions.workspace_id = excluded.workspace_id
                    THEN COALESCE(excluded.reviewer_terminal_id, paradev_sessions.reviewer_terminal_id)
                    ELSE excluded.reviewer_terminal_id
                END,
                agent = COALESCE(excluded.agent, paradev_sessions.agent),
                last_job_id = excluded.last_job_id,
                updated_at = excluded.updated_at
            WHERE excluded.updated_at >= paradev_sessions.updated_at
            """,
            (
                session_key,
                eff_repo,
                eff_cwd,
                eff_branch,
                eff_ws,
                eff_worktree,
                worker_tid,
                reviewer_tid,
                eff_agent,
                job_id,
                now,
            ),
        )
        self.conn.commit()

    def reconcile_worker(
        self, worker_id: str, hostname: str = "", capabilities: Optional[list[str]] = None
    ) -> list[dict[str, Any]]:
        self.touch_worker(worker_id, hostname, capabilities)
        with self._lock:
            rows = self.conn.execute(
                """
                SELECT * FROM jobs
                WHERE worker_id = ? AND status IN ('running', 'lease_lost')
                ORDER BY updated_at DESC
                """,
                (worker_id,),
            ).fetchall()
        return [self._row_to_dict(r) for r in rows]

    def sweep(self, now: Optional[float] = None) -> dict[str, int]:
        t = now if now is not None else time.time()
        with self._lock:
            c1 = self.conn.execute(
                """
                UPDATE jobs
                SET status = 'lease_lost',
                    delivery_state = 'pending',
                    error = COALESCE(error, 'Worker lease expired before completion'),
                    updated_at = ?
                WHERE status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?
                """,
                (t, t),
            ).rowcount
            c2 = self.conn.execute(
                """
                UPDATE jobs
                SET status = 'expired',
                    delivery_state = 'pending',
                    error = COALESCE(error, 'Mac mini was offline past job TTL'),
                    updated_at = ?
                WHERE status = 'queued' AND expires_at < ?
                """,
                (t, t),
            ).rowcount
            self.conn.commit()
        return {"lease_lost": c1, "expired": c2}

    def pending_deliveries(self, max_attempts: int = 5) -> list[dict[str, Any]]:
        with self._lock:
            rows = self.conn.execute(
                """
                SELECT * FROM jobs
                WHERE delivery_state = 'pending' AND delivery_attempts < ?
                ORDER BY updated_at ASC
                LIMIT 20
                """,
                (max_attempts,),
            ).fetchall()
        return [self._row_to_dict(r) for r in rows]

    def mark_delivery(self, job_id: str, delivered: bool) -> None:
        now = time.time()
        with self._lock:
            if delivered:
                self.conn.execute(
                    """
                    UPDATE jobs
                    SET delivery_state = 'delivered',
                        delivery_attempts = delivery_attempts + 1,
                        updated_at = ?
                    WHERE job_id = ?
                    """,
                    (now, job_id),
                )
            else:
                self.conn.execute(
                    """
                    UPDATE jobs
                    SET delivery_attempts = delivery_attempts + 1,
                        updated_at = ?
                    WHERE job_id = ?
                    """,
                    (now, job_id),
                )
            self.conn.commit()

    def stats(self) -> dict[str, int]:
        with self._lock:
            rows = self.conn.execute(
                "SELECT status, COUNT(*) AS cnt FROM jobs GROUP BY status"
            ).fetchall()
        return {r["status"]: r["cnt"] for r in rows}

    def list_paradev_sessions(self, limit: int = 20) -> list[dict[str, Any]]:
        limit = max(1, min(int(limit), 200))
        with self._lock:
            rows = self.conn.execute(
                "SELECT * FROM paradev_sessions ORDER BY updated_at DESC LIMIT ?",
                (limit,),
            ).fetchall()
        return [dict(r) for r in rows]

    def _decision_to_dict(self, row: Optional[sqlite3.Row]) -> Optional[dict[str, Any]]:
        if row is None:
            return None
        d = dict(row)
        if isinstance(d.get("options"), str):
            try:
                d["options"] = json.loads(d["options"])
            except Exception:
                d["options"] = []
        return d

    def create_decision(self, payload: dict[str, Any]) -> tuple[dict[str, Any], bool]:
        title = redact_secrets(str(payload.get("title") or "").strip())[:300]
        if not title:
            raise ValueError("title is required")
        context = redact_secrets(str(payload.get("context") or "").strip())[:8000]
        raw_opts = payload.get("options")
        options = [redact_secrets(str(o).strip())[:300] for o in raw_opts] if isinstance(raw_opts, list) else []
        source_env = str(payload.get("source_env") or "aws").strip()
        if source_env not in ("aws", "mac"):
            source_env = "aws"
        source_room = str(payload.get("source_room") or "").strip() or None
        source_bot = str(payload.get("source_bot") or "").strip() or None
        aws_session_id = str(payload.get("aws_session_id") or "").strip() or None
        idem = payload.get("idempotency_key")
        idem_key = str(idem).strip() if idem else None

        now = time.time()
        decision_id = f"dec_{uuid.uuid4().hex[:10]}"
        with self._lock:
            if idem_key:
                existing = self.conn.execute(
                    "SELECT * FROM decisions WHERE idempotency_key = ?", (idem_key,)
                ).fetchone()
                if existing is not None:
                    return self._decision_to_dict(existing), False
            self.conn.execute(
                """
                INSERT INTO decisions (
                    decision_id, idempotency_key, title, context, options,
                    source_env, source_room, source_bot, aws_session_id,
                    status, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
                """,
                (
                    decision_id,
                    idem_key,
                    title,
                    context,
                    json.dumps(options),
                    source_env,
                    source_room,
                    source_bot,
                    aws_session_id,
                    now,
                    now,
                ),
            )
            self.conn.commit()
            row = self.conn.execute(
                "SELECT * FROM decisions WHERE decision_id = ?", (decision_id,)
            ).fetchone()
        return self._decision_to_dict(row), True

    def get_decision(self, decision_id: str) -> Optional[dict[str, Any]]:
        with self._lock:
            row = self.conn.execute(
                "SELECT * FROM decisions WHERE decision_id = ?", (decision_id,)
            ).fetchone()
        return self._decision_to_dict(row)

    def list_decisions(
        self, status: Optional[str] = None, limit: int = 50
    ) -> list[dict[str, Any]]:
        limit = max(1, min(int(limit), 200))
        with self._lock:
            if status in ("pending", "resolved"):
                rows = self.conn.execute(
                    "SELECT * FROM decisions WHERE status = ? ORDER BY created_at DESC LIMIT ?",
                    (status, limit),
                ).fetchall()
            else:
                rows = self.conn.execute(
                    "SELECT * FROM decisions ORDER BY created_at DESC LIMIT ?",
                    (limit,),
                ).fetchall()
        return [self._decision_to_dict(r) for r in rows]

    def resolve_decision(
        self,
        decision_id: str,
        choice: str,
        note: str = "",
        resolved_by: str = "user",
    ) -> Optional[dict[str, Any]]:
        clean_choice = redact_secrets(str(choice or "").strip())[:500]
        if not clean_choice:
            raise ValueError("choice is required")
        clean_note = redact_secrets(str(note or "").strip())[:4000]
        now = time.time()
        with self._lock:
            row = self.conn.execute(
                "SELECT * FROM decisions WHERE decision_id = ?", (decision_id,)
            ).fetchone()
            if row is None:
                return None
            self.conn.execute(
                """
                UPDATE decisions
                SET status = 'resolved',
                    choice = ?,
                    note = ?,
                    resolved_by = ?,
                    resolved_at = ?,
                    updated_at = ?
                WHERE decision_id = ?
                """,
                (clean_choice, clean_note, resolved_by, now, now, decision_id),
            )
            self.conn.commit()
            updated = self.conn.execute(
                "SELECT * FROM decisions WHERE decision_id = ?", (decision_id,)
            ).fetchone()
        return self._decision_to_dict(updated)

    def ungranted_bot_ids(self, bot_ids: list[str]) -> list[str]:
        if not bot_ids:
            return []
        with self._lock:
            rows = self.conn.execute(
                "SELECT bot_id FROM bot_capability_grants"
            ).fetchall()
        granted = {r["bot_id"] for r in rows}
        return [bid for bid in bot_ids if bid not in granted]

    def mark_bot_granted(self, bot_id: str) -> None:
        now = time.time()
        with self._lock:
            self.conn.execute(
                """
                INSERT INTO bot_capability_grants (bot_id, granted_at)
                VALUES (?, ?)
                ON CONFLICT(bot_id) DO NOTHING
                """,
                (bot_id, now),
            )
            self.conn.commit()


class DsBotCallbackClient:
    """Delivers [MAC_JOB_RESULT ...] messages back into AWS ds-bot via /api/bot."""

    def __init__(
        self,
        base_url: str = "http://127.0.0.1:13080",
        container_name: str = "ds-bot",
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.container_name = container_name
        self._jar = http.cookiejar.CookieJar()
        self._opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self._jar)
        )
        self._lock = threading.Lock()
        self._authed = False

    def _fetch_launch_token(self) -> Optional[str]:
        res = subprocess.run(
            ["docker", "logs", self.container_name],
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
        combined = (res.stdout or "") + "\n" + (res.stderr or "")
        matches = re.findall(r"dsh web:.*?token=([A-Za-z0-9._~-]+)", combined)
        return matches[-1] if matches else None

    def _authenticate(self) -> bool:
        tok = self._fetch_launch_token()
        if not tok:
            return False
        url = f"{self.base_url}/?token={urllib.parse.quote(tok, safe='')}"
        req = urllib.request.Request(url, method="GET")
        try:
            with self._opener.open(req, timeout=10) as resp:
                resp.read()
            self._authed = True
            return True
        except urllib.error.HTTPError as exc:
            if exc.code in (200, 302, 303):
                self._authed = True
                return True
            return False
        except Exception:
            return False

    def post_bot_api(
        self, endpoint: str, payload: Optional[dict[str, Any]] = None
    ) -> Optional[dict[str, Any]]:
        body_obj: dict[str, Any] = {"endpoint": endpoint}
        if payload is not None:
            body_obj["payload"] = payload
        raw = json.dumps(body_obj).encode("utf-8")

        with self._lock:
            for attempt in range(2):
                if not self._authed and not self._authenticate():
                    return None
                req = urllib.request.Request(
                    f"{self.base_url}/api/bot",
                    data=raw,
                    method="POST",
                    headers={"Content-Type": "application/json"},
                )
                try:
                    with self._opener.open(req, timeout=15) as resp:
                        return json.loads(resp.read().decode("utf-8"))
                except urllib.error.HTTPError as exc:
                    if exc.code == 401 and attempt == 0:
                        self._authed = False
                        continue
                    return None
                except Exception:
                    return None
        return None

    def send_result(self, job: dict[str, Any]) -> bool:
        parts = [
            f"job_id={job['job_id']}",
            f"status={job['status']}",
            f"target={job['target']}",
        ]
        if job.get("workspace_id") or job.get("terminal_id"):
            if job.get("workspace_id"):
                parts.append(f"workspace_id={job['workspace_id']}")
            if job.get("terminal_id"):
                parts.append(f"terminal_id={job['terminal_id']}")
            parts.append(f"role={job.get('role') or 'worker'}")
        lines = [f"[MAC_JOB_RESULT {' '.join(parts)}]"]
        if job.get("pr_url"):
            lines.append(f"PR: {job['pr_url']}")
        if job.get("result_summary"):
            lines.append(f"Summary:\n{job['result_summary']}")
        if job.get("error"):
            lines.append(f"Error: {job['error']}")
        lines.append(
            "Note: Summarize this Mac job result for the user. Do not enqueue another Mac job unless the user asks."
        )
        text = "\n".join(lines)
        resp = self.post_bot_api(
            "send",
            {"sessionId": job["aws_session_id"], "text": text},
        )
        return bool(resp and resp.get("ok", True))


DEFAULT_INHERITED_CAPS = ("mac-bridge", "mac-dispatch-routing")


def sync_new_bot_capabilities(
    store: BrokerStore,
    client: Any,
    state_path: str,
    caps: tuple[str, ...] = DEFAULT_INHERITED_CAPS,
) -> int:
    """Attach shared Mac bridge capabilities once to any newly created ds-bot Bot."""
    if not state_path or not os.path.exists(state_path):
        return 0
    try:
        with open(state_path, "r", encoding="utf-8") as f:
            state = json.load(f)
    except Exception:
        return 0

    items = (state.get("capabilities") or {}).get("items") or {}
    available = [c for c in caps if c in items]
    if not available:
        return 0

    bots = state.get("bots") or {}
    new_ids = store.ungranted_bot_ids(list(bots.keys()))
    granted_count = 0
    for bid in new_ids:
        bot = bots.get(bid) or {}
        existing = set(bot.get("capabilities") or [])
        all_ok = True
        for cap in available:
            if cap not in existing:
                resp = client.post_bot_api(
                    "bot-capability",
                    {"botId": bid, "name": cap, "attached": True},
                )
                if not resp or not resp.get("ok"):
                    all_ok = False
                    break
        if all_ok:
            store.mark_bot_granted(bid)
            granted_count += 1
    return granted_count


def make_handler(
    store: BrokerStore,
    producer_token: str,
    worker_token: str,
    deliver_fn: Optional[Callable[[dict[str, Any]], None]] = None,
):
    class BrokerHandler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt: str, *args: Any) -> None:
            sys.stderr.write(f"[broker] {fmt % args}\n")

        def _send_json(self, code: int, obj: Any) -> None:
            body = json.dumps(obj).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _read_json(self) -> dict[str, Any]:
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0:
                return {}
            if length > 1024 * 1024:
                raise ValueError("payload too large")
            raw = self.rfile.read(length)
            data = json.loads(raw.decode("utf-8"))
            if not isinstance(data, dict):
                raise ValueError("JSON object expected")
            return data

        def _check_auth(self, *expected_tokens: str) -> bool:
            auth = self.headers.get("Authorization") or ""
            if not auth.startswith("Bearer "):
                self._send_json(401, {"ok": False, "error": "unauthorized"})
                return False
            supplied = auth[7:].strip()
            if not any(tok and hmac.compare_digest(supplied, tok) for tok in expected_tokens):
                self._send_json(403, {"ok": False, "error": "forbidden"})
                return False
            return True

        def do_GET(self) -> None:
            parsed = urllib.parse.urlparse(self.path)
            path = parsed.path
            qs = urllib.parse.parse_qs(parsed.query)

            if path == "/healthz":
                online, last_seen = store.is_mac_online()
                self._send_json(
                    200,
                    {
                        "ok": True,
                        "mac_online": online,
                        "last_worker_seen_at": last_seen,
                        "counts": store.stats(),
                    },
                )
                return

            if path == "/v1/jobs":
                if not self._check_auth(producer_token):
                    return
                limit = int((qs.get("limit") or ["20"])[0])
                status = (qs.get("status") or [None])[0]
                online, last_seen = store.is_mac_online()
                self._send_json(
                    200,
                    {
                        "ok": True,
                        "mac_online": online,
                        "last_worker_seen_at": last_seen,
                        "jobs": store.list_jobs(limit=limit, status=status),
                    },
                )
                return

            if path.startswith("/v1/jobs/"):
                if not self._check_auth(producer_token):
                    return
                job_id = path[len("/v1/jobs/") :].strip("/")
                job = store.get_job(job_id)
                if job is None:
                    self._send_json(404, {"ok": False, "error": "not_found"})
                    return
                online, _ = store.is_mac_online()
                self._send_json(200, {"ok": True, "mac_online": online, "job": job})
                return

            if path == "/v1/paradev/sessions":
                if not self._check_auth(producer_token, worker_token):
                    return
                limit = int((qs.get("limit") or ["20"])[0])
                self._send_json(
                    200,
                    {"ok": True, "sessions": store.list_paradev_sessions(limit=limit)},
                )
                return

            if path == "/v1/decisions":
                if not self._check_auth(producer_token, worker_token):
                    return
                limit = int((qs.get("limit") or ["50"])[0])
                status = (qs.get("status") or [None])[0]
                self._send_json(
                    200,
                    {"ok": True, "decisions": store.list_decisions(status=status, limit=limit)},
                )
                return

            if path.startswith("/v1/decisions/"):
                if not self._check_auth(producer_token, worker_token):
                    return
                dec_id = path[len("/v1/decisions/") :].strip("/")
                dec = store.get_decision(dec_id)
                if dec is None:
                    self._send_json(404, {"ok": False, "error": "not_found"})
                    return
                self._send_json(200, {"ok": True, "decision": dec})
                return

            self._send_json(404, {"ok": False, "error": "not_found"})

        def do_POST(self) -> None:
            parsed = urllib.parse.urlparse(self.path)
            path = parsed.path
            try:
                body = self._read_json()
            except Exception as exc:
                self._send_json(400, {"ok": False, "error": str(exc)})
                return

            if path == "/v1/jobs":
                if not self._check_auth(producer_token):
                    return
                try:
                    job, created = store.enqueue_job(body)
                except ValueError as exc:
                    self._send_json(400, {"ok": False, "error": str(exc)})
                    return
                online, _ = store.is_mac_online()
                self._send_json(
                    201 if created else 200,
                    {"ok": True, "created": created, "mac_online": online, "job": job},
                )
                return

            if path.startswith("/v1/jobs/") and path.endswith("/cancel"):
                if not self._check_auth(producer_token):
                    return
                job_id = path[len("/v1/jobs/") : -len("/cancel")].strip("/")
                job = store.cancel_job(job_id)
                if job is None:
                    self._send_json(404, {"ok": False, "error": "not_found"})
                    return
                self._send_json(200, {"ok": True, "job": job})
                return

            if path == "/v1/worker/claim":
                if not self._check_auth(worker_token):
                    return
                worker_id = str(body.get("worker_id") or "").strip()
                if not worker_id:
                    self._send_json(400, {"ok": False, "error": "worker_id is required"})
                    return
                job = store.claim_next_job(
                    worker_id=worker_id,
                    hostname=str(body.get("hostname") or ""),
                    capabilities=body.get("capabilities") or [],
                )
                self._send_json(200, {"ok": True, "job": job})
                return

            if path == "/v1/worker/reconcile":
                if not self._check_auth(worker_token):
                    return
                worker_id = str(body.get("worker_id") or "").strip()
                if not worker_id:
                    self._send_json(400, {"ok": False, "error": "worker_id is required"})
                    return
                jobs = store.reconcile_worker(
                    worker_id=worker_id,
                    hostname=str(body.get("hostname") or ""),
                    capabilities=body.get("capabilities") or [],
                )
                self._send_json(200, {"ok": True, "jobs": jobs})
                return

            if path == "/v1/worker/heartbeat":
                if not self._check_auth(worker_token):
                    return
                job_id = str(body.get("job_id") or "").strip()
                worker_id = str(body.get("worker_id") or "").strip()
                if not job_id or not worker_id:
                    self._send_json(
                        400, {"ok": False, "error": "job_id and worker_id are required"}
                    )
                    return
                ok_hb, job = store.heartbeat(job_id, worker_id)
                if job is None:
                    self._send_json(404, {"ok": False, "error": "not_found"})
                    return
                self._send_json(200, {"ok": ok_hb, "job": job})
                return

            if path == "/v1/worker/complete":
                if not self._check_auth(worker_token):
                    return
                job_id = str(body.get("job_id") or "").strip()
                worker_id = str(body.get("worker_id") or "").strip()
                status = str(body.get("status") or "").strip()
                if not job_id or not worker_id or not status:
                    self._send_json(
                        400,
                        {"ok": False, "error": "job_id, worker_id, status are required"},
                    )
                    return
                try:
                    ok_done, job = store.complete_job(body)
                except ValueError as exc:
                    self._send_json(400, {"ok": False, "error": str(exc)})
                    return
                if job is None:
                    self._send_json(404, {"ok": False, "error": "not_found"})
                    return
                if ok_done and deliver_fn is not None and job.get("delivery_state") == "pending":
                    threading.Thread(
                        target=deliver_fn, args=(job,), daemon=True
                    ).start()
                self._send_json(200 if ok_done else 409, {"ok": ok_done, "job": job})
                return

            if path == "/v1/decisions":
                if not self._check_auth(producer_token, worker_token):
                    return
                try:
                    dec, created = store.create_decision(body)
                except ValueError as exc:
                    self._send_json(400, {"ok": False, "error": str(exc)})
                    return
                self._send_json(201 if created else 200, {"ok": True, "created": created, "decision": dec})
                return

            if path.startswith("/v1/decisions/") and path.endswith("/resolve"):
                if not self._check_auth(producer_token, worker_token):
                    return
                dec_id = path[len("/v1/decisions/") : -len("/resolve")].strip("/")
                try:
                    dec = store.resolve_decision(
                        dec_id,
                        choice=str(body.get("choice") or ""),
                        note=str(body.get("note") or ""),
                        resolved_by=str(body.get("resolved_by") or "user"),
                    )
                except ValueError as exc:
                    self._send_json(400, {"ok": False, "error": str(exc)})
                    return
                if dec is None:
                    self._send_json(404, {"ok": False, "error": "not_found"})
                    return
                self._send_json(200, {"ok": True, "decision": dec})
                return

            self._send_json(404, {"ok": False, "error": "not_found"})

    return BrokerHandler


class ThreadingHTTPServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    allow_reuse_address = True
    daemon_threads = True


class ThreadingUnixStreamServer(
    socketserver.ThreadingMixIn, socketserver.UnixStreamServer
):
    daemon_threads = True

    def server_bind(self) -> None:
        if os.path.exists(self.server_address):
            os.unlink(self.server_address)
        super().server_bind()


def run_server() -> None:
    db_path = os.environ.get("BROKER_DB_PATH", "/var/lib/mac-job-broker/jobs.db")
    host = os.environ.get("BROKER_HOST", "127.0.0.1")
    port = int(os.environ.get("BROKER_PORT", "13090"))
    unix_sock = os.environ.get("BROKER_UNIX_SOCK", "/opt/ds-bot/dsbot/data/mac-broker.sock")
    producer_token = os.environ.get("BROKER_PRODUCER_TOKEN", "")
    worker_token = os.environ.get("BROKER_WORKER_TOKEN", "")
    dsbot_url = os.environ.get("DSBOT_URL", "http://127.0.0.1:13080")
    dsbot_container = os.environ.get("DSBOT_CONTAINER", "ds-bot")
    dsbot_state_path = os.environ.get("DSBOT_STATE_PATH", "/opt/ds-bot/dsbot/data/bot/state.json")

    if not producer_token or not worker_token:
        raise SystemExit("BROKER_PRODUCER_TOKEN and BROKER_WORKER_TOKEN must be set")

    store = BrokerStore(db_path)
    callback = DsBotCallbackClient(base_url=dsbot_url, container_name=dsbot_container)

    def deliver_one(job: dict[str, Any]) -> None:
        ok_sent = callback.send_result(job)
        store.mark_delivery(job["job_id"], ok_sent)

    handler_cls = make_handler(
        store, producer_token, worker_token, deliver_fn=deliver_one
    )

    tcp_server = ThreadingHTTPServer((host, port), handler_cls)
    unix_server: Optional[ThreadingUnixStreamServer] = None
    if unix_sock:
        unix_server = ThreadingUnixStreamServer(unix_sock, handler_cls)
        uid = int(os.environ.get("BROKER_SOCK_UID", "1000"))
        gid = int(os.environ.get("BROKER_SOCK_GID", "1000"))
        try:
            os.chown(unix_sock, uid, gid)
            os.chmod(unix_sock, 0o660)
        except PermissionError:
            os.chmod(unix_sock, 0o660)
        threading.Thread(target=unix_server.serve_forever, daemon=True).start()

    def sweeper_loop() -> None:
        while True:
            try:
                store.sweep()
                for job in store.pending_deliveries():
                    deliver_one(job)
                sync_new_bot_capabilities(store, callback, dsbot_state_path)
            except Exception as exc:
                sys.stderr.write(f"[broker] sweeper error: {exc}\n")
            time.sleep(SWEEP_INTERVAL_SEC)

    threading.Thread(target=sweeper_loop, daemon=True).start()
    sys.stderr.write(
        f"[broker] listening tcp={host}:{port} unix={unix_sock or 'disabled'}\n"
    )
    try:
        tcp_server.serve_forever()
    finally:
        tcp_server.shutdown()
        if unix_server is not None:
            unix_server.shutdown()
        store.close()


if __name__ == "__main__":
    run_server()
