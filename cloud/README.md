# DS Bot Cloud Runtime & Observability: isolated MVP (local, not deployed)

Built in a separate workspace from the handoff dated 18 Nov 2026. Nothing here touches
`/Applications/DS Bot.app`, `~/.ds-bot`, a live team, a cloud account, or any repository. Nothing was
pushed, deployed or purchased. Every external service is a **local stand-in**, listed below.

## Run it

```sh
npm install
npm run pg:start      # throwaway Postgres 16 on 127.0.0.1:54329, data in ./.pg (git-ignored)
npm test              # 80 tests, each file on its own fresh database
npm run bench         # retrieval benchmark -> docs/benchmark-report.md
node scripts/drill.mjs   # backup + restore into an empty database, digests compared
npm run pg:stop
```

## Backing up the Mac's DS Bot data

`~/.ds-bot` on the Mac is the only copy of every conversation, Session log, Bot, room and ledger line; RDS holds only
references back to it. The infra notes with the real AWS IDs and the full risk register are git-ignored on the same Mac.
`scripts/backup-mac.mjs` copies both off the Mac, encrypted (RISKS.md R49, R50):

```sh
node scripts/backup-mac.mjs backup --to-dir "/Volumes/<drive>/ds-bot-backups" --keep 14   # and/or --r2 (backups/mac/ in R2_BUCKET)
node scripts/backup-mac.mjs restore --from <file.dsbkp> --to ~/ds-bot-restore            # or --r2-key backups/mac/<file>
```

It includes `~/.ds-bot`, `~/.config/ds-bot-cloud` and `infra/*.local.md` (`--include-env` adds `cloud/.env`). The
passphrase is `DSBOT_BACKUP_PASSPHRASE` (environment or `.env`); store a copy in a password manager. Restore only writes
to an empty folder, never over `~/.ds-bot`, and checks every file against the manifest. Files written while the backup
runs may be caught mid-write; run it when DS Bot is idle, or daily from `launchd` (a `StartCalendarInterval` job running
the backup command above).

## DS Bot audit pipeline (implemented locally; not deployed)

```
DS Bot home (/data, read-only) -> src/lineage (bridge pass -> lineage.sqlite, schema v1)
  -> src/lineage-sidecar.mjs (ingest principal, POST /v1/events/batch, ordered, stops at a conflict)
  -> events + authorizations (migration 003; approval_ref always null) -> indexer -> POST /v1/search, GET /v1/authorizations
```

Sources: Session logs (thrown and returned Responding-to-Bots refusals, allowed and pending calls), the ledger
(passive deliveries, group category notices) and diagnostics (only refusals the structured sources missed). Keys are
stable per archive row and revision, so replays insert nothing. See `src/lineage/README.md`. Deploying it needs the
owner-approved AWS steps (migration 003 on the shared RDS, a new ingest principal in the secret, the sidecar container).
Coverage is bounded by what DS Bot writes to disk (RISKS.md R23).

## What is real and what is a stand-in

| Piece | In this MVP | Status |
|---|---|---|
| PostgreSQL schema, RLS, FTS (`tsvector`, GIN, `ts_rank_cd`), outbox, idempotent ingest | Real, on local Postgres 16 | Verified by tests |
| Remote database | `scripts/remote.mjs migrate` / `smoke` against database `ds_bot` on the existing RDS instance (PostgreSQL 18.3, pgvector 0.8.1), through an SSM tunnel, restricted login, TLS verified against the RDS host name | **Verified 18 Nov 2026**: schema applied, 8/8 smoke checks passed. Not yet run: the full 18-test suite remotely (it creates databases, which the restricted login must not) |
| Vector search | pgvector (`embedding_v`, cosine `<=>`) when migration 002 is applied, else `real[]` + SQL cosine | Verified locally (pgvector 0.8.7) and on RDS (0.8.1); ranks agree with the array fallback. No HNSW index yet |
| Embeddings | `openaiEmbedder` (text-embedding-3-small, 1536-d) | **Verified 19 Nov 2026** on the synthetic fixture only (`scripts/bench-remote.mjs`); consent for real transcripts still needs an explicit `yes` in `.env`. The mock remains the test default |
| Daytona | `daytonaProvider` (SDK 0.232.0): ephemeral sandbox, no network, 10-minute TTL, one read-only job; `mockDaytona` remains for tests | **Verified 19 Nov 2026** by `scripts/daytona-demo.mjs`: signed request -> RDS -> real sandbox -> result matched the local reference -> sandbox deleted -> evidence kept (8/8). Volumes **not** exercised (no volume configured) |
| Object storage | `r2ObjectStore` (Cloudflare R2 via the S3 API; conditional writes, digest recomputed on read, 5-minute upload tokens) and `localObjectStore` for tests | **Verified 19 Nov 2026** against the real bucket by `scripts/r2-check.mjs` (11/11: write, readback, digest, retry no-op, overwrite refused, R2 honours If-None-Match with 412, token and path guards, cleanup). Wired into `scripts/daytona-demo.mjs` and picked up automatically by `src/serve.mjs` |
| Controller | `src/serve.mjs` in the `cloud/Dockerfile` image | **Running on AWS EC2** (see `infra/aws-staging.md`), built on the instance, reaching RDS directly; a signed task ran end to end there (Daytona sandbox, artifact in R2), also after an instance reboot. While it runs it is the only writer, so the Mac demo scripts cannot dispatch. Internal only: no TLS, no inbound access, no independent security review yet |
| Signed API | HMAC, timestamp window, single-use nonce, tenant from principal | Verified by tests. WeChat callback signing **not implemented** |
| Lineage ingestion | DS Bot audit pipeline (below): bridge `src/lineage`, sidecar, ingest principal, refusals in `authorizations` | **Implemented locally, not deployed.** Tested end to end on a synthetic DS Bot home built from DS Bot and DSH source shapes; no real DS Bot data was read |
| dsh-observe / OTLP | Not integrated | WP0 gap: exact package, version (0.2.27 vs 0.2.28) and digest not pinned |

## What the tests prove (`npm test`)

Cloud task flow and evidence after sandbox deletion; bad/stale/replayed requests refused with nothing
admitted; idempotent task admission; scope, tenant and role enforced from the principal; single writer and
Mac-offline deferral without blocking cloud work; restart keeps timeline and undispatched work; a human
approval row (never agent text) is required for `git.push`, with allow and deny both on record; digest-checked,
immutable artifacts; events durable and replayable while the embedding provider is down; no cross-tenant or
private-agent leakage (including a hostile identifier); secrets redacted before indexing; prompts, reasoning
and self-asserted `verified_outcome` refused at ingest; synthetic lineage replay yields no duplicate rows.

## Not done / not claimed

- **No cloud smoke test passed**, because none was run. There is no AWS, Daytona, S3, OpenAI or WeChat integration.
- A real **conversation durability** test needs the real DS Bot controller; here "restart" means the API and
  database pool restarting, not DSH `/data` surviving. Mac-offline is modeled by routing, not a real Mac.
- The benchmark uses a 25-document synthetic corpus and a mock embedder. It says nothing about
  text-embedding-3-small. No reranker was trained. Fireworks-style eval is a design direction, not built.
- Security blocker from the handoff stands: the official Docker image runs bots with Full access. This MVP
  enables only a `read-only` scope, and `infra/docker-compose.staging.yml` is an unvalidated template.
- RLS note: the app role is non-superuser and cannot bypass policies, but the single `request_nonces` table
  is global, not per tenant, by design (replay protection). Production should also add rate limits/quotas.
- Not reviewed by an independent security reviewer. The handoff requires one before any exposure.

## Layout

`migrations/` schema (+ down script, optional pgvector) · `src/` ingest, indexer, search, API, controller,
worker, object store, authz, bridge adapter · `test/` · `scripts/` Postgres helper, benchmark, restore drill, Mac backup ·
`docs/openapi.yaml`, `docs/benchmark-report.md`, `docs/wp0-inventory.md` · `infra/` staging template · `env.example`.

## Remote results (19 Nov 2026, RDS + pgvector + real OpenAI embeddings, synthetic corpus)

See `docs/benchmark-report-remote.md`. On 25 documents and 11 queries, hybrid and vector search reached Recall@5 1.00
with text-embedding-3-small versus 0.85 for keyword search (paraphrase-only queries: 1.00 vs 0.67, three queries).
The sample is tiny, so treat it as a sanity check, not a measurement. Latencies (1.4-2.2 s per query) are dominated
by round trips through the SSM tunnel (a search runs several statements), not by pgvector. Index time for 27 events
was 65-84 s for the same reason. Run the service next to the database before drawing latency conclusions.

## Decisions (19 Nov 2026)

- **Controller host:** no AWS resources are created. The controller is packaged to run on any host; the host choice
  waits for a separate staging account (the existing AWS account belongs to another project and is not used for hosting).
- **Daytona volumes:** verified on the real account with a throwaway volume (persistence across sandboxes and per-tenant
  subpath isolation), then deleted. No volume is kept; create one per tenant on demand.
- **Object storage:** Cloudflare R2 (free tier: 10 GB-month, 1M Class A and 10M Class B operations per month, no egress
  fee for direct reads, per Cloudflare's pricing page; whether a card is required to enable R2 is unverified).

## Verified chain (19 Nov 2026)

`scripts/daytona-demo.mjs`, one run on real services, 10/10 checks: signed request -> admitted and recorded on RDS
(pgvector database) -> single-writer lease -> real Daytona sandbox (no network, deleted afterwards) -> artifact stored
in the real R2 bucket -> timeline and artifact digest intact after the sandbox is gone. The controller process itself
still ran on this Mac, reaching RDS through an SSM tunnel; no cloud host runs it yet.
