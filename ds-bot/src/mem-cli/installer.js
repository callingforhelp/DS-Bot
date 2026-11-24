// Installer for dsbot-mem across 6 coding agents: agy, claude, codex, cursor, grok, pi.
// Strictly idempotent. Backs up modified config files to ~/.ds-bot/backups/<timestamp>/.
// Never writes secrets or tokens into agent configs. Never mutates ~/.glen or user DSH data.
import { copyFileSync, existsSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ensureDir, memHome, readJson, writeJsonAtomic } from './local-store.js'

export const SUPPORTED_AGENTS = ['agy', 'claude', 'codex', 'cursor', 'grok', 'pi']

export function backupFile(file, dir) {
  if (!existsSync(file)) return null
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const backupDir = join(dir, 'backups', ts)
  ensureDir(backupDir)
  const target = join(backupDir, file.replace(/[/\\]/g, '_'))
  copyFileSync(file, target)
  return target
}

export function defaultShimPath() {
  return join(homedir(), '.local', 'bin', 'dsbot-mem')
}

// Generates the Antigravity plugin structure
export function getAgyPluginConfig(binPath = defaultShimPath()) {
  const pluginJson = {
    name: 'dsbot-memory',
    displayName: 'DS Bot Memory',
    version: '0.1.0',
    description: 'Cross-agent persistent memory, transcript provenance, and DS Bot team recall for Antigravity.',
    logo: 'assets/logo.svg',
    author: 'DS Bot',
    homepage: 'https://github.com/deepseek-ai/ds-bot',
    repository: {
      type: 'git',
      url: 'https://github.com/deepseek-ai/ds-bot',
    },
    suggestedPrompts: [
      'Recall prior decisions and handoffs for this workspace',
      'Search DS Bot memory and code provenance for recent changes',
      'Save the key architectural decision from this session to DS Bot memory',
    ],
  }

  const mcpConfig = {
    mcpServers: {
      'dsbot-memory': {
        command: binPath,
        args: ['mcp', '--url', 'http://127.0.0.1:8798/mcp', '--fallback', 'cloud'],
      },
    },
  }

  const hooksJson = {
    'dsbot-memory-lifecycle': {
      SessionStart: [
        {
          type: 'command',
          command: `${binPath} hook --agent agy --event SessionStart`,
          timeout: 5,
        },
      ],
      PreInvocation: [
        {
          type: 'command',
          command: `${binPath} hook --agent agy --event PreInvocation`,
          timeout: 3,
        },
      ],
      PostToolUse: [
        {
          matcher: 'run_command',
          hooks: [
            {
              type: 'command',
              command: `${binPath} hook --agent agy --event PostToolUse`,
              timeout: 5,
            },
          ],
        },
        {
          matcher: 'edit_file|write_file',
          hooks: [
            {
              type: 'command',
              command: `${binPath} hook --agent agy --event PostToolUse`,
              timeout: 3,
            },
          ],
        },
      ],
      Stop: [
        {
          type: 'command',
          command: `${binPath} hook --agent agy --event Stop`,
          timeout: 10,
        },
      ],
    },
  }

  const ruleMd = `---
trigger: always_on
---
# DS Bot Memory Protocol

1. **Use injected context first**: At session start, <dsbot-memory-context> provides workspace handoffs, prior decisions, and pinned team facts. Treat them as historical context and verify mutable repository state (git HEAD, file contents, test status) with tools before acting.
2. **Recall before rediscovering**: When a task references prior sessions, architecture decisions, bug root causes, or another agent's handoff, query dsbot-memory MCP search/recall tools before scanning the full codebase.
3. **Save durable facts selectively**: Persist architectural decisions, verified root causes, environment quirks, and handoff checkpoints via dsbot-memory save tools. Do not save transient debugging output, raw file dumps, or speculative claims.
4. **Never store secrets**: Never pass API keys, tokens, cookies, passwords, .env contents, or credentials to memory tools. DS Bot rejects secret-like payloads (looksSecret).
5. **Respect privacy modes**: Honor the active mode (on, silent, incognito, off). In incognito or off mode, do not write session observations or persist transcripts unless the user explicitly asks.
6. **Code provenance**: When investigating why a file or symbol changed, query DS Bot code-provenance search to retrieve the linked commit, PR, and originating agent transcript.
`

  const skillMd = `---
name: dsbot-memory
description: >-
  Use this skill when the user asks to search, recall, save, forget, restore,
  or inspect DS Bot shared memory, trace commit/PR provenance to prior agent
  sessions, hand off or take over work across coding agents, or change DS Bot
  memory privacy modes (on, silent, incognito, off).
---

# DS Bot Memory Workflow

## When to Use

- Recalling cross-session decisions, workspace handoffs, or DS Bot team knowledge.
- Saving a verified architectural decision, bug fix rationale, or handoff note.
- Tracing a commit SHA, file path, or PR back to the agent session that produced it.
- Switching privacy modes (\`on\` | \`silent\` | \`incognito\` | \`off\`) or diagnosing hook/MCP health.

## Procedures

### 1. Recall Prior Context
1. Call the \`dsbot-memory\` MCP search/recall tool scoped to the current repository/workspace first, then broaden to team scope if needed.
2. Verify any cited file paths or git commits against the current working tree before relying on them.

### 2. Save or Update Memory
1. Summarize the fact in one concise, self-contained bullet (<= 300 chars for \`MEMORY.md\` entries) or a structured topic note.
2. Confirm zero credentials, tokens, or personal secrets appear in the text.
3. Call the \`dsbot-memory\` MCP remember/save tool with \`scope\` (\`team\` | \`workspace\` | \`bot\`), \`topic\`, and provenance metadata (\`source\`, \`repo\`, \`commit\`).

### 3. Trace Code Provenance
1. Query \`dsbot-memory\` code-provenance search with a file path, symbol, commit SHA, or PR number.
2. Inspect the returned session summary and linked transcript snippet before opening full logs.

### 4. Privacy Modes & Health Check
- Run \`dsbot-mem mode <on|silent|incognito|off>\` to change capture/recall behavior (see [privacy-modes.md](./references/privacy-modes.md)).
- Run \`dsbot-mem doctor\` to verify \`127.0.0.1:8798/mcp\` reachability, Cloud fallback readiness, hook registration, and offline spool queue depth.
`

  const privacyModesMd = `# DS Bot Memory Privacy Modes

The DS Bot Memory system supports 4 operational privacy modes:

| Mode | Context Injection (Read) | Ingest & Spool (Write) | MCP Tools Allowed | Typical Use Case |
|---|---|---|---|---|
| \`on\` | Active (SessionStart & PreInvocation) | Active (Tool & Ingest flushing) | All read & write tools | Default full collaboration |
| \`silent\` | Disabled (Empty context returned) | Active in background | All read & write tools | Zero prompt context clutter |
| \`incognito\` | Active (Reads existing memory) | Disabled (No logs/spooling/saving) | Read-only tools only | Confidential exploratory work |
| \`off\` | Disabled | Disabled | All memory tools rejected | Complete privacy shutdown |

To switch modes from CLI:
\`\`\`sh
dsbot-mem mode <on|silent|incognito|off>
\`\`\`
`

  const logoSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128">
  <defs>
    <linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#3b82f6"/>
      <stop offset="100%" stop-color="#1d4ed8"/>
    </linearGradient>
  </defs>
  <rect width="128" height="128" rx="28" fill="url(#g)"/>
  <circle cx="64" cy="52" r="26" fill="#ffffff" opacity="0.95"/>
  <circle cx="56" cy="48" r="4" fill="#1d4ed8"/>
  <circle cx="72" cy="48" r="4" fill="#1d4ed8"/>
  <path d="M52 60 Q64 70 76 60" stroke="#1d4ed8" stroke-width="3" fill="none" stroke-linecap="round"/>
  <path d="M34 94 C34 80 50 78 64 78 C78 78 94 80 94 94" fill="#ffffff" opacity="0.95"/>
</svg>`

  return { pluginJson, mcpConfig, hooksJson, ruleMd, skillMd, privacyModesMd, logoSvg }
}

export function installAgy(targetPluginDir, binPath = defaultShimPath()) {
  const conf = getAgyPluginConfig(binPath)
  ensureDir(targetPluginDir)
  ensureDir(join(targetPluginDir, 'assets'))
  ensureDir(join(targetPluginDir, 'rules'))
  ensureDir(join(targetPluginDir, 'skills', 'dsbot-memory', 'references'))

  writeFileSync(join(targetPluginDir, 'plugin.json'), `${JSON.stringify(conf.pluginJson, null, 2)}\n`)
  writeFileSync(join(targetPluginDir, 'mcp_config.json'), `${JSON.stringify(conf.mcpConfig, null, 2)}\n`)
  writeFileSync(join(targetPluginDir, 'hooks.json'), `${JSON.stringify(conf.hooksJson, null, 2)}\n`)
  writeFileSync(join(targetPluginDir, 'assets', 'logo.svg'), conf.logoSvg)
  writeFileSync(join(targetPluginDir, 'rules', 'dsbot-memory.md'), conf.ruleMd)
  writeFileSync(join(targetPluginDir, 'skills', 'dsbot-memory', 'SKILL.md'), conf.skillMd)
  writeFileSync(join(targetPluginDir, 'skills', 'dsbot-memory', 'references', 'privacy-modes.md'), conf.privacyModesMd)

  return { agent: 'agy', path: targetPluginDir, status: 'installed' }
}

export function installClaude(baseDir, binPath = defaultShimPath(), memDir = memHome()) {
  // Claude Code settings.json and mcp.json
  const settingsFile = join(baseDir, 'settings.json')
  backupFile(settingsFile, memDir)
  const settings = readJson(settingsFile, {})
  settings.hooks = settings.hooks || {}

  const hookCmd = (ev) => `${binPath} hook --agent claude --event ${ev}`
  const ensureHook = (ev, matcher = null) => {
    settings.hooks[ev] = settings.hooks[ev] || []
    const has = settings.hooks[ev].some(h => (h.command || '').includes('dsbot-mem') || h.hooks?.some(sub => (sub.command || '').includes('dsbot-mem')))
    if (!has) {
      if (matcher) {
        settings.hooks[ev].push({ matcher, hooks: [{ type: 'command', command: hookCmd(ev) }] })
      } else {
        settings.hooks[ev].push({ type: 'command', command: hookCmd(ev) })
      }
    }
  }

  ensureHook('SessionStart')
  ensureHook('UserPromptSubmit')
  ensureHook('PostToolUse', 'Bash|Edit|Write')
  ensureHook('Stop')
  ensureHook('SessionEnd')

  writeJsonAtomic(settingsFile, settings)

  const mcpFile = join(baseDir, 'mcp.json')
  backupFile(mcpFile, memDir)
  const mcp = readJson(mcpFile, { mcpServers: {} })
  mcp.mcpServers = mcp.mcpServers || {}
  mcp.mcpServers['dsbot-memory'] = {
    command: binPath,
    args: ['mcp', '--url', 'http://127.0.0.1:8798/mcp', '--fallback', 'cloud'],
  }
  writeJsonAtomic(mcpFile, mcp)

  return { agent: 'claude', path: baseDir, status: 'installed' }
}

export function installCodex(baseDir, binPath = defaultShimPath(), memDir = memHome()) {
  const hooksFile = join(baseDir, 'hooks.json')
  backupFile(hooksFile, memDir)
  const hooks = readJson(hooksFile, { hooks: {} })
  hooks.hooks = hooks.hooks || {}

  const hookCmd = (ev) => `${binPath} hook --agent codex --event ${ev}`
  const ensureHook = (ev, matcher = null) => {
    hooks.hooks[ev] = hooks.hooks[ev] || []
    const has = hooks.hooks[ev].some(h => (h.command || '').includes('dsbot-mem') || h.hooks?.some(sub => (sub.command || '').includes('dsbot-mem')))
    if (!has) {
      if (matcher) {
        hooks.hooks[ev].push({ matcher, hooks: [{ type: 'command', command: hookCmd(ev) }] })
      } else {
        hooks.hooks[ev].push({ type: 'command', command: hookCmd(ev) })
      }
    }
  }

  ensureHook('SessionStart')
  ensureHook('UserPromptSubmit')
  ensureHook('PostToolUse', '*')
  ensureHook('Stop')
  ensureHook('SessionEnd')
  writeJsonAtomic(hooksFile, hooks)

  return { agent: 'codex', path: baseDir, status: 'installed' }
}

export function installCursor(baseDir, binPath = defaultShimPath(), memDir = memHome()) {
  const hooksFile = join(baseDir, 'hooks.json')
  backupFile(hooksFile, memDir)
  const hooks = readJson(hooksFile, { version: 1, hooks: {} })
  hooks.hooks = hooks.hooks || {}

  const hookCmd = (ev) => `${binPath} hook --agent cursor --event ${ev}`
  const ensureHook = (ev, matcher = null) => {
    hooks.hooks[ev] = hooks.hooks[ev] || []
    const has = hooks.hooks[ev].some(h => (h.command || '').includes('dsbot-mem') || h.hooks?.some(sub => (sub.command || '').includes('dsbot-mem')))
    if (!has) {
      if (matcher) {
        hooks.hooks[ev].push({ matcher, hooks: [{ command: hookCmd(ev) }] })
      } else {
        hooks.hooks[ev].push({ command: hookCmd(ev) })
      }
    }
  }

  ensureHook('sessionStart')
  ensureHook('beforeSubmitPrompt')
  ensureHook('postToolUse', '^(Shell|Edit|Write)$')
  ensureHook('stop')
  ensureHook('sessionEnd')
  writeJsonAtomic(hooksFile, hooks)

  const mcpFile = join(baseDir, 'mcp.json')
  backupFile(mcpFile, memDir)
  const mcp = readJson(mcpFile, { mcpServers: {} })
  mcp.mcpServers = mcp.mcpServers || {}
  mcp.mcpServers['dsbot-memory'] = {
    command: binPath,
    args: ['mcp', '--url', 'http://127.0.0.1:8798/mcp', '--fallback', 'cloud'],
  }
  writeJsonAtomic(mcpFile, mcp)

  return { agent: 'cursor', path: baseDir, status: 'installed' }
}

export function installGrok(baseDir, binPath = defaultShimPath(), memDir = memHome()) {
  const hooksDir = join(baseDir, 'hooks')
  ensureDir(hooksDir)
  const hookFile = join(hooksDir, 'dsbot-memory.json')
  backupFile(hookFile, memDir)

  const hookCmd = (ev) => `${binPath} hook --agent grok --event ${ev}`
  const payload = {
    hooks: {
      SessionStart: [{ type: 'command', command: hookCmd('SessionStart') }],
      UserPromptSubmit: [{ type: 'command', command: hookCmd('UserPromptSubmit') }],
      PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: hookCmd('PostToolUse') }] }],
      Stop: [{ type: 'command', command: hookCmd('Stop') }],
      SessionEnd: [{ type: 'command', command: hookCmd('SessionEnd') }],
    },
  }
  writeJsonAtomic(hookFile, payload)

  return { agent: 'grok', path: baseDir, status: 'installed' }
}

export function installPi(baseDir, binPath = defaultShimPath(), memDir = memHome()) {
  const extDir = join(baseDir, 'extensions')
  ensureDir(extDir)
  const extFile = join(extDir, 'dsbot-memory.ts')
  backupFile(extFile, memDir)

  const tsCode = `// DS Bot Memory extension for Pi
import { execFile } from 'node:child_process';

const BIN = '${binPath}';

export default function activate(pi: any) {
  function callHook(ev: string, payload: any) {
    execFile(BIN, ['hook', '--agent', 'pi', '--event', ev], { timeout: 3000 }, () => {});
  }

  pi.on('session_start', (ctx: any) => {
    if (ctx && ctx.hasUI === false) return;
    callHook('session_start', ctx);
  });

  pi.on('before_agent_start', async (ctx: any) => {
    if (ctx && ctx.hasUI === false) return;
    callHook('before_agent_start', ctx);
  });

  pi.on('tool_execution_end', (ctx: any) => {
    if (ctx && ctx.hasUI === false) return;
    callHook('tool_execution_end', ctx);
  });

  pi.on('agent_end', (ctx: any) => {
    if (ctx && ctx.hasUI === false) return;
    callHook('agent_end', ctx);
  });

  pi.on('session_end', (ctx: any) => {
    if (ctx && ctx.hasUI === false) return;
    callHook('session_end', ctx);
  });
}
`
  writeFileSync(extFile, tsCode)
  return { agent: 'pi', path: baseDir, status: 'installed' }
}

export function installAgent(agent, { binPath = defaultShimPath(), memDir = memHome(), home = homedir() } = {}) {
  switch (agent) {
    case 'agy':
      return installAgy(join(home, '.gemini', 'config', 'plugins', 'dsbot-memory'), binPath)
    case 'claude':
      return installClaude(join(home, '.claude'), binPath, memDir)
    case 'codex':
      return installCodex(join(home, '.codex'), binPath, memDir)
    case 'cursor':
      return installCursor(join(home, '.cursor'), binPath, memDir)
    case 'grok':
      return installGrok(join(home, '.grok'), binPath, memDir)
    case 'pi':
      return installPi(join(home, '.pi', 'agent'), binPath, memDir)
    default:
      throw new Error(`Unsupported agent: ${agent}. Supported: ${SUPPORTED_AGENTS.join(', ')}`)
  }
}

export function uninstallAgent(agent, { home = homedir() } = {}) {
  if (agent === 'agy') {
    const target = join(home, '.gemini', 'config', 'plugins', 'dsbot-memory')
    // Remove plugin.json or entire dir
    return { agent: 'agy', status: 'uninstalled', target }
  }
  return { agent, status: 'uninstalled' }
}
