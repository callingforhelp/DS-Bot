import { randomUUID } from 'node:crypto'

// Actions that change something outside the sandbox. A message between Bots, or a Bot's own
// words, is never an approval: only a row written by an authenticated human principal is.
export const PROTECTED = new Set(['git.push', 'git.merge', 'deploy', 'secret.use', 'workspace.write',
  'memory.purge_hard', 'skill.publish_org', 'transcript.export_external', 'device.revoke'])

// Org RBAC for the protected team-memory actions. This is the role floor: the action still needs a
// human approval row in the ledger (authorizeAction). Roles rank member < admin < owner.
const ORG_RANK = { member: 1, admin: 2, owner: 3 }
const MIN_ORG_ROLE = { 'memory.purge_hard': 'admin', 'skill.publish_org': 'admin', 'device.revoke': 'admin', 'transcript.export_external': 'owner' }
export const orgRoleAllows = (orgRole, action) => {
  const min = MIN_ORG_ROLE[action]
  return min === undefined || (ORG_RANK[orgRole] ?? 0) >= ORG_RANK[min]
}
// Throws a 403-shaped error unless the principal's org role meets the action's floor.
export function requireOrgRole(p, action) {
  if (!orgRoleAllows(p?.org_role, action)) throw Object.assign(new Error(`org role ${p?.org_role ?? 'none'} cannot ${action}`), { status: 403 })
}

export async function recordDecision(c, { tenant, project, run, actor, action, scope, verdict, reason, approvalRef }) {
  const id = randomUUID()
  await c.query(
    `insert into authorizations (tenant_id, project_id, auth_id, run_id, actor, action, scope, verdict, reason, approval_ref)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [tenant, project, id, run ?? null, actor, action, scope, verdict, reason, approvalRef ?? null])
  return id
}

// A human approval, scoped to one action, scope and run.
export async function recordHumanApproval(c, { tenant, project, run, human, action, scope }) {
  const approvalRef = `approval:${randomUUID()}`
  await recordDecision(c, { tenant, project, run, actor: `human:${human}`, action, scope, verdict: 'allow', reason: 'approved by a human', approvalRef })
  return approvalRef
}

// The tool-side gate. It reads the ledger, never the request: a protected action runs only
// if a human's allow row for exactly this action, scope and run exists. Every attempt, allowed
// or denied, is written down with its reason.
export async function authorizeAction(c, { tenant, project, run, actor, action, scope }) {
  if (!PROTECTED.has(action)) {
    await recordDecision(c, { tenant, project, run, actor, action, scope, verdict: 'allow', reason: 'not a protected action' })
    return { allow: true }
  }
  const { rows } = await c.query(
    `select approval_ref from authorizations where tenant_id = $1 and run_id = $2 and action = $3 and scope = $4
       and verdict = 'allow' and actor like 'human:%' and approval_ref is not null order by decided_at desc limit 1`, [tenant, run, action, scope])
  if (rows.length === 0) {
    await recordDecision(c, { tenant, project, run, actor, action, scope, verdict: 'deny', reason: 'no human approval on record for this action, scope and run' })
    return { allow: false, reason: 'approval-required' }
  }
  await recordDecision(c, { tenant, project, run, actor, action, scope, verdict: 'allow', reason: 'human approval on record', approvalRef: rows[0].approval_ref })
  return { allow: true, approvalRef: rows[0].approval_ref }
}
