// Manages the user PATH shim for dsbot-mem (~/.local/bin/dsbot-mem).
// Zero mutation unless explicitly triggered by the user via IPC or menu action.
import { chmodSync, existsSync, lstatSync, mkdirSync, readlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

export function shimPath(home = homedir()) {
  return join(home, '.local', 'bin', 'dsbot-mem')
}

export function targetCliPath(app) {
  // If packaged: resourcesPath/app.asar.unpacked/node_modules/ds-bot/bin/dsbot-mem.mjs
  // If in dev: resolve relative to ds-bot workspace
  if (app && app.isPackaged) {
    return join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'ds-bot', 'bin', 'dsbot-mem.mjs')
  }
  return resolve(dirname(new URL(import.meta.url).pathname), '../../ds-bot/bin/dsbot-mem.mjs')
}

export function cliShimStatus({ home = homedir(), app } = {}) {
  const p = shimPath(home)
  if (!existsSync(p)) {
    return { installed: false, path: p, valid: false }
  }
  let isLink = false
  let linkTarget = ''
  try {
    const st = lstatSync(p)
    isLink = st.isSymbolicLink()
    if (isLink) linkTarget = readlinkSync(p)
  } catch { /* ignore */ }

  const target = targetCliPath(app)
  const valid = isLink ? (linkTarget === target || existsSync(linkTarget)) : existsSync(p)
  return { installed: true, path: p, isLink, target: linkTarget || p, valid }
}

export function installCliShim({ home = homedir(), app } = {}) {
  const p = shimPath(home)
  const binDir = dirname(p)
  mkdirSync(binDir, { recursive: true, mode: 0o755 })

  const target = targetCliPath(app)
  if (existsSync(p)) {
    try { unlinkSync(p) } catch { /* ignore */ }
  }

  // Create wrapper script pointing to node and target script
  const script = `#!/bin/sh
exec node "${target}" "$@"
`
  writeFileSync(p, script, { mode: 0o755 })
  try { chmodSync(p, 0o755) } catch { /* best effort */ }

  return cliShimStatus({ home, app })
}
