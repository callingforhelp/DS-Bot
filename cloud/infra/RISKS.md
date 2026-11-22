# Risk register: cloud MVP on AWS (19 Nov 2026)

Recorded at the owner's request: risks are noted, not mitigated, unless marked otherwise. Nothing here is exposed to the
internet: the instance has no inbound rules and every host-published port is loopback only. Inside the instance, though, both
containers share Docker's default bridge (the controller binds 0.0.0.0 in its container, DS Bot binds its container IP), so
they can probably reach each other (R21).

| # | Risk | Status |
|---|---|---|
| R1 | **Containers could take the instance's AWS credentials.** With metadata hop limit 2, a container fetched an IMDSv2 token (verified: HTTP 200), so it could read `ds-bot/controller-env` (every key). | **Mitigated before this register was requested**: hop limit set to 1; the same container is now blocked; controller unaffected. Revert on request: `modify-instance-metadata-options --http-put-response-hop-limit 2` |
| R2 | **DS Bot runs with full access** (`DSH_PERMISSION_MODE=danger-full-access` in the official image), driven by a model, inside Flinter's VPC. A prompt-injected or confused bot can run any command in its container and reach anything the network allows. The spec lists this as a security blocker for remote use. | Open, **now live** (container `ds-bot` since 19 Nov 2026): accepted by the owner for this MVP. No inbound traffic reaches it, but the bot reads outbound content (web pages, tool output) that can carry prompt injection |
| R3 | **Reach inside Flinter's VPC.** Containers inherit the instance's network: RDS on 5432 (allowed for this security group), the `172.31.0.0/16` NFS rule on the RDS group, and Flinter's other instances. No egress firewall is in place. | Open |
| R4 | **Secrets in plaintext on disk**: `/opt/ds-bot/runtime.env`, `principals.json`, and the DS Bot model key; root-only, visible via `docker inspect`. | Open, accepted for the MVP |
| R5 | **Load on Flinter's shared production database**: polling every 2 s plus one held connection. See also R21 (`/ready` runs two queries, unauthenticated), R40 (nonce table growth), R32 (dispatch re-selects). | Open, light |
| R6 | **Public repository history** still contains AWS resource IDs (instance, security groups, VPC, subnet, managed-secret ID) on `cloud/mvp` and the fork's `dev`. IDs are not credentials. | Open: removing them needs a force-push |
| R7 | **The fork's `dev` is not a clean upstream base**: it contains `cloud/` and the feature merge. Upstream PR branches must be cut from `origin/dev`. | Open, process |
| R8 | **No TLS and no independent security review** (spec gates before any exposure). Without TLS, the unsigned `x-tenant`/`x-principal` headers can be swapped on path (R41). | Open: blocks exposure |
| R9 | **Parameter Store readable by the instance role** (managed SSM policy grants `ssm:GetParameter*` on `*`; 10 parameters exist). | Mitigated: explicit deny, verified with the policy simulator |
| R10 | **Model spend** once DS Bot runs: every bot turn calls a paid model (GMI). Daytona sandboxes and per-query OpenAI embeddings also spend without quotas (R32). | Open: no spend ceiling set yet |
| R12 | **The live GMI key is mirrored** into `ds-bot/controller-env` (owner's instruction). It is the same key as the Mac app's, so cloud usage bills to it, anyone with read access to that secret in the account can use it, and rotating it on the Mac leaves the cloud copy stale. It is kept out of the controller's env and goes only to DS Bot. | Open, accepted |
| R13 | **Real task summaries go to OpenAI** for embeddings (consent set to `yes` on 19 Nov 2026), after redaction. Redaction is a floor, not a guarantee. Search query text is embedded too, and DS Bot audit summaries would be (R39). | Open, accepted |
| R49 | **The Mac's `~/.ds-bot` is the only copy of everything real** (Session logs, Bots, rooms, ledger, diagnostics). RDS keeps only references such as `session:<id>#seq:<n>`; if the Mac's disk is lost, every reference points at nothing. The lineage archive in `~/.config/ds-bot-cloud` is derived from it and does not replace it. | Mitigated once run: `scripts/backup-mac.mjs backup` makes an encrypted (AES-256-GCM, scrypt passphrase) copy off the Mac, to a folder and/or R2 under `backups/mac/`, and `restore` proves every file digest. Still open until it is scheduled (README) and the passphrase is kept off the Mac |
| R50 | **The real AWS IDs and the R14-R48 detail exist only on one laptop**, in the git-ignored `infra/aws-staging.local.md` and `infra/RISKS.local.md` (they cannot be committed: the fork is public). | Mitigated once run: the same encrypted backup carries every `infra/*.local.md` (and `cloud/.env` with `--include-env`). The IDs can also be rebuilt from the `Project=ds-bot-cloud-mvp` tag (`aws-staging.md`); the review detail cannot |
| R11 | **Single host**: one t3.small runs the controller and DS Bot; no automatic redeploy, no off-host backup of DS Bot `/data` yet (backup design P12 pending; see R37 on what a backup would carry). | Open |

## Findings from the 19 Nov 2026 review (R14-R48)

A read-only review on 19 Nov 2026 (ten specialist reviewers, a critic and a planner) recorded 35 further findings,
R14-R48: 3 High, 22 Medium or Medium-Low, 8 Low or Low-Medium, 2 informational. They cover the DS Bot container's
isolation and credentials, the audit trail's tamper resistance, the API's roles and input handling, data redaction,
backups and the deploy process.

Their detail describes weaknesses of a running host, so it is kept out of this public repository, in the git-ignored
`infra/RISKS.local.md` on the owner's machine. Code fixes made for them (lineage ingest, redaction, API role gates and
validation, search scoping) are in this branch's history; the rest stay open by the owner's decision (noted, not mitigated).
