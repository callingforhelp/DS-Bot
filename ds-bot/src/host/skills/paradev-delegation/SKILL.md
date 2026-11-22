---
name: paradev-delegation
description: Delegate multi-agent coding, review, or repository tasks to ParaDev on this Mac inside a DS Bot background task using task_start so the foreground chat stays responsive.
---

# ParaDev delegation

Delegate long-running local coding, multi-repo orchestration, Xcode/macOS build, or code review tasks to ParaDev inside a DS Bot background task instead of blocking the foreground conversation.

## 1. Run ParaDev work inside a background task

1. Start a dedicated background task first via `task_start` with a short `title`, a concrete `brief` (goal, verification commands, expected output), and the target `workdir`.
2. Inside the background task, invoke `/Users/chief/.paradev/bin/paradev` (or your authorized repo workflow) so foreground chat remains idle and responsive for follow-up user or MCP messages.
3. Avoid concurrent edits in the same working copy: pass separate working directories or let ParaDev allocate isolated worktrees per worker/reviewer.

## 2. Monitor, steer, and collect results

- Call `task_list` to inspect active or settled background tasks.
- Call `task_send` to steer a running task or answer a follow-up question in its task session.
- Call `task_read` to inspect the full report file when task output is long or truncated.
- Call `task_stop` to cleanly stop a task and its spawned child jobs if the user cancels or changes direction.

## 3. Sync with Cloud Web Dev

- Before delegating to or pulling back from Cloud Web Dev (`location: cloud`), sync commits with `cloud_git_sync` (or coordinate with `cloud_exec`) so both Mac ParaDev and the cloud sandbox operate on matching branches and clean state.
- Report exact paths, commands run, test results, and any pending approvals to the caller without guessing unverified outcomes.
