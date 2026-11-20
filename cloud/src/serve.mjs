// Entry point for the container or any host: builds the real dependencies from the environment
// and starts the controller. Nothing is read from a file in the image; secrets come from the
// environment or a mounted file. Missing optional services fall back to the local stand-ins and
// say so in the log, so a half-configured host is never mistaken for a fully remote one.
import { readFileSync } from 'node:fs'
import { validatePrincipals } from './api.mjs'
import { startController } from './controller-service.mjs'
import { createDaytonaMachineManager, mockDaytonaClient } from './daytona-machine.mjs'
import { mockEmbedder, openaiEmbedder } from './embed.mjs'
import { createSandboxMessageHandler } from './machine-handler.mjs'
import { pgMachineStore } from './machine-store.mjs'
import { localObjectStore } from './objectstore.mjs'
import { r2ClientFromEnv, r2ObjectStore } from './r2store.mjs'
import { appPool } from './remote.mjs'
import { daytonaProvider } from './daytona.mjs'
import { mockDaytona } from './worker.mjs'

const env = process.env
const say = (...a) => console.log(new Date().toISOString(), ...a)

if (!env.PRINCIPALS_FILE) { console.error('PRINCIPALS_FILE (a JSON file of principals, mounted as a secret) is required'); process.exit(2) }
let principals
try { principals = JSON.parse(readFileSync(env.PRINCIPALS_FILE, 'utf8')) } catch { console.error('PRINCIPALS_FILE is not readable JSON'); process.exit(2) }
if (!principals.worker) { console.error('principals must include a "worker" principal'); process.exit(2) }
const principalErrors = validatePrincipals(principals)
if (principalErrors.length) { for (const e of principalErrors) console.error(`principals: ${e}`); process.exit(2) }

const pool = appPool(env, Number(env.DB_POOL_MAX || 8))
const haveR2 = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'].every(k => env[k])
const objectStore = haveR2
  ? r2ObjectStore({ client: r2ClientFromEnv(env), bucket: env.R2_BUCKET, secret: env.UPLOAD_TOKEN_SECRET ?? principals.worker.secret })
  : localObjectStore({ root: env.OBJECTS_DIR ?? '/tmp/ds-bot-objects', secret: env.UPLOAD_TOKEN_SECRET ?? principals.worker.secret })
const embedder = env.OPENAI_API_KEY && env.OPENAI_EMBEDDINGS_CONSENT === 'yes'
  ? openaiEmbedder({ apiKey: env.OPENAI_API_KEY, consentExternalTransfer: true })
  : mockEmbedder()
const provider = env.DAYTONA_API_KEY ? daytonaProvider({ apiKey: env.DAYTONA_API_KEY }) : mockDaytona()
const tenants = [...new Set(Object.values(principals).flatMap(p => p.tenants))]
const machineStore = pgMachineStore({ pool, tenants })
const machines = env.DAYTONA_API_KEY
  ? createDaytonaMachineManager({ apiKey: env.DAYTONA_API_KEY, store: machineStore })
  : createDaytonaMachineManager({ client: mockDaytonaClient(), store: machineStore })

say(`object store: ${haveR2 ? 'Cloudflare R2' : 'LOCAL stand-in (not durable)'}`)
say(`embeddings: ${embedder.model}${embedder.model.startsWith('mock') ? ' (mock; no consent or key)' : ''}`)
say(`sandboxes: ${env.DAYTONA_API_KEY ? 'Daytona' : 'LOCAL mock (no isolation)'}`)
say(`persistent machines: ${env.DAYTONA_API_KEY ? 'Daytona' : 'LOCAL mock'}`)

const localTenants = (env.EMBED_LOCAL_TENANTS ?? '').split(',').map(t => t.trim()).filter(Boolean)
if (localTenants.length) say(`embeddings for ${localTenants.join(', ')}: local only (EMBED_LOCAL_TENANTS)`)

const ctl = await startController({
  pool, principals, embedder, localEmbedder: mockEmbedder(), localTenants, objectStore, provider, machines,
  machineMessageHandler: createSandboxMessageHandler(),
  host: env.HOST ?? '127.0.0.1', port: Number(env.PORT ?? 8080),
  bucket: haveR2 ? env.R2_BUCKET : 'artifacts', instance: env.INSTANCE_ID ?? `ctl-${process.pid}`, log: (...a) => say(...a),
})
say(`listening on ${ctl.base}`)
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, async () => { say(`${signal}: stopping`); await ctl.stop(); await pool.end(); process.exit(0) })
}
