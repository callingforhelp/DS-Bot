import { randomUUID } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { replaceFile } from './files.js'

const MAX_CASES = 2000
const MAX_RULES = 200
const MAX_BYTES = 16 * 1024 * 1024
const clean = value => String(value ?? '').trim().slice(0, 4000)
const terms = (value) => {
  const text = clean(value).toLowerCase()
  const chars = [...text.replace(/\s/g, '')]
  return new Set([...chars.slice(1).map((char, index) => chars[index] + char), ...(text.match(/[a-z0-9]+/g) ?? [])])
}
const overlap = (a, b) => {
  const union = new Set([...a, ...b]).size
  return union ? [...a].filter(term => b.has(term)).length / union : 0
}

export function triageBank(home, writable = () => {}) {
  const dir = join(home, 'triage')
  let queue = Promise.resolve()
  const read = async (name, fallback, jsonl = false) => {
    try {
      const path = join(dir, name)
      if ((await stat(path)).size > MAX_BYTES) throw new Error('Triage bank exceeds size limit')
      const source = await readFile(path, 'utf8')
      return jsonl ? source.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : JSON.parse(source)
    } catch (error) { if (error.code === 'ENOENT') return fallback; throw error }
  }
  const write = async (name, value) => {
    writable()
    await mkdir(dir, { recursive: true })
    const path = join(dir, name)
    const temp = `${path}.${randomUUID()}.tmp`
    if (Buffer.byteLength(value) > MAX_BYTES) throw new Error('Triage bank exceeds size limit')
    await writeFile(temp, value, { mode: 0o600 })
    writable()
    await replaceFile(temp, path, writable)
  }
  return args => {
    const run = async () => {
      writable()
      const cases = await read('cases.jsonl', [], true)
      const state = await read('rules.json', { rules: [], reviewed: 0 })
      const now = Date.now()
      const addRule = (text, from_case) => {
        if (!clean(text)) throw new Error('Rule text is required')
        if (state.rules.length >= MAX_RULES) throw new Error('Triage rule limit reached; remove obsolete rules first')
        const rule = { id: randomUUID(), text: clean(text), from_case, created: now, hits: 0 }
        state.rules.push(rule)
        return rule
      }
      let result
      if (args.action === 'recall') {
        const query = terms(args.query)
        const ranked = cases.map(item => ({ ...item, score: overlap(query, terms([item.summary, item.attachments_summary, item.reason].join(' '))) }))
          .filter(item => item.score > 0).sort((a, b) => b.score - a.score).slice(0, Math.max(1, Math.min(20, Number(args.limit) || 5)))
        for (const rule of state.rules) if (overlap(query, terms(rule.text)) > 0) rule.hits++
        result = { cases: ranked, rules: state.rules }
      } else if (args.action === 'log') {
        for (const key of ['customer', 'summary', 'routed_to', 'reason']) if (!clean(args[key])) throw new Error(`${key} is required`)
        const entry = { id: randomUUID(), created: now }
        for (const key of ['customer', 'summary', 'attachments_summary', 'routed_to', 'reason']) entry[key] = clean(args[key])
        cases.push(entry)
        if (cases.length > MAX_CASES) cases.splice(0, cases.length - MAX_CASES)
        let bytes = cases.reduce((size, item) => size + Buffer.byteLength(JSON.stringify(item)) + 1, 0)
        while (bytes > MAX_BYTES && cases.length > 1) {
          bytes -= Buffer.byteLength(JSON.stringify(cases.shift())) + 1
        }
        result = { id: entry.id }
      } else if (args.action === 'outcome') {
        const entry = cases.find(item => item.id === args.id)
        if (!entry) throw new Error('Triage case not found')
        if (!['correct', 'misrouted', 'resolved'].includes(args.result)) throw new Error('Invalid outcome')
        if (entry.outcome?.result === 'misrouted') entry.misroute = entry.outcome
        entry.outcome = { result: args.result, correct_route: clean(args.correct_route), lesson: clean(args.lesson), at: now }
        if (args.result === 'misrouted') entry.misroute = entry.outcome
        if (args.result === 'misrouted' && clean(args.lesson)) addRule(args.lesson, entry.id)
        result = entry
      } else if (args.action === 'rules') {
        if (args.rule_action === 'add') result = addRule(args.text)
        else if (args.rule_action === 'remove') { state.rules = state.rules.filter(rule => rule.id !== args.id); result = state.rules }
        else if (args.rule_action === 'list') result = state.rules
        else throw new Error('rule_action must be add, remove or list')
      } else if (args.action === 'review') {
        result = { since: state.reviewed, cases: cases.filter(item => item.created > state.reviewed), misroutes: cases.filter(item => (item.misroute?.at ?? (item.outcome?.result === 'misrouted' ? item.outcome.at : 0)) > state.reviewed), rules: state.rules }
        state.reviewed = now
      } else throw new Error('Unknown triage action')
      if (['log', 'outcome'].includes(args.action)) await write('cases.jsonl', cases.map(item => JSON.stringify(item)).join('\n') + '\n')
      await write('rules.json', JSON.stringify(state))
      return JSON.stringify(result)
    }
    const pending = queue.then(run)
    queue = pending.catch(() => {})
    return pending
  }
}
