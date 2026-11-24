// Main entrypoint and CLI dispatcher for dsbot-mem.
import { readFileSync } from 'node:fs'
import { runDoctor } from './doctor.js'
import { flushSpool, readStdinJson, runHook } from './hooks.js'
import { installAgent, uninstallAgent } from './installer.js'
import { memHome, openStore, readMode, writeMode } from './local-store.js'
import { runMcp } from './mcp-bridge.js'
import { DEFAULT_SOURCE, migrateMemory } from './migrate.js'

export * from './local-store.js'
export * from './mcp-bridge.js'
export * from './hooks.js'
export * from './installer.js'
export * from './migrate.js'
export * from './doctor.js'

function getArg(args, flag) {
  const idx = args.indexOf(flag)
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null
}

function hasFlag(args, flag) {
  return args.includes(flag)
}

export async function cli(argv = process.argv.slice(2)) {
  const cmd = argv[0]
  const args = argv.slice(1)
  const dir = memHome()

  if (!cmd || cmd === 'help' || hasFlag(argv, '--help') || hasFlag(argv, '-h')) {
    console.log(`dsbot-mem - Persistent Agent Memory CLI for DS Bot

Commands:
  mcp                           Start stdio MCP server (bridges 127.0.0.1:8798/8797 or offline SQLite)
  hook                          Run agent lifecycle hook (--agent <agy|claude|...> --event <ev>)
  session-start                 Manual session start context recall
  ingest                        Ingest session transcripts or flush spool queue (--flush, --file <path>)
  search <query>                Full-text and semantic search over memories
  code-search <term>            Search commits, PRs, files linked to sessions
  pr-link                       Link commit/PR to session (--commit <sha> --pr <url> --session <id>)
  takeover                      Export session context for transfer to another agent (--session <id>)
  import                        Import transcript JSON/JSONL into memory (--file <path>)
  forget <ids...>               Soft-delete memories by ID
  restore <id>                  Restore soft-deleted memory
  mode [on|silent|incognito|off] Get or set memory privacy mode
  skill <save|get|list|delete>  Manage team skills
  artifact <save|get|list|delete> Manage team artifacts
  sync                          Sync pending outbox to cloud (if configured)
  install --agent <agent|all>   Install MCP & hooks for agent
  uninstall --agent <agent|all> Uninstall MCP & hooks for agent
  migrate-memory                Migrate Markdown notes (--source <dir> [--dry-run])
  doctor                        Check SQLite, MCP loopback, and agent status
`)
    return 0
  }

  switch (cmd) {
    case 'mcp': {
      const url = getArg(args, '--url')
      const fallback = getArg(args, '--fallback')
      const offline = hasFlag(args, '--offline')
      await runMcp({ url, fallback, offline })
      return 0
    }

    case 'hook': {
      const agent = getArg(args, '--agent') || 'agy'
      const event = getArg(args, '--event') || 'SessionStart'
      const payload = await readStdinJson()
      const res = await runHook({ agent, event, payload })
      console.log(JSON.stringify(res))
      return 0
    }

    case 'session-start': {
      const prompt = args.join(' ')
      const store = await openStore(dir)
      try {
        const hits = store.search(prompt || 'workspace', { limit: 5 })
        console.log(JSON.stringify(hits, null, 2))
      } finally {
        store.close()
      }
      return 0
    }

    case 'ingest': {
      if (hasFlag(args, '--flush')) {
        const res = await flushSpool({ dir })
        console.log(JSON.stringify(res))
        return 0
      }
      const file = getArg(args, '--file')
      if (file) {
        const raw = readFileSync(file, 'utf8')
        const store = await openStore(dir)
        try {
          const r = store.save({ text: raw.slice(0, 3500), kind: 'transcript', source: file })
          console.log(JSON.stringify(r))
        } finally {
          store.close()
        }
        return 0
      }
      const res = await flushSpool({ dir })
      console.log(JSON.stringify(res))
      return 0
    }

    case 'search': {
      const query = args.filter(a => !a.startsWith('-')).join(' ')
      const limit = Number(getArg(args, '--limit')) || 8
      const store = await openStore(dir)
      try {
        const hits = store.search(query, { limit })
        console.log(JSON.stringify(hits, null, 2))
      } finally {
        store.close()
      }
      return 0
    }

    case 'code-search': {
      const term = args.filter(a => !a.startsWith('-')).join(' ')
      const store = await openStore(dir)
      try {
        const hits = store.codeSearch(term)
        console.log(JSON.stringify(hits, null, 2))
      } finally {
        store.close()
      }
      return 0
    }

    case 'pr-link': {
      const commit = getArg(args, '--commit') || ''
      const pr = getArg(args, '--pr') || ''
      const session = getArg(args, '--session') || ''
      const repo = getArg(args, '--repo') || ''
      const store = await openStore(dir)
      try {
        const id = store.linkProvenance({ commit, pr, session, repo })
        console.log(JSON.stringify({ ok: true, id }))
      } finally {
        store.close()
      }
      return 0
    }

    case 'takeover': {
      const session = getArg(args, '--session') || args[0]
      const store = await openStore(dir)
      try {
        const rows = session ? store.session(session) : store.recent({ limit: 10 })
        console.log(JSON.stringify({ session, memories: rows }, null, 2))
      } finally {
        store.close()
      }
      return 0
    }

    case 'import': {
      const file = getArg(args, '--file') || args[0]
      if (!file) throw new Error('Specify file to import: dsbot-mem import --file <path>')
      const raw = readFileSync(file, 'utf8')
      const store = await openStore(dir)
      try {
        const r = store.save({ text: raw.slice(0, 3500), kind: 'import', source: file })
        console.log(JSON.stringify(r))
      } finally {
        store.close()
      }
      return 0
    }

    case 'forget': {
      const ids = args.map(Number).filter(n => !Number.isNaN(n) && n > 0)
      const store = await openStore(dir)
      try {
        const n = store.forget(ids)
        console.log(JSON.stringify({ forgotten: n }))
      } finally {
        store.close()
      }
      return 0
    }

    case 'restore': {
      const id = Number(args[0])
      const store = await openStore(dir)
      try {
        const ok = store.restore(id)
        console.log(JSON.stringify({ restored: ok }))
      } finally {
        store.close()
      }
      return 0
    }

    case 'mode': {
      const target = args[0]
      if (target) {
        const next = writeMode(dir, target)
        console.log(JSON.stringify({ mode: next }))
      } else {
        console.log(JSON.stringify({ mode: readMode(dir) }))
      }
      return 0
    }

    case 'skill': {
      const sub = args[0]
      const store = await openStore(dir)
      try {
        if (sub === 'list') {
          console.log(JSON.stringify(store.libraryList('skill'), null, 2))
        } else if (sub === 'get') {
          const item = store.libraryGet('skill', args[1])
          console.log(item ? item.body : 'Not found')
        } else if (sub === 'save') {
          const name = args[1]
          const body = args[2] || (hasFlag(args, '--body') ? getArg(args, '--body') : '')
          const saved = store.libraryPut('skill', name, body)
          console.log(JSON.stringify({ ok: true, name: saved }))
        } else if (sub === 'delete') {
          const ok = store.libraryDelete('skill', args[1])
          console.log(JSON.stringify({ deleted: ok }))
        } else {
          console.log('Usage: dsbot-mem skill <list|get|save|delete>')
        }
      } finally {
        store.close()
      }
      return 0
    }

    case 'artifact': {
      const sub = args[0]
      const store = await openStore(dir)
      try {
        if (sub === 'list') {
          console.log(JSON.stringify(store.libraryList('artifact'), null, 2))
        } else if (sub === 'get') {
          const item = store.libraryGet('artifact', args[1])
          console.log(item ? item.body : 'Not found')
        } else if (sub === 'save') {
          const name = args[1]
          const body = args[2] || (hasFlag(args, '--body') ? getArg(args, '--body') : '')
          const saved = store.libraryPut('artifact', name, body)
          console.log(JSON.stringify({ ok: true, name: saved }))
        } else if (sub === 'delete') {
          const ok = store.libraryDelete('artifact', args[1])
          console.log(JSON.stringify({ deleted: ok }))
        } else {
          console.log('Usage: dsbot-mem artifact <list|get|save|delete>')
        }
      } finally {
        store.close()
      }
      return 0
    }

    case 'sync': {
      const store = await openStore(dir)
      try {
        const outbox = store.pendingOutbox()
        console.log(JSON.stringify({ pending: outbox.length, outbox: outbox.slice(0, 10) }))
      } finally {
        store.close()
      }
      return 0
    }

    case 'install': {
      const agent = getArg(args, '--agent') || 'all'
      const targetAgents = agent === 'all' ? ['agy', 'claude', 'codex', 'cursor', 'grok', 'pi'] : [agent]
      const results = []
      for (const a of targetAgents) {
        results.push(installAgent(a, { memDir: dir }))
      }
      console.log(JSON.stringify(results, null, 2))
      return 0
    }

    case 'uninstall': {
      const agent = getArg(args, '--agent') || 'all'
      const targetAgents = agent === 'all' ? ['agy', 'claude', 'codex', 'cursor', 'grok', 'pi'] : [agent]
      const results = []
      for (const a of targetAgents) {
        results.push(uninstallAgent(a))
      }
      console.log(JSON.stringify(results, null, 2))
      return 0
    }

    case 'migrate-memory': {
      const source = getArg(args, '--source') || DEFAULT_SOURCE
      const dryRun = hasFlag(args, '--dry-run')
      const store = dryRun ? null : await openStore(dir)
      try {
        const report = migrateMemory({ source, dir, store, dryRun })
        console.log(JSON.stringify(report, null, 2))
      } finally {
        if (store) store.close()
      }
      return 0
    }

    case 'doctor': {
      const res = await runDoctor({ dir })
      console.log(JSON.stringify(res, null, 2))
      return 0
    }

    default:
      console.error(`Unknown command: ${cmd}. Run dsbot-mem --help for usage.`)
      return 1
  }
}
