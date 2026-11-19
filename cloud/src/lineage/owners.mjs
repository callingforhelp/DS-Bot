// Which Bot (and which group) each DSH Session speaks for, from DS Bot's bot/state.json.
// Mirrors ds-bot src/host/store.js indexSessions and groups.js groupSessionFor:
//   bot.sessionId (or bot.id)                 -> chat     (botId)
//   bot.segments[].sessionId                  -> segment  (botId)
//   bot.openParts[].sessionId and segments    -> part     (botId)
//   rooms[].sessions[botId], segments[botId]  -> group    (botId, roomId)
//   the room's own Session and rooms[].parts  -> room     (roomId, no Bot)
// Earlier segments are indexed first, so a current Session always wins a clash.
const sid = v => (typeof v === 'string' && v !== '' ? v : undefined)

export function buildOwners(state) {
  const owners = new Map()
  const current = new Map()
  const past = (segments, owner) => {
    if (!Array.isArray(segments)) return
    for (const s of segments) { const id = sid(s?.sessionId); if (id) owners.set(id, owner) }
  }
  for (const [key, bot] of Object.entries(state?.bots ?? {})) {
    const botId = sid(bot?.id) ?? sid(key)
    if (!botId) continue
    past(bot.segments, { botId, roomId: null, kind: 'segment' })
    current.set(sid(bot.sessionId) ?? botId, { botId, roomId: null, kind: 'chat' })
    for (const part of Array.isArray(bot.openParts) ? bot.openParts : []) {
      past(part?.segments, { botId, roomId: null, kind: 'part' })
      const id = sid(part?.sessionId)
      if (id) current.set(id, { botId, roomId: null, kind: 'part' })
    }
  }
  for (const [key, room] of Object.entries(state?.rooms ?? {})) {
    const roomId = sid(room?.id) ?? sid(key)
    if (!roomId) continue
    past(room.parts, { botId: null, roomId, kind: 'room' })
    for (const [botId, segments] of Object.entries(room.segments ?? {})) past(segments, { botId, roomId, kind: 'group' })
    current.set(sid(room.sessionId) ?? roomId, { botId: null, roomId, kind: 'room' })
    for (const [botId, sessionId] of Object.entries(room.sessions ?? {})) {
      const id = sid(sessionId)
      if (id) current.set(id, { botId, roomId, kind: 'group' })
    }
  }
  for (const [id, owner] of current) owners.set(id, owner)
  return owners
}
