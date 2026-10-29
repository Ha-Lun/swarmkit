import http from 'node:http';
import net from 'node:net';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  ClaudeHookBridge,
  Presence,
  claudeHookFilePath,
  claudeHookSocketPath,
  displayInput,
  ensurePrivateDir,
  handleClaudeHookRoute,
  parseHookBody,
  removeClaudeHookFile,
  startClaudeHookServer,
  writeClaudeHookFile,
  CLAUDE_HOOK_BODY_MAX,
} from '../server/claudehook.ts';
import type { HookWatcher } from '../server/claudehook.ts';
import { SdkSessions } from '../server/sdk/sessions.ts';
import type { QueryFn } from '../server/sdk/sessions.ts';
import { TranscriptWatcher } from '../server/watch/transcripts.ts';
import type { PermissionRequest, ServerEvent } from '../src/shared/types.ts';

const SID = '11111111-2222-4333-8444-555555555555';
const SECRET = 'a'.repeat(64);

const scratch = mkdtempSync(path.join(tmpdir(), 'claude-hook-scratch-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
/** The transcript the fake watcher follows; a symlink to it counts as the same file. */
const TRANSCRIPT = path.join(scratch, 'session.jsonl');
writeFileSync(TRANSCRIPT, '');
const OTHER_TRANSCRIPT = path.join(scratch, 'other.jsonl');
writeFileSync(OTHER_TRANSCRIPT, '');

const planInput = { plan: '# Plan\n- step one', planFilePath: '/home/u/.claude/plans/p.md' };
const questionInput = {
  questions: [
    {
      question: 'Which layout?',
      header: 'Layout',
      multiSelect: false,
      options: [
        { label: 'Grid', description: 'a grid' },
        { label: 'List', description: 'a list' },
      ],
    },
  ],
};

/** In-memory HookWatcher recording what the bridge asks of it. */
function fakeWatcher(known = true, transcript: string | undefined = TRANSCRIPT) {
  const pending = new Map<string, PermissionRequest>();
  const events: { type: 'add' | 'remove'; id: string; allow?: boolean }[] = [];
  const watcher: HookWatcher & { known: boolean } = {
    known,
    hasSession: async () => watcher.known,
    transcriptPath: () => transcript,
    addTerminalPermission: request => {
      pending.set(request.id, request);
      events.push({ type: 'add', id: request.id });
    },
    removeTerminalPermission: (_sessionId, id, allow) => {
      events.push({ type: 'remove', id, allow });
      return pending.delete(id);
    },
  };
  return { watcher, pending, events };
}

function makeBridge(over: { open?: boolean; owned?: boolean; known?: boolean; holdMs?: number; transcript?: string } = {}) {
  const fake = fakeWatcher(over.known ?? true, over.transcript ?? TRANSCRIPT);
  const state = { open: over.open ?? true, owned: over.owned ?? false };
  const bridge = new ClaudeHookBridge({
    watcher: fake.watcher,
    owns: () => state.owned,
    dashboardOpen: () => state.open,
    sessionWaitMs: 0,
    ...(over.holdMs !== undefined ? { holdMs: over.holdMs } : {}),
  });
  return { bridge, state, ...fake };
}

const hook = (tool: string, input: Record<string, unknown>, sessionId = SID, transcript: string | undefined = TRANSCRIPT) =>
  parseHookBody({ session_id: sessionId, tool_name: tool, tool_input: input, transcript_path: transcript })!;

async function nextPending(pending: Map<string, PermissionRequest>): Promise<PermissionRequest> {
  await vi.waitFor(() => expect(pending.size).toBeGreaterThan(0));
  return [...pending.values()].at(-1)!;
}

describe('parseHookBody', () => {
  it('accepts a well-formed hook body and rejects bad ones', () => {
    expect(parseHookBody({ session_id: SID, tool_name: 'ExitPlanMode', tool_input: planInput })).toEqual({
      sessionId: SID,
      toolName: 'ExitPlanMode',
      toolInput: planInput,
    });
    expect(parseHookBody({ session_id: SID, tool_name: 'X', tool_input: {}, transcript_path: '/t.jsonl' })?.transcriptPath).toBe('/t.jsonl');
    expect(parseHookBody(null)).toBeNull();
    expect(parseHookBody([])).toBeNull();
    expect(parseHookBody({ session_id: '../../etc/passwd', tool_name: 'ExitPlanMode', tool_input: {} })).toBeNull();
    expect(parseHookBody({ session_id: 'short', tool_name: 'ExitPlanMode', tool_input: {} })).toBeNull();
    expect(parseHookBody({ session_id: SID, tool_name: '', tool_input: {} })).toBeNull();
    expect(parseHookBody({ session_id: SID, tool_name: 'X', tool_input: 'nope' })).toBeNull();
    expect(parseHookBody({ session_id: SID, tool_name: 'X', tool_input: {}, transcript_path: 5 })).toBeNull();
  });
});

describe('displayInput', () => {
  it('caps the plan, keeps only known keys and refuses unrenderable input', () => {
    const plan = displayInput('ExitPlanMode', { plan: 'x'.repeat(200 * 1024), extra: 'drop', planFilePath: '/p' })!;
    expect((plan.plan as string).length).toBe(100 * 1024);
    expect(plan).not.toHaveProperty('extra');
    expect(displayInput('ExitPlanMode', {})).toBeNull();
    expect(displayInput('AskUserQuestion', { questions: 'x' })).toBeNull();
    expect(displayInput('AskUserQuestion', { questions: [] })).toBeNull();
    const q = displayInput('AskUserQuestion', questionInput) as { questions: { options: unknown[] }[] };
    expect(q.questions[0]!.options).toHaveLength(2);
  });
});

describe('ClaudeHookBridge pass cases', () => {
  it('passes an unknown tool', async () => {
    const { bridge, pending } = makeBridge();
    expect(await bridge.request(hook('Bash', { command: 'ls' }), new AbortController().signal)).toEqual({ decision: 'pass' });
    expect(pending.size).toBe(0);
  });

  it('passes a dashboard (SDK-owned) session', async () => {
    const { bridge, pending } = makeBridge({ owned: true });
    expect(await bridge.request(hook('ExitPlanMode', planInput), new AbortController().signal)).toEqual({ decision: 'pass' });
    expect(pending.size).toBe(0);
  });

  it('passes when no dashboard is open', async () => {
    const { bridge, pending } = makeBridge({ open: false });
    expect(await bridge.request(hook('ExitPlanMode', planInput), new AbortController().signal)).toEqual({ decision: 'pass' });
    expect(pending.size).toBe(0);
  });

  it('passes a session the watcher does not know', async () => {
    const { bridge, pending } = makeBridge({ known: false });
    expect(await bridge.request(hook('AskUserQuestion', questionInput), new AbortController().signal)).toEqual({ decision: 'pass' });
    expect(pending.size).toBe(0);
  });

  it('passes when the hook transcript is not the watcher transcript for that session', async () => {
    const { bridge, pending } = makeBridge();
    for (const transcript of [OTHER_TRANSCRIPT, path.join(scratch, 'missing.jsonl')]) {
      expect(await bridge.request(hook('ExitPlanMode', planInput, SID, transcript), new AbortController().signal)).toEqual({ decision: 'pass' });
    }
    // No transcript_path at all, and a watcher that does not know the file.
    const bare = parseHookBody({ session_id: SID, tool_name: 'ExitPlanMode', tool_input: planInput })!;
    expect(await bridge.request(bare, new AbortController().signal)).toEqual({ decision: 'pass' });
    const unknownFile = makeBridge();
    const noFile = new ClaudeHookBridge({ watcher: { ...unknownFile.watcher, transcriptPath: () => undefined }, owns: () => false, dashboardOpen: () => true, sessionWaitMs: 0 });
    expect(await noFile.request(hook('ExitPlanMode', planInput), new AbortController().signal)).toEqual({ decision: 'pass' });
    expect(pending.size + unknownFile.pending.size).toBe(0);
  });

  it('accepts the same transcript through a symlink', async () => {
    const link = path.join(scratch, 'link.jsonl');
    symlinkSync(TRANSCRIPT, link);
    const { bridge, pending } = makeBridge();
    const result = bridge.request(hook('ExitPlanMode', planInput, SID, link), new AbortController().signal);
    bridge.decide((await nextPending(pending)).id, { allow: true });
    expect(await result).toEqual({ decision: 'allow' });
  });

  it('passes input the dashboard cannot render', async () => {
    const { bridge, pending } = makeBridge();
    expect(await bridge.request(hook('ExitPlanMode', {}), new AbortController().signal)).toEqual({ decision: 'pass' });
    expect(pending.size).toBe(0);
  });

  it('passes the fifth pending prompt of one session', async () => {
    const { bridge, pending } = makeBridge();
    const held = Array.from({ length: 4 }, () => bridge.request(hook('ExitPlanMode', planInput), new AbortController().signal));
    await vi.waitFor(() => expect(pending.size).toBe(4));
    expect(await bridge.request(hook('ExitPlanMode', planInput), new AbortController().signal)).toEqual({ decision: 'pass' });
    expect(pending.size).toBe(4);
    bridge.releaseAll();
    expect(await Promise.all(held)).toEqual(Array(4).fill({ decision: 'pass' }));
    expect(pending.size).toBe(0);
  });
});

describe('ClaudeHookBridge decisions', () => {
  it('creates a terminal plan request on the root node', async () => {
    const { bridge, pending } = makeBridge();
    const result = bridge.request(hook('ExitPlanMode', planInput), new AbortController().signal);
    const request = await nextPending(pending);
    expect(request).toMatchObject({ sessionId: SID, nodeId: 'root', tool: 'ExitPlanMode', kind: 'plan', terminal: true, input: planInput });
    expect(bridge.decide(request.id, { allow: true })).toBe(true);
    await result;
    expect(bridge.decide(request.id, { allow: true })).toBe(false);
  });

  it('returns question answers, never an input', async () => {
    const { bridge, pending } = makeBridge();
    const result = bridge.request(hook('AskUserQuestion', questionInput), new AbortController().signal);
    const request = await nextPending(pending);
    expect(request.kind).toBe('question');
    bridge.decide(request.id, { allow: true, answers: { 'Which layout?': 'Grid' } });
    expect(await result).toEqual({ decision: 'allow', answers: { 'Which layout?': 'Grid' } });
  });

  it('approves a plan without a mode', async () => {
    const { bridge, pending } = makeBridge();
    const result = bridge.request(hook('ExitPlanMode', planInput), new AbortController().signal);
    bridge.decide((await nextPending(pending)).id, { allow: true });
    expect(await result).toEqual({ decision: 'allow' });
  });

  it('approves a plan with a mode', async () => {
    const { bridge, pending } = makeBridge();
    const result = bridge.request(hook('ExitPlanMode', planInput), new AbortController().signal);
    bridge.decide((await nextPending(pending)).id, { allow: true, mode: 'acceptEdits' });
    expect(await result).toEqual({ decision: 'allow', mode: 'acceptEdits' });
  });

  it('denies with the message, defaulting to Denied in SwarmKit', async () => {
    const { bridge, pending } = makeBridge();
    const first = bridge.request(hook('ExitPlanMode', planInput), new AbortController().signal);
    bridge.decide((await nextPending(pending)).id, { allow: false, message: 'split step two' });
    expect(await first).toEqual({ decision: 'deny', message: 'split step two' });

    pending.clear();
    const second = bridge.request(hook('ExitPlanMode', planInput), new AbortController().signal);
    bridge.decide((await nextPending(pending)).id, { allow: false });
    expect(await second).toEqual({ decision: 'deny', message: 'Denied in SwarmKit' });
  });

  it('hands a terminal decision back to the terminal dialog', async () => {
    const { bridge, pending, events } = makeBridge();
    const result = bridge.request(hook('AskUserQuestion', questionInput), new AbortController().signal);
    const request = await nextPending(pending);
    bridge.decide(request.id, { allow: false, terminal: true });
    expect(await result).toEqual({ decision: 'pass' });
    expect(events.at(-1)).toEqual({ type: 'remove', id: request.id, allow: false });
  });

  it('withdraws when the hook connection closes first', async () => {
    const { bridge, pending, events } = makeBridge();
    const closer = new AbortController();
    const result = bridge.request(hook('ExitPlanMode', planInput), closer.signal);
    const request = await nextPending(pending);
    closer.abort();
    expect(await result).toEqual({ decision: 'pass' });
    expect(events.at(-1)).toEqual({ type: 'remove', id: request.id, allow: false });
    expect(bridge.decide(request.id, { allow: true })).toBe(false);
  });

  it('replies pass and withdraws after the hold timeout', async () => {
    const { bridge, pending, events } = makeBridge({ holdMs: 20 });
    expect(await bridge.request(hook('ExitPlanMode', planInput), new AbortController().signal)).toEqual({ decision: 'pass' });
    expect(events.map(e => e.type)).toEqual(['add', 'remove']);
    expect(events[1]).toMatchObject({ allow: false });
    expect(pending.size).toBe(0);
  });

  it('does not create a request when the hook is already gone after the session wait', async () => {
    const { bridge, pending } = makeBridge();
    const closer = new AbortController();
    closer.abort();
    expect(await bridge.request(hook('ExitPlanMode', planInput), closer.signal)).toEqual({ decision: 'pass' });
    expect(pending.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// route
// ---------------------------------------------------------------------------

describe('POST /api/claude-hook over the Unix socket', () => {
  const xdg = mkdtempSync(path.join(tmpdir(), 'claude-hook-sock-'));
  let socketPath: string;
  let close: () => Promise<void>;
  let route: { bridge: ClaudeHookBridge; pending: Map<string, PermissionRequest>; state: { open: boolean; owned: boolean } };
  afterAll(() => rmSync(xdg, { recursive: true, force: true }));

  beforeEach(async () => {
    route = makeBridge();
    const started = await startClaudeHookServer({ bridge: route.bridge, secret: SECRET }, path.join(xdg, 'swarmkit', 'claude-hook.json'));
    socketPath = started.socketPath;
    close = started.close;
  });
  afterEach(async () => {
    route.bridge.releaseAll();
    await close();
  });

  interface Reply {
    status: number;
    json: unknown;
  }
  const send = (method: string, urlPath: string, body: string | undefined, headers: Record<string, string>, signal?: AbortSignal): Promise<Reply> =>
    new Promise((resolve, reject) => {
      const req = http.request({ socketPath, method, path: urlPath, headers, signal, agent: false }, res => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : undefined });
        });
      });
      req.on('error', reject);
      req.end(body);
    });
  const post = (body: unknown, headers: Record<string, string> = {}, raw = false, signal?: AbortSignal) =>
    send('POST', '/api/claude-hook', raw ? (body as string) : JSON.stringify(body), { 'content-type': 'application/json', 'x-swarmkit-hook': SECRET, ...headers }, signal);
  const good = { session_id: SID, tool_name: 'Bash', tool_input: { command: 'ls' } };

  it('creates the socket 0600 in a 0700 dir', () => {
    expect(statSync(socketPath).isSocket()).toBe(true);
    expect(statSync(socketPath).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(socketPath)).mode & 0o777).toBe(0o700);
  });

  it('passes a call it does not handle', async () => {
    const res = await post(good);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ decision: 'pass' });
  });

  it('serves nothing but POST /api/claude-hook', async () => {
    expect((await send('POST', '/api/sessions', '{}', { 'content-type': 'application/json', 'x-swarmkit-hook': SECRET })).status).toBe(404);
    expect((await send('GET', '/', undefined, {})).status).toBe(404);
  });

  it('rejects a missing or wrong secret without detail', async () => {
    for (const headers of [{ 'x-swarmkit-hook': '' }, { 'x-swarmkit-hook': 'b'.repeat(64) }, { 'x-swarmkit-hook': 'short' }]) {
      const res = await post(good, headers);
      expect(res.status).toBe(401);
      expect(res.json).toEqual({ error: 'unauthorized' });
    }
  });

  it('rejects a wrong content type, bad JSON, bad session ids and wrong methods', async () => {
    expect((await post(good, { 'content-type': 'text/plain' })).status).toBe(400);
    expect((await post('{nope', {}, true)).status).toBe(400);
    const bad = await post({ ...good, session_id: '../../x' });
    expect(bad.status).toBe(400);
    expect(bad.json).toEqual({ error: 'bad request' });
    expect((await send('GET', '/api/claude-hook', undefined, { 'x-swarmkit-hook': SECRET })).status).toBe(405);
  });

  it('rejects an oversize body', async () => {
    const res = await post({ ...good, tool_input: { blob: 'x'.repeat(CLAUDE_HOOK_BODY_MAX + 10) } });
    expect(res.status).toBe(413);
    expect(res.json).toEqual({ error: 'too large' });
  });

  it('holds the connection until the dashboard decides', async () => {
    const reply = post({ session_id: SID, tool_name: 'ExitPlanMode', tool_input: planInput, transcript_path: TRANSCRIPT });
    const request = await nextPending(route.pending);
    expect(route.bridge.decide(request.id, { allow: true, mode: 'auto' })).toBe(true);
    const res = await reply;
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ decision: 'allow', mode: 'auto' });
  });

  it('withdraws the prompt when the hook connection closes', async () => {
    const abort = new AbortController();
    const reply = post({ session_id: SID, tool_name: 'AskUserQuestion', tool_input: questionInput, transcript_path: TRANSCRIPT }, {}, false, abort.signal).catch(() => undefined);
    const request = await nextPending(route.pending);
    abort.abort();
    await reply;
    await vi.waitFor(() => expect(route.pending.has(request.id)).toBe(false));
    expect(route.bridge.decide(request.id, { allow: true })).toBe(false);
  });
});

describe('hook socket startup', () => {
  const base = mkdtempSync(path.join(tmpdir(), 'claude-hook-start-'));
  afterAll(() => rmSync(base, { recursive: true, force: true }));
  const ctx = () => ({ bridge: makeBridge().bridge, secret: SECRET });

  /** Leaves a socket file behind with no listener, like a crashed server. */
  async function leaveStaleSocket(sock: string): Promise<void> {
    const server = net.createServer();
    await new Promise<void>(resolve => server.listen(sock, resolve));
    // Closing would unlink; keep the inode by unref-ing the handle and abandoning it.
    server.unref();
  }

  it('replaces a stale socket of ours', async () => {
    const file = path.join(base, 'a', 'claude-hook.json');
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    await leaveStaleSocket(claudeHookSocketPath(file));
    expect(statSync(claudeHookSocketPath(file)).isSocket()).toBe(true);
    const started = await startClaudeHookServer(ctx(), file);
    expect(statSync(started.socketPath).isSocket()).toBe(true);
    await started.close();
    expect(existsSync(started.socketPath)).toBe(false);
  });

  it('refuses to unlink something that is not a socket', async () => {
    const file = path.join(base, 'b', 'claude-hook.json');
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(claudeHookSocketPath(file), 'precious');
    await expect(startClaudeHookServer(ctx(), file)).rejects.toThrow(/occupied/);
    expect(readFileSync(claudeHookSocketPath(file), 'utf8')).toBe('precious');
  });

  it('tightens a loose config dir to 0700 and refuses a symlinked one', async () => {
    const dir = path.join(base, 'c');
    mkdirSync(dir, { mode: 0o755 });
    chmodSync(dir, 0o755);
    ensurePrivateDir(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    const link = path.join(base, 'c-link');
    symlinkSync(dir, link);
    expect(() => ensurePrivateDir(link)).toThrow(/not a directory/);
    await expect(startClaudeHookServer(ctx(), path.join(link, 'claude-hook.json'))).rejects.toThrow();
  });
});

describe('Presence', () => {
  it('is closed with no presence, hidden, or stale; open while a tab is visible', () => {
    let now = 1_000_000;
    const presence = new Presence(() => now);
    expect(presence.anyVisible()).toBe(false);
    presence.set('a', false);
    expect(presence.anyVisible()).toBe(false);
    presence.set('a', true);
    expect(presence.anyVisible()).toBe(true);
    now += 89_000;
    expect(presence.anyVisible()).toBe(true);
    now += 2_000;
    expect(presence.anyVisible()).toBe(false);
  });

  it('keeps tabs apart: a hidden tab does not hide a visible one, and hiding the last one closes it', () => {
    let now = 5_000_000;
    const presence = new Presence(() => now);
    presence.set('a', true);
    presence.set('b', false);
    expect(presence.anyVisible()).toBe(true);
    now += 10_000;
    presence.set('a', false);
    expect(presence.anyVisible()).toBe(false);
  });

  it('is bounded', () => {
    const presence = new Presence();
    for (let i = 0; i < 500; i++) presence.set(`tab-${i}`, false);
    presence.set('last', true);
    expect(presence.anyVisible()).toBe(true);
  });
});

describe('ClaudeHookBridge with presence', () => {
  it('holds only while a tab is visible, and passes with none, a hidden one or a stale one', async () => {
    let now = 9_000_000;
    const presence = new Presence(() => now);
    const fake = fakeWatcher();
    const bridge = new ClaudeHookBridge({ watcher: fake.watcher, owns: () => false, dashboardOpen: () => presence.anyVisible(), sessionWaitMs: 0 });
    const call = () => bridge.request(hook('ExitPlanMode', planInput), new AbortController().signal);
    expect(await call()).toEqual({ decision: 'pass' });
    presence.set('t', false);
    expect(await call()).toEqual({ decision: 'pass' });
    presence.set('t', true);
    now += 91_000;
    expect(await call()).toEqual({ decision: 'pass' });
    presence.set('t', true);
    const held = call();
    const request = await nextPending(fake.pending);
    bridge.decide(request.id, { allow: true });
    expect(await held).toEqual({ decision: 'allow' });
  });
});

// ---------------------------------------------------------------------------
// hook file
// ---------------------------------------------------------------------------

describe('hook file', () => {
  const oldXdg = process.env.XDG_CONFIG_HOME;
  const dir = mkdtempSync(path.join(tmpdir(), 'claude-hook-test-'));
  beforeEach(() => {
    process.env.XDG_CONFIG_HOME = dir;
  });
  afterEach(() => {
    if (oldXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = oldXdg;
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('writes {socket, secret} as 0600 in a 0700 dir and leaves no temp file', () => {
    const file = claudeHookFilePath();
    expect(file).toBe(path.join(dir, 'swarmkit', 'claude-hook.json'));
    expect(claudeHookSocketPath()).toBe(path.join(dir, 'swarmkit', 'claude-hook.sock'));
    writeClaudeHookFile(claudeHookSocketPath(), SECRET);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ socket: claudeHookSocketPath(), secret: SECRET });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    // A rewrite (new start) replaces the content in place.
    writeClaudeHookFile(claudeHookSocketPath(), 'b'.repeat(64));
    expect(JSON.parse(readFileSync(file, 'utf8')).secret).toBe('b'.repeat(64));
    expect(existsSync(`${file}.tmp`)).toBe(false);
    rmSync(file);
  });

  it('uses XDG_CONFIG_HOME only when absolute, trimmed and normalised (as the hook script does)', () => {
    const file = (xdg: string) => {
      process.env.XDG_CONFIG_HOME = xdg;
      return claudeHookFilePath();
    };
    expect(file(`  ${dir}/a/../b/  `)).toBe(path.join(dir, 'b', 'swarmkit', 'claude-hook.json'));
    const home = path.join(homedir(), '.config', 'swarmkit', 'claude-hook.json');
    expect(file('relative/dir')).toBe(home);
    expect(file('   ')).toBe(home);
  });

  it('removes the file only while it still holds our secret', () => {
    const file = claudeHookFilePath();
    writeClaudeHookFile(claudeHookSocketPath(), 'c'.repeat(64));
    writeFileSync(claudeHookSocketPath(), '');
    removeClaudeHookFile(SECRET);
    expect(existsSync(file)).toBe(true);
    expect(existsSync(claudeHookSocketPath())).toBe(true);
    removeClaudeHookFile('c'.repeat(64));
    expect(existsSync(file)).toBe(false);
    expect(existsSync(claudeHookSocketPath())).toBe(false);
    removeClaudeHookFile(SECRET); // already gone: no throw
  });
});

// ---------------------------------------------------------------------------
// watcher integration
// ---------------------------------------------------------------------------

describe('TranscriptWatcher terminal permissions', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'claude-hook-watch-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('shows the prompt in detail and summary, then clears it', async () => {
    mkdirSync(path.join(root, 'proj'), { recursive: true });
    writeFileSync(
      path.join(root, 'proj', `${SID}.jsonl`),
      JSON.stringify({ type: 'user', uuid: 'u1', timestamp: new Date().toISOString(), cwd: '/repo/alpha', message: { role: 'user', content: 'plan it' } }) + '\n',
    );
    const events: ServerEvent[] = [];
    const watcher = new TranscriptWatcher({ root, emit: e => events.push(e), skip: () => false });
    expect(await watcher.hasSession('does-not-exist-0000', 0)).toBe(false);
    expect(await watcher.hasSession(SID, 0)).toBe(true);

    const bridge = new ClaudeHookBridge({ watcher, owns: () => false, dashboardOpen: () => true });
    const transcript = path.join(root, 'proj', `${SID}.jsonl`);
    expect(watcher.transcriptPath(SID)).toBe(transcript);
    expect(await bridge.request(hook('ExitPlanMode', planInput, SID, OTHER_TRANSCRIPT), new AbortController().signal)).toEqual({ decision: 'pass' });
    const result = bridge.request(hook('ExitPlanMode', planInput, SID, transcript), new AbortController().signal);
    await vi.waitFor(() => expect(watcher.pendingCount(SID)).toBe(1));
    const request = watcher.terminalPermissions(SID)[0]!;
    expect(events.some(e => e.type === 'permission.request' && e.request.id === request.id && e.request.terminal === true)).toBe(true);
    const detail = await watcher.get(SID);
    expect(detail?.permissions.map(p => p.id)).toEqual([request.id]);
    expect(detail?.pendingPermissions).toBe(1);
    expect(detail?.status).toBe('waiting');
    expect(watcher.list().find(s => s.id === SID)?.pendingPermissions).toBe(1);

    bridge.decide(request.id, { allow: true });
    await result;
    expect(events.some(e => e.type === 'permission.resolved' && e.id === request.id && e.allow)).toBe(true);
    expect(watcher.pendingCount(SID)).toBe(0);
    expect((await watcher.get(SID))?.permissions).toEqual([]);
    expect(watcher.list().find(s => s.id === SID)?.pendingPermissions).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// SDK sessions: plan approval with a mode
// ---------------------------------------------------------------------------

describe('SdkSessions plan mode', () => {
  const fakeHome = mkdtempSync(path.join(tmpdir(), 'fleet-hook-home-'));
  const trusted = path.join(fakeHome, 'trusted');
  const untrusted = path.join(fakeHome, 'untrusted');
  const oldHome = process.env.HOME;
  beforeEach(() => {
    mkdirSync(trusted, { recursive: true });
    mkdirSync(untrusted, { recursive: true });
    writeFileSync(path.join(fakeHome, '.claude.json'), JSON.stringify({ projects: { [trusted]: { hasTrustDialogAccepted: true } } }));
    process.env.HOME = fakeHome;
  });
  afterEach(() => {
    process.env.HOME = oldHome;
  });
  afterAll(() => rmSync(fakeHome, { recursive: true, force: true }));

  async function planDecision(
    body: { allow: boolean; mode?: 'auto' | 'acceptEdits' },
    tool = 'ExitPlanMode',
    cwd = trusted,
    sdkMode: string | null = 'plan',
  ) {
    const events: ServerEvent[] = [];
    let decision: unknown;
    const query = ((params: Parameters<QueryFn>[0]) => {
      const options = params.options!;
      return (async function* generator(): AsyncGenerator<unknown, void> {
        // The SDK reports the session's current permission mode (the seed is the terminal default, auto).
        yield { type: 'system', subtype: 'init', session_id: options.sessionId, model: 'claude-opus-5-5', ...(sdkMode ? { permissionMode: sdkMode } : {}) };
        decision = await options.canUseTool!(tool, planInput, { signal: options.abortController!.signal, toolUseID: 't1', requestId: 'r1' });
        yield { type: 'result', subtype: 'success' };
      })() as unknown as AsyncIterable<SDKMessage>;
    }) as QueryFn;
    const sdk = new SdkSessions(e => events.push(e), query);
    sdk.start({ prompt: 'plan it', cwd });
    await vi.waitFor(() => expect(events.some(e => e.type === 'permission.request')).toBe(true));
    const request = (events.find(e => e.type === 'permission.request') as { request: PermissionRequest }).request;
    expect(sdk.decide(request.id, body)).toBe(true);
    await vi.waitFor(() => expect(decision).toBeDefined());
    return decision;
  }

  it('sets the session mode when a plan is approved with one in a trusted project', async () => {
    expect(await planDecision({ allow: true, mode: 'acceptEdits' })).toEqual({
      behavior: 'allow',
      updatedInput: planInput,
      updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
    });
  });

  it('sets a mode only while the SDK session is in plan mode', async () => {
    const plain = { behavior: 'allow', updatedInput: planInput };
    expect(await planDecision({ allow: true, mode: 'auto' }, 'ExitPlanMode', trusted, 'default')).toEqual(plain);
    expect(await planDecision({ allow: true, mode: 'auto' }, 'ExitPlanMode', trusted, 'acceptEdits')).toEqual(plain);
    // No report from the SDK: the seeded terminal default (auto) applies.
    expect(await planDecision({ allow: true, mode: 'auto' }, 'ExitPlanMode', trusted, null)).toEqual(plain);
  });

  it('never sets a mode in an untrusted project', async () => {
    expect(await planDecision({ allow: true, mode: 'auto' }, 'ExitPlanMode', untrusted)).toEqual({ behavior: 'allow', updatedInput: planInput });
  });

  it('leaves permissions alone without a mode, on deny, and for non-plan tools', async () => {
    expect(await planDecision({ allow: true })).toEqual({ behavior: 'allow', updatedInput: planInput });
    expect(await planDecision({ allow: false, mode: 'auto' })).toMatchObject({ behavior: 'deny' });
    expect(await planDecision({ allow: true, mode: 'auto' }, 'Bash')).toEqual({ behavior: 'allow', updatedInput: planInput });
  });
});
