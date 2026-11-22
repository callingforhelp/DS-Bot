# AWS resources created for the cloud MVP (19 Nov 2026)

Created in an existing AWS account (us-east-2) with the owner's explicit approval, all tagged
`Project=ds-bot-cloud-mvp`. This repository is public, so resource IDs are placeholders here; the real IDs are in the
git-ignored `infra/aws-staging.local.md`. Find them with:
`aws resourcegroupstaggingapi get-resources --tag-filters Key=Project,Values=ds-bot-cloud-mvp`.

| Resource | ID / name | Purpose |
|---|---|---|
| EC2 instance | `<INSTANCE_ID>` (`ds-bot-controller`, t3.small, Amazon Linux 2023, IMDSv2 required, 16 GB encrypted gp3) | Runs the controller container |
| Security group | `<CONTROLLER_SG_ID>` (`ds-bot-controller`) | **No inbound rules**; outbound only |
| Rule on `flinter-rds-postgres` | `<DB_RULE_ID>` (tcp 5432 from `<CONTROLLER_SG_ID>`) | The only change to an existing Flinter resource |
| IAM role + instance profile | `ds-bot-controller` | `AmazonSSMManagedInstanceCore` + `GetSecretValue` on one secret only + an explicit **deny** on Parameter Store reads (the managed SSM policy otherwise allows `ssm:GetParameter*` on every parameter in the account). Verified with the IAM policy simulator: own secret allowed, a Flinter secret denied, parameter reads denied |
| Secrets Manager secret | `ds-bot/controller-env` | Controller settings (DB login, R2, Daytona, OpenAI, principals) |
| Database (inside the existing RDS) | `ds_bot` + login `ds_bot_app` | Created 18 Nov; cannot connect to any other database on the instance |

Placement: the bastion's subnet `<SUBNET_ID>` in `<VPC_ID>`. The subnet routes to an internet
gateway and has no NAT, so the instance has a public IPv4 address for outbound traffic only; its security group admits nothing.
Access is through AWS Systems Manager only. The controller listens on `127.0.0.1:8080` inside the instance.

Verified on the instance: Docker image built from `cloud/Dockerfile`; `/ready` reaches RDS directly through the rule above
(no tunnel); a signed task was dispatched by the controller, run in a real Daytona sandbox, and its artifact stored in R2
with a matching digest; all test rows and objects removed. **Restart:** after an instance reboot the container came back
on its own (Docker restart policy), `/ready` passed and a signed task ran end to end again.

## DS Bot container (19 Nov 2026)

The official DS Bot image, built on the instance from the public fork at `feat/responding-to-bots` `2ee1a772`
(`docker/Dockerfile`, DSH 0.2.2-rc.1), runs as container `ds-bot`: DSH home `/opt/ds-bot/dsbot/data`, workspace
`/opt/ds-bot/dsbot/workspace`, web UI on `127.0.0.1:13080` only. One provider: GMI (`deepseek-ai/deepseek-v4.1-flash-1017`),
key from `GMI_API_KEY` in the secret, passed to this container alone. The team starts empty; nothing is imported from the Mac.
Permission mode is the image's own `danger-full-access` (see RISKS.md R2/R3). The login token is never written to Run
Command output; read it in an interactive Session Manager shell.

## Operating notes

- **Single writer.** This controller holds the writer lock in `ds_bot` for as long as it runs, so `scripts/daytona-demo.mjs`
  and `scripts/remote.mjs` run from a Mac can no longer dispatch (by design). Stop the container first
  (`docker stop ds-bot-controller` through SSM), or submit tasks to this controller instead.
- **Load on the shared database.** The controller checks for tasks every 2 seconds and keeps one connection open to the
  existing Flinter RDS instance. That is light, but it is constant; raise the interval or stop the container between demos
  if the shared database should be left alone.
- **Reach inside the VPC.** The instance sits in Flinter's VPC with unrestricted outbound traffic, so anything that trusts the
  VPC address range can be reached from it (the RDS group, for example, admits port 2049 from `172.31.0.0/16`). Harmless while
  nothing reaches the controller from outside; the security review must cover it before any exposure.
- **Secrets on disk.** `/opt/ds-bot/runtime.env` and `principals.json` hold the controller's keys in plaintext on the instance
  (root-only; also visible to anyone who can run `docker inspect`). Acceptable for this MVP.
- **Cost.** Runs continuously: roughly $15/month for the instance plus about $4/month for its public IPv4 address (estimates).

## Not done (blocking any internet exposure)

- TLS in front of the API and an independent security review (spec gates). The API is reachable only from the instance itself.
- OpenAI embeddings on this host stay the mock until `OPENAI_EMBEDDINGS_CONSENT=yes` is set in the secret.
- No automatic redeploy: code is copied by SSM and the image rebuilt on the instance (a deploy tool is designed, not built; RISKS.md R36).

## DS Bot audit pipeline (deployed 19 Nov 2026)

- **Migration 003** applied to `ds_bot` on the existing RDS (additive: authorizations gain target, room, source event and
  private-agent scoping). Remote smoke test 8/8 afterwards.
- **Secret** `ds-bot/controller-env` gained an `ingest` principal `dsbot-shipper` (tenant `dsbot-cloud`, source
  `ds-bot-lineage`, project `dsbot-aws-staging`), `LINEAGE_PRINCIPAL_JSON` (kept out of the controller's env and written to a
  root-owned 0400 file for the sidecar), tenant `dsbot-cloud` for `operator`, and `EMBED_LOCAL_TENANTS=dsbot-cloud` (removed
  the same day once the owner confirmed the OpenAI consent covers DS Bot audit data; all tenants now use text-embedding-3-small). Live principals were
  checked against the new startup rules first (both 48-character secrets, valid roles, none shared).
- **Controller** redeployed with the new code; the previous image is kept as `ds-bot-controller:prev`, and the swap rolls back
  automatically if `/ready` fails. The existing end-to-end check still passes 7/7.
- **Lineage sidecar** container `ds-bot-lineage`: controller image, `node src/lineage-sidecar.mjs`, uid 1000, `/data` read-only,
  `/opt/ds-bot/lineage` writable, the controller's network namespace (never host networking), read-only root, all
  capabilities dropped, 256 MB / 64 pids, restart unless stopped. After any controller swap it must be **recreated** (`docker rm -f` and run again), not restarted: it is pinned to the old controller container's network namespace. Status:
  `/opt/ds-bot/lineage/status.json` (counts only). Live probes: the shipper authenticates (an empty batch is refused as
  input, 400), cannot search (403); a wrong secret gets 401; `operator` can search and list refusals in `dsbot-cloud`.
  **No DS Bot data has flowed yet**: the cloud DS Bot has no Chief and no Sessions.

## Planned, not deployed

- **Off-host backup of DS Bot `/data`** on the instance: designed only; see RISKS.md R11 and R37.

The Mac side is covered separately: `scripts/backup-mac.mjs` backs up `~/.ds-bot`, the lineage archive and the
git-ignored `*.local.md` notes, encrypted, off the Mac (RISKS.md R49, R50). The real IDs in this file's local twin are
also recoverable from the `Project=ds-bot-cloud-mvp` tag query above.

## Teardown (in this order)

```sh
P="--profile flinter --region us-east-2"
aws ec2 terminate-instances $P --instance-ids <INSTANCE_ID>
aws ec2 wait instance-terminated $P --instance-ids <INSTANCE_ID>
aws ec2 revoke-security-group-ingress $P --group-id <DB_SG_ID> --security-group-rule-ids <DB_RULE_ID>
aws ec2 delete-security-group $P --group-id <CONTROLLER_SG_ID>
aws iam remove-role-from-instance-profile --profile flinter --instance-profile-name ds-bot-controller --role-name ds-bot-controller
aws iam delete-instance-profile --profile flinter --instance-profile-name ds-bot-controller
aws iam delete-role-policy --profile flinter --role-name ds-bot-controller --policy-name ds-bot-read-own-secret
aws iam delete-role-policy --profile flinter --role-name ds-bot-controller --policy-name ds-bot-deny-parameter-reads
aws iam detach-role-policy --profile flinter --role-name ds-bot-controller --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
aws iam delete-role --profile flinter --role-name ds-bot-controller
aws secretsmanager delete-secret $P --secret-id ds-bot/controller-env   # 30-day recovery window by default
# Database: as the instance owner, DROP DATABASE ds_bot; DROP ROLE ds_bot_app;
```
