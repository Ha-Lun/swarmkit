// Tests for the agy runtime adapter, its PreToolUse hook and the hook bridge.
import { spawn } from 'node:child_process';
import { linkSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import type { Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { AgyHookBridge, createAgyQuery } from '../server/runtimes/agy.ts';
import type { AgyHookRequest, AgyOptions } from '../server/runtimes/agy.ts';

const fixture = fileURLToPath(new URL('./fixtures/fake-agy.mjs', import.meta.url));
const hookPy = fileURLToPath(new URL('../server/runtimes/agy-hook.py', import.meta.url));
const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), 'agy-test-')));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const sleep = (ms: number): Promise<void> => new Promise(res => setTimeout(res, ms));
const prefix = (): string[] => ['node', fixture];
const typeOf = (m: SDKMessage): string => (m as { type: string }).type;
const anyOf = (m: SDKMessage): Record<string, unknown> => m as unknown as Record<string, unknown>;

const userMsg = (text: string): SDKUserMessage => ({
  type: 'user',
  message: { role: 'user', content: text },
  parent_tool_use_id: null,
  session_id: 's1',
}) as unknown as SDKUserMessage;

const queryOpts = (extra?: Record<string, unknown>): Options => ({
  cwd: scratch,
  sessionId: 's1',
  model: 'm1',
  abortController: new AbortController(),
  ...extra,
}) as unknown as Options;

async function collect(prompt: string | AsyncIterable<SDKUserMessage>, options: Options, agy: AgyOptions): Promise<SDKMessage[]> {
  const out: SDKMessage[] = [];
  for await (const m of createAgyQuery(agy)({ prompt, options })) out.push(m);
  return out;
}

async function* twoTurns(): AsyncGenerator<SDKUserMessage> {
  yield userMsg('first');
  yield userMsg('second');
}

describe('agy query', () => {
  it('yields system init, tool use/result, merged text and result in order', async () => {
    const msgs = await collect('hello', queryOpts(), { commandPrefix: prefix() });
    expect(msgs.map(typeOf)).toEqual(['system', 'assistant', 'user', 'assistant', 'result']);

    const sys = anyOf(msgs[0]!);
    expect(sys).toMatchObject({ type: 'system', subtype: 'init', session_id: 's1', model: 'm1', cwd: scratch });

    const tool = anyOf(msgs[1]!).message as Record<string, unknown>;
    expect(tool.id).toBe('conv-fake-1:0');
    expect(tool.content).toEqual([{
      type: 'tool_use',
      id: 'conv-fake-1:0',
      name: 'Bash',
      input: { command: 'echo hi', description: 'say hi' },
    }]);

    const toolResult = anyOf(msgs[2]!).message as Record<string, unknown>;
    expect(toolResult.content).toEqual([{ type: 'tool_result', tool_use_id: 'conv-fake-1:0', content: 'done' }]);

    const text = anyOf(msgs[3]!).message as Record<string, unknown>;
    expect(text.id).toBe('conv-fake-1:1');
    expect(text.content).toEqual([{ type: 'text', text: 'hello world' }]);

    expect(anyOf(msgs[4]!)).toMatchObject({
      type: 'result',
      subtype: 'success',
      session_id: 's1',
      num_turns: 1,
      is_error: false,
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2 },
    });
  });

  it('runs the second queued turn with --conversation from the first init', async () => {
    const ids: string[] = [];
    const msgs = await collect(twoTurns(), queryOpts(), { commandPrefix: prefix(), onSessionId: id => ids.push(id) });
    expect(ids).toEqual(['conv-fake-1']);
    const results = msgs.filter(m => typeOf(m) === 'result').map(anyOf);
    expect(results).toHaveLength(2);
    expect(String(results[0]!.result)).toContain('conv=none');
    expect(String(results[1]!.result)).toContain('conv=conv-fake-1');
  });

  it('passes --dangerously-skip-permissions only when a hook is set', async () => {
    const withHook = await collect('hi', queryOpts(), { commandPrefix: prefix(), hook: { url: 'http://127.0.0.1:9/x', secret: 's' } });
    expect(String(anyOf(withHook.at(-1)!).result)).toContain('skip=true');
    const without = await collect('hi', queryOpts(), { commandPrefix: prefix() });
    expect(String(anyOf(without.at(-1)!).result)).toContain('skip=false');
  });

  it('passes hook env vars and strips CLAUDECODE/OPENCODE', async () => {
    const prevClaude = process.env.CLAUDECODE;
    const prevOpen = process.env.OPENCODE;
    process.env.CLAUDECODE = '1';
    process.env.OPENCODE = '1';
    try {
      const msgs = await collect('hi', queryOpts(), { commandPrefix: prefix(), hook: { url: 'http://127.0.0.1:9/x', secret: 's' } });
      const text = String(anyOf(msgs.at(-1)!).result);
      expect(text).toContain('hookUrl=http://127.0.0.1:9/x');
      expect(text).toContain(`dashCwd=${scratch}`);
      expect(text).toContain('claudecode=false');
      expect(text).toContain('opencode=false');
    } finally {
      if (prevClaude === undefined) delete process.env.CLAUDECODE;
      else process.env.CLAUDECODE = prevClaude;
      if (prevOpen === undefined) delete process.env.OPENCODE;
      else process.env.OPENCODE = prevOpen;
    }
  });

  it('turns a crash without a result event into an error result', async () => {
    const msgs = await collect('crash', queryOpts(), { commandPrefix: prefix() });
    expect(msgs.map(typeOf)).toEqual(['system', 'result']);
    expect(anyOf(msgs[1]!)).toMatchObject({ subtype: 'error_during_execution', is_error: true });
    expect(String(anyOf(msgs[1]!).result)).toContain('boom');
  });

  it('abort ends the iterator', async () => {
    const abortController = new AbortController();
    const iterable = createAgyQuery({ commandPrefix: prefix() })({ prompt: 'hang', options: queryOpts({ abortController }) });
    const it = iterable[Symbol.asyncIterator]();
    expect(typeOf((await it.next()).value!)).toBe('system');
    const pending = it.next();
    await sleep(400);
    abortController.abort();
    expect((await pending).done).toBe(true);
  });

  it('streams messages while the process is still running', async () => {
    const iterable = createAgyQuery({ commandPrefix: prefix() })({ prompt: 'slow', options: queryOpts() });
    const types: string[] = [];
    let toolUseAt = 0;
    let resultAt = 0;
    for await (const m of iterable) {
      const t = typeOf(m);
      types.push(t);
      if (t === 'assistant' && toolUseAt === 0) {
        const content = (anyOf(m).message as Record<string, unknown>).content as Record<string, unknown>[];
        if (content.length > 0 && (content[0] as Record<string, unknown>).type === 'tool_use') toolUseAt = Date.now();
      }
      if (t === 'result' && resultAt === 0) resultAt = Date.now();
    }
    expect(types).toEqual(['system', 'assistant', 'user', 'assistant', 'result']);
    expect(toolUseAt).toBeGreaterThan(0);
    expect(resultAt).toBeGreaterThan(0);
    // The tool_use arrived ~300 ms before the result: it was streamed live, not after exit.
    expect(resultAt - toolUseAt).toBeGreaterThanOrEqual(150);
  });

  it('interrupt signals the running process', async () => {
    const iterable = createAgyQuery({ commandPrefix: prefix() })({ prompt: 'hang', options: queryOpts() });
    const it = iterable[Symbol.asyncIterator]();
    expect(typeOf((await it.next()).value!)).toBe('system');
    const pending = it.next();
    await sleep(500);
    await (iterable as unknown as { interrupt: () => Promise<unknown> }).interrupt();
    const got = await pending;
    expect(typeOf(got.value!)).toBe('result');
    expect(anyOf(got.value!)).toMatchObject({ subtype: 'error_during_execution', is_error: true });
    expect(String(anyOf(got.value!).result)).toContain('SIGINT');
    expect((await it.next()).done).toBe(true);
  });

  it('emits tool_use even when DONE arrives without ACTIVE', async () => {
    const msgs = await collect('tool-no-active', queryOpts(), { commandPrefix: prefix() });
    const assistants = msgs.filter(m => typeOf(m) === 'assistant');
    const toolUses = assistants.flatMap(m => ((anyOf(m).message as Record<string, unknown>).content ?? []) as Record<string, unknown>[])
      .filter(b => b.type === 'tool_use');
    expect(toolUses).toHaveLength(1);
    expect(toolUses[0]).toMatchObject({ id: 'conv-fake-1:0', name: 'Bash' });
    const toolResults = msgs.filter(m => typeOf(m) === 'user');
    expect(toolResults).toHaveLength(1);
  });

  it('emits at most one tool_result per step', async () => {
    const msgs = await collect('tool-dup-done', queryOpts(), { commandPrefix: prefix() });
    const toolResults = msgs.filter(m => typeOf(m) === 'user');
    expect(toolResults).toHaveLength(1);
    const toolUses = msgs.filter(m => typeOf(m) === 'assistant')
      .flatMap(m => ((anyOf(m).message as Record<string, unknown>).content ?? []) as Record<string, unknown>[])
      .filter(b => b.type === 'tool_use');
    expect(toolUses).toHaveLength(1);
  });

  it('reads the model per turn via currentModel', async () => {
    async function* turns(): AsyncGenerator<SDKUserMessage> {
      yield userMsg('first');
      yield userMsg('second');
    }
    let calls = 0;
    const msgs = await collect(turns(), queryOpts(), {
      commandPrefix: prefix(),
      model: 'fallback-model',
      currentModel: () => (++calls === 1 ? 'agy-model-a' : 'agy-model-b'),
    });
    const results = msgs.filter(m => typeOf(m) === 'result').map(anyOf);
    expect(results).toHaveLength(2);
    expect(String(results[0]!.result)).toContain('model=agy-model-a');
    expect(String(results[1]!.result)).toContain('model=agy-model-b');
  });
});

interface SeenRequest {
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

async function startHookServer(respond: (seen: SeenRequest) => { status: number; json: unknown }): Promise<{ url: string; seen: SeenRequest[]; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const seen: SeenRequest[] = [];
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let data = '';
      req.on('data', (chunk: Buffer) => {
        data += chunk;
      });
      req.on('end', () => {
        const entry = { headers: { ...req.headers }, body: data };
        seen.push(entry);
        const out = respond(entry);
        res.writeHead(out.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(out.json));
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('no server address'));
        return;
      }
      resolve({ url: `http://127.0.0.1:${addr.port}/hook`, seen, close: () => new Promise<void>(res => server.close(() => res())) });
    });
  });
}

function hookEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_PROXY: '*', no_proxy: '*' };
  for (const k of ['SWARMKIT_DASH_HOOK_URL', 'SWARMKIT_DASH_HOOK_SECRET', 'SWARMKIT_DASH_CWD', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete env[k];
  return { ...env, ...extra };
}

function hookInput(name: string, args: Record<string, unknown>): string {
  return JSON.stringify({ conversationId: 'c1', stepIdx: 2, toolCall: { name, args }, lastUserInput: 'hi' });
}

function runHook(stdin: string, env: NodeJS.ProcessEnv): Promise<{ code: number | null; out: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', ['-I', hookPy], { env, stdio: ['pipe', 'pipe', 'inherit'] });
    let text = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      text += chunk;
    });
    child.on('error', reject);
    const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
    timer.unref();
    if (!child.stdin) {
      clearTimeout(timer);
      reject(new Error('hook stdin unavailable'));
      return;
    }
    child.stdin.write(stdin);
    child.stdin.end();
    child.on('close', code => {
      clearTimeout(timer);
      let out: Record<string, unknown>;
      try {
        const lines = text.trim().split('\n');
        expect(lines).toHaveLength(1);
        out = JSON.parse(lines[0]!) as Record<string, unknown>;
      } catch (parseErr) {
        reject(new Error(`hook printed no single JSON line: ${text} (${String(parseErr)})`));
        return;
      }
      resolve({ code, out });
    });
  });
}

describe('agy-hook.py', () => {
  it('allows when the hook env is missing', async () => {
    const { code, out } = await runHook(hookInput('run_command', { CommandLine: 'rm -rf /' }), hookEnv());
    expect(code).toBe(0);
    expect(out).toEqual({ decision: 'allow' });
  });

  it('auto-allows reads inside the root without any HTTP call', async () => {
    const env = hookEnv({ SWARMKIT_DASH_HOOK_URL: 'http://127.0.0.1:1/unreachable', SWARMKIT_DASH_HOOK_SECRET: 's', SWARMKIT_DASH_CWD: scratch });
    const { code, out } = await runHook(hookInput('view_file', { AbsolutePath: path.join(scratch, 'a.txt') }), env);
    expect(code).toBe(0);
    expect(out).toEqual({ decision: 'allow' });
  });

  it('asks the dashboard for paths outside the root', async () => {
    const server = await startHookServer(() => ({ status: 200, json: { decision: 'allow' } }));
    try {
      const env = hookEnv({ SWARMKIT_DASH_HOOK_URL: server.url, SWARMKIT_DASH_HOOK_SECRET: 'topsecret', SWARMKIT_DASH_CWD: scratch });
      const { code, out } = await runHook(hookInput('view_file', { AbsolutePath: '/etc/hostname' }), env);
      expect(code).toBe(0);
      expect(out).toEqual({ decision: 'allow' });
      expect(server.seen).toHaveLength(1);
      expect(server.seen[0]!.headers['x-swarmkit-hook']).toBe('topsecret');
      expect(JSON.parse(server.seen[0]!.body) as unknown).toMatchObject({ conversationId: 'c1', stepIdx: 2 });
    } finally {
      await server.close();
    }
  });

  it('run_command posts to the dashboard and returns its decision', async () => {
    const server = await startHookServer(() => ({ status: 200, json: { decision: 'deny', reason: 'nope from dash' } }));
    try {
      const env = hookEnv({ SWARMKIT_DASH_HOOK_URL: server.url, SWARMKIT_DASH_HOOK_SECRET: 's', SWARMKIT_DASH_CWD: scratch });
      const { code, out } = await runHook(hookInput('run_command', { CommandLine: 'echo hi' }), env);
      expect(code).toBe(0);
      expect(out).toEqual({ decision: 'deny', reason: 'nope from dash' });
      expect(server.seen).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it('denies when the dashboard answers 500', async () => {
    const server = await startHookServer(() => ({ status: 500, json: { error: 'boom' } }));
    try {
      const env = hookEnv({ SWARMKIT_DASH_HOOK_URL: server.url, SWARMKIT_DASH_HOOK_SECRET: 's', SWARMKIT_DASH_CWD: scratch });
      const { out } = await runHook(hookInput('run_command', { CommandLine: 'echo hi' }), env);
      expect(out.decision).toBe('deny');
    } finally {
      await server.close();
    }
  });

  it('denies when the dashboard is unreachable', async () => {
    const env = hookEnv({ SWARMKIT_DASH_HOOK_URL: 'http://127.0.0.1:1/unreachable', SWARMKIT_DASH_HOOK_SECRET: 's', SWARMKIT_DASH_CWD: scratch });
    const { code, out } = await runHook(hookInput('run_command', { CommandLine: 'echo hi' }), env);
    expect(code).toBe(0);
    expect(out.decision).toBe('deny');
  });

  it('asks the dashboard for edits of the root AGENTS.md', async () => {
    const server = await startHookServer(() => ({ status: 200, json: { decision: 'allow' } }));
    try {
      const env = hookEnv({ SWARMKIT_DASH_HOOK_URL: server.url, SWARMKIT_DASH_HOOK_SECRET: 's', SWARMKIT_DASH_CWD: scratch });
      const { code, out } = await runHook(hookInput('write_to_file', { TargetFile: path.join(scratch, 'AGENTS.md') }), env);
      expect(code).toBe(0);
      expect(out).toEqual({ decision: 'allow' });
      expect(server.seen).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it.each([
    ['.claude/settings.json'],
    ['CLAUDE.md'],
    ['sub/dir/CLAUDE.md'],
    ['.github/workflows/x.yml'],
    ['pkg/.GitHub/a.yml'],
    ['package.json'],
    ['.env.local'],
    ['Makefile'],
    ['.husky/pre-commit'],
  ])('asks the dashboard for edits of %s', async rel => {
    const server = await startHookServer(() => ({ status: 200, json: { decision: 'deny', reason: 'asked' } }));
    try {
      const env = hookEnv({ SWARMKIT_DASH_HOOK_URL: server.url, SWARMKIT_DASH_HOOK_SECRET: 's', SWARMKIT_DASH_CWD: scratch });
      const { out } = await runHook(hookInput('write_to_file', { TargetFile: path.join(scratch, rel) }), env);
      expect(out).toEqual({ decision: 'deny', reason: 'asked' });
      expect(server.seen).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it('asks for edits of a hard-linked file but auto-allows a plain edit and a read in .claude', async () => {
    const plain = path.join(scratch, 'plain.txt');
    const linked = path.join(scratch, 'linked.txt');
    writeFileSync(plain, 'x');
    writeFileSync(linked, 'x');
    linkSync(linked, path.join(scratch, 'linked2.txt'));
    const server = await startHookServer(() => ({ status: 200, json: { decision: 'deny', reason: 'asked' } }));
    try {
      const env = hookEnv({ SWARMKIT_DASH_HOOK_URL: server.url, SWARMKIT_DASH_HOOK_SECRET: 's', SWARMKIT_DASH_CWD: scratch });
      expect((await runHook(hookInput('write_to_file', { TargetFile: plain }), env)).out).toEqual({ decision: 'allow' });
      expect((await runHook(hookInput('view_file', { AbsolutePath: path.join(scratch, '.claude', 'settings.json') }), env)).out).toEqual({ decision: 'allow' });
      expect(server.seen).toHaveLength(0);
      expect((await runHook(hookInput('write_to_file', { TargetFile: linked }), env)).out).toEqual({ decision: 'deny', reason: 'asked' });
      expect(server.seen).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it('ignores HTTP(S)_PROXY for the dashboard call', async () => {
    const server = await startHookServer(() => ({ status: 200, json: { decision: 'allow' } }));
    try {
      const env = hookEnv({
        SWARMKIT_DASH_HOOK_URL: server.url,
        SWARMKIT_DASH_HOOK_SECRET: 's',
        SWARMKIT_DASH_CWD: scratch,
        HTTP_PROXY: 'http://127.0.0.1:1',
        http_proxy: 'http://127.0.0.1:1',
        NO_PROXY: '',
        no_proxy: '',
      });
      const { out } = await runHook(hookInput('run_command', { CommandLine: 'echo hi' }), env);
      expect(out).toEqual({ decision: 'allow' });
      expect(server.seen).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it('denies malformed stdin', async () => {
    const env = hookEnv({ SWARMKIT_DASH_HOOK_URL: 'http://127.0.0.1:1/unreachable', SWARMKIT_DASH_HOOK_SECRET: 's', SWARMKIT_DASH_CWD: scratch });
    const { code, out } = await runHook('not json', env);
    expect(code).toBe(0);
    expect(out).toEqual({ decision: 'deny', reason: 'swarmkit hook error' });
  });

  it.each([
    [{ SWARMKIT_DASH_HOOK_URL: 'http://127.0.0.1:1/unreachable' }],
    [{ SWARMKIT_DASH_HOOK_SECRET: 's' }],
    [{ SWARMKIT_DASH_HOOK_URL: '', SWARMKIT_DASH_HOOK_SECRET: 's' }],
    [{ SWARMKIT_DASH_HOOK_URL: 'http://127.0.0.1:1/unreachable', SWARMKIT_DASH_HOOK_SECRET: '' }],
  ])('denies when exactly one hook env var is set (%o)', async extra => {
    const env = hookEnv({ ...extra, SWARMKIT_DASH_CWD: scratch });
    const { code, out } = await runHook(hookInput('run_command', { CommandLine: 'echo hi' }), env);
    expect(code).toBe(0);
    expect(out).toEqual({ decision: 'deny', reason: 'incomplete swarmkit hook configuration' });
  });

  it('stays inert when both hook env vars are empty strings', async () => {
    const env = hookEnv({ SWARMKIT_DASH_HOOK_URL: '', SWARMKIT_DASH_HOOK_SECRET: '', SWARMKIT_DASH_CWD: scratch });
    const { code, out } = await runHook(hookInput('run_command', { CommandLine: 'rm -rf /' }), env);
    expect(code).toBe(0);
    expect(out).toEqual({ decision: 'allow' });
  });
});

const bridgeBody = (name: string, args: Record<string, unknown>): unknown => ({
  conversationId: 'c1',
  stepIdx: 3,
  toolCall: { name, args },
});

describe('AgyHookBridge', () => {
  it('allows through a registered handler with mapped tool and toolUseId', async () => {
    const seen: AgyHookRequest[] = [];
    const bridge = new AgyHookBridge();
    bridge.register('s1', async req => {
      seen.push(req);
      return { allow: true };
    });
    const res = await bridge.handle('s1', bridgeBody('run_command', { CommandLine: 'ls', toolSummary: 'list' }));
    expect(res).toEqual({ status: 200, json: { decision: 'allow' } });
    expect(seen).toEqual([{ tool: 'Bash', input: { command: 'ls', description: 'list', raw: { CommandLine: 'ls', toolSummary: 'list' } }, toolUseId: 'c1:3', title: 'list' }]);
  });

  it('passes all raw tool params (bounded) alongside the mapped fields', async () => {
    const bridge = new AgyHookBridge();
    const seen: AgyHookRequest[] = [];
    bridge.register('sr', async req => {
      seen.push(req);
      return { allow: true };
    });
    await bridge.handle('sr', bridgeBody('run_command', { CommandLine: 'ls', Cwd: '/etc', toolSummary: 'list' }));
    expect(seen[0]!.input).toMatchObject({ command: 'ls', raw: { CommandLine: 'ls', Cwd: '/etc', toolSummary: 'list' } });
    await bridge.handle('sr', bridgeBody('write_to_file', { TargetFile: '/a', CodeContent: 'x'.repeat(30000) }));
    const raw = seen[1]!.input.raw as string;
    expect(typeof raw).toBe('string');
    expect(raw.length).toBeLessThan(20100);
  });

  it('returns the handler deny reason', async () => {
    const bridge = new AgyHookBridge();
    bridge.register('s2', async () => ({ allow: false, reason: 'not now' }));
    expect(await bridge.handle('s2', bridgeBody('view_file', { AbsolutePath: '/x' }))).toEqual({
      status: 200,
      json: { decision: 'deny', reason: 'not now' },
    });
  });

  it('denies when the handler throws', async () => {
    const bridge = new AgyHookBridge();
    bridge.register('s3', async () => {
      throw new Error('kaput');
    });
    const res = await bridge.handle('s3', bridgeBody('view_file', { AbsolutePath: '/x' }));
    expect(res.status).toBe(200);
    expect(res.json.decision).toBe('deny');
  });

  it('rejects unknown secrets with 403', async () => {
    const bridge = new AgyHookBridge();
    bridge.register('s1', async () => ({ allow: true }));
    expect(await bridge.handle('wrong', bridgeBody('view_file', { AbsolutePath: '/x' }))).toEqual({
      status: 403,
      json: { decision: 'deny', reason: 'unknown hook secret' },
    });
    expect(await bridge.handle(undefined, bridgeBody('view_file', { AbsolutePath: '/x' }))).toMatchObject({ status: 403 });
  });

  it('rejects bad bodies with 400', async () => {
    const bridge = new AgyHookBridge();
    bridge.register('s1', async () => ({ allow: true }));
    for (const bad of [{}, { conversationId: 'c1' }, { conversationId: 'c1', stepIdx: 'x', toolCall: { name: 'a', args: {} } }, null, 'str']) {
      expect(await bridge.handle('s1', bad)).toMatchObject({ status: 400 });
    }
  });

  it('forgets unregistered secrets', async () => {
    const bridge = new AgyHookBridge();
    bridge.register('s9', async () => ({ allow: true }));
    bridge.unregister('s9');
    expect(await bridge.handle('s9', bridgeBody('view_file', { AbsolutePath: '/x' }))).toMatchObject({ status: 403 });
  });
});
