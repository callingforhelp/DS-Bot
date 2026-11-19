# AWS resources created for the cloud MVP (19 Nov 2026)

Created in the existing Flinter account (us-east-2) with the user's explicit approval, all tagged
`Project=ds-bot-cloud-mvp`. Nothing else in the account was changed. No secrets appear in this file.

| Resource | ID / name | Purpose |
|---|---|---|
| EC2 instance | `i-0c1117f3148176425` (`ds-bot-controller`, t3.small, Amazon Linux 2023, IMDSv2 required, 16 GB encrypted gp3) | Runs the controller container |
| Security group | `sg-081612086c2e0261a` (`ds-bot-controller`) | **No inbound rules**; outbound only |
| Rule on `flinter-rds-postgres` | `sgr-0eafad21363df7e66` (tcp 5432 from `sg-081612086c2e0261a`) | The only change to an existing Flinter resource |
| IAM role + instance profile | `ds-bot-controller` | `AmazonSSMManagedInstanceCore` + `GetSecretValue` on one secret only + an explicit **deny** on Parameter Store reads (the managed SSM policy otherwise allows `ssm:GetParameter*` on every parameter in the account). Verified with the IAM policy simulator: own secret allowed, a Flinter secret denied, parameter reads denied |
| Secrets Manager secret | `ds-bot/controller-env` | Controller settings (DB login, R2, Daytona, OpenAI, principals) |
| Database (inside the existing RDS) | `ds_bot` + login `ds_bot_app` | Created 18 Nov; cannot connect to any other database on the instance |

Placement: the bastion's subnet `subnet-028d0584dad035672` in `vpc-0d90aa7ac1485e1f2`. The subnet routes to an internet
gateway and has no NAT, so the instance has a public IPv4 address for outbound traffic only; its security group admits nothing.
Access is through AWS Systems Manager only. The controller listens on `127.0.0.1:8080` inside the instance.

Verified on the instance: Docker image built from `cloud/Dockerfile`; `/ready` reaches RDS directly through the rule above
(no tunnel); a signed task was dispatched by the controller, run in a real Daytona sandbox, and its artifact stored in R2
with a matching digest; all test rows and objects removed. **Restart:** after an instance reboot the container came back
on its own (Docker restart policy), `/ready` passed and a signed task ran end to end again.

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
- No automatic redeploy: code is copied by SSM and the image rebuilt on the instance.

## Teardown (in this order)

```sh
P="--profile flinter --region us-east-2"
aws ec2 terminate-instances $P --instance-ids i-0c1117f3148176425
aws ec2 wait instance-terminated $P --instance-ids i-0c1117f3148176425
aws ec2 revoke-security-group-ingress $P --group-id sg-040556e5e54989837 --security-group-rule-ids sgr-0eafad21363df7e66
aws ec2 delete-security-group $P --group-id sg-081612086c2e0261a
aws iam remove-role-from-instance-profile --profile flinter --instance-profile-name ds-bot-controller --role-name ds-bot-controller
aws iam delete-instance-profile --profile flinter --instance-profile-name ds-bot-controller
aws iam delete-role-policy --profile flinter --role-name ds-bot-controller --policy-name ds-bot-read-own-secret
aws iam delete-role-policy --profile flinter --role-name ds-bot-controller --policy-name ds-bot-deny-parameter-reads
aws iam detach-role-policy --profile flinter --role-name ds-bot-controller --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
aws iam delete-role --profile flinter --role-name ds-bot-controller
aws secretsmanager delete-secret $P --secret-id ds-bot/controller-env   # 30-day recovery window by default
# Database: as the instance owner, DROP DATABASE ds_bot; DROP ROLE ds_bot_app;
```
