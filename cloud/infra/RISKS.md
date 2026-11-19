# Risk register: cloud MVP on AWS (19 Nov 2026)

Recorded at the owner's request: risks are noted, not mitigated, unless marked otherwise. Nothing here is exposed to the
internet: the instance has no inbound rules and every service listens on localhost.

| # | Risk | Status |
|---|---|---|
| R1 | **Containers could take the instance's AWS credentials.** With metadata hop limit 2, a container fetched an IMDSv2 token (verified: HTTP 200), so it could read `ds-bot/controller-env` (every key). | **Mitigated before this register was requested**: hop limit set to 1; the same container is now blocked; controller unaffected. Revert on request: `modify-instance-metadata-options --http-put-response-hop-limit 2` |
| R2 | **DS Bot runs with full access** (`DSH_PERMISSION_MODE=danger-full-access` in the official image), driven by a model, inside Flinter's VPC. A prompt-injected or confused bot can run any command in its container and reach anything the network allows. The spec lists this as a security blocker for remote use. | Open: accepted by the owner for this MVP. No remote traffic reaches it |
| R3 | **Reach inside Flinter's VPC.** Containers inherit the instance's network: RDS on 5432 (allowed for this security group), the `172.31.0.0/16` NFS rule on the RDS group, and Flinter's other instances. No egress firewall is in place. | Open |
| R4 | **Secrets in plaintext on disk**: `/opt/ds-bot/runtime.env`, `principals.json`, and the DS Bot model key; root-only, visible via `docker inspect`. | Open, accepted for the MVP |
| R5 | **Load on Flinter's shared production database**: polling every 2 s plus one held connection. | Open, light |
| R6 | **Public repository history** still contains AWS resource IDs (instance, security groups, VPC, subnet, managed-secret ID) on `cloud/mvp` and the fork's `dev`. IDs are not credentials. | Open: removing them needs a force-push |
| R7 | **The fork's `dev` is not a clean upstream base**: it contains `cloud/` and the feature merge. Upstream PR branches must be cut from `origin/dev`. | Open, process |
| R8 | **No TLS and no independent security review** (spec gates before any exposure). | Open: blocks exposure |
| R9 | **Parameter Store readable by the instance role** (managed SSM policy grants `ssm:GetParameter*` on `*`; 10 parameters exist). | Mitigated: explicit deny, verified with the policy simulator |
| R10 | **Model spend** once DS Bot runs: every bot turn calls a paid model. | Open: needs a spend ceiling from the owner |
| R11 | **Single host**: one t3.small runs the controller and DS Bot; no automatic redeploy, no off-host backup of DS Bot `/data` yet. | Open |
