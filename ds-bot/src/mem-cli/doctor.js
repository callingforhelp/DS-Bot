// Diagnostics for dsbot-mem: loopback MCP, local SQLite, Ollama embed, agent hooks, and Glen coexistence.
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { OLLAMA_MODEL, OLLAMA_URL, embedText, memHome, openStore, readMode } from './local-store.js'
import { LOCAL_URLS, probeLocal } from './mcp-bridge.js'

export async function runDoctor({ env = process.env, home = homedir(), dir = memHome(env) } = {}) {
  const report = {
    dir,
    mode: readMode(dir),
    sqlite: { ok: false, integrity: null, stats: null },
    mcp: { liveUrl: null, probed: LOCAL_URLS },
    ollama: { ok: false, url: OLLAMA_URL, model: OLLAMA_MODEL },
    glenCoexistence: { present: false, warning: null },
    agents: {},
  }

  // 1. SQLite check
  try {
    const store = await openStore(dir)
    try {
      report.sqlite.integrity = store.integrity()
      report.sqlite.stats = store.stats()
      report.sqlite.ok = report.sqlite.integrity === 'ok'
    } finally {
      store.close()
    }
  } catch (err) {
    report.sqlite.error = String(err?.message ?? err)
  }

  // 2. Loopback MCP probe
  try {
    const active = await probeLocal(LOCAL_URLS, '', 250)
    report.mcp.liveUrl = active || null
  } catch {
    report.mcp.liveUrl = null
  }

  // 3. Ollama embedding check
  try {
    const vec = await embedText('test embedding probe', { timeoutMs: 500 })
    report.ollama.ok = Array.isArray(vec) && vec.length > 0
  } catch {
    report.ollama.ok = false
  }

  // 4. Glen coexistence check
  const glenDir = join(home, '.glen')
  if (existsSync(glenDir)) {
    report.glenCoexistence.present = true
    report.glenCoexistence.warning = 'Glen directory detected at ~/.glen. Coexistence is safe, but ensure Glen hooks do not duplicate context injection.'
  }

  // 5. Agent hook configurations check
  const checkFile = (p) => existsSync(join(home, p))
  report.agents.agy = { pluginInstalled: checkFile('.gemini/config/plugins/dsbot-memory/plugin.json') }
  report.agents.claude = { configPresent: checkFile('.claude/settings.json') }
  report.agents.codex = { configPresent: checkFile('.codex/hooks.json') }
  report.agents.cursor = { configPresent: checkFile('.cursor/hooks.json') }
  report.agents.grok = { configPresent: checkFile('.grok/hooks/dsbot-memory.json') }
  report.agents.pi = { configPresent: checkFile('.pi/agent/extensions/dsbot-memory.ts') }

  return report
}
