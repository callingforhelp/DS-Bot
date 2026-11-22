# AWS DS Bot ↔ Mac Mini Direct Bridge

## Architecture

The Mac bridge connects the AWS-hosted `ds-bot` instance directly to the local `0.3.9` Mac `DS Bot.app` (via its native loopback MCP server) over an outbound AWS SSM port-forwarding tunnel (`13090 -> 13090`), requiring zero inbound firewall rules on the Mac mini and no ParaDev dependency. `mac-job-worker` also maintains a persistent outbound SSM tunnel (`8080 -> 8080`) for Cloud Handoff (`ds-bot-controller`).

```
User (Web UI :13080/:13081 or Android App :8788)
  │
  ▼
AWS `ds-bot` Container
  ├─ Skill: `mac-dispatch-routing`
  └─ MCP:   `cloud/mac-job-broker/mac-broker-mcp.mjs`
  │
  ▼  Unix domain socket (`/data/mac-broker.sock`)
AWS `mac-job-broker` (`cloud/mac-job-broker/broker.py` + SQLite)
  ├─ Durable `jobs` queue (`target="dsbot"` default, `target="git_sync"`)
  └─ `DsBotCallbackClient` -> delivers `[MAC_JOB_RESULT ...]` back into `ds-bot`
  │
  ▼  Outbound AWS SSM tunnel (`13090 -> 13090`)
Mac Mini `mac-job-worker` (`cloud/mac-job-worker/worker.py`)
  ├─ Enforces `is_authorized_local_path` allowlist + case-insensitive APFS denylist
  ├─ `target="dsbot"` (default) -> Local Mac `DS Bot.app` MCP (`127.0.0.1:8798/mcp`:
  │   `send_to_bot` / `send_to_group` -> `wait_for_reply` + `list_waiting`),
  │   with safe pre-send fallback to headless `dsh`
  ├─ `target="git_sync"` -> local `git` push/pull & repo bootstrap
  └─ Secondary SSM tunnel watchdog (`8080 -> 8080`, probing `http://127.0.0.1:8080/ready`)
```

## Components

- `cloud/mac-job-broker/broker.py`: Durable SQLite job queue and Decision Mailbox (`/v1/decisions`).
- `cloud/mac-job-broker/mac-broker-mcp.mjs`: Stdio MCP server exposing `mac_enqueue_job` (default `target="dsbot"`), `mac_job_status`, `mac_list_jobs`, `mac_cancel_job`, `mac_git_sync`, and `decision_*` tools to `ds-bot`.
- `cloud/mac-job-worker/worker.py`: Outbound SSM tunnel manager (`13090` job broker + `8080` Cloud Handoff watchdog) and local runner on the Mac mini supporting `dsbot` and `git_sync`.
- `cloud/decision-mailbox/decision-mailbox-mcp.mjs`: Local Mac stdio MCP server for logging and resolving decisions across Cloud and Mac with offline spooling.
