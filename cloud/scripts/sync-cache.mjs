// Syncs remote DS Bot controller state (machines, authorizations, lineage search) into a local
// read-only cache (~/.ds-bot/cloud-cache/latest.json) so remote jobs can be viewed offline.
// Usage:
//   node scripts/sync-cache.mjs            # sync from 127.0.0.1:8080, fall back to cache if offline
//   node scripts/sync-cache.mjs --offline  # read cached state without network calls
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { apiClient } from '../src/client.mjs'

const cacheDir = join(homedir(), '.ds-bot', 'cloud-cache')
const cachePath = join(cacheDir, 'latest.json')
const credPath = process.env.DS_BOT_OPERATOR_FILE ?? join(cacheDir, 'operator.json')
const baseUrl = process.env.CONTROLLER_URL ?? 'http://127.0.0.1:8080'
const projectId = process.env.PROJECT ?? 'dsbot-aws-staging'
const offlineOnly = process.argv.includes('--offline')

function readCache() {
  try {
    return JSON.parse(readFileSync(cachePath, 'utf8'))
  } catch {
    return null
  }
}

function writeCache(data) {
  mkdirSync(cacheDir, { recursive: true })
  const tmp = join(dirname(cachePath), `.latest.${process.pid}.tmp`)
  writeFileSync(tmp, JSON.stringify(data, null, 2))
  renameSync(tmp, cachePath)
}

function printSummary(data, source) {
  console.log(`[${source}] syncedAt=${data.syncedAt} project=${data.projectId} tenant=${data.tenant}`)
  const machines = data.machines ?? []
  console.log(`Machines (${machines.length}):`)
  for (const m of machines) {
    console.log(`  - ${m.name ?? m.id} [${m.state ?? m.status ?? 'unknown'}] snapshot=${m.snapshot ?? '-'} project=${m.labels?.project ?? m.projectId ?? '-'}`)
  }
  const auths = data.authorizations ?? []
  console.log(`Authorizations (${auths.length}):`)
  for (const a of auths.slice(0, 10)) {
    console.log(`  - ${a.occurred_at ?? a.at ?? ''} ${a.outcome ?? a.verdict ?? ''} ${a.action ?? ''} ${a.summary ?? a.reason ?? ''}`.trim())
  }
  const hits = data.events ?? []
  console.log(`Events (${hits.length}):`)
  for (const e of hits.slice(0, 10)) {
    console.log(`  - ${e.occurred_at ?? ''} ${e.kind ?? ''} ${e.summary ?? ''}`.trim())
  }
}

if (offlineOnly) {
  const cached = readCache()
  if (!cached) {
    console.error(`No offline cache found at ${cachePath}. Run without --offline while connected first.`)
    process.exit(1)
  }
  printSummary(cached, 'offline-cache')
  process.exit(0)
}

let creds
try {
  creds = JSON.parse(readFileSync(credPath, 'utf8'))
} catch {
  console.error(`Missing operator credentials at ${credPath}`)
  process.exit(2)
}

const tenant = creds.tenant ?? 'dsbot-cloud'
const api = apiClient({ baseUrl, principal: creds.id ?? 'operator', secret: creds.secret, tenant })

try {
  const [machinesRes, authRes, searchRes] = await Promise.all([
    api('GET', '/v1/machines'),
    api('GET', `/v1/authorizations?project_id=${encodeURIComponent(projectId)}&limit=50`),
    api('POST', '/v1/search', { project_id: projectId, query: 'dsbot', mode: 'lexical', limit: 50 }).catch(() => ({ status: 0, body: { hits: [] } })),
  ])
  if (machinesRes.status < 200 || machinesRes.status >= 300) {
    throw new Error(`/v1/machines HTTP ${machinesRes.status}: ${JSON.stringify(machinesRes.body)}`)
  }
  if (authRes.status < 200 || authRes.status >= 300) {
    throw new Error(`/v1/authorizations HTTP ${authRes.status}: ${JSON.stringify(authRes.body)}`)
  }

  const snapshot = {
    syncedAt: new Date().toISOString(),
    baseUrl,
    tenant,
    projectId,
    machines: machinesRes.body?.machines ?? [],
    authorizations: authRes.body?.items ?? authRes.body?.authorizations ?? [],
    events: searchRes.body?.hits ?? searchRes.body?.results ?? [],
  }
  writeCache(snapshot)
  printSummary(snapshot, 'online->cached')
} catch (err) {
  const cached = readCache()
  if (cached) {
    console.error(`Controller unreachable (${err.message}); falling back to local cache.`)
    printSummary(cached, 'offline-fallback')
    process.exit(0)
  }
  console.error(`Sync failed and no cache exists: ${err.message}`)
  process.exit(1)
}
