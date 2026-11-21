#!/usr/bin/env node
/**
 * Stdio MCP server running inside the AWS ds-bot container (/data/mac-broker-mcp.mjs).
 * Talks to host-side mac-job-broker over the bind-mounted Unix domain socket
 * (/data/mac-broker.sock) using BROKER_PRODUCER_TOKEN.
 */
import fs from 'node:fs';
import http from 'node:http';
import readline from 'node:readline';

function readTokenFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8').trim();
  } catch {
    return '';
  }
}

const SOCKET_PATH = process.env.BROKER_UNIX_SOCK || '/data/mac-broker.sock';
const PRODUCER_TOKEN =
  process.env.BROKER_PRODUCER_TOKEN ||
  readTokenFile(process.env.BROKER_PRODUCER_TOKEN_FILE || '/data/.mac-broker-producer-token');
const DEFAULT_SESSION_ID =
  process.env.AWS_CHIEF_SESSION_ID || 'session-e6a71bb9-caa0-4464-b27b-8db77f079e0d';

const TOOLS = [
  {
    name: 'mac_enqueue_job',
    description:
      'Enqueue a Mac-specific job for the user Mac mini (Xcode, iOS simulator, Swift/macOS builds, ParaDev local coding agents, or local Mac DS Bot). Returns job_id and whether the Mac worker is currently online. Results are posted back into this conversation when finished.',
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          enum: ['paradev', 'dsbot', 'git_sync'],
          description:
            'paradev for local Mac coding/Xcode/repo tasks via ParaDev agents; dsbot for local Mac DS Bot tasks; git_sync for fast local git push/pull/repo bootstrap.',
        },
        task: {
          type: 'string',
          description: 'Clear, self-contained task description for the Mac mini.',
        },
        repo: {
          type: 'string',
          description: 'Optional repo or ParaDev workspace name/path.',
        },
        branch: {
          type: 'string',
          description: 'Optional git branch name.',
        },
        timeout_sec: {
          type: 'integer',
          description: 'Optional timeout in seconds (default 900, max 7200).',
        },
        idempotency_key: {
          type: 'string',
          description: 'Optional deduplication key for retries.',
        },
        workspace_id: {
          type: 'string',
          description:
            'Optional existing ParaDev workspace ID on the Mac mini to reuse (for follow-ups or launching a reviewer in the same workspace).',
        },
        terminal_id: {
          type: 'string',
          description:
            'Optional existing ParaDev terminal/session ID inside workspace_id to send a follow-up message to.',
        },
        agent: {
          type: 'string',
          enum: ['codex', 'devin', 'claude', 'dsbot'],
          description: 'Optional ParaDev agent preset (default codex).',
        },
        cwd: {
          type: 'string',
          description:
            'Optional authorized local directory path on the Mac mini (for local-only or non-GitHub work).',
        },
        local_only: {
          type: 'boolean',
          description: 'Set true for local Mac folders/projects that do not exist on GitHub.',
        },
        role: {
          type: 'string',
          enum: ['worker', 'reviewer'],
          description:
            'Role in the ParaDev workspace: worker (default implementer) or reviewer (separate review terminal in the same workspace).',
        },
        aws_session_id: {
          type: 'string',
          description: 'Optional AWS ds-bot session ID to receive completion callback.',
        },
      },
      required: ['target', 'task'],
    },
  },
  {
    name: 'mac_job_status',
    description: 'Check the status and result of a previously enqueued Mac job.',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'The job_id returned by mac_enqueue_job.' },
      },
      required: ['job_id'],
    },
  },
  {
    name: 'mac_list_jobs',
    description: 'List recent Mac jobs and whether the Mac mini worker is currently online.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'Max jobs to return (default 10).' },
        status: {
          type: 'string',
          enum: ['queued', 'running', 'succeeded', 'failed', 'lease_lost', 'cancelled', 'expired'],
        },
      },
    },
  },
  {
    name: 'mac_cancel_job',
    description: 'Cancel a queued or running Mac job.',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'The job_id to cancel.' },
      },
      required: ['job_id'],
    },
  },
  {
    name: 'mac_register_paradev_repo',
    description:
      'Check whether a repository is already registered in ParaDev on the Mac mini, and register/clone it if missing. Call this before operating on a repository so ParaDev on the Mac mini stays synced.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          description:
            'Repository name, owner/repo (e.g. callingforhelp/Astra-Ares), GitHub URL, or Mac local path.',
        },
        cwd: {
          type: 'string',
          description:
            'Optional authorized local directory path on the Mac mini (for local-only or non-GitHub work).',
        },
        local_only: {
          type: 'boolean',
          description: 'Set true for local Mac folders/projects that do not exist on GitHub.',
        },
      },
      required: ['repo'],
    },
  },
  {
    name: 'mac_git_sync',
    description:
      'Run a fast local git sync job on the Mac mini: push uncommitted/unpushed local commits (auto-committing a WIP branch if dirty, and creating a private GitHub remote via gh repo create if create_if_missing is true) OR pull remote cloud changes down to the Mac mini.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['push', 'pull'],
          description: 'push: commit/push Mac mini local changes to origin; pull: fetch/checkout/pull origin branch onto Mac mini.',
        },
        repo: {
          type: 'string',
          description: 'Repository name, owner/repo, or local Mac path.',
        },
        branch: {
          type: 'string',
          description: 'Optional branch name to push or pull.',
        },
        create_if_missing: {
          type: 'boolean',
          description: 'If true and local folder has no git/origin remote yet, init git and create a private GitHub repo via gh.',
        },
      },
      required: ['repo'],
    },
  },
  {
    name: 'mac_list_paradev_sessions',
    description:
      'List active ParaDev workspace and terminal mappings (workspace_id, worker_terminal_id, reviewer_terminal_id, repo, cwd, branch) persisted from Mac mini jobs.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'Max sessions to return (default 20).' },
      },
    },
  },
  {
    name: 'decision_create',
    description:
      'Log a decision that needs human approval or choice into the shared Cloud+Mac Decision Mailbox.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short decision title.' },
        context: { type: 'string', description: 'Background, options, and impact.' },
        options: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of choices (e.g. ["Approve", "Reject"]).',
        },
        source_room: { type: 'string', description: 'Group chat or room name.' },
        source_bot: { type: 'string', description: 'Bot name requesting the decision.' },
        idempotency_key: { type: 'string', description: 'Optional dedup key.' },
      },
      required: ['title'],
    },
  },
  {
    name: 'decision_list',
    description: 'List pending or resolved decisions in the shared Cloud+Mac Decision Mailbox.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['pending', 'resolved'] },
        limit: { type: 'integer' },
      },
    },
  },
  {
    name: 'decision_resolve',
    description: 'Resolve a pending decision with the user choice and optional note.',
    inputSchema: {
      type: 'object',
      properties: {
        decision_id: { type: 'string' },
        choice: { type: 'string' },
        note: { type: 'string' },
      },
      required: ['decision_id', 'choice'],
    },
  },
];

function brokerRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : null;
    const req = http.request(
      {
        socketPath: SOCKET_PATH,
        path,
        method,
        headers: {
          Authorization: `Bearer ${PRODUCER_TOKEN}`,
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          try {
            resolve({ status: res.statusCode, data: JSON.parse(text) });
          } catch {
            resolve({ status: res.statusCode, data: { raw: text } });
          }
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

function replyError(id, code, message) {
  process.stdout.write(
    JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n'
  );
}

async function handleToolCall(name, args) {
  if (name === 'mac_enqueue_job') {
    const res = await brokerRequest('POST', '/v1/jobs', {
      target: args?.target || 'paradev',
      task: args?.task || '',
      repo: args?.repo,
      branch: args?.branch,
      timeout_sec: args?.timeout_sec,
      idempotency_key: args?.idempotency_key,
      workspace_id: args?.workspace_id,
      terminal_id: args?.terminal_id,
      agent: args?.agent,
      cwd: args?.cwd,
      local_only: Boolean(args?.local_only),
      role: args?.role,
      aws_session_id: args?.aws_session_id || DEFAULT_SESSION_ID,
    });
    return {
      content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }],
      isError: res.status >= 400,
    };
  }
  if (name === 'mac_job_status') {
    const id = encodeURIComponent(String(args?.job_id || ''));
    const res = await brokerRequest('GET', `/v1/jobs/${id}`);
    return {
      content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }],
      isError: res.status >= 400,
    };
  }
  if (name === 'mac_list_jobs') {
    const params = new URLSearchParams();
    if (args?.limit) params.set('limit', String(args.limit));
    if (args?.status) params.set('status', String(args.status));
    const q = params.toString();
    const res = await brokerRequest('GET', `/v1/jobs${q ? `?${q}` : ''}`);
    return {
      content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }],
      isError: res.status >= 400,
    };
  }
  if (name === 'mac_cancel_job') {
    const id = encodeURIComponent(String(args?.job_id || ''));
    const res = await brokerRequest('POST', `/v1/jobs/${id}/cancel`, {});
    return {
      content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }],
      isError: res.status >= 400,
    };
  }
  if (name === 'mac_register_paradev_repo') {
    const repo = String(args?.repo || '').trim();
    const res = await brokerRequest('POST', '/v1/jobs', {
      target: 'paradev_register',
      task: `Ensure ParaDev repo registered: ${repo}`,
      repo,
      cwd: args?.cwd,
      local_only: Boolean(args?.local_only),
      timeout_sec: 120,
      aws_session_id: DEFAULT_SESSION_ID,
    });
    return {
      content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }],
      isError: res.status >= 400,
    };
  }
  if (name === 'mac_git_sync') {
    const action = args?.action === 'pull' ? 'pull' : 'push';
    const repo = String(args?.repo || '').trim();
    const branch = args?.branch ? String(args.branch).trim() : undefined;
    const res = await brokerRequest('POST', '/v1/jobs', {
      target: 'git_sync',
      task: JSON.stringify({
        action,
        repo,
        branch,
        create_if_missing: Boolean(args?.create_if_missing),
      }),
      repo,
      branch,
      timeout_sec: 180,
      aws_session_id: DEFAULT_SESSION_ID,
    });
    return {
      content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }],
      isError: res.status >= 400,
    };
  }
  if (name === 'mac_list_paradev_sessions') {
    const params = new URLSearchParams();
    if (args?.limit) params.set('limit', String(args.limit));
    const q = params.toString();
    const res = await brokerRequest('GET', `/v1/paradev/sessions${q ? `?${q}` : ''}`);
    return {
      content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }],
      isError: res.status >= 400,
    };
  }
  if (name === 'decision_create') {
    const res = await brokerRequest('POST', '/v1/decisions', {
      title: args?.title || '',
      context: args?.context || '',
      options: Array.isArray(args?.options) ? args.options : [],
      source_env: 'aws',
      source_room: args?.source_room,
      source_bot: args?.source_bot,
      aws_session_id: DEFAULT_SESSION_ID,
      idempotency_key: args?.idempotency_key,
    });
    return {
      content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }],
      isError: res.status >= 400,
    };
  }
  if (name === 'decision_list') {
    const params = new URLSearchParams();
    if (args?.status) params.set('status', String(args.status));
    if (args?.limit) params.set('limit', String(args.limit));
    const q = params.toString();
    const res = await brokerRequest('GET', `/v1/decisions${q ? `?${q}` : ''}`);
    return {
      content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }],
      isError: res.status >= 400,
    };
  }
  if (name === 'decision_resolve') {
    const id = encodeURIComponent(String(args?.decision_id || ''));
    const res = await brokerRequest('POST', `/v1/decisions/${id}/resolve`, {
      choice: args?.choice || '',
      note: args?.note || '',
      resolved_by: 'aws-ds-bot',
    });
    return {
      content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }],
      isError: res.status >= 400,
    };
  }
  throw new Error(`Unknown tool: ${name}`);
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (msg.id === undefined || msg.id === null) return;
  try {
    if (msg.method === 'initialize') {
      reply(msg.id, {
        protocolVersion: msg.params?.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'mac-bridge', version: '1.0.0' },
      });
    } else if (msg.method === 'tools/list') {
      reply(msg.id, { tools: TOOLS });
    } else if (msg.method === 'tools/call') {
      const result = await handleToolCall(msg.params?.name, msg.params?.arguments);
      reply(msg.id, result);
    } else if (msg.method === 'ping') {
      reply(msg.id, {});
    } else {
      replyError(msg.id, -32601, `Method not found: ${msg.method}`);
    }
  } catch (err) {
    replyError(msg.id, -32000, err instanceof Error ? err.message : String(err));
  }
});
