import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')

// A local stand-in for the Daytona SDK: a sandbox is a temporary directory that is deleted
// afterwards. UNVERIFIED against Daytona: no account or API key was available. It holds only
// what the job gives it, and no cloud or database credentials.
export function mockDaytona() {
  const live = new Map()
  return {
    live,
    async create({ volumeSubpath }) {
      const dir = mkdtempSync(join(tmpdir(), 'daytona-mock-'))
      mkdirSync(join(dir, 'volume', volumeSubpath), { recursive: true })
      const sandbox = { id: `sbx-${randomUUID()}`, dir, volumeSubpath, destroyed: false }
      live.set(sandbox.id, sandbox)
      return sandbox
    },
    async run(sandbox, job) { return execReadOnly(sandbox, job) },
    async destroy(sandbox) {
      rmSync(sandbox.dir, { recursive: true, force: true })
      sandbox.destroyed = true
      live.delete(sandbox.id)
    },
  }
}

// Read-only work only: summarize the text the job carries. No network, no repository, no push.
function execReadOnly(sandbox, job) {
  if (job.kind !== 'readonly.summarize') throw new Error(`job kind not allowed in the MVP: ${job.kind}`)
  const text = String(job.payload?.text ?? '')
  const scratch = join(sandbox.dir, 'volume', sandbox.volumeSubpath, 'input.txt')
  writeFileSync(scratch, text)
  return { words: (text.match(/\S+/g) ?? []).length, lines: text.split('\n').length, sha256: sha(text) }
}

// Runs one dispatched job end to end. The run ID and trace ID the controller assigned travel
// with every event. The sandbox gets one upload token for one key, never store credentials,
// and the result comes back as signed API calls, never as a direct database write.
export async function runJob({ provider, objectStore, api, bucket = 'artifacts', task, traceId = `trace-${randomUUID()}` }) {
  const { tenant, project, run_id: run, job } = task
  const sandbox = await provider.create({ volumeSubpath: `${tenant}/${project}` })
  let seq = 0
  const emit = (kind, extra = {}) => api('POST', '/v1/events', {
    schema_version: 1, tenant_id: tenant, project_id: project, event_id: `${run}-${kind}-${seq}`, run_id: run, agent_id: 'daytona-worker',
    trace_id: traceId, kind, occurred_at: new Date().toISOString(), source_system: 'daytona-worker', source_id: run, source_seq: seq++,
    source_sha256: sha(`${run}:${kind}:${seq}`), body: extra.body ?? {}, claimed_outcome: extra.claimed,
  })
  try {
    await emit('worker.started', { body: { summary: `sandbox ${sandbox.id} started read-only job ${job.kind}` } })
    const result = await provider.run(sandbox, job)
    const key = `${tenant}/${project}/${run}/result.json`
    const bytes = Buffer.from(JSON.stringify(result))
    const token = await objectStore.presign({ bucket, key })
    const stored = await objectStore.put({ bucket, key, token, bytes })
    const reg = await api('POST', '/v1/artifacts/register', { project_id: project, run_id: run, artifact_id: `${run}-result`, bucket, key, sha256: stored.sha256, bytes: stored.bytes, media_type: 'application/json', provenance: { sandbox: sandbox.id, trace_id: traceId } })
    if (reg.status !== 200) throw new Error(`artifact registration failed: ${reg.status}`)
    await emit('task.result', { claimed: 'completed', body: { summary: `read-only job finished: ${result.words} words`, commit: undefined } })
    return { result, artifact: { bucket, key, ...stored }, sandbox: sandbox.id }
  } catch (error) {
    await emit('task.result', { claimed: 'failed', body: { summary: `job failed: ${String(error.message).slice(0, 120)}` } }).catch(() => {})
    throw error
  } finally {
    await provider.destroy(sandbox)
    if (sandbox.dir && existsSync(sandbox.dir)) throw new Error('sandbox directory was not removed')
  }
}
