# DS Bot Cloud Runtime & Observability: isolated MVP (local, not deployed)

Built in a separate workspace from the handoff dated 18 Nov 2026. Nothing here touches
`/Applications/DS Bot.app`, `~/.ds-bot`, a live team, a cloud account, or any repository. Nothing was
pushed, deployed or purchased. Every external service is a **local stand-in**, listed below.

## Run it

```sh
npm install
npm run pg:start      # throwaway Postgres 16 on 127.0.0.1:54329, data in ./.pg (git-ignored)
npm test              # 16 tests, each file on its own fresh database
npm run bench         # retrieval benchmark -> docs/benchmark-report.md
node scripts/drill.mjs   # backup + restore into an empty database, digests compared
npm run pg:stop
```

## What is real and what is a stand-in

| Piece | In this MVP | Status |
|---|---|---|
| PostgreSQL schema, RLS, FTS (`tsvector`, GIN, `ts_rank_cd`), outbox, idempotent ingest | Real, on local Postgres 16 | Verified by tests |
| Remote database | `scripts/remote.mjs migrate` / `smoke` against database `ds_bot` on the existing RDS instance (PostgreSQL 18.3, pgvector 0.8.1), through an SSM tunnel, restricted login, TLS verified against the RDS host name | **Verified 18 Nov 2026**: schema applied, 8/8 smoke checks passed. Not yet run: the full 18-test suite remotely (it creates databases, which the restricted login must not) |
| Vector search | pgvector (`embedding_v`, cosine `<=>`) when migration 002 is applied, else `real[]` + SQL cosine | Verified locally (pgvector 0.8.7) and on RDS (0.8.1); ranks agree with the array fallback. No HNSW index yet |
| Embeddings | Offline hashed mock. `openaiEmbedder` is written but **never called** | OpenAI path unverified; needs key + explicit consent flag |
| Daytona | `mockDaytona`: a temp directory, deleted after the job | **Not Daytona.** No account, key or volume tested; FUSE volumes not exercised |
| S3/R2 | `localObjectStore`: immutable objects, per-key expiring upload tokens | Real S3 policy / pre-signed URLs unverified |
| Controller | Single-writer lease via Postgres advisory lock + dispatch loop | **Not the official DS Bot Docker image.** No EC2/EBS, no DSH `/data` |
| Signed API | HMAC, timestamp window, single-use nonce, tenant from principal | Verified by tests. WeChat callback signing **not implemented** |
| Lineage ingestion | Adapter over the PoC `lineage.sqlite` layout | Tested on a synthetic fixture only; the real PoC output was not read |
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
worker, object store, authz, bridge adapter · `test/` · `scripts/` Postgres helper, benchmark, restore drill ·
`docs/openapi.yaml`, `docs/benchmark-report.md`, `docs/wp0-inventory.md` · `infra/` staging template · `env.example`.
