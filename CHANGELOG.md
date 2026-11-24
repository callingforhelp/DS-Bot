# Changelog (`callingforhelp/DS-Bot` — `dev`)

Historical changelog of all changes on `dev` from the upstream `Fei2411/DS-Bot` `v0.3.8` baseline on `main` (`5e9b7da8`, `2026-11-16`) through `16616727` (`2026-11-24`).

---

## 1. Kev-4B Context Steward, Group Traces & Reply Rules (`2026-11-24`)
- **`16616727`** (`PR #32`, `feat/group-reply-rules`) — `feat(ds-bot): add flexible group reply rules for @ and unnamed posts` across `bot-settings.js`, `bot-response-policy.js`, `groups.js`, and tests.
- **`f99f410d`** — `feat(parts): add group busy guard and inter-bot trace capture on switch` (`isRoomBusy` in `ds-bot/src/host/parts.js`, durable `<home>/memory/groups/<roomId>/traces/` JSON + `index.jsonl` via `ds-bot/src/host/group-trace.js`, factor scores in `steward.js`, and `test/group-trace.test.js`).
- **`0ff15366`** — `feat(parts): add daily Kev-4B idle part boundary sweep` (`sweepIdleParts()` on 24h `.unref()`'d interval in `ds-bot/src/host/parts.js`).
- **`8c950fcb`** — `feat(steward): blend local Kev-4B decision model into task boundary detection` (`kevStewardRequest`, `scoreKevDecision`, `askKevSteward` in `ds-bot/src/host/steward.js` + `parts.js` fallback).

---

## 2. Live Voice Polish & Diagnostics (`2026-11-23` – `2026-11-24`)
- **`1500ddaa`** (`PR #31`, `fix/voice-standby-5s`) — Default standby idle timeout to `5s` and tighten spoken turn style (`voice-live.js`).
- **`217160d4`** (`PR #30`, `fix/voice-not-found`) — Fall back to `openai-direct` on controller `404` (`voice-live.js`).
- **`03198705`** (`PR #29`, `fix/voice-diagnostics`) — Log WebRTC stats, mic settings, and `oai-events` to diagnostics.
- **`7de4788b`** (`PR #28`, `fix/voice-error-surface`) — Persist connection errors on screen, log to diagnostics, and retry on unmute.
- **`e99000f3`** (`PR #27`, `fix/mic-startup`) — Request microphone permission on Mac startup when undetermined (`app/src/main.mjs`).
- **`41b870ea`** (`PR #26`, `fix/voice-live-bt-audio`) — Route remote WebRTC playback through `AudioContext` for Bluetooth HFP.
- **`8c251ed8`** (`PR #25`, `fix/voice-live-ui`) — Live voice UI fixes.

---

## 3. Needs-You Closed Loop & Mode C Slack Router (`2026-11-23` – `2026-11-24`)
- **`514f49f5`** — `feat: implement Needs You closed-loop decision sync and resume`:
  - `ds-bot/src/host/mcp-server.js`: preserved `MCP_TOOLS` exact 7 tools (`answer_question` rejected); enriched `list_waiting` with `id`, `detail`, `options` labels, `multiSelect`, `allowCustom`, and non-`issueDraft` in-scope `views`.
  - `cloud/mac-job-broker/broker.py` & `mac-broker-mcp.mjs`: added `kind`/`card_id`/`resume_job_id` migrations, `POST /v1/worker/decisions/reconcile`, HTTP `409` refusal on remote `kind="approval"`, numeric choice expansion, and deadlock-free `decision_resume` job enqueueing.
  - `cloud/mac-job-worker/worker.py`: added read-only `state.json` waiting enrichment (`collect_local_waiting_items`), hash-deduped `WaitingSyncManager`, and `closedCards` / absent-card duplicate-resume protection.
  - `cloud/slack-router/slack_router.py`: added `/decisions` (`/waiting`), `/decide`, `/approve`, `409` Mac-only handling, `resume_job_id` thread tracking, and proactive `watch_pending_decisions_once()` alerts.
- **`429f8076`** (`PR #24`, `chore/slack-router-event-logging`) — Add event logging for Slack router.
- **`1a779e0a`** (`PR #22`, `feat/slack-router-mode-c`) — Thin stateless Slack Socket Mode router, `local_only` path guards, and bidirectional Mac <-> EC2 context sync.

---

## 4. DS Bot `v0.3.9` -> `v0.3.10` Upgrade & ParaDev Removal (`2026-11-22`)
- **`a5d8eb31`** (`PR #21`, `chore/post-0310-polish`) — Post-`0.3.10` polish and MCP test baseline fixes.
- **`40c66baa`** (`PR #20`, `feat/merge-v0.3.10`) — Merge upstream DS Bot `v0.3.10` (with Local MCP server on `127.0.0.1:8798/mcp`).
- **`57016782`** (`PR #19`, `feat/direct-dsbot-no-paradev`) — Remove ParaDev dependency; route Mac worker jobs directly through DS Bot Local MCP + `dsh`.
- **`4c2bb37f`** (`PR #18`, `feat/merge-v0.3.9`) — Merge upstream DS Bot `v0.3.9`.

---

## 5. Mac <-> AWS Bridge, Docker Persistence & Voice Foundations (`2026-11-21` – `2026-11-22`)
- **`7e7ff9ef`** (`PR #17`, `chore/merge-cloud-mvp-backup`) — Merge Cloud MVP backup.
- **`da146690`** (`PR #14`, `fix/mac-bridge-verified-salvage`) — Salvage verified Mac bridge fixes.
- **`a04ef9b6`** (`PR #13`, `feat/docker-persist-home-links`) — Persist Docker home links.
- **`b3c512a3`** (`PR #12`, `fix/composer-lag-and-send-stability`) — Composer lag and send stability fixes.
- **`c3fbaff6`** (`PR #11`, `feat/mac-paradev-bridge`) — Non-GitHub `local_only` / `cwd` bootstrap, APFS path guard, and `fcntl.flock` decision spooling.
- **`9af68eef`** (`PR #10`, `feat/mac-paradev-bridge`) — Initial Mac job broker, worker, and decision mailbox MCP.
- **`7d1049f8`** (`PR #9`, `feat/openai-live-voice`) — OpenAI Live Voice integration.

---

## 6. Cloud Runtime MVP, Machines API & `1+1` Routing (`2026-11-18` – `2026-11-21`)
- **`ff4fe497`** (`PR #8`), **`ef7a1cd0`** (`PR #7`), **`bc7473cf`** (`PR #6`), **`ad4c6c98`** (`PR #5`), **`aed82098`** (`PR #3`) — DSH snapshot approval, message handler, persistent Daytona machines, and machines API.
- **`c2d175c5`** (`PR #4`), **`44e7a362`** (`PR #1`) — `1+1` Orchestrator routing (`Planner` / `Coder` / `Reviewer`).
- **`48c466e8`** (`PR #2`) — Local-agent DSH preset fix.
- **`7039354d` / `a4a7af25` / `6513cd25`** — Cloud runtime MVP under `cloud/` and DS Bot audit pipeline.
- **`65db0fb5`** — `feat/responding-to-bots` dispatcher rules.
- **`a95e3af4`..`83013153`** — Upstream `Fei2411/DS-Bot` `v0.3.8` + `#1719`–`#1811` bugfixes on top of `main` (`5e9b7da8`).
