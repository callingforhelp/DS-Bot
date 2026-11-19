# DS Bot lineage bridge

Reads a DS Bot home (`DSH_HOME`; `/data` in the DS Bot image) **read-only** and writes a versioned SQLite
archive of who asked whom to do what, and which Responding-to-Bots decisions refused it. The archive keeps ids,
times, reason codes, hashes and byte counts. It never stores message text, paths, workspace folders or Session titles.

```sh
node src/lineage/cli.mjs --home /data --db /lineage/lineage.sqlite --once           # one pass
node src/lineage/cli.mjs --home /data --db /lineage/lineage.sqlite --watch --interval 15000
node src/lineage/cli.mjs --db /lineage/lineage.sqlite --verify                       # read-only check, exit 1 on problems
```

`--db` must be outside `--home`. `--text-key-file` makes text hashes keyed HMACs instead of plain SHA-256. Output is
counts only.

## Sources

| Source | What it yields |
|---|---|
| `bot/state.json` | Bots, rooms, and which Bot/room each Session speaks for (chat, segment, part, group, room) |
| `sessions/<project>/<session>/session.vN.jsonl(.zstd)` | Message-tool calls and results: thrown refusals (`isError`), returned refusals (`post_to_group`), allowed and pending calls; routing on inbound messages |
| `bot/ledger/pair-*.jsonl` | Requests, replies, deliveries; a passive delivery is a suppressed result |
| `bot/ledger/group-<room>.jsonl` | Category notices (a group call refused for its task category) |
| `bot/logs/diagnostics.jsonl(.1)` | Policy refusals the other sources did not record (a repeat within 2 s of a structured denial is dropped) |

## Running it beside DS Bot

As a sidecar: mount the DS Bot home read-only and a separate writable folder for the archive, run as the same uid
as DS Bot (1000 in the image) because Session files are mode 0600, and keep it off host networking (see RISKS.md R38).

## Contract

The schema is `schema.mjs` (contract C1, `PRAGMA user_version = 1`). `rev` grows by one when a tracked field
changes (kind, outcome, reason, actor, target, room_id, action, task_id, run_id); a decided outcome never returns to
`pending`; rows are never deleted. Row ids are `sha256(parts joined by NUL)[0:40]`. Names that do not resolve to a Bot
are stored as `unresolved:<12 hex>`. Policy reason codes (contract C2) are `POLICY_REASONS` in `refusals.mjs`.

The pieces: `readers.mjs` (file access), `owners.mjs`, `refusals.mjs` (pure classifiers), `link.mjs` (task/run/event
linking, a time-window heuristic carried over from the proof of concept), `pass.mjs` (one pass, one transaction),
`archive.mjs` (writer), `cli.mjs` (the only place they are composed).
