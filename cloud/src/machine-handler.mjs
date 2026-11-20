// Delivers a chat message to the DS-Bot runtime inside a Daytona sandbox without ever
// interpolating raw user text into a shell command. Payload travels base64-encoded in env.
export function createSandboxMessageHandler({ timeoutSecs = 120 } = {}) {
  const script = [
    'node -e',
    '"const m = JSON.parse(Buffer.from(process.env.DS_BOT_MSG_B64, \'base64\').toString(\'utf8\'));',
    'const fs = require(\'node:fs\');',
    'fs.mkdirSync(\'/data/bot/inbox\', { recursive: true });',
    'const f = \'/data/bot/inbox/\' + m.seq + \'.json\';',
    'fs.writeFileSync(f, JSON.stringify(m));',
    'console.log(JSON.stringify({ delivered: true, file: f, threadId: m.threadId, botId: m.botId }));"',
  ].join(' ')

  return async (_machine, sandbox, message) => {
    const payload = Buffer.from(JSON.stringify({
      threadId: message.threadId ?? 'default',
      botId: message.botId ?? 'default',
      text: String(message.text ?? ''),
      seq: message.seq,
      at: message.at,
    }), 'utf8').toString('base64')

    const res = await sandbox.process.executeCommand(script, undefined, { DS_BOT_MSG_B64: payload }, timeoutSecs)
    if (res.exitCode !== 0) {
      throw new Error(`sandbox message delivery failed (exit ${res.exitCode})`)
    }
    const lastLine = String(res.result ?? '').trim().split('\n').at(-1) ?? ''
    try {
      const parsed = JSON.parse(lastLine)
      return { exitCode: res.exitCode, ...parsed }
    } catch {
      return { exitCode: res.exitCode, stdout: res.result }
    }
  }
}
