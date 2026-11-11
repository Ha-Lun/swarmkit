// Fake `opencode acp` server for acp.test.ts: line-delimited JSON-RPC over stdio.
// Answers initialize, session/new, session/load and set_config_option, streams one
// canned turn per session/prompt, and records what it saw when FAKE_ACP_RECORD is set.
import { appendFileSync } from 'node:fs';

const recordPath = process.env.FAKE_ACP_RECORD;

function record(entry) {
  if (!recordPath) return;
  try {
    appendFileSync(recordPath, `${JSON.stringify(entry)}\n`);
  } catch {
    // The test does not depend on the record file.
  }
}

record({ method: 'start', pid: process.pid });

const send = obj => {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
};

const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const replyError = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

const MODEL = 'fake-model';
let configuredModel = null;
const modelValue = () => configuredModel ?? MODEL;

let turnSeq = 0;
const hanging = [];
const pendingPerm = new Map();
const pendingElicit = new Map();

const choice = (title, consts) => ({ type: 'string', title, description: `${title}?`, oneOf: consts.map(c => ({ const: c.toLowerCase(), title: c, description: `the ${c}` })) });
const elicitSchemas = {
  elicit: {
    type: 'object',
    properties: {
      q0: choice('Color', ['Red', 'Blue']),
      q0_custom: { type: 'string', title: 'Color (other)', description: 'Type your own answer' },
      q1: { type: 'array', title: 'Letters', description: 'Which letters?', items: { anyOf: [{ const: 'a', title: 'Alpha' }, { const: 'b', title: 'Beta, gamma' }, { const: 'c', title: 'Delta' }] } },
      q1_custom: { type: 'string', title: 'Letters (other)' },
      q2: { type: 'integer', title: 'Count', description: 'How many?' },
      q3: { type: 'boolean', title: 'Sure', description: 'Are you sure?' },
    },
    required: [],
  },
  'elicit-unknown': { type: 'object', properties: { q0: { type: 'object', title: 'Nested' } } },
  'elicit-big': { type: 'object', properties: Object.fromEntries([0, 1, 2, 3, 4].map(i => [`q${i}`, choice(`Q${i}`, ['A', 'B'])])) },
};

const configOptions = () => [{ id: 'model', name: 'Model', currentValue: modelValue() }];

function update(sessionId, upd) {
  send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: upd } });
}

function promptText(params) {
  const parts = Array.isArray(params?.prompt) ? params.prompt : [];
  return parts
    .map(p => (p && typeof p === 'object' && typeof p.text === 'string' ? p.text : ''))
    .join('\n');
}

function handlePrompt(id, params) {
  const sessionId = params?.sessionId;
  const text = promptText(params);
  if (text === 'hang') {
    hanging.push({ id, sessionId });
    return;
  }
  if (text === 'partial-exit') {
    const line = JSON.stringify({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', messageId: 'm_partial', content: { type: 'text', text: 'partial hello' } } },
    });
    process.stdout.write(line, () => process.exit(0));
    return;
  }
  if (text === 'echo-env') {
    update(sessionId, {
      sessionUpdate: 'agent_message_chunk',
      messageId: 'm_env',
      content: {
        type: 'text',
        text: JSON.stringify({
          OPENCODE: process.env.OPENCODE ?? null,
          CLAUDECODE: process.env.CLAUDECODE ?? null,
          overlay: process.env.OPENCODE_CONFIG_CONTENT ?? null,
        }),
      },
    });
    reply(id, { stopReason: 'completed', usage: { inputTokens: 1, outputTokens: 1, cachedReadTokens: 0 } });
    return;
  }
  if (Object.hasOwn(elicitSchemas, text)) {
    const elicitId = 2000 + (turnSeq += 1);
    pendingElicit.set(elicitId, { promptId: id, sessionId });
    send({
      jsonrpc: '2.0',
      id: elicitId,
      method: 'elicitation/create',
      params: { mode: 'form', sessionId, toolCallId: 'tc_q', message: 'Questions', requestedSchema: elicitSchemas[text] },
    });
    return;
  }
  const n = (turnSeq += 1);
  const thinkId = `m_think_${n}`;
  const split = text === 'split-message';
  const textId = split ? 'm_same' : `m_text_${n}`;
  const toolCallId = `tc_${n}`;
  const rawInput = { command: 'agy-task start x' };
  update(sessionId, { sessionUpdate: 'agent_thought_chunk', messageId: thinkId, content: { type: 'text', text: 'thinking one ' } });
  update(sessionId, { sessionUpdate: 'agent_thought_chunk', messageId: thinkId, content: { type: 'text', text: 'thinking two' } });
  update(sessionId, { sessionUpdate: 'agent_message_chunk', messageId: textId, content: { type: 'text', text: 'hello ' } });
  update(sessionId, { sessionUpdate: 'agent_message_chunk', messageId: textId, content: { type: 'text', text: 'world' } });
  update(sessionId, { sessionUpdate: 'tool_call', toolCallId, name: 'run', title: 'run worker', kind: 'execute', status: 'in_progress', rawInput });
  update(sessionId, {
    sessionUpdate: 'tool_call_update',
    toolCallId,
    title: 'run worker',
    kind: 'execute',
    status: 'in_progress',
    rawInput,
  });
  const permId = 1000 + n;
  pendingPerm.set(permId, { promptId: id, sessionId, toolCallId, rawInput, split });
  send({
    jsonrpc: '2.0',
    id: permId,
    method: 'session/request_permission',
    params: {
      sessionId,
      toolCall: { toolCallId, title: 'run worker', kind: 'execute', rawInput },
      options: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'allow-always', name: 'Allow always', kind: 'allow_always' },
        { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
        { optionId: 'reject-always', name: 'Reject always', kind: 'reject_always' },
      ],
    },
  });
}

function handlePermissionResponse(id, msg) {
  const elicit = pendingElicit.get(Number(id));
  if (elicit) {
    pendingElicit.delete(Number(id));
    record({ method: 'elicitation-result', result: msg?.result ?? null, error: msg?.error ?? null });
    reply(elicit.promptId, { stopReason: msg?.result?.action === 'cancel' ? 'cancelled' : 'end_turn', usage: { inputTokens: 1, outputTokens: 1, cachedReadTokens: 0 } });
    return;
  }
  const turn = pendingPerm.get(Number(id));
  if (!turn) return;
  pendingPerm.delete(Number(id));
  const outcome = msg?.result?.outcome;
  const allowed = outcome?.outcome === 'selected' && String(outcome.optionId ?? '').startsWith('allow');
  record({ method: 'permission-decision', optionId: outcome?.optionId ?? null, allowed });
  if (turn.split) {
    update(turn.sessionId, {
      sessionUpdate: 'agent_message_chunk',
      messageId: 'm_same',
      content: { type: 'text', text: 'after' },
    });
  }
  update(turn.sessionId, {
    sessionUpdate: 'tool_call_update',
    toolCallId: turn.toolCallId,
    title: 'run worker',
    kind: 'execute',
    status: allowed ? 'completed' : 'failed',
    rawInput: turn.rawInput,
    content: [{ type: 'text', text: allowed ? 'worker output ok' : 'permission denied' }],
  });
  update(turn.sessionId, { sessionUpdate: 'usage_update', cost: { amount: 0.05 } });
  reply(turn.promptId, {
    stopReason: 'finished',
    usage: { inputTokens: 10, outputTokens: 20, cachedReadTokens: 5 },
  });
}

function handle(msg) {
  if (msg === null || typeof msg !== 'object') return;
  if (typeof msg.method === 'string') {
    if (msg.id !== undefined) {
      const params = msg.method === undefined ? {} : (msg.params ?? {});
      if (msg.method === 'initialize') {
        record({ method: 'initialize', params });
        reply(msg.id, { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: false } } });
      } else if (msg.method === 'session/new') {
        record({ method: 'session/new', params });
        reply(msg.id, { sessionId: 'ses_fake', configOptions: configOptions() });
        update('ses_fake', { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'compact', description: 'Compact the session' }, { name: 'review', description: 'Review changes', input: { hint: '<path>' } }] });
      } else if (msg.method === 'session/load') {
        record({ method: 'session/load', params });
        reply(msg.id, { sessionId: params?.sessionId ?? 'ses_fake', configOptions: configOptions() });
        update(params?.sessionId ?? 'ses_fake', { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'compact', description: 'Compact the session' }, { name: 'review', description: 'Review changes', input: { hint: '<path>' } }] });
      } else if (msg.method === 'session/set_config_option') {
        record({ method: 'session/set_config_option', params });
        if (params?.configId === 'model') configuredModel = params.value ?? null;
        reply(msg.id, {});
      } else if (msg.method === 'session/prompt') {
        record({
          method: 'session/prompt',
          params: { sessionId: params?.sessionId },
          blocks: (Array.isArray(params?.prompt) ? params.prompt : []).map(b => (b.type === 'image' ? { type: b.type, mimeType: b.mimeType, dataLen: String(b.data).length } : b)),
        });
        handlePrompt(msg.id, params ?? {});
      } else {
        replyError(msg.id, -32601, `Method not found: ${msg.method}`);
      }
    } else if (msg.method === 'session/cancel') {
      record({ method: 'session/cancel', params: msg.params ?? {} });
      for (const h of hanging.splice(0)) {
        reply(h.id, { stopReason: 'cancelled', usage: { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0 } });
      }
    }
    return;
  }
  if (msg.id !== undefined) handlePermissionResponse(msg.id, msg);
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', data => {
  buffer += data;
  const lines = buffer.split('\n');
  buffer = lines.pop() ?? '';
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    try {
      handle(JSON.parse(line));
    } catch {
      // Non-JSON lines are ignored, like the adapter ignores them.
    }
  }
});

process.stdin.on('end', () => {
  record({ method: 'stdin-end' });
});

process.on('SIGTERM', () => {
  record({ method: 'sigterm' });
  process.exit(0);
});
