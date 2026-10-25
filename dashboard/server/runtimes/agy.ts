// agy runtime adapter: one `agy -p` process per turn, yielding Claude-SDK-shaped messages.
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import type { Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { QueryFn } from '../sdk/sessions.ts';
import { num, str, userText } from './util.ts';

export interface AgyOptions {
  command?: string;
  /** e.g. ['node', '/abs/fake-agy.mjs'] for tests; when set, spawn(prefix[0], [...prefix.slice(1), ...args]). */
  commandPrefix?: string[];
  model?: string;
  /** Reads the lead model per turn (model switches on follow-up turns). */
  currentModel?: () => string | undefined;
  effort?: string;
  agent?: string;
  /** agy conversation id -> --conversation on the first turn. */
  resumeId?: string;
  onSessionId?: (id: string) => void;
  hook?: { url: string; secret: string };
  env?: NodeJS.ProcessEnv;
  /** Absolute image dir of the session once it has pasted images: --add-dir on each turn, and the hook may read there. */
  imagesDir?: () => string | undefined;
}

export interface AgyHookRequest {
  tool: string;
  input: Record<string, unknown>;
  toolUseId: string;
  title?: string;
}

interface AgyHookDecision {
  allow: boolean;
  reason?: string;
}

export interface AgyHookResponse {
  status: number;
  json: { decision: 'allow' | 'deny'; reason?: string };
}

type Raw = Record<string, unknown>;

type HookHandler = (req: AgyHookRequest, signal?: AbortSignal) => Promise<AgyHookDecision>;


function strip(input: Raw): Raw {
  const out: Raw = {};
  for (const [k, v] of Object.entries(input)) if (v !== undefined) out[k] = v;
  return out;
}

function asObj(v: unknown): Raw {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : {};
}

const MAX_RAW = 20000;

/** All raw tool parameters for the permission prompt, bounded to MAX_RAW chars when stringified. */
function boundedRaw(params: Raw): unknown {
  let text: string;
  try {
    text = JSON.stringify(params) ?? '';
  } catch {
    return '[unserializable parameters]';
  }
  return text.length <= MAX_RAW ? params : `${text.slice(0, MAX_RAW)}... [truncated]`;
}

/** agy tool name + raw params -> the Claude tool name/input the dashboard reducer understands. */
function mapTool(name: string, params: Raw): { name: string; input: Raw } {
  const pick = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = params[k];
      if (typeof v === 'string' && v.length > 0) return v;
    }
    return undefined;
  };
  const file = (v: string | undefined): Raw => (v ? { file_path: v } : {});
  switch (name) {
    case 'view_file':
    case 'read_file':
      return { name: 'Read', input: file(pick('AbsolutePath', 'Path')) };
    case 'list_dir':
      return { name: 'Read', input: file(pick('DirectoryPath')) };
    case 'write_to_file':
    case 'replace_file_content':
    case 'multi_replace_file_content':
      return { name: 'Edit', input: file(pick('TargetFile')) };
    case 'edit_file':
    case 'write_file':
    case 'sed_file':
      return { name: 'Edit', input: file(pick('Path', 'TargetFile')) };
    case 'grep_search':
      return { name: 'Grep', input: strip({ pattern: pick('Query'), path: pick('SearchPath') }) };
    case 'find_by_name':
      return { name: 'Grep', input: strip({ pattern: pick('Pattern'), path: pick('SearchDirectory') }) };
    case 'run_command': {
      const input: Raw = { command: pick('CommandLine') };
      const desc = pick('toolSummary');
      if (desc) input.description = desc;
      return { name: 'Bash', input: strip(input) };
    }
    case 'read_url_content':
    case 'search_web': {
      const input: Raw = {};
      const url = pick('Url', 'url');
      const query = pick('Query', 'query');
      if (url) input.url = url;
      if (query) input.query = query;
      return { name: 'WebFetch', input: Object.keys(input).length > 0 ? input : { ...params } };
    }
    case 'invoke_subagent':
    case 'browser_subagent': {
      const input: Raw = { description: pick('toolSummary') ?? 'subagent' };
      const st = pick('name', 'agent', 'subagent_type');
      if (st) input.subagent_type = st;
      const prompt = pick('prompt', 'Task');
      if (prompt) input.prompt = prompt;
      return { name: 'Agent', input };
    }
    default:
      return { name, input: { ...params } };
  }
}

function mapUsage(u: unknown): { input_tokens: number; output_tokens: number; cache_read_input_tokens: number } | undefined {
  if (!u || typeof u !== 'object' || Array.isArray(u)) return undefined;
  const r = u as Raw;
  return { input_tokens: num(r.input_tokens), output_tokens: num(r.output_tokens), cache_read_input_tokens: num(r.cache_read_tokens) };
}

export function createAgyQuery(opts: AgyOptions): QueryFn {
  const fn = (params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }) => {
    let proc: ChildProcess | null = null;
    let killTimer: NodeJS.Timeout | null = null;
    let aborted = false;
    const options = params.options;
    const sessionId = options?.sessionId ?? options?.resume ?? '';
    const model = opts.model ?? options?.model;
    const cwd = options?.cwd;
    const signal = options?.abortController?.signal;
    let convId: string | undefined = opts.resumeId;
    let reported = false;

    const noteId = (id: string): void => {
      convId = id;
      if (!reported) {
        reported = true;
        opts.onSessionId?.(id);
      }
    };

    const clearKillTimer = (): void => {
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = null;
      }
    };

    const kill = (sig: NodeJS.Signals, thenSig?: NodeJS.Signals, afterMs?: number): void => {
      const p = proc;
      if (!p || p.exitCode !== null || p.signalCode !== null) return;
      try {
        p.kill(sig);
      } catch {
        // Already gone.
      }
      if (thenSig && afterMs !== undefined) {
        clearKillTimer();
        killTimer = setTimeout(() => {
          try {
            p.kill(thenSig);
          } catch {
            // Already gone.
          }
        }, afterMs);
        killTimer.unref();
      }
    };

    if (signal) {
      if (signal.aborted) aborted = true;
      else {
        signal.addEventListener('abort', () => {
          aborted = true;
          kill('SIGTERM', 'SIGKILL', 3000);
        }, { once: true });
      }
    }

    const envFor = (): NodeJS.ProcessEnv => {
      const env: NodeJS.ProcessEnv = { ...process.env, ...opts.env };
      if (opts.hook) {
        env.SWARMKIT_DASH_HOOK_URL = opts.hook.url;
        env.SWARMKIT_DASH_HOOK_SECRET = opts.hook.secret;
        if (cwd) env.SWARMKIT_DASH_CWD = cwd;
      }
      const imagesDir = opts.imagesDir?.();
      if (opts.hook && imagesDir) env.SWARMKIT_DASH_IMAGES_DIR = imagesDir;
      delete env.CLAUDECODE;
      delete env.OPENCODE;
      return env;
    };

    const argsFor = (text: string, conv: string | undefined): string[] => {
      const args = ['-p', text, '--output-format', 'stream-json', '--agent', opts.agent ?? 'lead-dev-hybrid'];
      const turnModel = opts.currentModel?.() ?? opts.model;
      if (turnModel) args.push('--model', turnModel);
      if (opts.effort) args.push('--effort', opts.effort);
      if (conv) args.push('--conversation', conv);
      const imagesDir = opts.imagesDir?.();
      if (imagesDir) args.push('--add-dir', imagesDir);
      if (opts.hook) args.push('--dangerously-skip-permissions');
      return args;
    };

    const asMsg = (m: unknown): SDKMessage => m as SDKMessage;
    const errorResult = (text: string): SDKMessage => asMsg({
      type: 'result',
      subtype: 'error_during_execution',
      session_id: sessionId,
      result: text,
      is_error: true,
    });

    const runTurn = async function* (text: string): AsyncGenerator<SDKMessage> {
      const parts = opts.commandPrefix?.length ? opts.commandPrefix : [opts.command ?? 'agy'];
      const [file, ...pre] = parts as [string, ...string[]];
      const outbox: SDKMessage[] = [];
      let closed = false;
      let wake: (() => void) | null = null;
      const poke = (): void => {
        const w = wake;
        wake = null;
        w?.();
      };
      const push = (m: SDKMessage): void => {
        outbox.push(m);
        poke();
      };
      const untilEvent = (): Promise<void> => {
        if (outbox.length > 0 || closed || aborted || signal?.aborted) return Promise.resolve();
        return new Promise<void>(res => {
          const onAbort = (): void => {
            wake = null;
            res();
          };
          wake = () => {
            if (signal) signal.removeEventListener('abort', onAbort);
            res();
          };
          if (signal) signal.addEventListener('abort', onAbort, { once: true });
        });
      };
      let child: ChildProcess;
      try {
        child = spawn(file, [...pre, ...argsFor(text, convId)], { cwd, env: envFor() });
      } catch (err) {
        yield errorResult((err as Error)?.message ?? 'agy failed to start');
        return;
      }
      proc = child;
      let lastErr = '';
      let sawResult = false;
      let finished = false;
      let pending: { idx: number; id: string; text: string; usage?: Raw } | null = null;
      const seenTools = new Set<number>();
      const finishedTools = new Set<number>();

      const flushText = (): void => {
        if (!pending || !pending.text) {
          pending = null;
          return;
        }
        const p = pending;
        pending = null;
        const msg: Raw = { id: p.id, role: 'assistant', model, content: [{ type: 'text', text: p.text }] };
        if (p.usage) msg.usage = p.usage;
        push(asMsg({ type: 'assistant', parent_tool_use_id: null, session_id: sessionId, message: msg }));
      };

      const toolId = (cid: string | undefined, idx: number): string => `${cid ?? convId ?? 'agy'}:${idx}`;

      const handleLine = (line: string): void => {
        let evt: Raw;
        try {
          evt = JSON.parse(line) as Raw;
        } catch {
          return;
        }
        if (!evt || typeof evt !== 'object') return;
        if (evt.event === 'init') {
          const id = str(evt.conversation_id);
          if (id) noteId(id);
          return;
        }
        if (evt.event === 'step_update') {
          const su = asObj(evt.step_update);
          const idx = su.step_index;
          if (typeof idx !== 'number') return;
          const cid = str(su.conversation_id) ?? str(evt.conversation_id);
          if (su.step_type === 'agent_response') {
            const delta = su.text_delta;
            if (typeof delta === 'string' && delta) {
              if (pending && pending.idx !== idx) flushText();
              if (!pending) pending = { idx, id: toolId(cid, idx), text: '' };
              pending.text += delta;
            }
            const u = mapUsage(su.usage);
            if (u && pending && pending.idx === idx) pending.usage = u;
            if (su.state === 'DONE' || su.state === 'ERROR') flushText();
            return;
          }
          if (su.step_type === 'tool') {
            if (pending) flushText();
            const info = asObj(su.tool_info);
            const rawName = str(info.name) ?? str(su.tool_name) ?? 'unknown';
            const params = asObj(info.parameters);
            const id = toolId(cid, idx);
            if (su.state === 'ACTIVE') {
              if (!seenTools.has(idx)) {
                seenTools.add(idx);
                const mapped = mapTool(rawName, params);
                push(asMsg({
                  type: 'assistant',
                  parent_tool_use_id: null,
                  session_id: sessionId,
                  message: { id, role: 'assistant', model, content: [{ type: 'tool_use', id, name: mapped.name, input: mapped.input }] },
                }));
              }
              return;
            }
            if (su.state === 'DONE' || su.state === 'ERROR') {
              if (!seenTools.has(idx)) {
                seenTools.add(idx);
                const mapped = mapTool(rawName, params);
                push(asMsg({
                  type: 'assistant',
                  parent_tool_use_id: null,
                  session_id: sessionId,
                  message: { id, role: 'assistant', model, content: [{ type: 'tool_use', id, name: mapped.name, input: mapped.input }] },
                }));
              }
              if (finishedTools.has(idx)) return;
              finishedTools.add(idx);
              const isErr = su.state === 'ERROR';
              const em = asObj(info.error);
              const content = isErr ? (str(em.message) ?? 'error') : 'done';
              push(asMsg({
                type: 'user',
                parent_tool_use_id: null,
                session_id: sessionId,
                message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, ...(isErr ? { is_error: true } : {}) }] },
              }));
            }
            return;
          }
          if (pending && pending.idx !== idx) flushText();
          return;
        }
        if (evt.event === 'result') {
          flushText();
          const r = asObj(evt.result);
          const cid = str(r.conversation_id) ?? str(evt.conversation_id);
          if (cid) noteId(cid);
          const ok = r.status === 'SUCCESS';
          const denied = (Array.isArray(r.denied_actions) ? r.denied_actions : []) as Raw[];
          const names = denied.map(d => str(d.display_name) ?? str(d.action)).filter((v): v is string => !!v);
          if (names.length > 0) {
            push(asMsg({
              type: 'assistant',
              parent_tool_use_id: null,
              session_id: sessionId,
              message: { id: `${cid ?? convId ?? 'agy'}:denied`, role: 'assistant', model, content: [{ type: 'text', text: `Denied: ${names.join(', ')}` }] },
            }));
          }
          const msg: Raw = {
            type: 'result',
            subtype: ok ? 'success' : 'error_during_execution',
            session_id: sessionId,
            result: typeof r.response === 'string' ? r.response : '',
            is_error: !ok,
          };
          if (typeof r.num_turns === 'number') msg.num_turns = r.num_turns;
          const u = mapUsage(r.usage);
          if (u) msg.usage = u;
          push(asMsg(msg));
          sawResult = true;
        }
      };

      const done = (): void => {
        if (finished) return;
        finished = true;
        clearKillTimer();
        proc = null;
        closed = true;
        if (buf.trim()) handleLine(buf);
        if (aborted || signal?.aborted) {
          outbox.length = 0;
          poke();
          return;
        }
        if (pending) flushText();
        if (!sawResult) push(errorResult(lastErr || 'agy exited unexpectedly'));
        else poke();
      };

      let buf = '';
      child.stdout?.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8');
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          handleLine(line);
        }
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        for (const part of chunk.toString('utf8').split('\n')) {
          const t = part.trim();
          if (t) lastErr = t;
        }
      });
      child.on('error', (err: Error) => {
        if (!lastErr) lastErr = err.message;
        done();
      });
      child.on('close', () => done());

      for (;;) {
        while (outbox.length > 0) {
          if (aborted || signal?.aborted) return;
          yield outbox.shift()!;
        }
        if (closed) return;
        if (aborted || signal?.aborted) return;
        await untilEvent();
      }
    };

    const nextOrAbort = async (it: AsyncIterator<SDKUserMessage>): Promise<IteratorResult<SDKUserMessage> | null> => {
      if (!signal || signal.aborted) {
        if (signal?.aborted) return null;
        return it.next();
      }
      let onAbort = (): void => {};
      const abortP = new Promise<null>(res => {
        onAbort = () => res(null);
        signal.addEventListener('abort', onAbort, { once: true });
      });
      try {
        return await Promise.race([
          it.next(),
          abortP.then((): IteratorResult<SDKUserMessage> => ({ value: undefined as never, done: true })),
        ]);
      } finally {
        signal.removeEventListener('abort', onAbort);
      }
    };

    async function* gen(): AsyncGenerator<SDKMessage> {
      yield asMsg({ type: 'system', subtype: 'init', session_id: sessionId, model, cwd });
      if (typeof params.prompt === 'string') {
        if (params.prompt && !aborted && !signal?.aborted) {
          for await (const m of runTurn(params.prompt)) yield m;
        }
        return;
      }
      const it = params.prompt[Symbol.asyncIterator]();
      for (;;) {
        if (aborted || signal?.aborted) return;
        const r = await nextOrAbort(it);
        if (!r || r.done) return;
        const text = userText(r.value);
        if (!text) continue;
        if (aborted || signal?.aborted) return;
        for await (const m of runTurn(text)) yield m;
        if (aborted || signal?.aborted) return;
      }
    }

    const iterable = gen() as AsyncGenerator<SDKMessage> & { interrupt: () => Promise<unknown> };
    iterable.interrupt = async (): Promise<unknown> => {
      kill('SIGINT', 'SIGTERM', 2000);
      return undefined;
    };
    return iterable;
  };
  return fn as QueryFn;
}

export class AgyHookBridge {
  private handlers = new Map<string, HookHandler>();

  register(secret: string, handler: HookHandler): void {
    this.handlers.set(secret, handler);
  }

  unregister(secret: string): void {
    this.handlers.delete(secret);
  }

  async handle(secretHeader: string | undefined, body: unknown, signal?: AbortSignal): Promise<AgyHookResponse> {
    const deny = (status: number, reason?: string): AgyHookResponse => ({
      status,
      json: reason ? { decision: 'deny', reason } : { decision: 'deny' },
    });
    let handler: HookHandler | undefined;
    const given = typeof secretHeader === 'string' ? secretHeader : '';
    for (const [secret, h] of this.handlers) {
      const a = Buffer.from(secret, 'utf8');
      const b = Buffer.from(given, 'utf8');
      if (a.length !== b.length) continue;
      if (timingSafeEqual(a, b)) handler = h;
    }
    if (!handler) return deny(403, 'unknown hook secret');
    const o = (body && typeof body === 'object' && !Array.isArray(body) ? body : undefined) as Raw | undefined;
    const toolCall = (o?.toolCall && typeof o.toolCall === 'object' && !Array.isArray(o.toolCall) ? o.toolCall : undefined) as Raw | undefined;
    const conv = o?.conversationId;
    const step = o?.stepIdx;
    const args = toolCall?.args;
    if (
      typeof conv !== 'string' || !conv ||
      typeof step !== 'number' || !Number.isInteger(step) ||
      !toolCall || typeof toolCall.name !== 'string' || !toolCall.name ||
      !args || typeof args !== 'object' || Array.isArray(args)
    ) {
      return deny(400, 'bad hook body');
    }
    const mapped = mapTool(toolCall.name, args as Raw);
    mapped.input.raw = boundedRaw(args as Raw);
    const title = typeof (args as Raw).toolSummary === 'string' ? (args as Raw).toolSummary as string : undefined;
    try {
      const decision = await handler({
        tool: mapped.name,
        input: mapped.input,
        toolUseId: `${conv}:${step}`,
        ...(title ? { title } : {}),
      }, signal);
      if (decision.allow) return { status: 200, json: { decision: 'allow' } };
      return { status: 200, json: { decision: 'deny', ...(decision.reason ? { reason: decision.reason } : {}) } };
    } catch {
      return deny(200, 'hook handler failed');
    }
  }
}
