// OpenCode ACP runtime adapter: drives `opencode acp` over stdio JSON-RPC and
// yields Claude-SDK-shaped messages so SdkSessions can consume them like SDK output.
// Sessions use the user's normal OpenCode config exactly like the `opencode` CLI:
// the dashboard never injects OPENCODE_CONFIG_CONTENT (and strips any
// caller-provided value) so only what the config marks `ask` reaches the
// dashboard via session/request_permission.
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { QueryFn } from '../sdk/sessions.ts';
import type { SlashCommandInfo } from '../../src/shared/types.ts';
import { num, rec, str, userBlocks } from './util.ts';
import type { Rec } from './util.ts';

export interface AcpOptions {
  command?: string[];
  model?: string;
  /** Reads the lead model per turn (model switches on follow-up turns). */
  currentModel?: () => string | undefined;
  resumeId?: string;
  onSessionId?: (id: string) => void;
  env?: NodeJS.ProcessEnv;
}

const MAX_TOOL_TEXT = 20000;

/** The configOption with id 'model', whatever shape the agent returns it in. */
function modelCurrentValue(configOptions: unknown): string | undefined {
  if (Array.isArray(configOptions)) {
    for (const opt of configOptions) {
      const o = rec(opt);
      if (o && o.id === 'model') return str(o.currentValue) ?? str(o.value);
    }
    return undefined;
  }
  const m = rec(configOptions)?.model;
  if (typeof m === 'string' && m.length > 0) return m;
  return str(rec(m)?.currentValue) ?? str(rec(m)?.value);
}

function mapToolCall(name: string | undefined, kind: string | undefined, rawInput: Rec, title: string | undefined): { name: string; input: unknown } {
  if (name === 'task') {
    return {
      name: 'Agent',
      input: {
        subagent_type: rawInput.subagent_type ?? rawInput.agent,
        description: rawInput.description ?? title,
        prompt: rawInput.prompt,
      },
    };
  }
  switch (kind) {
    case 'read':
      return { name: 'Read', input: rawInput };
    case 'edit':
    case 'delete':
    case 'move':
      return { name: 'Edit', input: rawInput };
    case 'search':
      return { name: 'Grep', input: rawInput };
    case 'execute':
      return { name: 'Bash', input: { command: rawInput.command ?? title, description: title } };
    case 'fetch':
      return { name: 'WebFetch', input: rawInput };
    case 'think':
      return { name: 'Thinking', input: rawInput };
    default:
      return { name: name ?? title ?? 'Unknown', input: rawInput };
  }
}

/** A tool call is worth emitting once its input says something or it started/finished. */
function hasMeaningfulInput(rawInput: Rec, status: string | undefined): boolean {
  return (
    Object.keys(rawInput).some(k => k !== 'cwd') ||
    status === 'in_progress' ||
    status === 'completed' ||
    status === 'failed'
  );
}

function toolResultText(update: Rec): string {
  const content = update.content;
  if (Array.isArray(content)) {
    const texts = content
      .map(part => {
        const p = rec(part);
        return p && typeof p.text === 'string' ? p.text : '';
      })
      .filter(t => t.length > 0);
    if (texts.length > 0) return texts.join('\n').slice(0, MAX_TOOL_TEXT);
  } else if (typeof content === 'string' && content.length > 0) {
    return content.slice(0, MAX_TOOL_TEXT);
  }
  const rawOutput = update.rawOutput;
  if (typeof rawOutput === 'string') return rawOutput.slice(0, MAX_TOOL_TEXT);
  if (rawOutput !== undefined && rawOutput !== null) {
    try {
      return (JSON.stringify(rawOutput) ?? '').slice(0, MAX_TOOL_TEXT);
    } catch {
      return '';
    }
  }
  return '';
}

/** Allow only picks `allow_once` (never allow_always); deny picks reject_once, then reject_always. No match -> cancelled. */
export function pickOptionId(options: unknown, kinds: string[]): string | undefined {
  if (!Array.isArray(options)) return undefined;
  const list = options.map(rec).filter((o): o is Rec => o !== undefined);
  for (const kind of kinds) {
    const id = str(list.find(o => o.kind === kind)?.optionId);
    if (id) return id;
  }
  return undefined;
}

/** The JSON-RPC permission outcome for the given acceptable kinds (cancelled when none exists). */
function outcomeFor(options: unknown, kinds: string[]): { outcome: Rec } {
  const optionId = pickOptionId(options, kinds);
  return { outcome: optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' } };
}

const MAX_QUESTIONS = 4;
const MAX_OPTIONS = 10;
const MAX_QUESTION_TEXT = 500;
const MAX_LABEL_TEXT = 100;
const MAX_DESCRIPTION_TEXT = 300;
const MAX_HEADER = 12;
const MAX_ANSWER_TEXT = 2000;
const MAX_ANSWER_TOKENS = 50;

const clip = (v: string, n: number): string => (v.length > n ? v.slice(0, n) : v);

interface ElicitOption {
  label: string;
  description?: string;
  value: unknown;
}

interface ElicitField {
  key: string;
  /** The `<key>_custom` property, present only when the schema declares it. */
  customKey?: string;
  type: 'single' | 'multi' | 'text' | 'number' | 'integer' | 'boolean';
  /** The unique question text, which keys the dashboard's answers. */
  question: string;
  options: ElicitOption[];
}

export interface Elicitation {
  input: { questions: Array<{ question: string; header: string; multiSelect: boolean; options: Array<{ label: string; description?: string }> }> };
  fields: ElicitField[];
}

/** oneOf/anyOf entries ({const,title,description}) or enum scalars, as options. null when the list is not an array. */
function elicitOptions(list: unknown): ElicitOption[] | null {
  if (!Array.isArray(list)) return null;
  const out: ElicitOption[] = [];
  for (const entry of list) {
    const e = rec(entry);
    const value = e ? e.const : entry;
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') continue;
    const label = (e && str(e.title)) || String(value);
    const description = e ? str(e.description) : undefined;
    out.push({ label: clip(label, MAX_LABEL_TEXT), ...(description ? { description: clip(description, MAX_DESCRIPTION_TEXT) } : {}), value });
  }
  return out;
}

/**
 * opencode's `elicitation/create` form as the AskUserQuestion input the dashboard shows.
 * The payload is model-controlled, so shape and sizes are checked strictly: a string with
 * an error means the request is rejected as a whole.
 */
export function parseElicitation(params: Rec): Elicitation | string {
  if (params.mode !== undefined && params.mode !== 'form') return 'unsupported elicitation mode';
  const schema = rec(params.requestedSchema);
  const props = rec(schema?.properties);
  if (!props) return 'missing requestedSchema.properties';
  const keys = Object.keys(props);
  const fields: ElicitField[] = [];
  const questions: Elicitation['input']['questions'] = [];
  const used = new Set<string>();
  for (const key of keys) {
    const base = key.endsWith('_custom') ? key.slice(0, -'_custom'.length) : undefined;
    if (base !== undefined && base.length > 0 && props[base] !== undefined) continue; // The "other" box of a choice.
    const def = rec(props[key]);
    if (!def) return `field ${clip(key, 40)} is not an object`;
    let type: ElicitField['type'];
    let options: ElicitOption[] = [];
    if (def.type === 'string') {
      options = elicitOptions(def.oneOf) ?? elicitOptions(def.anyOf) ?? elicitOptions(def.enum) ?? [];
      type = options.length > 0 ? 'single' : 'text';
    } else if (def.type === 'array') {
      const items = rec(def.items);
      options = elicitOptions(items?.anyOf) ?? elicitOptions(items?.oneOf) ?? elicitOptions(items?.enum) ?? [];
      if (options.length === 0) return `field ${clip(key, 40)} has no choices`;
      type = 'multi';
    } else if (def.type === 'number' || def.type === 'integer' || def.type === 'boolean') {
      type = def.type;
    } else {
      return `field ${clip(key, 40)} has an unsupported type`;
    }
    if (questions.length >= MAX_QUESTIONS) return `more than ${MAX_QUESTIONS} questions`;
    if (options.length > MAX_OPTIONS) return `more than ${MAX_OPTIONS} options`;
    const title = str(def.title);
    let question = clip(str(def.description) ?? title ?? key, MAX_QUESTION_TEXT);
    for (let n = 2; used.has(question); n++) question = `${clip(question, MAX_QUESTION_TEXT)} (${n})`;
    used.add(question);
    const customKey = `${key}_custom`;
    fields.push({ key, ...(props[customKey] !== undefined ? { customKey } : {}), type, question, options });
    questions.push({
      question,
      header: clip(title ?? key, MAX_HEADER),
      multiSelect: type === 'multi',
      options: options.map(o => ({ label: o.label, ...(o.description ? { description: o.description } : {}) })),
    });
  }
  if (questions.length === 0) return 'no questions';
  return { input: { questions }, fields };
}

/** The accept `content` for the dashboard's answers (keyed by question text): consts for matched choices, free text via `<key>_custom`. */
export function elicitationContent(e: Elicitation, answers: Record<string, unknown> | undefined): Rec {
  const content: Rec = {};
  for (const f of e.fields) {
    const raw = answers?.[f.question];
    const text = typeof raw === 'string' ? clip(raw.trim(), MAX_ANSWER_TEXT) : '';
    if (text.length === 0) continue;
    if (f.type === 'single') {
      const hit = f.options.find(o => o.label === text);
      if (hit) content[f.key] = hit.value;
      else content[f.customKey ?? f.key] = text;
    } else if (f.type === 'multi') {
      const tokens = text.split(',').slice(0, MAX_ANSWER_TOKENS);
      const picked: unknown[] = [];
      let unmatched = false;
      for (let i = 0; i < tokens.length;) {
        let hit: ElicitOption | undefined;
        let end = i + 1;
        // Longest run of tokens that rejoins into a label (labels may contain commas).
        for (let j = tokens.length; j > i; j--) {
          const candidate = tokens.slice(i, j).join(',').trim();
          hit = f.options.find(o => o.label === candidate);
          if (hit) {
            end = j;
            break;
          }
        }
        if (hit) picked.push(hit.value);
        else if (tokens[i]!.trim().length > 0) unmatched = true;
        i = end;
      }
      // A non-empty custom field overrides the choices in opencode, so free text carries the whole answer.
      if (unmatched && f.customKey) content[f.customKey] = text;
      else if (picked.length > 0) content[f.key] = picked;
    } else if (f.type === 'number' || f.type === 'integer') {
      const n = Number(text);
      if (Number.isFinite(n) && (f.type === 'number' || Number.isInteger(n))) content[f.key] = n;
    } else if (f.type === 'boolean') {
      if (/^(true|yes|y|1)$/i.test(text)) content[f.key] = true;
      else if (/^(false|no|n|0)$/i.test(text)) content[f.key] = false;
    } else {
      content[f.key] = text;
    }
  }
  return content;
}

interface ToolState {
  emitted: boolean;
  finished: boolean;
  name?: string;
  kind?: string;
  title?: string;
  rawInput: Rec;
}

interface PendingChunk {
  messageId: string;
  kind: 'agent_message_chunk' | 'agent_thought_chunk';
  text: string;
}

export function createAcpQuery(acpOpts: AcpOptions): QueryFn {
  const fn: QueryFn = params => {
    const options: Options = params.options ?? {};
    const cmd = acpOpts.command ?? ['opencode', 'acp'];
    const cwd = typeof options.cwd === 'string' ? options.cwd : process.cwd();
    const baseEnv = acpOpts.env ?? process.env;
    // Use the user's normal OpenCode config: never inject OPENCODE_CONFIG_CONTENT,
    // and strip any caller-provided value so the dashboard cannot alter permissions.
    const env: NodeJS.ProcessEnv = { ...baseEnv, OPENCODE: '1' };
    delete env.OPENCODE_CONFIG_CONTENT;
    delete env.CLAUDECODE;

    let child: ChildProcess | null = null;
    let nextId = 1;
    const pending = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>();
    let dead = false;
    let exited = false;
    let aborted = false;
    let ready = false;
    let sessionId: string | undefined;
    // Latest available slash commands from the agent (available_commands_update).
    let commands: SlashCommandInfo[] = [];
    let modelName = acpOpts.model;
    let turnCount = 0;
    let cost: number | undefined;
    let killTimer: NodeJS.Timeout | null = null;

    const outbox: SDKMessage[] = [];
    let wake: (() => void) | null = null;
    const signalOut = (): void => {
      if (wake) {
        const w = wake;
        wake = null;
        w();
      }
    };
    const push = (msg: SDKMessage): void => {
      outbox.push(msg);
      signalOut();
    };

    let chunk: PendingChunk | null = null;
    let flushSeq = 0;
    let lastText = '';
    const tools = new Map<string, ToolState>();
    let turnSettled = false;
    let turnOutcome: { result?: unknown; error?: unknown } | null = null;
    const settleTurn = (outcome: { result?: unknown; error?: unknown }): void => {
      if (turnSettled) return;
      turnSettled = true;
      turnOutcome = outcome;
      signalOut();
    };

    let endReject: ((err: Error) => void) | null = null;
    const endPromise = new Promise<never>((_resolve, reject) => {
      endReject = reject;
    });
    endPromise.catch(() => {});
    const finishWaiting = (err: Error): void => {
      if (endReject) {
        const reject = endReject;
        endReject = null;
        reject(err);
      }
    };

    const write = (obj: unknown): void => {
      if (!child || exited || !child.stdin?.writable) return;
      try {
        child.stdin.write(`${JSON.stringify(obj)}\n`);
      } catch {
        // The child is going away; exit handling covers the rest.
      }
    };
    const sendRequest = (method: string, reqParams: unknown): Promise<unknown> =>
      new Promise<unknown>((resolve, reject) => {
        if (exited) {
          reject(new Error('agent process exited'));
          return;
        }
        const id = nextId++;
        pending.set(id, { resolve, reject });
        write({ jsonrpc: '2.0', id, method, params: reqParams });
      });
    const sendNotification = (method: string, noteParams: unknown): void => {
      write({ jsonrpc: '2.0', method, params: noteParams });
    };

    const kill = (): void => {
      const proc = child;
      if (!proc || exited || killTimer) return;
      try {
        proc.kill('SIGTERM');
      } catch {
        // Already gone.
      }
      killTimer = setTimeout(() => {
        killTimer = null;
        if (!exited && proc.exitCode === null && proc.signalCode === null) {
          try {
            proc.kill('SIGKILL');
          } catch {
            // Already gone.
          }
        }
      }, 3000);
      killTimer.unref?.();
    };

    const flushChunk = (): void => {
      const pendingChunk = chunk;
      chunk = null;
      if (!pendingChunk || !sessionId || pendingChunk.text.length === 0) return;
      const content =
        pendingChunk.kind === 'agent_thought_chunk'
          ? [{ type: 'thinking', thinking: pendingChunk.text }]
          : [{ type: 'text', text: pendingChunk.text }];
      push({
        type: 'assistant',
        parent_tool_use_id: null,
        session_id: sessionId,
        message: { id: `${pendingChunk.messageId}#${flushSeq++}`, role: 'assistant', model: modelName, content },
      } as unknown as SDKMessage);
    };

    const onChunk = (kind: 'agent_message_chunk' | 'agent_thought_chunk', messageId: string, text: string): void => {
      if (messageId.length === 0 || text.length === 0) return;
      if (chunk && (chunk.messageId !== messageId || chunk.kind !== kind)) flushChunk();
      if (!chunk) chunk = { messageId, kind, text: '' };
      chunk.text += text;
      if (kind === 'agent_message_chunk') lastText = chunk.text;
    };

    const onToolUpdate = (update: Rec): void => {
      const toolCallId = str(update.toolCallId);
      if (!toolCallId || !sessionId) return;
      let state = tools.get(toolCallId);
      if (!state) {
        state = { emitted: false, finished: false, rawInput: {} };
        tools.set(toolCallId, state);
      }
      const name = str(update.name) ?? state.name;
      const kind = str(update.kind) ?? state.kind;
      const title = str(update.title) ?? state.title;
      const rawInput = rec(update.rawInput);
      if (rawInput) state.rawInput = { ...state.rawInput, ...rawInput };
      if (name !== undefined) state.name = name;
      if (kind !== undefined) state.kind = kind;
      if (title !== undefined) state.title = title;
      const status = str(update.status);
      if (!state.emitted && hasMeaningfulInput(state.rawInput, status)) {
        state.emitted = true;
        const mapped = mapToolCall(state.name, state.kind, state.rawInput, state.title);
        push({
          type: 'assistant',
          parent_tool_use_id: null,
          session_id: sessionId,
          message: {
            id: `tool-${toolCallId}`,
            role: 'assistant',
            model: modelName,
            content: [{ type: 'tool_use', id: toolCallId, name: mapped.name, input: mapped.input }],
          },
        } as unknown as SDKMessage);
      }
      if ((status === 'completed' || status === 'failed') && state.emitted && !state.finished) {
        state.finished = true;
        push({
          type: 'user',
          parent_tool_use_id: null,
          session_id: sessionId,
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: toolCallId,
                content: toolResultText(update),
                is_error: status === 'failed',
              },
            ],
          },
        } as unknown as SDKMessage);
      }
    };

    const onUpdate = (update: Rec, sid: string | undefined): void => {
      // Commands arrive right after session/new or load, before ready is set.
      if (update.sessionUpdate === 'available_commands_update') {
        if (sid !== undefined && sessionId !== undefined && sid !== sessionId) return;
        const list = Array.isArray(update.availableCommands) ? update.availableCommands : [];
        const next: SlashCommandInfo[] = [];
        for (const entry of list) {
          const r = rec(entry);
          if (!r || typeof r.name !== 'string' || r.name.length === 0) continue;
          const item: SlashCommandInfo = { name: r.name };
          if (typeof r.description === 'string' && r.description.length > 0) item.description = r.description;
          const hint = rec(r.input)?.hint;
          if (typeof hint === 'string' && hint.length > 0) item.argumentHint = hint;
          next.push(item);
        }
        commands = next;
        return;
      }
      if (!ready) return;
      if (sid !== undefined && sessionId !== undefined && sid !== sessionId) return;
      const kind = update.sessionUpdate;
      if (kind === 'agent_message_chunk' || kind === 'agent_thought_chunk') {
        const content = rec(update.content);
        if (content && typeof content.text === 'string') {
          onChunk(kind, str(update.messageId) ?? '', content.text);
        }
        return;
      }
      flushChunk();
      if (kind === 'tool_call' || kind === 'tool_call_update') {
        onToolUpdate(update);
      } else if (kind === 'usage_update') {
        const amount = rec(update.cost)?.amount;
        if (typeof amount === 'number' && Number.isFinite(amount)) cost = amount;
      }
    };

    const onPermissionRequest = async (id: number | string, reqParams: Rec): Promise<void> => {
      const sid = str(reqParams.sessionId);
      if (!sessionId || (sid !== undefined && sid !== sessionId)) {
        write({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
        return;
      }
      const toolCall = rec(reqParams.toolCall) ?? {};
      const reqOptions = reqParams.options;
      const mapped = mapToolCall(str(toolCall.name), str(toolCall.kind), rec(toolCall.rawInput) ?? {}, str(toolCall.title));
      const canUse = options.canUseTool;
      if (!canUse) {
        write({
          jsonrpc: '2.0',
          id,
          result: outcomeFor(reqOptions, ['reject_once', 'reject_always']),
        });
        return;
      }
      const signal = options.abortController?.signal;
      if (signal?.aborted) {
        write({ jsonrpc: '2.0', id, result: { outcome: { outcome: 'cancelled' } } });
        return;
      }
      let decision: unknown;
      try {
        decision = await Promise.race([
          canUse(
            mapped.name,
            (mapped.input ?? {}) as Record<string, unknown>,
            {
              signal: (signal ?? new AbortController().signal) as AbortSignal,
              toolUseID: str(toolCall.toolCallId) ?? String(id),
              ...(str(toolCall.title) ? { title: str(toolCall.title) as string } : {}),
              requestId: String(id),
            },
          ),
          endPromise.then(
            () => ({ behavior: 'cancelled' }),
            () => ({ behavior: 'cancelled' }),
          ),
        ]);
      } catch {
        decision = { behavior: 'deny' };
      }
      const behavior = rec(decision)?.behavior;
      if (behavior === 'allow' && !aborted && !signal?.aborted) {
        write({
          jsonrpc: '2.0',
          id,
          result: outcomeFor(reqOptions, ['allow_once']),
        });
      } else if (aborted || signal?.aborted) {
        write({ jsonrpc: '2.0', id, result: { outcome: { outcome: 'cancelled' } } });
      } else {
        write({
          jsonrpc: '2.0',
          id,
          result: outcomeFor(reqOptions, ['reject_once', 'reject_always']),
        });
      }
    };

    /** agent -> client `elicitation/create`: opencode's questions, shown through canUseTool as an AskUserQuestion. */
    const onElicitation = async (id: number | string, reqParams: Rec): Promise<void> => {
      const sid = str(reqParams.sessionId);
      if (!sessionId || (sid !== undefined && sid !== sessionId)) {
        write({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
        return;
      }
      const parsed = parseElicitation(reqParams);
      if (typeof parsed === 'string') {
        write({ jsonrpc: '2.0', id, error: { code: -32602, message: `Invalid elicitation: ${parsed}` } });
        return;
      }
      const canUse = options.canUseTool;
      const signal = options.abortController?.signal;
      // Declining would cancel the whole turn, so no way to ask means "skipped": accept with nothing.
      if (!canUse) {
        write({ jsonrpc: '2.0', id, result: { action: 'accept', content: {} } });
        return;
      }
      if (aborted || signal?.aborted) {
        write({ jsonrpc: '2.0', id, result: { action: 'cancel' } });
        return;
      }
      let decision: unknown;
      try {
        decision = await Promise.race([
          canUse('AskUserQuestion', parsed.input as Record<string, unknown>, {
            signal: (signal ?? new AbortController().signal) as AbortSignal,
            toolUseID: str(reqParams.toolCallId) ?? String(id),
            requestId: String(id),
          }),
          endPromise.then(
            () => ({ behavior: 'cancelled' }),
            () => ({ behavior: 'cancelled' }),
          ),
        ]);
      } catch {
        decision = { behavior: 'deny' };
      }
      const d = rec(decision);
      if (aborted || signal?.aborted || d?.behavior === 'cancelled') {
        write({ jsonrpc: '2.0', id, result: { action: 'cancel' } });
      } else if (d?.behavior === 'allow') {
        const answers = rec(rec(d.updatedInput)?.answers);
        write({ jsonrpc: '2.0', id, result: { action: 'accept', content: elicitationContent(parsed, answers) } });
      } else {
        write({ jsonrpc: '2.0', id, result: { action: 'accept', content: {} } });
      }
    };

    const onLine = (line: string): void => {
      const trimmed = line.trim();
      if (trimmed.length === 0) return;
      let msg: Rec;
      try {
        const parsed: unknown = JSON.parse(trimmed);
        const asRec = rec(parsed);
        if (!asRec) return;
        msg = asRec;
      } catch {
        return;
      }
      if (msg.method !== undefined) {
        if (msg.id !== undefined) {
          if (msg.method === 'session/request_permission') {
            void onPermissionRequest(msg.id as number | string, rec(msg.params) ?? {});
          } else if (msg.method === 'elicitation/create') {
            void onElicitation(msg.id as number | string, rec(msg.params) ?? {});
          } else {
            write({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${String(msg.method)}` } });
          }
        } else if (msg.method === 'session/update') {
          const p = rec(msg.params) ?? {};
          onUpdate(rec(p.update) ?? {}, str(p.sessionId));
        }
        return;
      }
      if (msg.id !== undefined) {
        const key = Number(msg.id);
        const entry = pending.get(key);
        if (!entry) return;
        pending.delete(key);
        if (msg.error !== undefined && msg.error !== null) {
          entry.reject(new Error(str(rec(msg.error)?.message) ?? 'agent request failed'));
        } else {
          entry.resolve(msg.result);
        }
      }
    };

    const waitWake = (): Promise<void> =>
      new Promise<void>(resolve => {
        wake = resolve;
      });
    const waitEvent = (): Promise<void> => {
      if (outbox.length > 0 || turnSettled || aborted || exited) return Promise.resolve();
      return Promise.race([waitWake(), endPromise.then(() => undefined, () => undefined)]);
    };

    const readTurn = async (sid: string, blocks: ReturnType<typeof userBlocks>, n: number): Promise<void> => {
      turnSettled = false;
      turnOutcome = null;
      chunk = null;
      lastText = '';
      const want = acpOpts.currentModel?.() ?? acpOpts.model;
      if (want && want !== modelName && !exited) {
        try {
          await sendRequest('session/set_config_option', { sessionId: sid, configId: 'model', value: want });
          modelName = want;
        } catch (err) {
          settleTurn({ error: err });
          return;
        }
      }
      void sendRequest('session/prompt', { sessionId: sid, prompt: blocks }).then(
        result => settleTurn({ result }),
        error => settleTurn({ error }),
      );
    };

    const finishTurn = (sid: string, n: number): SDKMessage | null => {
      flushChunk();
      if (aborted) return null;
      const outcome = turnOutcome;
      if (!outcome || outcome.error !== undefined) {
        const message = outcome?.error instanceof Error ? outcome.error.message : 'prompt failed';
        return {
          type: 'result',
          subtype: 'error_during_execution',
          session_id: sid,
          ...(cost !== undefined ? { total_cost_usd: cost } : {}),
          usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 },
          num_turns: n,
          result: message,
          is_error: true,
        } as unknown as SDKMessage;
      }
      const r = rec(outcome.result) ?? {};
      const usage = rec(r.usage) ?? {};
      const stopReason = str(r.stopReason);
      return {
        type: 'result',
        subtype: stopReason === 'cancelled' ? 'error_during_execution' : 'success',
        session_id: sid,
        ...(cost !== undefined ? { total_cost_usd: cost } : {}),
        usage: {
          input_tokens: num(usage.inputTokens),
          output_tokens: num(usage.outputTokens),
          cache_read_input_tokens: num(usage.cachedReadTokens),
        },
        num_turns: n,
        result: lastText,
        is_error: false,
      } as unknown as SDKMessage;
    };

    const generator = (async function* (): AsyncGenerator<SDKMessage, void, void> {
      const abortSignal = options.abortController?.signal;
      const abortHandler = (): void => {
        aborted = true;
        kill();
        settleTurn({ error: new Error('aborted') });
        finishWaiting(new Error('aborted'));
        signalOut();
      };
      if (abortSignal) {
        if (abortSignal.aborted) {
          aborted = true;
        } else {
          abortSignal.addEventListener('abort', abortHandler, { once: true });
        }
      }
      try {
        if (cmd.length === 0) throw new Error('no command to spawn');
        child = spawn(cmd[0] as string, cmd.slice(1), { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
        child.stderr?.resume();
        let rest = '';
        child.stdout?.on('data', (data: Buffer) => {
          rest += data.toString('utf8');
          const lines = rest.split('\n');
          rest = lines.pop() ?? '';
          for (const line of lines) onLine(line);
        });
        const onDead = (): void => {
          if (dead) return;
          if (rest.trim().length > 0) {
            const tail = rest;
            rest = '';
            onLine(tail);
          }
          dead = true;
          exited = true;
          if (killTimer) {
            clearTimeout(killTimer);
            killTimer = null;
          }
          for (const [, entry] of [...pending]) entry.reject(new Error('agent process exited'));
          pending.clear();
          settleTurn({ error: new Error('agent process exited') });
          finishWaiting(new Error('agent process exited'));
          signalOut();
        };
        child.on('error', onDead);
        child.on('exit', onDead);

        await sendRequest('initialize', {
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, elicitation: { form: {} } },
        });
        if (aborted) return;
        if (acpOpts.resumeId) {
          const loaded = rec(await sendRequest('session/load', { sessionId: acpOpts.resumeId, cwd, mcpServers: [] }));
          sessionId = str(loaded?.sessionId) ?? acpOpts.resumeId;
          const initialModel = acpOpts.currentModel?.() ?? acpOpts.model;
          if (initialModel && modelCurrentValue(loaded?.configOptions) !== initialModel) {
            await sendRequest('session/set_config_option', { sessionId, configId: 'model', value: initialModel });
          }
          modelName = initialModel ?? modelCurrentValue(loaded?.configOptions) ?? 'opencode';
        } else {
          const created = rec(await sendRequest('session/new', { cwd, mcpServers: [] }));
          sessionId = str(created?.sessionId);
          if (!sessionId) throw new Error('agent did not return a session id');
          const initialModel = acpOpts.currentModel?.() ?? acpOpts.model;
          if (initialModel && modelCurrentValue(created?.configOptions) !== initialModel) {
            await sendRequest('session/set_config_option', { sessionId, configId: 'model', value: initialModel });
          }
          modelName = initialModel ?? modelCurrentValue(created?.configOptions) ?? 'opencode';
        }
        ready = true;
        acpOpts.onSessionId?.(sessionId);
        const sid = sessionId;
        yield {
          type: 'system',
          subtype: 'init',
          session_id: (options.sessionId ?? options.resume ?? sid) as string,
          model: modelName,
          cwd,
        } as unknown as SDKMessage;

        if (typeof params.prompt === 'string') {
          turnCount += 1;
          await readTurn(sid, [{ type: 'text', text: params.prompt }], turnCount);
          for (;;) {
            while (outbox.length > 0) yield outbox.shift() as SDKMessage;
            if (turnSettled || aborted || exited) break;
            await waitEvent();
          }
          while (outbox.length > 0) yield outbox.shift() as SDKMessage;
          const done = finishTurn(sid, turnCount);
          while (outbox.length > 0) yield outbox.shift() as SDKMessage;
          if (done) yield done;
        } else {
          const it = params.prompt[Symbol.asyncIterator]();
          for (;;) {
            if (aborted || exited) break;
            const next = await Promise.race([
              it.next(),
              endPromise.then(
                () => undefined,
                () => undefined,
              ),
            ]);
            if (aborted || exited || !next || next.done) break;
            turnCount += 1;
            const n = turnCount;
            await readTurn(sid, userBlocks(next.value), n);
            for (;;) {
              while (outbox.length > 0) yield outbox.shift() as SDKMessage;
              if (turnSettled || aborted || exited) break;
              await waitEvent();
            }
            while (outbox.length > 0) yield outbox.shift() as SDKMessage;
            const done = finishTurn(sid, n);
            while (outbox.length > 0) yield outbox.shift() as SDKMessage;
            if (done) yield done;
            else break;
            if (exited || aborted) break;
          }
        }
      } finally {
        if (abortSignal) abortSignal.removeEventListener('abort', abortHandler);
        child?.stdout?.removeAllListeners('data');
        if (child && !exited) {
          // The child is still alive (e.g. Stop was pressed): SIGTERM first,
          // then SIGKILL after 3 s via killTimer. stdin EOF alone can let the
          // child exit 0 on its own before the signal lands, so keep the
          // signal as the primary cause and keep the SIGKILL fallback and the
          // exit tracking armed until the child is actually reaped.
          kill();
          try {
            child.stdin?.end();
          } catch {
            // Already gone.
          }
          const proc = child;
          child = null;
          proc.once('exit', () => {
            if (killTimer) {
              clearTimeout(killTimer);
              killTimer = null;
            }
            proc.removeAllListeners();
          });
        } else {
          if (killTimer) {
            clearTimeout(killTimer);
            killTimer = null;
          }
          if (child) {
            try {
              child.stdin?.end();
            } catch {
              // Already gone.
            }
          }
          child?.removeAllListeners();
          child = null;
        }
      }
    })();

    const interrupt = (): Promise<void> => {
      if (sessionId && child && !exited) sendNotification('session/cancel', { sessionId });
      return Promise.resolve();
    };

    return Object.assign(generator, {
      interrupt,
      supportedCommands: async (): Promise<SlashCommandInfo[]> => commands,
    });
  };
  return fn;
}
