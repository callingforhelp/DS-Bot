import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

// The container image ships only src/ (see Dockerfile and .dockerignore). Everything the service
// entry point imports, directly or not, must therefore live in src/ or come from a package.
// This failed once on the real instance: src/db.mjs imported a helper from scripts/.
const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../src')

test('everything serve.mjs loads ships in the image', () => {
  const seen = new Set()
  const outside = []
  const walk = (file) => {
    if (seen.has(file)) return
    seen.add(file)
    const text = readFileSync(file, 'utf8')
    for (const m of text.matchAll(/(?:import\s[^'"]*from\s*|import\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g)) {
      const target = resolve(dirname(file), m[1])
      if (!target.startsWith(SRC + '/')) outside.push(`${relative(SRC, file)} -> ${m[1]}`)
      else walk(target)
    }
  }
  walk(join(SRC, 'serve.mjs'))
  assert.deepEqual(outside, [])
  assert.ok(seen.size > 5)
})
