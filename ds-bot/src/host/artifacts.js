// Versioned team artifacts: specs, plans and notes that every Bot can read and update.
// The record lives in `state.artifacts[slug]`; the latest text is mirrored to
// `<home>/artifacts/<slug>.md` and indexed for search.
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { sanitizeText } from './ingest.js'
import { output } from './tools.js'

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/
const KINDS = new Set(['spec', 'plan', 'note', 'decision', 'handoff'])
const CONTENT_MAX = 200_000
const VERSIONS_MAX = 20
const TITLE_MAX = 200

const fail = (message, code = 'bot/invalid') => Object.assign(new Error(message), { code })

export const slugify = text =>
  String(text ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64).replace(/-+$/, '')

export function install(rt) {
  const { state } = rt
  const dir = () => join(rt.home, 'artifacts')
  const redact = text => (typeof rt.redactSecrets === 'function' ? rt.redactSecrets(text) : text)
  const store = () => (state.artifacts ??= {})

  function writeFile(slug, content) {
    mkdirSync(dir(), { recursive: true })
    const path = join(dir(), `${slug}.md`)
    const tmp = `${path}.tmp`
    writeFileSync(tmp, content, 'utf8')
    renameSync(tmp, path)
  }

  function index(art) {
    try {
      rt.memoryIndexUpsert?.({
        id: `artifact:${art.slug}`,
        kind: 'artifact',
        scopeKey: art.scope ?? 'team',
        botId: art.createdBy ?? null,
        repoKey: art.repo ?? null,
        topic: art.kind,
        title: art.title,
        body: art.content,
        meta: { slug: art.slug, kind: art.kind, tags: art.tags, version: art.version },
        isPrivate: false,
        createdAt: art.createdAt,
        updatedAt: art.updatedAt,
      })
    } catch (error) {
      rt.warn?.('ds-bot: artifact not indexed: %s', error?.message ?? error)
    }
  }

  const summary = art => ({
    slug: art.slug, title: art.title, kind: art.kind, version: art.version, tags: art.tags,
    repo: art.repo ?? null, createdBy: art.createdBy ?? null, updatedBy: art.updatedBy ?? null,
    createdAt: art.createdAt, updatedAt: art.updatedAt, bytes: art.content.length,
  })

  const artifactsView = () => Object.values(store()).map(summary).sort((a, b) => b.updatedAt - a.updatedAt)

  function getArtifact(slug, { version } = {}) {
    const art = store()[String(slug ?? '')]
    if (art === undefined) return undefined
    if (version === undefined || Number(version) === art.version) return { ...art, versions: undefined, history: art.versions.map(({ version: v, at, by }) => ({ version: v, at, by })) }
    const old = art.versions.find(item => item.version === Number(version))
    return old === undefined ? undefined : { ...art, content: old.content, version: old.version, versions: undefined, history: art.versions.map(({ version: v, at, by }) => ({ version: v, at, by })) }
  }

  async function saveArtifact(input = {}, actor = {}) {
    await rt.load?.()
    const readOnly = rt.readOnly?.()
    if (readOnly !== undefined) throw fail(readOnly, 'bot/read-only')
    const slug = input.slug === undefined ? slugify(input.title) : String(input.slug)
    if (!SLUG.test(slug)) throw fail('An artifact needs a slug of lowercase letters, digits and dashes (or a title to make one from).')
    const content = sanitizeText(String(input.content ?? ''), redact)
    if (content === '') throw fail('The artifact has no content (secrets and private spans are removed).')
    if (content.length > CONTENT_MAX) throw fail(`The artifact is over ${CONTENT_MAX} characters.`)
    const now = Date.now()
    const items = store()
    const old = items[slug]
    if (old !== undefined && input.baseVersion !== undefined && Number(input.baseVersion) !== old.version) {
      throw fail(`"${slug}" is at version ${old.version}, not ${Number(input.baseVersion)}. Read it again and merge.`, 'bot/conflict')
    }
    const kind = KINDS.has(input.kind) ? input.kind : old?.kind ?? 'note'
    const art = {
      slug,
      title: sanitizeText(String(input.title ?? old?.title ?? slug), redact).slice(0, TITLE_MAX) || slug,
      kind,
      scope: 'team',
      tags: Array.isArray(input.tags) ? input.tags.map(tag => String(tag).slice(0, 40)).slice(0, 12) : old?.tags ?? [],
      repo: input.repo ?? old?.repo ?? null,
      content,
      version: (old?.version ?? 0) + 1,
      createdBy: old?.createdBy ?? actor.botId ?? 'user',
      updatedBy: actor.botId ?? 'user',
      createdAt: old?.createdAt ?? now,
      updatedAt: now,
      versions: [...(old?.versions ?? []), { version: (old?.version ?? 0) + 1, at: now, by: actor.botId ?? 'user', content }].slice(-VERSIONS_MAX),
    }
    items[slug] = art
    writeFile(slug, `# ${art.title}\n\n${content}\n`)
    index(art)
    await rt.save?.()
    return summary(art)
  }

  async function deleteArtifact(slug) {
    await rt.load?.()
    const readOnly = rt.readOnly?.()
    if (readOnly !== undefined) throw fail(readOnly, 'bot/read-only')
    const key = String(slug ?? '')
    if (store()[key] === undefined) throw fail(`No artifact "${key}".`, 'bot/not-found')
    delete store()[key]
    try { rmSync(join(dir(), `${key}.md`), { force: true }) } catch { /* the record is gone either way */ }
    try { rt.memoryIndexDelete?.(`artifact:${key}`) } catch { /* index follows on next sync */ }
    await rt.save?.()
    return { slug: key, deleted: true }
  }

  // HTTP-style endpoint for the panel: GET list or one, PUT save, DELETE remove.
  async function artifactEndpoint({ method = 'GET', slug, body = {} } = {}) {
    const verb = String(method).toUpperCase()
    if (verb === 'GET') {
      if (slug === undefined) return { status: 200, body: { artifacts: artifactsView() } }
      const art = getArtifact(slug, { version: body.version })
      return art === undefined ? { status: 404, body: { error: 'No such artifact' } } : { status: 200, body: art }
    }
    try {
      if (verb === 'PUT' || verb === 'POST') return { status: 200, body: await saveArtifact({ ...body, ...(slug === undefined ? {} : { slug }) }, { botId: undefined }) }
      if (verb === 'DELETE') return { status: 200, body: await deleteArtifact(slug) }
    } catch (error) {
      return { status: error.code === 'bot/not-found' ? 404 : error.code === 'bot/conflict' ? 409 : 400, body: { error: error.message, code: error.code } }
    }
    return { status: 405, body: { error: 'Method not allowed' } }
  }

  rt.teamTools?.push(defineTool({
    name: 'bot_artifact',
    description: 'Share a versioned document with the whole team (spec, plan, note, decision, handoff). Actions: list, read, save, delete. Saving an existing slug makes a new version; pass baseVersion to avoid overwriting a teammate\'s newer edit.',
    parameters: {
      action: { type: 'string', required: true, description: '"list", "read", "save" or "delete"' },
      slug: { type: 'string', description: 'Lowercase id with dashes; made from the title when saving a new one' },
      title: { type: 'string', description: 'Title (save)' },
      kind: { type: 'string', description: 'spec, plan, note, decision or handoff (save)' },
      content: { type: 'string', description: 'The full text (save)' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags (save)' },
      baseVersion: { type: 'number', description: 'The version you read; save fails if it moved on' },
      version: { type: 'number', description: 'An older version to read' },
    },
    output,
    async execute(args, exec) {
      await rt.load?.()
      const botId = rt.selfOf?.(exec?.agent?.id)
      if (botId === undefined) return 'Only Bots on the team share artifacts.'
      try {
        if (args.action === 'list') {
          const rows = artifactsView()
          return rows.length === 0 ? 'No artifacts yet.' : rows.map(row => `- ${row.slug} · ${row.kind} · v${row.version} · ${row.title}`).join('\n')
        }
        if (args.action === 'read') {
          const art = getArtifact(args.slug, { version: args.version })
          return art === undefined ? `No artifact "${args.slug}".` : `# ${art.title} (v${art.version}, ${art.kind})\n\n${art.content}`
        }
        if (args.action === 'save') {
          const saved = await saveArtifact(args, { botId })
          return `Saved "${saved.slug}" as version ${saved.version}.`
        }
        if (args.action === 'delete') {
          const art = store()[String(args.slug ?? '')]
          if (art !== undefined && art.createdBy !== botId && !rt.isMain?.(botId)) return 'Only the author or a Main Bot deletes an artifact.'
          await deleteArtifact(args.slug)
          return `Deleted "${args.slug}".`
        }
        return 'Unknown action; use list, read, save or delete.'
      } catch (error) {
        return error.message
      }
    },
  }))

  Object.assign(rt, { artifactsView, saveArtifact, getArtifact, deleteArtifact, artifactEndpoint })
}
