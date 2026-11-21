# AWS DS Bot ↔ Mac Mini ParaDev Bridge

## Architecture

The Mac ParaDev bridge connects the AWS-hosted `dsh web` bot (`ds-bot`) to authorized local files, repositories, and ParaDev agent workspaces on the user's Mac mini over an outbound AWS SSM port-forwarding tunnel (`13090 -> 13090`), requiring zero inbound firewall rules on the Mac mini and no paid ParaDev cloud relay.

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
  ├─ Durable `jobs` queue (leases, heartbeats, idempotency keys, secret redaction)
  ├─ Durable `paradev_sessions` registry:
  │   `(repo_or_cwd, branch)` -> `(workspace_id, worktree_path, worker_terminal_id, reviewer_terminal_id)`
  └─ `DsBotCallbackClient` -> delivers `[MAC_JOB_RESULT ...]` back into `ds-bot`
  │
  ▼  Outbound AWS SSM tunnel (`13090 -> 13090`)
Mac Mini `mac-job-worker` (`cloud/mac-job-worker/worker.py`)
  ├─ Enforces `is_authorized_local_path` allowlist + case-insensitive APFS denylist
  ├─ Local non-GitHub folders (`local_only=True` / `cwd`):
  │   Auto-bootstraps a local `.git` root (preserving linked Git worktrees) and imports via `paradev projects create --local --import`
  └─ ParaDev workspace orchestration (`default_paradev_runner`):
      ├─ `role="worker"`   -> creates or reuses `worker_terminal_id` (`codex`, `devin` on SWE-2 Max, or `claude`)
      ├─ `role="reviewer"` -> creates or reuses separate `reviewer_terminal_id` in the SAME `workspace_id`
      └─ `agent="dsbot"`   -> executes local `dsh --profile headless` inside the ParaDev workspace's `worktreePath`
```

## Components

- `cloud/mac-job-broker/broker.py`: Durable SQLite job queue, ParaDev session registry (`/v1/paradev/sessions`), and Decision Mailbox (`/v1/decisions`).
- `cloud/mac-job-broker/mac-broker-mcp.mjs`: Stdio MCP server exposing `mac_enqueue_job`, `mac_job_status`, `mac_list_jobs`, `mac_cancel_job`, `mac_register_paradev_repo`, `mac_list_paradev_sessions`, `mac_git_sync`, and `decision_*` tools to `ds-bot`.
- `cloud/mac-job-worker/worker.py`: Outbound SSM tunnel manager and job runner on the Mac mini supporting `paradev`, `paradev_register`, `dsbot`, and `git_sync`.
- `cloud/decision-mailbox/decision-mailbox-mcp.mjs`: Local Mac stdio MCP server for logging and resolving decisions across Cloud and Mac with offline spooling.
