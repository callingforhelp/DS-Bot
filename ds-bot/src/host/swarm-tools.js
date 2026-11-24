// Tools that let a Bot participate in a swarm: `swarm`, `post_message`, `read_board`,
// and `swarm_wait`. Registered through `rt.swarmToolsForSession(sessionId)` into
// `shareBotTools` (see tools.js), scoped to Sessions that belong to a swarm.
import { defineTool } from '@deepseek-ai/dsh-tools'
import { output } from './tools.js'

export const SWARM_PROMPT_ORDER = 647
export const SWARM_PROMPT_NAME = 'bot-swarm'

export const SWARM_INSTRUCTIONS = `The message board is how you work with the swarm. Every post is public to the channel.

- \`read_board({ since, limit, seqs, channel })\`: read the feed, oldest first. Without \`since\` you get the most recent; pass the highest seq you have seen to read what followed. \`seqs\` reads exact posts.
- \`post_message({ text, channel })\`: post tagged with your name.
  - @name wakes that member; @prefix wakes prefix-1..prefix-k; @all wakes everyone.
  - An @mention is a doorbell: name only the member who acts next, never CC.
  - When your work is done, start your post with \`@coordinator [done]\` (or the member who assigned you) so the swarm can land it.
- \`swarm_wait({ since, mentions_only })\`: sleep until a doorbell rings for you. Sleeping costs nothing.
  - Pass the highest seq you have actually read as \`since\`.
  - Set \`mentions_only: false\` when you are free and hunting for unassigned work.
- \`swarm({ action, ... })\`: manage the swarm.
  - action:"status": see every member, its role, status and last post.
  - action:"models": list models with quota availability.
  - action:"add": add helpers. You own them and must kill them before you finish.
  - action:"model": switch the model of yourself or a helper you added when quota runs out.
  - action:"kill": permanently remove a helper you added and its workspace.
  - action:"title": coordinator only, name the swarm.
  - action:"channel": create, join, leave or drop channels.`

export function install(rt) {
  const { ctx } = rt

  const own = (exec) => {
    const sessionId = exec.agent?.session?.id ?? exec.agent?.id
    const held = rt.swarmOwners?.get(sessionId)
    if (held === undefined) throw new Error('This Session is not a member of any swarm')
    const swarm = rt.swarm?.swarmOf(held.swarmId)
    return { sessionId, swarmId: held.swarmId, memberName: held.memberName, role: held.role, swarm }
  }

  // ── tools ───────────────────────────────────────────────────────────────────
  const swarmTool = defineTool({
    name: 'swarm',
    description: 'Manage the swarm: view status and models, spawn helpers, switch models on quota limits, kill helpers you own, manage channels, or set the swarm title.',
    parameters: {
      action: { type: 'string', required: true, enum: ['status', 'models', 'add', 'model', 'kill', 'title', 'channel'], description: 'What to do: status, models, add, model, kill, title, channel' },
      name: { type: 'string', description: 'Member or channel name (short, lowercase, no spaces)' },
      brief: { type: 'string', description: 'For add: the worker assignment (what it owns, what done looks like)' },
      model: { type: 'object', additionalProperties: true, description: 'For add and model: { provider, model, reasoningEffort }' },
      n: { type: 'integer', description: 'For add: number of copies to spawn (name-1..name-n)' },
      tasks: { type: 'array', items: { type: 'string' }, description: 'For add: slice targets, one worker per slice' },
      fork: { type: 'string', description: 'For add: member name to fork conversation history from ("coordinator" or worker name)' },
      workspace: { type: 'string', enum: ['inherit', 'share', 'branch'], description: 'For add: inherit (default), share (git worktree), branch (isolated clone)' },
      all: { type: 'boolean', description: 'For models: list every model including hidden' },
      title: { type: 'string', description: 'For title: new swarm title' },
      op: { type: 'string', enum: ['create', 'join', 'leave', 'drop'], description: 'For channel: channel operation' },
      member: { type: 'string', description: 'For channel: target member for join/leave' },
      members: { type: 'array', items: { type: 'string' }, description: 'For channel: initial members for create' },
      remove_workspace: { type: 'boolean', description: 'For kill: remove git worktree if clean' },
    },
    output,
    async execute(args, exec) {
      const { swarmId, memberName } = own(exec)
      const action = String(args.action ?? '').toLowerCase()
      switch (action) {
        case 'status': {
          const view = rt.swarm.statusView(swarmId, memberName)
          return JSON.stringify(view, null, 2)
        }
        case 'models': {
          const list = rt.swarm.listModelsWithQuota({ all: args.all === true })
          return JSON.stringify(list, null, 2)
        }
        case 'add': {
          const added = await rt.swarm.addMembers(swarmId, memberName, {
            name: args.name, brief: args.brief, model: args.model, n: args.n, tasks: args.tasks, fork: args.fork, workspace: args.workspace,
          })
          return `Added ${added.map(member => member.name).join(', ')}`
        }
        case 'model': {
          const target = args.name ?? memberName
          const updated = await rt.swarm.switchMemberModel(swarmId, memberName, target, args.model)
          return `Switched ${updated.name} to ${updated.model.provider}/${updated.model.model}`
        }
        case 'kill': {
          const result = await rt.swarm.killMember(swarmId, memberName, args.name, { removeWorkspace: args.remove_workspace === true })
          return `Killed ${result.member.name} (workspace: ${result.workspace})`
        }
        case 'title': {
          const title = await rt.swarm.setTitle(swarmId, memberName, args.title)
          return `Swarm title set to "${title}"`
        }
        case 'channel': {
          const res = rt.swarm.channelOp(swarmId, memberName, { op: args.op, name: args.name, member: args.member, members: args.members })
          return `Channels: ${res.channels.join(', ')}`
        }
        default:
          return `Unknown action "${args.action}"`
      }
    },
  })

  const postMessageTool = defineTool({
    name: 'post_message',
    description: 'Post a message to the swarm message board. Tagged with your name. Ring doorbells with @name, @prefix, @all, or @#channel. Never CC.',
    parameters: {
      text: { type: 'string', required: true, description: 'The message to post' },
      channel: { type: 'string', description: 'Channel to post to (default: main)' },
    },
    output,
    async execute(args, exec) {
      const { swarmId, memberName } = own(exec)
      const record = await rt.swarm.post(swarmId, { agent: memberName, text: args.text, channel: args.channel })
      const note = record.wake?.length ? ` (rang: ${record.wake.join(', ')})` : ''
      return `Posted #${record.seq}${note}`
    },
  })

  const readBoardTool = defineTool({
    name: 'read_board',
    description: 'Read messages from the swarm message board, oldest first. Each message carries a monotonic seq number.',
    parameters: {
      since: { type: 'integer', description: 'Return oldest messages after this seq number' },
      limit: { type: 'integer', description: 'Most messages to return (default 20, max 100)' },
      seqs: { type: 'array', items: { type: 'integer' }, description: 'Return exactly these seqs, ignoring since/limit' },
      channel: { type: 'string', description: 'Narrows to this channel (default: main)' },
    },
    output,
    async execute(args, exec) {
      const { swarmId, memberName } = own(exec)
      const view = rt.swarm.readBoard(swarmId, {
        since: args.since, limit: args.limit, seqs: args.seqs, channel: args.channel, viewer: memberName,
      })
      return JSON.stringify(view, null, 2)
    },
  })

  const swarmWaitTool = defineTool({
    name: 'swarm_wait',
    description: 'Sleep until a doorbell rings for you. Sleeping costs nothing. Ends your turn immediately.',
    parameters: {
      since: { type: 'integer', required: true, description: 'Wake for messages after this seq number (pass the last seq you actually saw)' },
      mentions_only: { type: 'boolean', description: 'Wake only for @you or @all (default: true). Set false to wake for any post.' },
    },
    output,
    async execute(args, exec) {
      const { memberName, swarm } = own(exec)
      const member = swarm.members[memberName]
      if (member !== undefined) {
        member.status = 'waiting'
        member.waitSince = args.since
        member.mentionsOnly = args.mentions_only !== false
      }
      return `Waiting on board #${args.since}`
    },
  })

  const tools = [swarmTool, postMessageTool, readBoardTool, swarmWaitTool]

  // System prompt injection for swarm members
  if (ctx?.systemPrompt?.section !== undefined) {
    ctx.effect?.(() => ctx.systemPrompt.section({
      name: SWARM_PROMPT_NAME,
      order: SWARM_PROMPT_ORDER,
      interpolate: false,
      text: ({ agent }) => {
        const sessionId = agent?.session?.id ?? agent?.id
        const held = rt.swarmOwners?.get(sessionId)
        if (held === undefined) return ''
        const swarm = rt.state?.swarms?.[held.swarmId]
        const title = swarm?.title ?? 'swarm'
        return `[Swarm: "${title}" · role: ${held.role} · name: ${held.memberName}]\n${SWARM_INSTRUCTIONS}`
      },
    }), 'ds-bot: swarm prompt section')
  }

  // Returns swarm tools if session is registered in a swarm
  rt.swarmToolsForSession = (sessionId) => {
    if (rt.swarmOwners?.has(sessionId)) return tools
    return []
  }

  return { tools, swarmTool, postMessageTool, readBoardTool, swarmWaitTool }
}
