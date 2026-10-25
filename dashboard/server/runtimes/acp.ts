// OpenCode ACP runtime adapter: drives `opencode acp` over stdio JSON-RPC and
// yields Claude-SDK-shaped messages so SdkSessions can consume them like SDK output.
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { QueryFn } from '../sdk/sessions.ts';

export interface AcpOptions {
  command?: string[];
  model?: string;
  resumeId?: string;
  onSessionId?: (id: string) => void;
  env?: NodeJS.ProcessEnv;
}

type Rec = Record<string, unknown>;

const OVERLAY = {
  agent: {
    'lead-dev-hybrid': {
      permission: {
        bash: {
          '*': 'ask',
          'agy-task *': 'allow',
        },
      },
    },
  },
};

const MAX_TOOL_TEXT = 20000;

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function rec(v: unknown): Rec | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined;
}

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
      return { name: 'Edit', input: rawInput };
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

function pickOptionId(options: unknown, kinds: string[]): string | undefined {
  if (!Array.isArray(options)) return undefined;
  const list = options.map(rec).filter((o): o is Rec => o !== undefined);
  return str(list.find(o => typeof o.kind === 'string' && kinds.includes(o.kind))?.optionId) ?? str(list[0]?.optionId);
}

function userText(msg: SDKUserMessage): string {
  const content = rec(msg as unknown as Rec)?.message !== undefined ? rec((msg as unknown as Rec).message)?.content : undefined;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(part => {
        const p = rec(part);
        return p && p.type === 'text' && typeof p.text === 'string' ? p.text : '';
      })
      .filter(t => t.length > 0)
      .join('\n');
  }
  return '';
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
    const env: NodeJS.ProcessEnv = { ...baseEnv, OPENCODE: '1', OPENCODE_CONFIG_CONTENT: JSON.stringify(OVERLAY) };
    delete env.CLAUDECODE;

    let child: ChildProcess | null = null;
    let nextId = 1;
    const pending = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>();
    let dead = false;
    let exited = false;
    let aborted = false;
    let ready = false;
    let sessionId: string | undefined;
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
        message: { id: pendingChunk.messageId, role: 'assistant', model: modelName, content },
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
          result: { outcome: { outcome: 'selected', optionId: pickOptionId(reqOptions, ['reject_once', 'reject_always']) } },
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
              signal: (signal ?? AbortSignal.abort()) as AbortSignal,
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
          result: { outcome: { outcome: 'selected', optionId: pickOptionId(reqOptions, ['allow_once', 'allow_always']) } },
        });
      } else if (aborted || signal?.aborted) {
        write({ jsonrpc: '2.0', id, result: { outcome: { outcome: 'cancelled' } } });
      } else {
        write({
          jsonrpc: '2.0',
          id,
          result: { outcome: { outcome: 'selected', optionId: pickOptionId(reqOptions, ['reject_once', 'reject_always']) } },
        });
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

    const readTurn = (sid: string, text: string, n: number): void => {
      turnSettled = false;
      turnOutcome = null;
      chunk = null;
      lastText = '';
      void sendRequest('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text }] }).then(
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
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        });
        if (aborted) return;
        if (acpOpts.resumeId) {
          const loaded = rec(await sendRequest('session/load', { sessionId: acpOpts.resumeId, cwd, mcpServers: [] }));
          sessionId = str(loaded?.sessionId) ?? acpOpts.resumeId;
          if (acpOpts.model && modelCurrentValue(loaded?.configOptions) !== acpOpts.model) {
            await sendRequest('session/set_config_option', { sessionId, configId: 'model', value: acpOpts.model });
          }
          modelName = acpOpts.model ?? modelCurrentValue(loaded?.configOptions) ?? 'opencode';
        } else {
          const created = rec(await sendRequest('session/new', { cwd, mcpServers: [] }));
          sessionId = str(created?.sessionId);
          if (!sessionId) throw new Error('agent did not return a session id');
          if (acpOpts.model && modelCurrentValue(created?.configOptions) !== acpOpts.model) {
            await sendRequest('session/set_config_option', { sessionId, configId: 'model', value: acpOpts.model });
          }
          modelName = acpOpts.model ?? modelCurrentValue(created?.configOptions) ?? 'opencode';
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
          readTurn(sid, params.prompt, turnCount);
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
            readTurn(sid, userText(next.value), n);
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

    return Object.assign(generator, { interrupt });
  };
  return fn;
}
