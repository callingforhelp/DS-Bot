const ATTEMPTS = 3

export class CustomerFailures {
  // A connection's replayable kf sync page contains at most 1000 messages.
  constructor(limit = 1024) {
    this.limit = limit
    this.entries = new Map()
  }

  exhausted(connId, key) {
    return (this.entries.get(connId)?.get(key) ?? 0) >= ATTEMPTS
  }

  success(connId, key) {
    const entries = this.entries.get(connId)
    entries?.delete(key)
    if (entries?.size === 0) this.entries.delete(connId)
  }

  fail(connId, key, permanent = false) {
    if (key === undefined) return false
    let entries = this.entries.get(connId)
    if (entries === undefined) this.entries.set(connId, entries = new Map())
    const attempts = (entries.get(key) ?? 0) + 1
    if (!entries.has(key) && entries.size >= this.limit) entries.delete(entries.keys().next().value)
    const retry = !permanent && attempts < ATTEMPTS
    entries.set(key, retry ? attempts : ATTEMPTS)
    return retry
  }

  clear(connId) {
    this.entries.delete(connId)
  }
}
