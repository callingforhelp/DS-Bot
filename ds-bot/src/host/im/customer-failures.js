const ATTEMPTS = 3

export class CustomerFailures {
  constructor(limit = 1024) {
    this.limit = limit
    this.entries = new Map()
    this.limited = new Set()
  }

  exhausted(key) {
    return (this.entries.get(key)?.attempts ?? 0) >= ATTEMPTS
  }

  shouldReply(connId, key) {
    return !this.limited.has(connId) || this.entries.has(key)
  }

  success(key) {
    this.entries.delete(key)
  }

  fail(connId, key, permanent = false) {
    if (key === undefined) return false
    const previous = this.entries.get(key)
    if (previous === undefined && this.limited.has(connId)) return false
    if (previous === undefined && this.entries.size >= this.limit) {
      const [oldest, entry] = this.entries.entries().next().value
      this.entries.delete(oldest)
      // Forgotten identities must not gain another retry budget on a page replay.
      this.limited.add(entry.connId)
    }
    const attempts = (previous?.attempts ?? 0) + 1
    const retry = !permanent && !this.limited.has(connId) && attempts < ATTEMPTS
    this.entries.set(key, { connId, attempts: retry ? attempts : ATTEMPTS })
    return retry
  }

  clear(connId) {
    for (const [key, entry] of this.entries) {
      if (entry.connId === connId) this.entries.delete(key)
    }
    this.limited.delete(connId)
  }
}
