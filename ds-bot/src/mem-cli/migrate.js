// dsbot-mem migrate-memory: index a folder of Markdown memory files (default ~/agent-memory).
// The source is only read. Each `##` section is stored once, keyed by its content hash.
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { cleanTopic, looksSecret, MEM_LIMITS, readJson, writeJsonAtomic } from './local-store.js'

export const DEFAULT_SOURCE = join(homedir(), 'agent-memory')
const sha = (s) => createHash('sha256').update(s).digest('hex')

export function splitSections(markdown) {
  const sections = []
  let heading = ''
  let lines = []
  const flush = () => {
    const body = lines.join('\n').trim()
    if (body) sections.push({ heading, body })
    lines = []
  }
  for (const line of markdown.split('\n')) {
    const m = /^##\s+(.*)$/.exec(line)
    if (m) { flush(); heading = m[1].trim() } else lines.push(line)
  }
  flush()
  return sections
}

// Drops secret-looking lines and reports file and line numbers only, never the text.
export function screen(body) {
  const kept = []
  const skipped = []
  body.split('\n').forEach((line, i) => (looksSecret(line) ? skipped.push(i + 1) : kept.push(line)))
  return { text: kept.join('\n').trim(), skipped }
}

// Plans the import. With a store and dryRun=false it also writes memories and the manifest.
export function migrateMemory({ source = DEFAULT_SOURCE, dir, store = null, dryRun = true, now = () => new Date().toISOString() }) {
  const manifestFile = join(dir, 'migration-manifest.json')
  const manifest = readJson(manifestFile, { files: {} })
  const index = (() => { try { return readFileSync(join(source, 'MEMORY.md'), 'utf8') } catch { return '' } })()
  const files = readdirSync(source).filter(f => f.endsWith('.md')).sort()
  const report = { source, dryRun, files: [], added: 0, unchanged: 0, secretLinesSkipped: 0 }
  for (const file of files) {
    const raw = readFileSync(join(source, file), 'utf8')
    const topic = cleanTopic(file.replace(/\.md$/, ''))
    const entry = { file, topic, sha256: sha(raw), indexed: file === 'MEMORY.md' || index.includes(`[[${file.replace(/\.md$/, '')}]]`), sections: 0, added: 0, skipped: [] }
    const done = manifest.files[file]?.sections ?? {}
    const next = {}
    splitSections(raw).forEach((sec, i) => {
      const { text, skipped } = screen(sec.body)
      entry.skipped.push(...skipped.map(n => ({ section: i, line: n })))
      report.secretLinesSkipped += skipped.length
      if (!text) return
      entry.sections++
      const h = sha(`${sec.heading}\n${text}`)
      next[i] = h
      if (done[i] === h) { report.unchanged++; return }
      entry.added++
      report.added++
      if (!dryRun && store) {
        const head = sec.heading ? `${sec.heading}\n` : ''
        store.save({ text: `${head}${text}`.slice(0, MEM_LIMITS.text), topic, scope: 'team', kind: 'doc', source: `agent-memory/${file}#${i}`, session: `agent-memory:${file}` })
      }
    })
    manifest.files[file] = { sha256: entry.sha256, importedAt: dryRun ? manifest.files[file]?.importedAt ?? null : now(), sections: dryRun ? done : next }
    report.files.push(entry)
  }
  if (!dryRun) writeJsonAtomic(manifestFile, manifest)
  return report
}
