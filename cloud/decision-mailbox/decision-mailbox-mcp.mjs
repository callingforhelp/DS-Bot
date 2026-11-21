#!/usr/bin/env node
/**
 * Stdio MCP server for Mac DS Bot.app connecting to the unified AWS Decision Mailbox
 * over the local SSM tunnel (http://127.0.0.1:13090), with offline local spooling
 * to ~/.mac-job-worker/pending-decisions.jsonl so local decisions carry over to cloud.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const ENV_FILE = process.env.WORKER_ENV_FILE || '/Users/chief/.mac-job-worker/env';
const SPOOL_FILE =
  process.env.DECISION_SPOOL_FILE || '/Users/chief/.mac-job-worker/pending-decisions.jsonl';
const BROKER_URL = (process.env.BROKER_URL || 'http://127.0.0.1:13090').replace(/\/+$/, '');

function readWorkerToken() {
  if (process.env.BROKER_WORKER_TOKEN) return process.env.BROKER_WORKER_TOKEN.trim();
  try {
    const lines = fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      if (line.startsWith('BROKER_WORKER_TOKEN=')) {
        return line.slice('BROKER_WORKER_TOKEN='.length).trim();
      }
    }
  } catch {
    return '';
  }
  return '';
}

const WORKER_TOKEN = readWorkerToken();

const TOOLS = [
  {
    name: 'decision_create',
    description:
      'Log a decision that needs human approval or choice into the shared Cloud+Mac Decision Mailbox (spools locally if Mac is offline and syncs to AWS automatically).',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short decision title.' },
        context: { type: 'string', description: 'Background, options, and impact.' },
        options: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of choices.',
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

async function brokerFetch(method, urlPath, body) {
  const res = await fetch(`${BROKER_URL}${urlPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${WORKER_TOKEN}`,
      'Content-Type': 'application/json',
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(8_000),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  return { status: res.status, data };
}

function spoolDecision(payload) {
  fs.mkdirSync(path.dirname(SPOOL_FILE), { recursive: true });
  fs.appendFileSync(SPOOL_FILE, JSON.stringify(payload) + '\n', { mode: 0o600 });
}

async function handleToolCall(name, args) {
  if (name === 'decision_create') {
    const payload = {
      title: String(args?.title || '').trim(),
      context: String(args?.context || '').trim(),
      options: Array.isArray(args?.options) ? args.options : [],
      source_env: 'mac',
      source_room: args?.source_room || null,
      source_bot: args?.source_bot || null,
      idempotency_key: args?.idempotency_key || `mac_${crypto.randomUUID()}`,
    };
    try {
      const res = await brokerFetch('POST', '/v1/decisions', payload);
      return {
        content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }],
        isError: res.status >= 400,
      };
    } catch {
      spoolDecision(payload);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                ok: true,
                queued_locally: true,
                message:
                  'EC2 broker unreachable; decision spooled locally and will carry over to cloud automatically when SSM reconnects.',
                idempotency_key: payload.idempotency_key,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  }

  if (name === 'decision_list') {
    const params = new URLSearchParams();
    if (args?.status) params.set('status', String(args.status));
    if (args?.limit) params.set('limit', String(args.limit));
    const q = params.toString();
    const res = await brokerFetch('GET', `/v1/decisions${q ? `?${q}` : ''}`);
    return {
      content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }],
      isError: res.status >= 400,
    };
  }

  if (name === 'decision_resolve') {
    const id = encodeURIComponent(String(args?.decision_id || ''));
    const res = await brokerFetch('POST', `/v1/decisions/${id}/resolve`, {
      choice: String(args?.choice || ''),
      note: String(args?.note || ''),
      resolved_by: 'mac-ds-bot',
    });
    return {
      content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }],
      isError: res.status >= 400,
    };
  }

  throw new Error(`Unknown tool: ${name}`);
}

function writeMsg(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
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
      writeMsg({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: msg.params?.protocolVersion || '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'decision-mailbox', version: '1.0.0' },
        },
      });
    } else if (msg.method === 'tools/list') {
      writeMsg({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } });
    } else if (msg.method === 'tools/call') {
      const result = await handleToolCall(msg.params?.name, msg.params?.arguments);
      writeMsg({ jsonrpc: '2.0', id: msg.id, result });
    } else if (msg.method === 'ping') {
      writeMsg({ jsonrpc: '2.0', id: msg.id, result: {} });
    } else {
      writeMsg({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32601, message: `Method not found: ${msg.method}` },
      });
    }
  } catch (err) {
    writeMsg({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
        isError: true,
      },
    });
  }
});
