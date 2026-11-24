#!/usr/bin/env node
// dsbot-mem: Persistent cross-agent memory, provenance tracking, and team library for DS Bot.
import { cli } from '../src/mem-cli/index.js'

try {
  const code = await cli(process.argv.slice(2))
  if (typeof code === 'number' && code !== 0) {
    process.exit(code)
  }
} catch (err) {
  console.error(`dsbot-mem error: ${err?.message ?? err}`)
  process.exit(1)
}
