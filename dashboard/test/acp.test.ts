// Tests for the OpenCode ACP runtime adapter against a fake `opencode acp` child.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { createAcpQuery, pickOptionId } from '../server/runtimes/acp.ts';
import type { AcpOptions } from '../server/runtimes/acp.ts';

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-acp-agent.mjs');

type Rec = Record<string, unknown>;

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function makeRecord(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'acp-test-'));
  dirs.push(dir);
  return path.join(dir, 'record.jsonl');
}

function readRecord(file: string): Rec[] {
  try {
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter(line => line.trim().length > 0)
      .map(line => JSON.parse(line) as Rec);
  } catch {
    return [];
  }
}

function timed<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const gate = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), ms);
  });
  return Promise.race([p, gate]).finally(() => clearTimeout(timer));
}

interface Seen {
  toolName: string;
  input: Record<string, unknown>;
  toolUseID?: string;
  title?: string;
  requestId?: string;
}

const allowUse = (seen: Seen[]): NonNullable<Options['canUseTool']> =>
  (async (toolName, input, opts) => {
    seen.push({ toolName, input, ...(opts.toolUseID ? { toolUseID: opts.toolUseID } : {}), ...(opts.title ? { title: opts.title } : {}), ...(opts.requestId ? { requestId: opts.requestId } : {}) });
    return { behavior: 'allow' };
  }) as NonNullable<Options['canUseTool']>;

const denyUse = (seen: Seen[]): NonNullable<Options['canUseTool']> =>
  (async (toolName, input, opts) => {
    seen.push({ toolName, input, ...(opts.toolUseID ? { toolUseID: opts.toolUseID } : {}) });
    return { behavior: 'deny', message: 'Denied in test' };
  }) as NonNullable<Options['canUseTool']>;

const acpOpts = (recordFile: string, extra?: Partial<AcpOptions>): AcpOptions => ({
  command: ['node', fixture],
  env: { ...process.env, CLAUDECODE: '1', FAKE_ACP_RECORD: recordFile },
  ...extra,
});

const sdkOpts = (canUseTool: NonNullable<Options['canUseTool']>, extra?: Partial<Options>): { options: Options; abort: AbortController } => {
  const { abortController, ...rest } = extra ?? {};
  const abort = abortController ?? new AbortController();
  return {
    options: { cwd: process.cwd(), sessionId: 'dash-1', abortController: abort, canUseTool, ...rest },
    abort,
  };
};

async function collectAll(query: ReturnType<typeof createAcpQuery>, prompt: string | AsyncIterable<SDKUserMessage>, options: Options, abort: AbortController): Promise<SDKMessage[]> {
  const out: SDKMessage[] = [];
  const drain = (async () => {
    for await (const m of query({ prompt, options })) out.push(m);
  })();
  try {
    await timed(drain, 15000, 'messages');
  } catch (err) {
    abort.abort();
    await timed(drain.catch(() => {}), 15000, 'drain after abort').catch(() => {});
    throw err;
  }
  return out;
}

const messageOf = (m: SDKMessage): Rec => ((m as unknown as Rec).message ?? {}) as Rec;
const blocksOf = (m: SDKMessage): Rec[] => (Array.isArray(messageOf(m).content) ? (messageOf(m).content as Rec[]) : []);
const typesOf = (messages: SDKMessage[]): string[] => messages.map(m => (m as unknown as Rec).type as string);

describe('acp runtime', () => {
  it('streams a full turn: init, thinking, text, tool_use, tool_result, result', async () => {
    const recordFile = makeRecord();
    const seen: Seen[] = [];
    const { options, abort } = sdkOpts(allowUse(seen));
    const messages = await collectAll(createAcpQuery(acpOpts(recordFile)), 'do work', options, abort);

    expect(typesOf(messages)).toEqual(['system', 'assistant', 'assistant', 'assistant', 'user', 'result']);

    const init = messages[0] as unknown as Rec;
    expect(init.subtype).toBe('init');
    expect(init.session_id).toBe('dash-1');
    expect(init.model).toBe('fake-model');
    expect(init.cwd).toBe(process.cwd());

    const thinking = messages[1];
    expect((thinking as unknown as Rec).parent_tool_use_id).toBeNull();
    expect((thinking as unknown as Rec).session_id).toBe('ses_fake');
    expect(messageOf(thinking).id).toBe('m_think_1#0');
    expect(blocksOf(thinking)).toEqual([{ type: 'thinking', thinking: 'thinking one thinking two' }]);

    const text = messages[2];
    expect(messageOf(text).id).toBe('m_text_1#1');
    expect(blocksOf(text)).toEqual([{ type: 'text', text: 'hello world' }]);

    const toolUse = blocksOf(messages[3]!)[0]!;
    expect(toolUse.type).toBe('tool_use');
    expect(toolUse.id).toBe('tc_1');
    expect(toolUse.name).toBe('Bash');
    expect((toolUse.input as Rec).command).toBe('agy-task start x');

    const toolResult = blocksOf(messages[4]!)[0]!;
    expect(toolResult.type).toBe('tool_result');
    expect(toolResult.tool_use_id).toBe('tc_1');
    expect(toolResult.content).toBe('worker output ok');
    expect(toolResult.is_error).toBe(false);

    const result = messages[5] as unknown as Rec;
    expect(result.subtype).toBe('success');
    expect(result.session_id).toBe('ses_fake');
    expect(result.total_cost_usd).toBe(0.05);
    expect(result.usage).toEqual({ input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 5 });
    expect(result.num_turns).toBe(1);
    expect(result.result).toBe('hello world');
    expect(result.is_error).toBe(false);

    expect(seen).toHaveLength(1);
    expect(seen[0]!.toolName).toBe('Bash');
    expect((seen[0]!.input as Rec).command).toBe('agy-task start x');
    expect(seen[0]!.toolUseID).toBe('tc_1');

    const entries = readRecord(recordFile);
    expect(entries.some(e => e.method === 'session/new' && (e.params as Rec)?.cwd === process.cwd())).toBe(true);
    expect(entries.some(e => e.method === 'permission-decision' && e.allowed === true)).toBe(true);
  });

  it('exposes available commands via supportedCommands', async () => {
    const recordFile = makeRecord();
    const seen: Seen[] = [];
    const { options, abort } = sdkOpts(allowUse(seen));
    const q = createAcpQuery(acpOpts(recordFile))({ prompt: 'do work', options });
    const first = await timed((q as unknown as AsyncGenerator<SDKMessage>).next(), 15000, 'init');
    expect((first.value as unknown as Rec).type).toBe('system');
    await vi.waitFor(async () => {
      const cmds = await (q as unknown as { supportedCommands: () => Promise<unknown> }).supportedCommands();
      expect(cmds).toEqual([
        { name: 'compact', description: 'Compact the session' },
        { name: 'review', description: 'Review changes', argumentHint: '<path>' },
      ]);
    });
    const rest: SDKMessage[] = [];
    for await (const m of q) rest.push(m);
    expect(rest.some(m => (m as unknown as Rec).type === 'result')).toBe(true);
    abort.abort();
  });

  it('deny answers the permission with a failed tool result', async () => {
    const recordFile = makeRecord();
    const seen: Seen[] = [];
    const { options, abort } = sdkOpts(denyUse(seen));
    const messages = await collectAll(createAcpQuery(acpOpts(recordFile)), 'do work', options, abort);

    expect(typesOf(messages)).toEqual(['system', 'assistant', 'assistant', 'assistant', 'user', 'result']);
    const toolResult = blocksOf(messages[4]!)[0]!;
    expect(toolResult.tool_use_id).toBe('tc_1');
    expect(toolResult.is_error).toBe(true);
    expect(toolResult.content).toBe('permission denied');
    const result = messages[5] as unknown as Rec;
    expect(result.subtype).toBe('success');
    expect(seen[0]!.toolUseID).toBe('tc_1');
    expect(readRecord(recordFile).some(e => e.method === 'permission-decision' && e.allowed === false)).toBe(true);
  });

  it('sets the model via session/set_config_option when it differs', async () => {
    const recordFile = makeRecord();
    const seen: Seen[] = [];
    let sessionId = '';
    const { options, abort } = sdkOpts(allowUse(seen));
    const messages = await collectAll(
      createAcpQuery(acpOpts(recordFile, { model: 'custom-model', onSessionId: id => { sessionId = id; } })),
      'do work',
      options,
      abort,
    );
    expect((messages[0] as unknown as Rec).model).toBe('custom-model');
    expect(sessionId).toBe('ses_fake');
    const entries = readRecord(recordFile);
    expect(entries.some(e => e.method === 'session/set_config_option' && JSON.stringify(e.params).includes('custom-model'))).toBe(true);
  });

  it('leaves the model alone when none is requested', async () => {
    const recordFile = makeRecord();
    const seen: Seen[] = [];
    const { options, abort } = sdkOpts(allowUse(seen));
    const messages = await collectAll(createAcpQuery(acpOpts(recordFile)), 'do work', options, abort);
    expect((messages[0] as unknown as Rec).model).toBe('fake-model');
    expect(readRecord(recordFile).some(e => e.method === 'session/set_config_option')).toBe(false);
  });

  it('resumeId uses session/load and reports the loaded session', async () => {
    const recordFile = makeRecord();
    const seen: Seen[] = [];
    let sessionId = '';
    const { options, abort } = sdkOpts(allowUse(seen));
    const messages = await collectAll(
      createAcpQuery(acpOpts(recordFile, { resumeId: 'ses_old', onSessionId: id => { sessionId = id; } })),
      'do work',
      options,
      abort,
    );
    expect(sessionId).toBe('ses_old');
    expect((messages[0] as unknown as Rec).session_id).toBe('dash-1');
    const entries = readRecord(recordFile);
    expect(entries.some(e => e.method === 'session/load' && ((e.params as Rec)?.sessionId as string) === 'ses_old')).toBe(true);
    expect(entries.some(e => e.method === 'session/new')).toBe(false);
  });

  it('consumes two queued turns into two results', async () => {
    const recordFile = makeRecord();
    const seen: Seen[] = [];
    const { options, abort } = sdkOpts(allowUse(seen), { sessionId: 'dash-2' });
    async function* prompts(): AsyncGenerator<SDKUserMessage> {
      for (const text of ['first', 'second']) {
        yield { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: 'dash-2' };
      }
    }
    const messages = await collectAll(createAcpQuery(acpOpts(recordFile)), prompts(), options, abort);
    const results = messages.filter(m => (m as unknown as Rec).type === 'result') as unknown as Rec[];
    expect(results.map(r => r.num_turns)).toEqual([1, 2]);
    expect(results.every(r => r.subtype === 'success' && r.result === 'hello world')).toBe(true);
    const toolUses = messages.flatMap(blocksOf).filter(b => b.type === 'tool_use');
    expect(toolUses.map(b => b.id)).toEqual(['tc_1', 'tc_2']);
    expect(seen.map(s => s.toolUseID)).toEqual(['tc_1', 'tc_2']);
  });

  it('interrupt sends session/cancel and ends the turn as cancelled', async () => {
    const recordFile = makeRecord();
    const seen: Seen[] = [];
    const { options, abort } = sdkOpts(allowUse(seen));
    const items: SDKUserMessage[] = [];
    const waiters: Array<(r: IteratorResult<SDKUserMessage>) => void> = [];
    const pushMsg = (m: SDKUserMessage): void => {
      const waiter = waiters.shift();
      if (waiter) waiter({ value: m, done: false });
      else items.push(m);
    };
    const queue: AsyncIterable<SDKUserMessage> = {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<SDKUserMessage>> {
            const item = items.shift();
            if (item) return Promise.resolve({ value: item, done: false });
            return new Promise<IteratorResult<SDKUserMessage>>(resolve => waiters.push(resolve));
          },
        };
      },
    };
    const query = createAcpQuery(acpOpts(recordFile))({ prompt: queue, options });
    const it = query as unknown as AsyncGenerator<SDKMessage, void, void> & { interrupt(): Promise<void> };
    try {
      const first = await timed(it.next(), 15000, 'init');
      expect((first.value as unknown as Rec).type).toBe('system');
      pushMsg({ type: 'user', message: { role: 'user', content: 'hang' }, parent_tool_use_id: null, session_id: 'dash-1' });
      const rest: SDKMessage[] = [];
      const drain = (async () => {
        for (;;) {
          const next = await it.next();
          if (next.done) break;
          rest.push(next.value);
          if ((next.value as unknown as Rec).type === 'result') abort.abort();
        }
      })();
      await vi.waitFor(
        () => {
          expect(readRecord(recordFile).some(e => e.method === 'session/prompt')).toBe(true);
        },
        { timeout: 10000 },
      );
      await it.interrupt();
      await timed(drain, 15000, 'cancelled result');
      const last = rest.at(-1) as unknown as Rec;
      expect(last.type).toBe('result');
      expect(last.subtype).toBe('error_during_execution');
      expect(last.is_error).toBe(false);
      expect(readRecord(recordFile).some(e => e.method === 'session/cancel')).toBe(true);
    } finally {
      abort.abort();
      await it.return?.(undefined);
    }
  });

  it('abort kills the child and ends the iterator', async () => {
    const recordFile = makeRecord();
    const seen: Seen[] = [];
    const { options, abort } = sdkOpts(allowUse(seen));
    const query = createAcpQuery(acpOpts(recordFile))({ prompt: 'hang', options });
    const got: SDKMessage[] = [];
    const drain = (async () => {
      for await (const m of query) got.push(m);
    })();
    await timed(
      (async () => {
        while (got.length === 0) await new Promise(resolve => setTimeout(resolve, 25));
      })(),
      15000,
      'init',
    );
    expect((got[0] as unknown as Rec).type).toBe('system');
    abort.abort();
    await timed(drain, 15000, 'abort end');
    // Stop must terminate the child. Usually the SIGTERM handler records
    // 'sigterm', but stdin EOF can drain the fake's event loop first so it
    // exits 0 via 'stdin-end' instead. Both are valid terminations, so accept
    // either and then assert the child process is actually gone.
    await vi.waitFor(
      () => {
        expect(readRecord(recordFile).some(e => e.method === 'sigterm' || e.method === 'stdin-end')).toBe(true);
      },
      { timeout: 5000, interval: 50 },
    );
    const started = readRecord(recordFile).find(e => e.method === 'start');
    const pid = started?.pid;
    expect(typeof pid).toBe('number');
    await vi.waitFor(
      () => {
        expect(() => process.kill(pid as number, 0)).toThrow();
      },
      { timeout: 5000, interval: 50 },
    );
  });

  it('passes OPENCODE=1, drops CLAUDECODE and never sets OPENCODE_CONFIG_CONTENT', async () => {
    const recordFile = makeRecord();
    const seen: Seen[] = [];
    const { options, abort } = sdkOpts(allowUse(seen));
    const messages = await collectAll(
      createAcpQuery(
        acpOpts(recordFile, {
          env: { ...process.env, CLAUDECODE: '1', OPENCODE_CONFIG_CONTENT: '{"permission":{"bash":"allow"}}', FAKE_ACP_RECORD: recordFile },
        }),
      ),
      'echo-env',
      options,
      abort,
    );
    const envBlock = messages
      .flatMap(blocksOf)
      .find(b => b.type === 'text' && typeof b.text === 'string' && (b.text as string).startsWith('{'));
    expect(envBlock).toBeDefined();
    const envSeen = JSON.parse(envBlock!.text as string) as Rec;
    expect(envSeen.OPENCODE).toBe('1');
    expect(envSeen.CLAUDECODE).toBeNull();
    // Even a caller-provided value must not reach the child: the dashboard
    // never alters the user's OpenCode permission config.
    expect(envSeen.overlay).toBeNull();
  });

  it('a child that exits at once ends the iterator with no unhandled rejection', async () => {
    const rejections: unknown[] = [];
    const onRejection = (err: unknown): void => {
      rejections.push(err);
    };
    process.on('unhandledRejection', onRejection);
    try {
      const seen: Seen[] = [];
      const { options } = sdkOpts(allowUse(seen));
      const query = createAcpQuery({ command: ['node', '-e', 'process.exit(1)'] })({ prompt: 'hi', options });
      let threw: unknown = null;
      try {
        for await (const m of query) {
          void m;
        }
      } catch (err) {
        threw = err;
      }
      expect(threw ?? 'ended').toBeDefined();
      await new Promise(resolve => setTimeout(resolve, 250));
      expect(rejections).toEqual([]);
    } finally {
      process.removeListener('unhandledRejection', onRejection);
    }
  });

  it('passes a live (non-aborted) signal when options.abortController is missing', async () => {
    const recordFile = makeRecord();
    const seen: Seen[] = [];
    const signals: unknown[] = [];
    const canUse = (async (_toolName: string, _input: Record<string, unknown>, opts: { signal: AbortSignal }) => {
      signals.push(opts.signal);
      seen.push({ toolName: _toolName, input: _input });
      return { behavior: 'allow' };
    }) as NonNullable<Options['canUseTool']>;
    const options = { cwd: process.cwd(), sessionId: 'dash-1', canUseTool: canUse } as Options;
    const messages = await collectAll(createAcpQuery(acpOpts(recordFile)), 'do work', options, new AbortController());
    expect(seen).toHaveLength(1);
    expect(signals).toHaveLength(1);
    const signal = signals[0] as AbortSignal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);
    expect(messages.some(m => (m as unknown as Rec).type === 'result')).toBe(true);
  });

  it('gives same-messageId chunks split by a tool_call unique ids, both reaching the reducer', async () => {
    const recordFile = makeRecord();
    const seen: Seen[] = [];
    const { options, abort } = sdkOpts(allowUse(seen));
    const messages = await collectAll(createAcpQuery(acpOpts(recordFile)), 'split-message', options, abort);
    const assistants = messages.filter(m => (m as unknown as Rec).type === 'assistant');
    const sameId = assistants.filter(m => String(messageOf(m).id ?? '').startsWith('m_same#'));
    expect(sameId).toHaveLength(2);
    expect(messageOf(sameId[0]!).id).not.toBe(messageOf(sameId[1]!).id);
    const texts = sameId.map(m => (blocksOf(m)[0] as Rec).text as string).sort();
    expect(texts).toEqual(['after', 'hello world']);

    const { applyMessage, createTree } = await import('../server/model/reducer.ts');
    const tree = createTree('split-test', { startedAt: Date.now() });
    const events = sameId.flatMap(m => applyMessage(tree, m));
    const textEvents = events.filter(
      e => e.type === 'node.event' && (e as { event: { kind: string } }).event.kind === 'text',
    );
    expect(textEvents).toHaveLength(2);
  });

  it('processes a buffered partial stdout line when the child exits', async () => {
    const recordFile = makeRecord();
    const seen: Seen[] = [];
    const { options, abort } = sdkOpts(allowUse(seen));
    const messages = await collectAll(createAcpQuery(acpOpts(recordFile)), 'partial-exit', options, abort);
    const texts = messages.flatMap(blocksOf).filter(b => b.type === 'text');
    expect(texts.some(b => (b.text as string) === 'partial hello')).toBe(true);
    const last = messages.at(-1) as unknown as Rec;
    expect(last.type).toBe('result');
  });

  it('switches the model on a follow-up turn via currentModel', async () => {
    const recordFile = makeRecord();
    const seen: Seen[] = [];
    const { options, abort } = sdkOpts(allowUse(seen), { sessionId: 'dash-model' });
    let calls = 0;
    const currentModel = (): string => (++calls <= 2 ? 'custom-model' : 'custom-model-2');
    async function* prompts(): AsyncGenerator<SDKUserMessage> {
      for (const text of ['first', 'second']) {
        yield { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: 'dash-model' };
      }
    }
    const messages = await collectAll(
      createAcpQuery(acpOpts(recordFile, { model: 'custom-model', currentModel })),
      prompts(),
      options,
      abort,
    );
    const results = messages.filter(m => (m as unknown as Rec).type === 'result');
    expect(results).toHaveLength(2);
    const entries = readRecord(recordFile);
    const switches = entries.filter(
      e => e.method === 'session/set_config_option' && JSON.stringify(e.params).includes('custom-model-2'),
    );
    expect(switches.length).toBeGreaterThanOrEqual(1);
  });
});

describe('pickOptionId', () => {
  const opts = [
    { optionId: 'aa', kind: 'allow_always' },
    { optionId: 'ra', kind: 'reject_always' },
    { optionId: 'ao', kind: 'allow_once' },
    { optionId: 'ro', kind: 'reject_once' },
  ];
  it('allow only picks allow_once', () => {
    expect(pickOptionId(opts, ['allow_once'])).toBe('ao');
    expect(pickOptionId([opts[0], opts[1]], ['allow_once'])).toBeUndefined();
  });
  it('deny prefers reject_once, then reject_always, never list[0]', () => {
    expect(pickOptionId(opts, ['reject_once', 'reject_always'])).toBe('ro');
    expect(pickOptionId([opts[0], opts[1]], ['reject_once', 'reject_always'])).toBe('ra');
    expect(pickOptionId([opts[0]], ['reject_once', 'reject_always'])).toBeUndefined();
    expect(pickOptionId('x', ['reject_once'])).toBeUndefined();
  });
});
