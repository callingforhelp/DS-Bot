import { Daytona } from '@daytonaio/sdk'

// The real Daytona provider, same shape as mockDaytona (create / run / destroy). Sandboxes are
// created for one read-only job: ephemeral, no network at all, and a hard time-to-live, so a lost
// or crashed controller cannot leave one running. The sandbox gets the job's text and nothing
// else: no database, cloud or API credentials of ours.
export function daytonaProvider({ apiKey, ttlMinutes = 10 }) {
  if (!apiKey) throw new Error('DAYTONA_API_KEY is required')
  const client = new Daytona({ apiKey })
  return {
    async create({ volumeSubpath }) {
      const remote = await client.create({
        language: 'python', ephemeral: true, networkBlockAll: true, ttlMinutes, autoStopInterval: ttlMinutes,
        labels: { app: 'ds-bot-cloud-mvp', purpose: 'readonly-job' },
      }, { timeout: 120 })
      return { id: remote.id, volumeSubpath, remote, destroyed: false }
    },
    // Read-only work: count and hash the text the job carries, inside the sandbox.
    async run(sandbox, job) {
      if (job.kind !== 'readonly.summarize') throw new Error(`job kind not allowed in the MVP: ${job.kind}`)
      await sandbox.remote.fs.uploadFile(Buffer.from(String(job.payload?.text ?? ''), 'utf8'), '/tmp/job-input.txt')
      const code = "import hashlib,json;t=open('/tmp/job-input.txt','rb').read().decode();print(json.dumps({'words':len(t.split()),'lines':len(t.split(chr(10))),'sha256':hashlib.sha256(t.encode()).hexdigest()}))"
      const res = await sandbox.remote.process.executeCommand(`python3 -c "${code}"`, undefined, undefined, 60)
      if (res.exitCode !== 0) throw new Error(`sandbox command failed (exit ${res.exitCode})`)
      return JSON.parse(res.result.trim().split('\n').at(-1))
    },
    async destroy(sandbox) {
      await client.delete(sandbox.remote)
      sandbox.destroyed = true
    },
    // For the demo's proof that the sandbox is really gone.
    async exists(id) {
      try { await client.get(id); return true } catch { return false }
    },
  }
}
