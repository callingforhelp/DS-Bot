// The lineage sidecar: one bridge pass over the DS Bot home into the archive, then ship the
// archive's new rows to the controller, then write a status file; repeat. Configured from the
// environment (see cloud/src/lineage/README.md). Prints counts only.
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { envelopesFromLineage } from './bridge-adapter.mjs'
import { apiClient } from './client.mjs'
import { openArchive } from './lineage/archive.mjs'
import { runPass } from './lineage/pass.mjs'
import { readers } from './lineage/readers.mjs'
import * as classify from './lineage/refusals.mjs'
import { openShipState, shipOnce } from './lineage/ship.mjs'

const env = process.env
const fail = message => { console.error(`lineage-sidecar: ${message}`); process.exit(2) }
const inside = (root, path) => { const r = relative(root, path); return r === '' || (!r.startsWith('..') && !isAbsolute(r)) }

const home = resolve(env.LINEAGE_HOME ?? '/data')
const dbPath = resolve(env.LINEAGE_DB ?? '/lineage/lineage.sqlite')
const statePath = resolve(env.SHIP_STATE ?? '/lineage/shipped.sqlite')
const statusPath = resolve(env.STATUS_FILE ?? '/lineage/status.json')
// Checked before any secret is read.
for (const [name, path] of [['LINEAGE_DB', dbPath], ['SHIP_STATE', statePath], ['STATUS_FILE', statusPath]]) if (inside(home, path)) fail(`${name} must be outside LINEAGE_HOME`)
for (const k of ['INSTALL_ID', 'TENANT', 'PROJECT', 'LINEAGE_PRINCIPAL_FILE']) if (!env[k]) fail(`${k} is required`)
if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(env.INSTALL_ID)) fail('INSTALL_ID must match ^[a-z0-9][a-z0-9-]{0,39}$')
const interval = env.INTERVAL_MS === undefined ? 15_000 : Number(env.INTERVAL_MS)
if (!Number.isInteger(interval) || interval < 5000) fail('INTERVAL_MS must be an integer of at least 5000')
let principal
try { principal = JSON.parse(readFileSync(env.LINEAGE_PRINCIPAL_FILE, 'utf8')) } catch { fail('LINEAGE_PRINCIPAL_FILE is not readable JSON') }
if (typeof principal?.id !== 'string' || typeof principal?.secret !== 'string') fail('LINEAGE_PRINCIPAL_FILE must hold {id, secret}')
const textKey = env.LINEAGE_TEXT_KEY_FILE ? readFileSync(env.LINEAGE_TEXT_KEY_FILE) : undefined
const post = apiClient({ baseUrl: env.CONTROLLER_URL ?? 'http://127.0.0.1:8080', principal: principal.id, secret: principal.secret, tenant: env.TENANT })
principal = undefined

const archive = openArchive(dbPath)
const shipState = openShipState(statePath)
const status = { at: null, lastOkAt: null, pass: null, ship: null, consecutiveFailures: 0 }
const writeStatus = () => {
  const tmp = join(dirname(statusPath), `.status.${process.pid}.tmp`)
  writeFileSync(tmp, JSON.stringify(status))
  renameSync(tmp, statusPath)
}

async function once() {
  const pass = await runPass({ home, archive, readers, classify, textKey })
  if (pass.rotated) console.error('lineage-sidecar: diagnostics rotated between passes')
  if (pass.cleared) console.error('lineage-sidecar: diagnostics cleared between passes')
  const ship = await shipOnce({
    envelopes: envelopesFromLineage(dbPath, { tenant: env.TENANT, project: env.PROJECT, installId: env.INSTALL_ID }),
    state: shipState, post, log: line => console.error(`lineage-sidecar: ${line}`),
  })
  status.at = Date.now()
  status.pass = { counts: pass.counts, torn: pass.torn, rotated: pass.rotated, cleared: pass.cleared }
  status.ship = ship
  const ok = ship.conflicts === 0 && ship.errors === 0
  status.consecutiveFailures = ok ? 0 : status.consecutiveFailures + 1
  if (ok) status.lastOkAt = status.at
  writeStatus()
  console.log(JSON.stringify({ pass: { authorizations: pass.counts.authorizations, events: pass.counts.events, torn: pass.torn }, ship }))
  return ok
}

let stopping = false
const close = () => { archive.close(); shipState.close() }
if (env.ONCE === '1') {
  let ok = false
  try { ok = await once() } catch (error) { console.error(`lineage-sidecar: pass failed: ${error?.code ?? error?.name ?? 'error'}`) }
  close()
  process.exit(ok ? 0 : 1)
}
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { stopping = true })
while (!stopping) {
  try { await once() } catch (error) {
    status.consecutiveFailures += 1
    status.at = Date.now()
    try { writeStatus() } catch { /* the next pass tries again */ }
    console.error(`lineage-sidecar: pass failed: ${error?.code ?? error?.name ?? 'error'}`)
  }
  const wait = status.consecutiveFailures === 0 ? interval : Math.min(300_000, interval * 2 ** Math.min(status.consecutiveFailures, 6))
  for (let t = 0; t < wait && !stopping; t += 500) await new Promise(r => setTimeout(r, 500))
}
close()
process.exit(0)
