#!/usr/bin/env python3
"""Stateless thin Slack Socket Mode router with Mac priority and EC2 /cloud fallback."""

from __future__ import annotations

import argparse
import http.cookiejar
import json
import os
import re
import signal
import socket
import sqlite3
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

from ws_client import SimpleWebSocket, WebSocketError

SECRET_PATTERNS = [
    re.compile(r"\bsk-[A-Za-z0-9_-]{16,}\b"),
    re.compile(r"\bgh[pousr]_[A-Za-z0-9_]{20,}\b"),
    re.compile(r"\bAIza[0-9A-Za-z_-]{20,}\b"),
    re.compile(r"\bx(?:app|oxb|oxp|oxa)-[A-Za-z0-9-]{16,}\b"),
    re.compile(r"(?i)\b(bearer\s+)[A-Za-z0-9._~+/-]{16,}=*"),
    re.compile(r"(?i)\b(AKIA[0-9A-Z]{16})\b"),
]

_LOCAL_PATH_PATTERNS = [
    re.compile(r"(?:^|[\s'\"`(\[])(?:/Users/|~/|file:///Users/)"),
    re.compile(r"\b(?:Desktop|Downloads)\b", re.IGNORECASE),
    re.compile(r"\.(?:step|stp|stl|fcstd|kicad_pcb|kicad_sch|f3d)\b", re.IGNORECASE),
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


def has_local_only_path(text: str) -> bool:
    if not text:
        return False
    return any(p.search(text) for p in _LOCAL_PATH_PATTERNS)


def markdown_to_mrkdwn(text: str) -> str:
    raw = str(text or "")
    parts = re.split(r"(```[\s\S]*?```)", raw)
    out: list[str] = []
    for idx, part in enumerate(parts):
        if idx % 2 == 1:
            out.append(part)
            continue
        p = re.sub(r"\[([^\]]+)\]\((https?://[^)\s]+)\)", r"<\2|\1>", part)
        p = re.sub(r"(^|\s)\*([^*\n]+)\*(?=$|\s|[.,!?;:])", r"\1_\2_", p)
        p = re.sub(r"\*\*([^*]+)\*\*", r"*\1*", p)
        out.append(p)
    return "".join(out)


def chunk_slack_text(text: str, limit: int = 3800) -> list[str]:
    clean = str(text or "").strip()
    if not clean:
        return ["(empty response)"]
    if len(clean) <= limit:
        return [clean]
    chunks: list[str] = []
    rest = clean
    while len(rest) > limit:
        window = rest[:limit]
        cut = -1
        for sep in ("\n\n", "\n", " "):
            pos = window.rfind(sep)
            if pos >= limit // 3:
                cut = pos + (len(sep) if sep != " " else 0)
                break
        if cut <= 0:
            cut = limit
        piece = rest[:cut].rstrip()
        if piece.count("```") % 2 == 1:
            piece += "\n```"
            rest = "```\n" + rest[cut:].lstrip()
        else:
            rest = rest[cut:].lstrip()
        chunks.append(piece)
    if rest:
        chunks.append(rest)
    return chunks


def _load_env_file(path: str) -> None:
    if not path or not os.path.exists(path):
        return
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            k = k.strip()
            v = v.strip().strip('"').strip("'")
            if k and k not in os.environ:
                os.environ[k] = v


def _parse_csv_set(raw: str) -> set[str]:
    return {x.strip() for x in raw.split(",") if x.strip()}


def _parse_channel_map(raw: str) -> dict[str, tuple[Optional[str], Optional[str]]]:
    mapping: dict[str, tuple[Optional[str], Optional[str]]] = {}
    for item in raw.split(","):
        item = item.strip()
        if not item or "=" not in item:
            continue
        ch, target = item.split("=", 1)
        ch = ch.strip()
        target = target.strip()
        if not ch or not target:
            continue
        if target.lower().startswith("group:"):
            mapping[ch] = (None, target[6:].strip() or None)
        else:
            mapping[ch] = (target, None)
    return mapping


@dataclass
class RouterConfig:
    slack_app_token: str = ""
    slack_bot_token: str = ""
    slack_api_base: str = "https://slack.com/api"
    allowed_users: set[str] = field(default_factory=lambda: {"U0C2NC6ARAQ"})
    default_bot: str = "Devin Manager"
    channel_map: dict[str, tuple[Optional[str], Optional[str]]] = field(
        default_factory=lambda: {
            "D0CKFEVJF0X": ("Devin Manager", None),
            "C0CKX41QVRQ": ("Devin Manager", None),
        }
    )
    known_bots: list[str] = field(
        default_factory=lambda: [
            "Devin Manager",
            "Chief",
            "Coder",
            "Reviewer",
            "Planner",
            "Grok Bot (old)",
            "Grok Bot Carbon",
            "Grok Bot",
            "Capy Code Review (deepseek)",
            "Capy Code Review",
            "Devin Cloud",
            "Manufacturability",
        ]
    )
    known_groups: list[str] = field(default_factory=lambda: ["1+1 Routing", "Project Team"])
    broker_url: str = "http://127.0.0.1:13090"
    broker_producer_token: str = ""
    dsbot_url: str = "http://127.0.0.1:13080"
    dsbot_container: str = "ds-bot"
    dsbot_auth_token: str = ""
    ec2_cloud_bot: str = "Chief"
    db_path: str = "/var/lib/slack-router/router.db"
    watch_interval_sec: float = 0.5
    cloud_timeout_sec: float = 180.0

    @classmethod
    def from_env(cls) -> "RouterConfig":
        cfg = cls(
            slack_app_token=os.environ.get("SLACK_APP_TOKEN", "").strip(),
            slack_bot_token=os.environ.get("SLACK_BOT_TOKEN", "").strip(),
            slack_api_base=os.environ.get("SLACK_API_BASE", "https://slack.com/api").strip().rstrip("/"),
            default_bot=os.environ.get("SLACK_DEFAULT_BOT", "Devin Manager").strip() or "Devin Manager",
            broker_url=os.environ.get("BROKER_URL", "http://127.0.0.1:13090").strip().rstrip("/"),
            broker_producer_token=os.environ.get("BROKER_PRODUCER_TOKEN", "").strip(),
            dsbot_url=os.environ.get("DSBOT_URL", "http://127.0.0.1:13080").strip().rstrip("/"),
            dsbot_container=os.environ.get("DSBOT_CONTAINER", "ds-bot").strip() or "ds-bot",
            dsbot_auth_token=os.environ.get("DSBOT_AUTH_TOKEN", "").strip(),
            ec2_cloud_bot=os.environ.get("EC2_CLOUD_BOT", "Chief").strip() or "Chief",
            db_path=os.environ.get("ROUTER_DB_PATH", "/var/lib/slack-router/router.db").strip(),
            watch_interval_sec=float(os.environ.get("WATCH_INTERVAL_SEC", "0.5")),
            cloud_timeout_sec=float(os.environ.get("CLOUD_TIMEOUT_SEC", "180")),
        )
        raw_users = os.environ.get("SLACK_ALLOWED_USERS")
        if raw_users is not None:
            cfg.allowed_users = _parse_csv_set(raw_users)
        raw_ch = os.environ.get("SLACK_CHANNEL_MAP")
        if raw_ch is not None:
            cfg.channel_map = _parse_channel_map(raw_ch)
        raw_bots = os.environ.get("SLACK_KNOWN_BOTS")
        if raw_bots is not None:
            cfg.known_bots = [x.strip() for x in raw_bots.split(",") if x.strip()]
        raw_groups = os.environ.get("SLACK_KNOWN_GROUPS")
        if raw_groups is not None:
            cfg.known_groups = [x.strip() for x in raw_groups.split(",") if x.strip()]
        return cfg


@dataclass
class ParsedCommand:
    action: str  # message | cloud | queue | cancel | move_to_cloud | empty
    text: str = ""
    bot: Optional[str] = None
    group: Optional[str] = None
    job_id: Optional[str] = None
    force: bool = False
    local_only: bool = False


def parse_incoming_command(
    raw_text: str,
    *,
    channel: str = "",
    self_user_id: str = "",
    default_bot: str = "Devin Manager",
    channel_map: Optional[dict[str, tuple[Optional[str], Optional[str]]]] = None,
    known_bots: Optional[list[str]] = None,
    known_groups: Optional[list[str]] = None,
) -> ParsedCommand:
    text = str(raw_text or "")
    if self_user_id:
        text = text.replace(f"<@{self_user_id}>", " ")
    text = text.strip()
    if not text:
        return ParsedCommand(action="empty")

    low = text.lower()
    if re.match(r"^/queue(?:\s|$)", low):
        return ParsedCommand(action="queue")

    m_cancel = re.match(r"^/cancel(?:\s+(\S+))?", text, re.IGNORECASE)
    if m_cancel:
        return ParsedCommand(action="cancel", job_id=(m_cancel.group(1) or "").strip() or None)

    m_move = re.match(r"^/move-to-cloud\b(.*)$", text, re.IGNORECASE | re.DOTALL)
    if m_move:
        rest = m_move.group(1).strip()
        force = False
        if rest.startswith("--force"):
            force = True
            rest = rest[len("--force") :].strip()
        toks = rest.split()
        jid = toks[0] if toks else None
        if len(toks) > 1 and toks[1] == "--force":
            force = True
        return ParsedCommand(action="move_to_cloud", job_id=jid, force=force)

    force = False
    explicit_local = False
    explicit_cloud = False
    m_cloud = re.match(r"^/cloud\b(.*)$", text, re.IGNORECASE | re.DOTALL)
    if m_cloud:
        explicit_cloud = True
        body = m_cloud.group(1).strip()
        if body.startswith("--force"):
            force = True
            body = body[len("--force") :].strip()
    else:
        m_local = re.match(r"^/local\b(.*)$", text, re.IGNORECASE | re.DOTALL)
        if m_local:
            explicit_local = True
            body = m_local.group(1).strip()
        else:
            body = text

    bot_name, group_name = (channel_map or {}).get(channel, (default_bot, None))
    if not bot_name and not group_name:
        bot_name = default_bot

    m_group_q = re.match(r'^@group:\s*"([^"]+)"(?:\s*[:,-]?\s*|\s+)(.*)$', body, re.IGNORECASE | re.DOTALL)
    if m_group_q:
        group_name = m_group_q.group(1).strip()
        bot_name = None
        body = m_group_q.group(2).strip()
    elif re.match(r"^@group:\s*", body, re.IGNORECASE):
        after = re.sub(r"^@group:\s*", "", body, count=1, flags=re.IGNORECASE)
        matched_g = None
        for g in sorted(known_groups or [], key=len, reverse=True):
            mg = re.match(rf"^({re.escape(g)})(?=$|[\s:,-])(.*)$", after, re.IGNORECASE | re.DOTALL)
            if mg:
                matched_g = g
                body = mg.group(2).lstrip(" :,-").strip()
                break
        if matched_g is None:
            parts = after.split(None, 1)
            matched_g = parts[0] if parts else ""
            body = parts[1].strip() if len(parts) > 1 else ""
        if matched_g:
            group_name = matched_g
            bot_name = None
    else:
        for b in sorted(known_bots or [], key=len, reverse=True):
            mb = re.match(rf"^@{re.escape(b)}(?=$|[\s:,-])(.*)$", body, re.IGNORECASE | re.DOTALL)
            if mb:
                bot_name = b
                group_name = None
                body = mb.group(1).lstrip(" :,-").strip()
                break

    if not body:
        return ParsedCommand(action="empty")

    local_only = explicit_local or has_local_only_path(body)
    return ParsedCommand(
        action="cloud" if explicit_cloud else "message",
        text=body,
        bot=bot_name,
        group=group_name,
        force=force,
        local_only=local_only,
    )


class RouterStore:
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
                CREATE TABLE IF NOT EXISTS seen_events (
                    event_key TEXT PRIMARY KEY,
                    seen_at REAL NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_seen_at ON seen_events(seen_at);
                CREATE TABLE IF NOT EXISTS tracked_jobs (
                    job_id TEXT PRIMARY KEY,
                    channel TEXT NOT NULL,
                    thread_ts TEXT NOT NULL,
                    msg_ts TEXT NOT NULL,
                    user_id TEXT NOT NULL,
                    bot_name TEXT,
                    group_name TEXT,
                    local_only INTEGER NOT NULL DEFAULT 0,
                    status TEXT NOT NULL,
                    created_at REAL NOT NULL,
                    completed_at REAL
                );
                CREATE INDEX IF NOT EXISTS idx_tracked_open ON tracked_jobs(completed_at, created_at);
                """
            )
            self.conn.commit()

    def close(self) -> None:
        with self._lock:
            self.conn.close()

    def mark_seen_if_new(self, event_key: str) -> bool:
        now = time.time()
        cutoff = now - 86400.0
        with self._lock:
            self.conn.execute("DELETE FROM seen_events WHERE seen_at < ?", (cutoff,))
            cur = self.conn.execute(
                "INSERT OR IGNORE INTO seen_events (event_key, seen_at) VALUES (?, ?)",
                (event_key, now),
            )
            self.conn.commit()
            return (cur.rowcount or 0) > 0

    def track_job(
        self,
        *,
        job_id: str,
        channel: str,
        thread_ts: str,
        msg_ts: str,
        user_id: str,
        bot_name: Optional[str],
        group_name: Optional[str],
        local_only: bool,
        status: str = "queued",
    ) -> None:
        now = time.time()
        with self._lock:
            self.conn.execute(
                """
                INSERT INTO tracked_jobs (
                    job_id, channel, thread_ts, msg_ts, user_id,
                    bot_name, group_name, local_only, status, created_at, completed_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
                ON CONFLICT(job_id) DO NOTHING
                """,
                (
                    job_id,
                    channel,
                    thread_ts,
                    msg_ts,
                    user_id,
                    bot_name,
                    group_name,
                    1 if local_only else 0,
                    status,
                    now,
                ),
            )
            self.conn.commit()

    def list_open_jobs(self) -> list[dict[str, Any]]:
        with self._lock:
            rows = self.conn.execute(
                "SELECT * FROM tracked_jobs WHERE completed_at IS NULL ORDER BY created_at ASC"
            ).fetchall()
        return [dict(r) for r in rows]

    def get_tracked_job(self, job_id: str) -> Optional[dict[str, Any]]:
        with self._lock:
            row = self.conn.execute(
                "SELECT * FROM tracked_jobs WHERE job_id = ?", (job_id,)
            ).fetchone()
        return dict(row) if row else None

    def finish_job(self, job_id: str, status: str) -> None:
        now = time.time()
        with self._lock:
            self.conn.execute(
                "UPDATE tracked_jobs SET status = ?, completed_at = ? WHERE job_id = ?",
                (status, now, job_id),
            )
            self.conn.commit()


class SlackApiClient:
    def __init__(self, app_token: str, bot_token: str, api_base: str = "https://slack.com/api") -> None:
        self.app_token = app_token
        self.bot_token = bot_token
        self.api_base = api_base.rstrip("/")

    def _call(self, method: str, payload: dict[str, Any], *, use_app_token: bool = False) -> dict[str, Any]:
        tok = self.app_token if use_app_token else self.bot_token
        req = urllib.request.Request(
            f"{self.api_base}/{method}",
            data=json.dumps(payload).encode("utf-8"),
            method="POST",
            headers={
                "Content-Type": "application/json; charset=utf-8",
                "Authorization": f"Bearer {tok}",
            },
        )
        with urllib.request.urlopen(req, timeout=15.0) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        if not data.get("ok"):
            raise RuntimeError(f"Slack {method} failed: {data.get('error', data)}")
        return data

    def auth_test(self) -> dict[str, Any]:
        return self._call("auth.test", {})

    def connections_open(self) -> str:
        res = self._call("apps.connections.open", {}, use_app_token=True)
        url = str(res.get("url") or "").strip()
        if not url:
            raise RuntimeError("Slack apps.connections.open returned empty url")
        return url

    def post_message(
        self, channel: str, text: str, thread_ts: Optional[str] = None
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {"channel": channel, "text": text}
        if thread_ts:
            payload["thread_ts"] = thread_ts
        return self._call("chat.postMessage", payload)

    def add_reaction(self, channel: str, timestamp: str, name: str) -> None:
        try:
            self._call("reactions.add", {"channel": channel, "timestamp": timestamp, "name": name})
        except Exception:
            pass

    def remove_reaction(self, channel: str, timestamp: str, name: str) -> None:
        try:
            self._call("reactions.remove", {"channel": channel, "timestamp": timestamp, "name": name})
        except Exception:
            pass


class BrokerProducerClient:
    def __init__(self, base_url: str, producer_token: str) -> None:
        self.base_url = base_url.rstrip("/")
        self.producer_token = producer_token

    def _req(self, method: str, path: str, body: Optional[dict[str, Any]] = None) -> tuple[int, dict[str, Any]]:
        data = json.dumps(body).encode("utf-8") if body is not None else None
        headers = {"Authorization": f"Bearer {self.producer_token}"}
        if data is not None:
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(f"{self.base_url}{path}", data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=15.0) as resp:
                return resp.status, json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            raw = exc.read().decode("utf-8", errors="replace")
            try:
                return exc.code, json.loads(raw)
            except Exception:
                return exc.code, {"ok": False, "error": raw}

    def healthz(self) -> dict[str, Any]:
        req = urllib.request.Request(f"{self.base_url}/healthz", method="GET")
        with urllib.request.urlopen(req, timeout=5.0) as resp:
            return json.loads(resp.read().decode("utf-8"))

    def enqueue_job(self, payload: dict[str, Any]) -> tuple[int, dict[str, Any]]:
        return self._req("POST", "/v1/jobs", payload)

    def get_job(self, job_id: str) -> tuple[int, dict[str, Any]]:
        return self._req("GET", f"/v1/jobs/{urllib.parse.quote(job_id)}")

    def list_jobs(self, limit: int = 20) -> tuple[int, dict[str, Any]]:
        return self._req("GET", f"/v1/jobs?limit={int(limit)}")

    def cancel_job(self, job_id: str) -> tuple[int, dict[str, Any]]:
        return self._req("POST", f"/v1/jobs/{urllib.parse.quote(job_id)}/cancel", {})

    def add_cloud_note(
        self,
        *,
        channel: str,
        thread_ts: str,
        bot_name: str,
        prompt_excerpt: str,
        reply_excerpt: str,
    ) -> tuple[int, dict[str, Any]]:
        return self._req(
            "POST",
            "/v1/cloud-notes",
            {
                "channel": channel,
                "thread_ts": thread_ts,
                "bot_name": bot_name,
                "prompt_excerpt": prompt_excerpt,
                "reply_excerpt": reply_excerpt,
            },
        )


class Ec2DsBotClient:
    """Talks to EC2 ds-bot (:13080/api/bot) via DSH launch-token session cookie."""

    def __init__(
        self,
        base_url: str = "http://127.0.0.1:13080",
        container_name: str = "ds-bot",
        auth_token: str = "",
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.container_name = container_name
        self.auth_token = auth_token.strip()
        self._jar = http.cookiejar.CookieJar()
        self._opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self._jar))
        self._lock = threading.Lock()
        self._authed = False

    def _resolve_token(self) -> str:
        if self.auth_token:
            return self.auth_token
        res = subprocess.run(
            ["docker", "logs", self.container_name],
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
        combined = (res.stdout or "") + "\n" + (res.stderr or "")
        matches = re.findall(r"dsh web:.*?token=([A-Za-z0-9._~-]+)", combined)
        return matches[-1] if matches else ""

    def _authenticate(self) -> bool:
        tok = self._resolve_token()
        if not tok:
            return False
        url = f"{self.base_url}/?token={urllib.parse.quote(tok, safe='')}"
        req = urllib.request.Request(url, method="GET")
        try:
            with self._opener.open(req, timeout=10.0) as resp:
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

    def post_bot_api(self, endpoint: str, payload: Optional[dict[str, Any]] = None) -> Any:
        body: dict[str, Any] = {"endpoint": endpoint}
        if payload is not None:
            body["payload"] = payload
        raw = json.dumps(body).encode("utf-8")
        with self._lock:
            for attempt in range(2):
                if not self._authed and not self._authenticate():
                    raise RuntimeError("EC2 ds-bot cookie authentication failed")
                req = urllib.request.Request(
                    f"{self.base_url}/api/bot",
                    data=raw,
                    method="POST",
                    headers={"Content-Type": "application/json"},
                )
                try:
                    with self._opener.open(req, timeout=20.0) as resp:
                        data = json.loads(resp.read().decode("utf-8"))
                except urllib.error.HTTPError as exc:
                    if exc.code == 401 and attempt == 0:
                        self._authed = False
                        continue
                    raise RuntimeError(f"EC2 ds-bot HTTP {exc.code} on {endpoint}") from exc
                if not data.get("ok"):
                    err = data.get("error") or {}
                    raise RuntimeError(err.get("message") or f"EC2 ds-bot error on {endpoint}")
                return data.get("value")
        raise RuntimeError(f"EC2 ds-bot request failed on {endpoint}")

    def ask(self, bot_name: str, text: str, *, timeout_sec: float = 180.0, poll_sec: float = 0.75) -> str:
        state = self.post_bot_api("state", {})
        bots = state.get("bots") or []
        bot = next(
            (b for b in bots if str(b.get("name") or "").lower() == bot_name.lower()),
            None,
        ) or (bots[0] if bots else None)
        if not bot:
            raise RuntimeError("No bots found on EC2 ds-bot")
        bot_id = bot["id"]
        session_id = bot.get("sessionId") or bot_id

        before_chat = self.post_bot_api("chat", {"botId": bot_id})
        before_items = before_chat.get("items") or []
        max_bot_seq = max(
            (int(it.get("seq")) for it in before_items if it.get("seq") is not None),
            default=-1,
        )
        max_bot_count = sum(1 for it in before_items if it.get("kind") == "bot")

        self.post_bot_api("send", {"sessionId": session_id, "text": text})

        deadline = time.monotonic() + max(10.0, timeout_sec)
        saw_working = False
        while time.monotonic() < deadline:
            time.sleep(poll_sec)
            st = self.post_bot_api("state", {})
            act = (st.get("activity") or {}).get(bot_id)
            working = act == "working"
            if working:
                saw_working = True
            page = self.post_bot_api("chat", {"botId": bot_id})
            items = page.get("items") or []
            new_bot_texts = [
                str(it.get("text") or "").strip()
                for it in items
                if it.get("kind") == "bot"
                and str(it.get("text") or "").strip()
                and (
                    (it.get("seq") is not None and int(it["seq"]) > max_bot_seq)
                    if max_bot_seq >= 0
                    else True
                )
            ]
            if max_bot_seq < 0:
                all_bot_texts = [
                    str(it.get("text") or "").strip()
                    for it in items
                    if it.get("kind") == "bot" and str(it.get("text") or "").strip()
                ]
                new_bot_texts = all_bot_texts[max_bot_count:]
            if not working and new_bot_texts:
                return "\n\n".join(new_bot_texts)
            if not working and saw_working:
                err_item = next(
                    (it for it in reversed(items) if it.get("kind") in ("error", "bot") and str(it.get("text") or "").strip()),
                    None,
                )
                if err_item:
                    return str(err_item.get("text") or "").strip()
        raise TimeoutError(f"EC2 ds-bot timed out waiting for {bot_name}")


class SlackRouter:
    def __init__(
        self,
        *,
        config: RouterConfig,
        store: RouterStore,
        slack: SlackApiClient,
        broker: BrokerProducerClient,
        ec2_dsbot: Optional[Ec2DsBotClient] = None,
        self_user_id: str = "",
    ) -> None:
        self.config = config
        self.store = store
        self.slack = slack
        self.broker = broker
        self.ec2_dsbot = ec2_dsbot
        self.self_user_id = self_user_id
        self._watch_lock = threading.Lock()
        self._stop_event = threading.Event()
        self._ws_lock = threading.Lock()
        self._active_ws: Optional[SimpleWebSocket] = None

    def _post_thread(self, channel: str, thread_ts: str, text: str) -> None:
        formatted = markdown_to_mrkdwn(redact_secrets(text))
        for part in chunk_slack_text(formatted):
            self.slack.post_message(channel, part, thread_ts=thread_ts)

    def handle_interactive(self, payload: dict[str, Any]) -> None:
        # v2 hook: answer_waiting card actions go here once mcp-server exposes answer_waiting.
        ch = str((payload.get("channel") or {}).get("id") or "")
        msg_ts = str((payload.get("message") or {}).get("thread_ts") or (payload.get("message") or {}).get("ts") or "")
        if ch and msg_ts:
            self._post_thread(ch, msg_ts, "Interactive cards are answered in DS Bot (Desktop or Phone) in v1.")

    def _run_cloud_turn(
        self,
        *,
        channel: str,
        thread_ts: str,
        msg_ts: str,
        prompt: str,
    ) -> None:
        bot_name = self.config.ec2_cloud_bot
        if self.ec2_dsbot is None:
            self._post_thread(channel, thread_ts, "EC2 `/cloud` runner is not configured.")
            return
        self.slack.add_reaction(channel, msg_ts, "cloud")
        try:
            reply = self.ec2_dsbot.ask(
                bot_name, prompt, timeout_sec=self.config.cloud_timeout_sec
            )
            self._post_thread(channel, thread_ts, reply)
            try:
                self.broker.add_cloud_note(
                    channel=channel,
                    thread_ts=thread_ts,
                    bot_name=bot_name,
                    prompt_excerpt=prompt,
                    reply_excerpt=reply,
                )
            except Exception as exc:
                sys.stderr.write(f"[slack-router] add_cloud_note failed: {exc}\n")
        except Exception as exc:
            self._post_thread(channel, thread_ts, f":x: EC2 `/cloud` failed: {redact_secrets(str(exc))}")
        finally:
            self.slack.remove_reaction(channel, msg_ts, "cloud")

    def _enqueue_mac_job(
        self,
        *,
        channel: str,
        thread_ts: str,
        msg_ts: str,
        user_id: str,
        parsed: ParsedCommand,
    ) -> None:
        payload: dict[str, Any] = {
            "target": "dsbot",
            "task": parsed.text,
            "aws_session_id": f"slack:{channel}:{thread_ts}",
            "idempotency_key": f"slack:{channel}:{msg_ts}",
            "local_only": bool(parsed.local_only),
        }
        if parsed.bot:
            payload["bot"] = parsed.bot
        if parsed.group:
            payload["group"] = parsed.group
        code, data = self.broker.enqueue_job(payload)
        if code not in (200, 201) or not data.get("ok"):
            self._post_thread(channel, thread_ts, f":x: Could not enqueue job: {data.get('error', f'HTTP {code}')}")
            return
        job = data["job"]
        job_id = job["job_id"]
        mac_online = bool(data.get("mac_online"))
        self.store.track_job(
            job_id=job_id,
            channel=channel,
            thread_ts=thread_ts,
            msg_ts=msg_ts,
            user_id=user_id,
            bot_name=parsed.bot,
            group_name=parsed.group,
            local_only=bool(parsed.local_only),
            status=str(job.get("status") or "queued"),
        )
        if mac_online:
            self.slack.add_reaction(channel, msg_ts, "eyes")
        else:
            self.slack.add_reaction(channel, msg_ts, "hourglass_flowing_sand")
            dest = f"group `{parsed.group}`" if parsed.group else f"`{parsed.bot or self.config.default_bot}`"
            if parsed.local_only:
                hint = f"Pinned `local_only` for Mac (`/cancel {job_id}` to drop)."
            else:
                hint = f"Commands: `/cancel {job_id}`, `/move-to-cloud {job_id}`, or `/queue`."
            self._post_thread(
                channel,
                thread_ts,
                f":hourglass_flowing_sand: Mac is offline. Queued `{job_id}` for {dest} on Mac wake.\n{hint}",
            )

    def _handle_message_event(self, event: dict[str, Any], event_id: str) -> None:
        if event.get("bot_id") is not None:
            return
        subtype = event.get("subtype")
        if subtype is not None and subtype != "file_share":
            return
        channel = str(event.get("channel") or "").strip()
        channel_type = str(event.get("channel_type") or "").strip()
        user_id = str(event.get("user") or "").strip()
        msg_ts = str(event.get("ts") or "").strip()
        thread_ts = str(event.get("thread_ts") or msg_ts).strip()
        ev_type = str(event.get("type") or "")

        is_direct = ev_type == "message" and channel_type == "im"
        is_mention = ev_type == "app_mention"
        if not (is_direct or is_mention):
            return
        if not channel or not msg_ts:
            return
        if self.config.allowed_users and user_id not in self.config.allowed_users:
            return
        if self.config.channel_map and channel not in self.config.channel_map and not is_direct:
            return

        dedup_key = event_id or f"{channel}:{msg_ts}"
        if not self.store.mark_seen_if_new(dedup_key):
            return

        if event.get("files"):
            self._post_thread(
                channel,
                thread_ts,
                "Note: Slack file/image attachments are not forwarded in v1; running text portion only.",
            )

        parsed = parse_incoming_command(
            str(event.get("text") or ""),
            channel=channel,
            self_user_id=self.self_user_id,
            default_bot=self.config.default_bot,
            channel_map=self.config.channel_map,
            known_bots=self.config.known_bots,
            known_groups=self.config.known_groups,
        )
        if parsed.action == "empty":
            return

        if parsed.action == "queue":
            code, data = self.broker.list_jobs(limit=20)
            if code != 200 or not data.get("ok"):
                self._post_thread(channel, thread_ts, f":x: `/queue` failed: {data.get('error', code)}")
                return
            mac_state = "online" if data.get("mac_online") else "offline"
            open_jobs = [j for j in (data.get("jobs") or []) if j.get("status") in ("queued", "running", "lease_lost")]
            if not open_jobs:
                self._post_thread(channel, thread_ts, f"Mac is *{mac_state}*. Queue is empty.")
                return
            lines = [f"Mac is *{mac_state}*. Pending jobs ({len(open_jobs)}):"]
            for j in open_jobs:
                who = j.get("group") or j.get("bot") or "Chief"
                pin = " `[local_only]`" if j.get("local_only") else ""
                preview = str(j.get("task") or "").replace("\n", " ")[:60]
                lines.append(f"- `{j['job_id']}` [{j['status']}] -> *{who}*{pin}: {preview}")
            self._post_thread(channel, thread_ts, "\n".join(lines))
            return

        if parsed.action == "cancel":
            if not parsed.job_id:
                self._post_thread(channel, thread_ts, "Usage: `/cancel <job_id>`")
                return
            code, data = self.broker.cancel_job(parsed.job_id)
            if code != 200 or not data.get("ok"):
                self._post_thread(channel, thread_ts, f":x: Could not cancel `{parsed.job_id}`: {data.get('error', code)}")
                return
            self.store.finish_job(parsed.job_id, "cancelled")
            self._post_thread(channel, thread_ts, f"Cancelled `{parsed.job_id}` (`{data['job']['status']}`).")
            return

        if parsed.action == "move_to_cloud":
            if not parsed.job_id:
                self._post_thread(channel, thread_ts, "Usage: `/move-to-cloud [--force] <job_id>`")
                return
            code, got = self.broker.get_job(parsed.job_id)
            if code != 200 or not got.get("ok"):
                self._post_thread(channel, thread_ts, f":x: Job `{parsed.job_id}` not found.")
                return
            job = got["job"]
            if job.get("status") not in ("queued", "lease_lost"):
                self._post_thread(channel, thread_ts, f"Job `{parsed.job_id}` is already `{job.get('status')}` and cannot be moved.")
                return
            if job.get("local_only") and not parsed.force:
                self._post_thread(
                    channel,
                    thread_ts,
                    f":no_entry: Job `{parsed.job_id}` is pinned `local_only` (references local Mac paths). Pass `/move-to-cloud --force {parsed.job_id}` to override.",
                )
                return
            ccode, _ = self.broker.cancel_job(parsed.job_id)
            if ccode != 200:
                self._post_thread(channel, thread_ts, f":x: Failed to cancel `{parsed.job_id}` before moving to cloud.")
                return
            self.store.finish_job(parsed.job_id, "moved_to_cloud")
            self._post_thread(channel, thread_ts, f"Moved `{parsed.job_id}` to EC2 `/cloud` (Mac queue entry cancelled).")
            self._run_cloud_turn(
                channel=channel, thread_ts=thread_ts, msg_ts=msg_ts, prompt=str(job.get("task") or "")
            )
            return

        if parsed.action == "cloud":
            if parsed.local_only and not parsed.force:
                parsed.local_only = True
                self._post_thread(
                    channel,
                    thread_ts,
                    ":no_entry: Detected local Mac path/file in `/cloud` request; pinning `local_only` to Mac queue instead (use `/cloud --force ...` to override).",
                )
                self._enqueue_mac_job(
                    channel=channel, thread_ts=thread_ts, msg_ts=msg_ts, user_id=user_id, parsed=parsed
                )
                return
            self._run_cloud_turn(channel=channel, thread_ts=thread_ts, msg_ts=msg_ts, prompt=parsed.text)
            return

        self._enqueue_mac_job(
            channel=channel, thread_ts=thread_ts, msg_ts=msg_ts, user_id=user_id, parsed=parsed
        )

    def dispatch_envelope(self, envelope: dict[str, Any], *, async_work: bool = True) -> Optional[str]:
        etype = envelope.get("type")
        if etype == "disconnect":
            return "disconnect"
        if etype == "hello":
            return "hello"
        if etype == "events_api":
            payload = envelope.get("payload") or {}
            event = payload.get("event") or {}
            event_id = str(payload.get("event_id") or "")
            if async_work:
                threading.Thread(
                    target=self._safe_handle_message, args=(event, event_id), daemon=True
                ).start()
            else:
                self._safe_handle_message(event, event_id)
        elif etype == "interactive":
            payload = envelope.get("payload") or {}
            if async_work:
                threading.Thread(target=self.handle_interactive, args=(payload,), daemon=True).start()
            else:
                self.handle_interactive(payload)
        return None

    def _safe_handle_message(self, event: dict[str, Any], event_id: str) -> None:
        try:
            self._handle_message_event(event, event_id)
        except Exception as exc:
            sys.stderr.write(f"[slack-router] event error: {exc}\n")

    def watch_tracked_jobs_once(self) -> int:
        with self._watch_lock:
            open_jobs = self.store.list_open_jobs()
            completed = 0
            for tracked in open_jobs:
                job_id = tracked["job_id"]
                try:
                    code, data = self.broker.get_job(job_id)
                except Exception:
                    continue
                if code == 404:
                    self.store.finish_job(job_id, "missing")
                    continue
                if code != 200 or not data.get("ok"):
                    continue
                job = data["job"]
                st = str(job.get("status") or "")
                ch = tracked["channel"]
                thread_ts = tracked["thread_ts"]
                msg_ts = tracked["msg_ts"]
                if st == "succeeded":
                    self.slack.remove_reaction(ch, msg_ts, "eyes")
                    self.slack.remove_reaction(ch, msg_ts, "hourglass_flowing_sand")
                    summary = str(job.get("result_summary") or "").strip() or "(Done)"
                    self._post_thread(ch, thread_ts, summary)
                    self.store.finish_job(job_id, "succeeded")
                    completed += 1
                elif st == "lease_lost":
                    self.slack.remove_reaction(ch, msg_ts, "eyes")
                    self.slack.remove_reaction(ch, msg_ts, "hourglass_flowing_sand")
                    self._post_thread(
                        ch,
                        thread_ts,
                        f":warning: Job `{job_id}` stopped mid-turn when Mac disconnected (`lease_lost`). Not auto-retried on EC2 to prevent duplicate side effects. Re-send to retry on Mac or use `/cloud`.",
                    )
                    self.store.finish_job(job_id, "lease_lost")
                    completed += 1
                elif st in ("failed", "expired", "cancelled"):
                    self.slack.remove_reaction(ch, msg_ts, "eyes")
                    self.slack.remove_reaction(ch, msg_ts, "hourglass_flowing_sand")
                    err = str(job.get("error") or st)
                    self._post_thread(ch, thread_ts, f":x: Job `{job_id}` ended with `{st}`: {err}")
                    self.store.finish_job(job_id, st)
                    completed += 1
            return completed

    def _watcher_loop(self) -> None:
        while not self._stop_event.wait(self.config.watch_interval_sec):
            try:
                self.watch_tracked_jobs_once()
            except Exception as exc:
                sys.stderr.write(f"[slack-router] watcher error: {exc}\n")

    def stop(self) -> None:
        self._stop_event.set()
        with self._ws_lock:
            ws = self._active_ws
        if ws is not None:
            ws.close()

    def run_forever(self) -> None:
        if not self.config.slack_app_token or not self.config.slack_bot_token:
            raise SystemExit("SLACK_APP_TOKEN and SLACK_BOT_TOKEN must be set")
        if not self.config.broker_producer_token:
            raise SystemExit("BROKER_PRODUCER_TOKEN must be set")

        if not self.self_user_id:
            me = self.slack.auth_test()
            self.self_user_id = str(me.get("user_id") or "")
            sys.stderr.write(f"[slack-router] authenticated as {me.get('user')} ({self.self_user_id})\n")

        threading.Thread(target=self._watcher_loop, daemon=True).start()

        backoff = 2.0
        while not self._stop_event.is_set():
            ws: Optional[SimpleWebSocket] = None
            try:
                ws_url = self.slack.connections_open()
                ws = SimpleWebSocket.connect(ws_url, timeout=30.0)
                with self._ws_lock:
                    self._active_ws = ws
                backoff = 2.0
                sys.stderr.write("[slack-router] socket mode connected\n")
                while not self._stop_event.is_set():
                    try:
                        raw = ws.recv_text(timeout=30.0)
                    except socket.timeout:
                        continue
                    if raw is None:
                        break
                    envelope = json.loads(raw)
                    eid = envelope.get("envelope_id")
                    if eid:
                        ws.send_text(json.dumps({"envelope_id": eid}))
                    res = self.dispatch_envelope(envelope, async_work=True)
                    if res == "disconnect":
                        sys.stderr.write("[slack-router] slack requested disconnect; reconnecting\n")
                        break
            except (OSError, WebSocketError, RuntimeError, ValueError) as exc:
                if not self._stop_event.is_set():
                    sys.stderr.write(f"[slack-router] socket error ({exc}); retrying in {backoff:.0f}s\n")
            finally:
                with self._ws_lock:
                    if self._active_ws is ws:
                        self._active_ws = None
                if ws is not None:
                    ws.close()
            if not self._stop_event.is_set():
                self._stop_event.wait(backoff)
                backoff = min(30.0, backoff * 2.0)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--env-file", action="append", default=[])
    args = parser.parse_args()
    for p in args.env_file:
        _load_env_file(p)
    cfg = RouterConfig.from_env()
    store = RouterStore(cfg.db_path)
    slack = SlackApiClient(cfg.slack_app_token, cfg.slack_bot_token, cfg.slack_api_base)
    broker = BrokerProducerClient(cfg.broker_url, cfg.broker_producer_token)
    ec2 = Ec2DsBotClient(cfg.dsbot_url, cfg.dsbot_container, cfg.dsbot_auth_token)
    router = SlackRouter(config=cfg, store=store, slack=slack, broker=broker, ec2_dsbot=ec2)

    def _sig(_signum: int, _frame: Any) -> None:
        router.stop()

    signal.signal(signal.SIGTERM, _sig)
    signal.signal(signal.SIGINT, _sig)
    try:
        router.run_forever()
    finally:
        store.close()


if __name__ == "__main__":
    main()
