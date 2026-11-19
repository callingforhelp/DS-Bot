# WP0 inventory (read only, 18 Nov 2026)

Recorded from this machine. Gaps are gaps; nothing below is guessed.

| Item | Finding |
|---|---|
| Local tools | node 24, pnpm, psql/postgres 16.16, aws CLI present; terraform absent; Docker CLI present but the daemon was down |
| pgvector | Not installed locally. Vector column is the `real[]` fallback; the pgvector migration is written, not run |
| Credentials in the environment | No `AWS_*`, `DAYTONA*` or `OPENAI*` variables. No cloud call was possible or attempted |
| DS Bot Docker | `docker/README.md` (read from the dev checkout): `/data` for DSH sessions/team, `/workspace` for files; built locally from source. **Image digest not verified**; not built or run here |
| Docker permissions | Per the handoff and SECURITY_MODEL, bots run with Full access in the container. Not re-verified here |
| Responding-to-Bots branch | `feat/responding-to-bots` at `ac0f4de2` (7 commits, local). Porting to the cloud image is not done; the controller here is a stand-in |
| WeChat in server mode | Not checked. No callback implementation exists here |
| Bridge PoC | `test-env/observe-poc/bridge/bridge.mjs` (576 lines) and `lineage.sqlite` exist; the adapter was built from the PoC's source header and table layout. The database contents were not ingested |
| dsh-observe | Not located or pinned. Version 0.2.27 vs 0.2.28 discrepancy unresolved; needs package source, lockfile and digest |
| Accounts | AWS staging role, managed Postgres with pgvector, Daytona project, S3/R2 bucket, OpenAI project, WeChat test bot: none available |

Next, in order: pin the DS Bot image digest and DSH version; verify dsh-observe provenance; obtain the staging
accounts through a secret manager; replace each stand-in one at a time, re-running the same test suite against it.
