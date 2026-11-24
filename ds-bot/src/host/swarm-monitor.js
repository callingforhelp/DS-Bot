// Swarm monitor: zero-LLM background watchdog. An unref'd timer checks active swarms
// against `rt.live` and the swarm board. If a swarm is silent and inactive for too long:
//   - Identifies whether the swarm stalled (silent with working members or waiting without wake)
//   - Emits deterministic `[stall]` warning citing `#seq` with 3-tick cooldown and max-3 cap
//   - Marks `dormant` after an unaddressed `[done]` from the coordinator or 5 idle ticks.
//
// Never calls an LLM. Pure deterministic checks and board updates.

export const DEFAULT_MONITOR_MS = 180_000
export const STALL_COOLDOWN_TICKS = 3
export const MAX_STALLS = 3
export const DORMANT_IDLE_TICKS = 5

export function install(rt) {
  const intervalMs = rt.config?.swarmMonitorMs ?? DEFAULT_MONITOR_MS
  let timer

  function inspectSwarm(swarm) {
    if (swarm.closed || swarm.halted) return { action: 'none' }

    const board = rt.swarm?.boardOf(swarm.id)
    const head = board ? board.lastSeq() : 0
    const liveSessions = rt.live ?? new Map()

    // 1. Check for unaddressed [done] from coordinator
    if (!swarm.dormant && head > 0) {
      const lastPost = rt.ledger?.record(board.book, head)
      if (lastPost && lastPost.agent === 'coordinator' && /^\s*\[done\]/i.test(lastPost.text)) {
        swarm.dormant = true
        return { action: 'dormant', reason: 'coordinator [done]' }
      }
    }

    // 2. Check activity of members
    let workingCount = 0
    let busyInLive = 0
    for (const member of Object.values(swarm.members)) {
      if (member.status === 'working') {
        workingCount += 1
        if (liveSessions.get(member.sessionId)?.turn !== undefined) busyInLive += 1
      }
    }

    // Check if new posts arrived since last tick
    const lastPostSeq = swarm.monitorLastSeq ?? 0
    const hasNewPosts = head > lastPostSeq
    swarm.monitorLastSeq = head

    if (hasNewPosts) {
      swarm.idleTicks = 0
      swarm.stallTickCooldown = Math.max(0, (swarm.stallTickCooldown ?? 0) - 1)
      return { action: 'active' }
    }

    // If no new posts, check stall conditions
    swarm.stalls ??= 0
    swarm.stallTickCooldown ??= 0

    if (swarm.stalls < MAX_STALLS && swarm.stallTickCooldown === 0) {
      const waitingMembers = Object.values(swarm.members).filter(m => m.status === 'waiting')
      const stoppedMembers = Object.values(swarm.members).filter(m => m.status === 'stopped')

      let candidateReason = ''
      if (workingCount > 0 && busyInLive === 0) {
        candidateReason = `${workingCount} member(s) marked working but none active in live`
      } else if (stoppedMembers.length > 0 && waitingMembers.length > 0) {
        candidateReason = `${stoppedMembers.length} member(s) stopped on failure`
      }

      if (candidateReason !== '') {
        swarm.stalls += 1
        swarm.stallTickCooldown = STALL_COOLDOWN_TICKS
        const stallText = `[stall] Swarm "${swarm.title}" appears inactive (${candidateReason}) since #${head}. @coordinator please check progress or reassign.`
        board.post({ agent: 'monitor', kind: 'system', text: stallText, members: [] })
        return { action: 'stall', seq: head, stalls: swarm.stalls }
      }
    }

    if (busyInLive > 0) {
      swarm.idleTicks = 0
      swarm.stallTickCooldown = Math.max(0, (swarm.stallTickCooldown ?? 0) - 1)
      return { action: 'active' }
    }

    swarm.idleTicks = (swarm.idleTicks ?? 0) + 1

    // If idle too long with no activity, mark dormant
    if (swarm.idleTicks >= DORMANT_IDLE_TICKS) {
      swarm.dormant = true
      return { action: 'dormant', reason: `${swarm.idleTicks} idle ticks` }
    }

    if (swarm.stallTickCooldown > 0) {
      swarm.stallTickCooldown -= 1
    }

    return { action: 'idle', idleTicks: swarm.idleTicks }
  }

  function tick() {
    const swarms = rt.state?.swarms
    if (!swarms) return []
    const results = []
    for (const swarm of Object.values(swarms)) {
      results.push({ swarmId: swarm.id, ...inspectSwarm(swarm) })
    }
    return results
  }

  function start() {
    if (timer !== undefined) return
    timer = setInterval(tick, intervalMs)
    timer.unref?.()
  }

  function stop() {
    if (timer !== undefined) {
      clearInterval(timer)
      timer = undefined
    }
  }

  start()

  const monitor = { tick, inspectSwarm, start, stop }
  rt.swarmMonitor = monitor
  return monitor
}
