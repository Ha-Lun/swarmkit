import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentNode, AgentNodeHead, ServerEvent } from '../src/shared/types';
import type { SessionTree, TreeInit } from '../server/model/reducer';
import { AGENT_RE, EVICT_AFTER_MS, SdkSessions, SessionError } from '../server/sdk/sessions';
import type { QueryFn, ResumeInfo } from '../server/sdk/sessions';
import { validEffort, ValidationError } from '../server/validate.ts';

// The data-model team builds the real reducer in parallel this checkout only
// has the throwing stub, so stand in a minimal tree fake with the final signatures.
vi.mock('../server/model/reducer.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../server/model/reducer.ts')>();
  const makeRoot = (sessionId: string, init: TreeInit = { startedAt: Date.now() }): AgentNode => ({
    id: 'root',
    sessionId,
    parentId: null,
    kind: 'main',
    agentType: init.agentType ?? 'main',
    ...(init.prompt ? { prompt: init.prompt } : {}),
    status: 'running',
    startedAt: init.startedAt ?? Date.now(),
    costUsd: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    toolCounts: {},
    events: [],
  });
  return {
    ...actual,
    createTree(sessionId: string, init?: TreeInit): SessionTree {
      return {
        sessionId,
        nodes: new Map([['root', makeRoot(sessionId, init)]]),
        toolOwner: new Map(),
      };
    },
    applyMessage(): ServerEvent[] {
      return [];
    },
    setStatus(tree: SessionTree, nodeId: string, status: AgentNode['status']): ServerEvent[] {
      const node = tree.nodes.get(nodeId);
      if (node) node.status = status;
      const { events: _events, ...head } = node ?? ({} as AgentNode);
      const nodeHead = head as AgentNodeHead;
      return [{ type: 'node.upsert', node: nodeHead }];
    },
  };
});

/** Real scratch dir under $HOME: resume() validates cwds like the start path does. */
const homeDir = mkdtempSync(path.join(homedir(), 'fleet-sessions-test-'));
afterAll(() => rmSync(homeDir, { recursive: true, force: true }));

interface FakeState {
  options?: { sessionId?: string };
  decision?: { behavior?: string } | null;
}

/** Fake queryFn: yields an init message, asks for a Bash permission via canUseTool, then yields a result. */
function makeFakeQuery(state: FakeState) {
  return (params: Parameters<QueryFn>[0]) => {
    const options = params.options!;
    state.options = options;
    const init = { type: 'system', subtype: 'init', session_id: options.sessionId, model: 'claude-opus-5-5' };
    return (async function* generator(): AsyncGenerator<any, void> {
      yield init;
      state.decision = await options.canUseTool!(
        'Bash',
        { command: 'ls' },
        { signal: options.abortController!.signal, toolUseID: 't1', requestId: 'req-t1' },
      );
      yield { type: 'result', subtype: 'success' };
    })() as unknown as AsyncIterable<SDKMessage>;
  };
}

/** Recording fake: captures the options of every query and finishes immediately. */
function makeRecordingQuery(optionsSeen: (Record<string, unknown> | undefined)[]) {
  return (params: Parameters<QueryFn>[0]) => {
    optionsSeen.push(params.options as Record<string, unknown> | undefined);
    return (async function* generator(): AsyncGenerator<any, void> {
      yield { type: 'system', subtype: 'init', model: 'claude-opus-5-5' };
      yield { type: 'result', subtype: 'success' };
    })() as unknown as AsyncIterable<SDKMessage>;
  };
}

/** Internal access for the lifecycle assertions (abort handle, consuming, updatedAt). */
interface RawSession {
  abort: AbortController;
  consuming: boolean;
  generation: number;
  stopped: boolean;
  updatedAt: number;
  tree: SessionTree;
}

function raw(sdk: SdkSessions, id: string): RawSession {
  const map = (sdk as unknown as { sessions: Map<string, RawSession> }).sessions;
  expect(map.get(id)).toBeDefined();
  return map.get(id)!;
}

describe('SdkSessions', () => {
  it('surfaces permission requests and resolves them', async () => {
    const events: ServerEvent[] = [];
    const state: FakeState = {};
    const sdk = new SdkSessions(e => events.push(e), makeFakeQuery(state));

    const id = sdk.start({ prompt: 'review the fleet server', cwd: homeDir, agent: 'reviewer' });
    expect(id).toBeTruthy();
    expect(sdk.owns(id)).toBe(true);
    expect(state.options?.sessionId).toBe(id);

    // The permission prompt is emitted and tracked as pending.
    await vi.waitFor(() => {
      expect(events.some(e => e.type === 'permission.request')).toBe(true);
    });
    const request = (events.find(e => e.type === 'permission.request')! as { request: { id: string; sessionId: string; tool: string; toolUseId?: string; input: unknown } }).request;
    expect(request.sessionId).toBe(id);
    expect(request.tool).toBe('Bash');
    expect(request.toolUseId).toBe('t1');
    expect(request.input).toEqual({ command: 'ls' });
    expect(sdk.get(id)?.permissions.map(p => p.id)).toContain(request.id);
    expect(sdk.list()[0]?.pendingPermissions).toBe(1);

    // Deciding allow resolves the fake's canUseTool promise with behavior 'allow'.
    expect(sdk.decide(request.id, { allow: true })).toBe(true);
    await vi.waitFor(() => {
      expect(state.decision?.behavior).toBe('allow');
    });
    expect(events.some(e => e.type === 'permission.resolved' && e.id === request.id && e.allow)).toBe(true);
    await vi.waitFor(() => {
      expect(sdk.get(id)?.permissions).toHaveLength(0);
    });

    // The fake iterator ends cleanly, so the root finishes as done.
    await vi.waitFor(() => {
      expect(sdk.get(id)?.status).toBe('done');
    });

    const summary = sdk.list()[0]!;
    expect(summary.id).toBe(id);
    expect(summary.source).toBe('page');
    expect(summary.cwd).toBe(homeDir);
    expect(summary.project).toBe(homeDir.split('/').pop());
    expect(summary.title).toBe('review the fleet server');
    expect(summary.status).toBe('done');
    expect(summary.agent).toBe('reviewer');
    expect(summary.nodeCount).toBe(1);
    expect(summary.pendingPermissions).toBe(0);
    expect(typeof summary.startedAt).toBe('number');
    expect(typeof summary.updatedAt).toBe('number');
    expect(typeof summary.costUsd).toBe('number');
  });

  it('stop() denies pending permissions and marks the session stopped', async () => {
    const events: ServerEvent[] = [];
    const state: FakeState = {};
    const sdk = new SdkSessions(e => events.push(e), makeFakeQuery(state));
    const id = sdk.start({ prompt: 'stop me', cwd: homeDir });

    await vi.waitFor(() => {
      expect(events.some(e => e.type === 'permission.request')).toBe(true);
    });
    expect(sdk.stop(id)).toBe(true);
    expect(sdk.stop(id)).toBe(true); // idempotent

    await vi.waitFor(() => {
      expect(state.decision?.behavior).toBe('deny');
    });
    expect(events.some(e => e.type === 'permission.resolved' && e.allow === false)).toBe(true);
    expect(sdk.get(id)?.status).toBe('stopped');
    expect(sdk.get(id)?.permissions).toHaveLength(0);
  });

  it('rejects unknown session and permission ids', () => {
    const sdk = new SdkSessions(() => {});
    expect(sdk.owns('nope')).toBe(false);
    expect(sdk.get('nope')).toBeUndefined();
    expect(sdk.stop('nope')).toBe(false);
    expect(sdk.send('nope', 'hi')).toBe(false);
    expect(sdk.interrupt('nope')).toBe(false);
    expect(sdk.decide('missing-permission', { allow: true })).toBe(false);
  });

  it('matches the documented agent regex', () => {
    expect('lead-dev-hybrid').toMatch(AGENT_RE);
    expect('agy-task').toMatch(AGENT_RE);
    expect('../evil').not.toMatch(AGENT_RE);
    expect('-leading-dash').not.toMatch(AGENT_RE);
    expect('a'.repeat(65)).not.toMatch(AGENT_RE);
  });

  describe('lifecycle', () => {
    it('send()/interrupt() after the query ended answer with a 409 SessionError', async () => {
      const optionsSeen: (Record<string, unknown> | undefined)[] = [];
      const sdk = new SdkSessions(() => {}, makeRecordingQuery(optionsSeen));
      const id = sdk.start({ prompt: 'short turn', cwd: homeDir });
      await vi.waitFor(() => {
        expect(sdk.get(id)?.status).toBe('done');
      });
      try {
        sdk.send(id, 'one more message');
        expect.unreachable('send should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(SessionError);
        expect((err as SessionError).status).toBe(409);
        expect((err as SessionError).message).toContain('use Continue');
      }
      try {
        sdk.interrupt(id);
        expect.unreachable('interrupt should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(SessionError);
        expect((err as SessionError).status).toBe(409);
      }
    });

    it('stop -> resume -> stop aborts the second controller', async () => {
      const optionsSeen: (Record<string, unknown> | undefined)[] = [];
      const sdk = new SdkSessions(() => {}, makeRecordingQuery(optionsSeen));
      const id = sdk.start({ prompt: 'first turn', cwd: homeDir });
      await vi.waitFor(() => {
        expect(sdk.get(id)?.status).toBe('done');
      });

      const resumed = await sdk.resume(id, { text: 'second turn' }, { cwd: homeDir });
      expect(resumed).toBe(id);
      await vi.waitFor(() => {
        expect(sdk.get(id)?.status).toBe('done');
      });
      const session = raw(sdk, id);
      expect(session.generation).toBe(2);
      expect(session.stopped).toBe(false);

      expect(sdk.stop(id)).toBe(true);
      expect(session.abort.signal.aborted).toBe(true);
    });

    it('resumes a page session right after stop (the 60 s freshness 409 is terminal-only)', async () => {
      const optionsSeen: (Record<string, unknown> | undefined)[] = [];
      const sdk = new SdkSessions(() => {}, makeRecordingQuery(optionsSeen));
      const id = sdk.start({ prompt: 'long first turn', cwd: homeDir });
      await vi.waitFor(() => {
        expect(raw(sdk, id).generation).toBe(1);
      });
      expect(sdk.stop(id)).toBe(true);
      await expect(sdk.resume(id, { text: 'continue now' }, { cwd: homeDir })).resolves.toBe(id);
      expect(raw(sdk, id).stopped).toBe(false);
      expect(optionsSeen.at(-1)?.resume).toBe(id);
    });

    it('denies a canUseTool call from a stale generation ("Session restarted")', async () => {
      const spied: Array<NonNullable<Options['canUseTool']>> = [];
      const sdk = new SdkSessions(() => {}, params => {
        spied.push(params.options!.canUseTool!);
        return (async function* generator(): AsyncGenerator<any, void> {
          yield { type: 'system', subtype: 'init', model: 'claude-opus-5-5' };
          yield { type: 'result', subtype: 'success' };
        })() as unknown as AsyncIterable<SDKMessage>;
      });
      const id = sdk.start({ prompt: 'turn one', cwd: homeDir });
      await vi.waitFor(() => {
        expect(sdk.get(id)?.status).toBe('done');
      });
      // Resume starts a new generation; the captured first-generation canUseTool is stale now.
      await sdk.resume(id, { text: 'turn two' }, { cwd: homeDir });
      expect(raw(sdk, id).generation).toBe(2);
      await vi.waitFor(() => {
        expect(sdk.get(id)?.status).toBe('done');
      });
      const decision = await spied[0]!(
        'Bash',
        { command: 'ls' },
        { signal: new AbortController().signal, toolUseID: 't2', requestId: 'req-t2' },
      );
      expect(decision).toEqual({ behavior: 'deny', message: 'Session restarted' });
    });

    it('resume on an idle+consuming session routes the text into the live process (no new query)', async () => {
      const events: ServerEvent[] = [];
      let queries = 0;
      const received: string[] = [];
      const sdk = new SdkSessions(e => events.push(e), params => {
        queries += 1;
        const iterator = params.prompt as AsyncIterable<{ message: { content: string } }>;
        return (async function* generator(): AsyncGenerator<any, void> {
          for await (const m of iterator) {
            received.push(typeof m.message.content === 'string' ? m.message.content : '');
            yield { type: 'result', subtype: 'success' };
          }
        })() as unknown as AsyncIterable<SDKMessage>;
      });
      const id = sdk.start({ prompt: 'hello there', cwd: homeDir });
      await vi.waitFor(() => {
        expect(received).toContain('hello there');
      });
      // Emulate the turn-ended state the real reducer produces (the mock yields no status events here).
      expect(raw(sdk, id).consuming).toBe(true);
      raw(sdk, id).tree.nodes.get('root')!.status = 'idle';

      const resumed = await sdk.resume(id, { text: 'question two' }, { cwd: homeDir });
      expect(resumed).toBe(id);
      expect(queries).toBe(1); // still the same live process
      await vi.waitFor(() => {
        expect(received).toContain('question two');
      });
    });

    it('resumes of an active (running/waiting) consuming session stay at 409', async () => {
      const events: ServerEvent[] = [];
      const state: FakeState = {};
      const sdk = new SdkSessions(e => events.push(e), makeFakeQuery(state));
      const id = sdk.start({ prompt: 'busy', cwd: homeDir });
      await vi.waitFor(() => {
        expect(events.some(e => e.type === 'permission.request')).toBe(true);
      });
      await expect(sdk.resume(id, { text: 'nope' }, { cwd: homeDir })).rejects.toMatchObject({
        status: 409,
      });
    });

    it('validates the resume cwd with the start-path contract (existence, directory, under $HOME)', async () => {
      const sdk = new SdkSessions(() => {}, makeRecordingQuery([]));
      const badPaths = [
        '/definitely/not/a/dir', // does not exist
        '/dev/null', // not a directory (if it exists; skip on strange systems)
        '/tmp', // outside $HOME
      ];
      for (const cwd of badPaths) {
        try {
          await sdk.resume('missing', { text: 'x' }, { cwd });
          // /tmp check may be valid on machines where /tmp == $HOME (unlikely); only assert for the clearly invalid ones.
        } catch (err) {
          expect(err).toBeInstanceOf(SessionError);
          expect((err as SessionError).status).toBe(400);
        }
      }
    });

    describe('with a live heartbeat holder (CLAUDE_CONFIG_DIR injected)', () => {
      const base = mkdtempSync(path.join(homedir(), 'fleet-live-resume-test-'));
      const sessionsDir = path.join(base, 'sessions');
      mkdirSync(sessionsDir);

      afterAll(() => rmSync(base, { recursive: true, force: true }));

      /** Points liveHolder at the temp sessions dir for the duration of fn. */
      const withConfigDir = async (fn: () => Promise<void>): Promise<void> => {
        const prev = process.env.CLAUDE_CONFIG_DIR;
        process.env.CLAUDE_CONFIG_DIR = base;
        try {
          await fn();
        } finally {
          if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
          else process.env.CLAUDE_CONFIG_DIR = prev;
        }
      };

      const writeHolder = (sessionId: string, entrypoint: string): void =>
        writeFileSync(
          path.join(sessionsDir, `${process.pid}.json`),
          JSON.stringify({
            pid: process.pid, // alive, so the default probe reports it as a holder
            sessionId,
            cwd: homeDir,
            kind: 'interactive',
            entrypoint,
            status: 'busy',
          }),
        );

      it('refuses a terminal session with a live holder (409, names the pid)', async () => {
        await withConfigDir(async () => {
          writeHolder('term-held', 'cli');
          const sdk = new SdkSessions(() => {}, makeRecordingQuery([]));
          try {
            await sdk.resume('term-held', { text: 'once more' }, { cwd: homeDir });
            expect.unreachable('resume should have thrown');
          } catch (err) {
            expect(err).toBeInstanceOf(SessionError);
            expect((err as SessionError).status).toBe(409);
            expect((err as SessionError).message)
              .toBe(`This session is open in another Claude Code process (pid ${process.pid}). Exit it there first, or continue it there.`);
          }
          rmSync(path.join(sessionsDir, `${process.pid}.json`));
        });
      });

      it('refuses a restart of an ended page session held by a non-dashboard process, allows sdk-ts', async () => {
        await withConfigDir(async () => {
          const optionsSeen: (Record<string, unknown> | undefined)[] = [];
          const sdk = new SdkSessions(() => {}, makeRecordingQuery(optionsSeen));
          const id = sdk.start({ prompt: 'leftover check', cwd: homeDir });
          await vi.waitFor(() => {
            expect(sdk.get(id)?.status).toBe('done');
          });
          sdk.stop(id);

          writeHolder(id, 'cli');
          await expect(sdk.resume(id, { text: 'fork me' }, { cwd: homeDir })).rejects.toMatchObject({
            status: 409,
          });

          // A dashboard-spawned holder (our own SDK process) does not block the restart.
          writeHolder(id, 'sdk-ts');
          await expect(sdk.resume(id, { text: 'ours' }, { cwd: homeDir })).resolves.toBe(id);
          await vi.waitFor(() => {
            expect(sdk.get(id)?.status).toBe('done');
          });
          expect(optionsSeen.at(-1)?.resume).toBe(id);
          rmSync(path.join(sessionsDir, `${process.pid}.json`));
        });
      });
    });
  });

  describe('eviction', () => {
    it('removes long-finished sessions and emits session.removed', async () => {
      const events: ServerEvent[] = [];
      const optionsSeen: (Record<string, unknown> | undefined)[] = [];
      const sdk = new SdkSessions(e => events.push(e), makeRecordingQuery(optionsSeen));
      const id = sdk.start({ prompt: 'doomed', cwd: homeDir });
      await vi.waitFor(() => {
        expect(sdk.get(id)?.status).toBe('done');
      });
      // Freshly finished: nothing to evict yet.
      sdk.evict();
      expect(sdk.owns(id)).toBe(true);

      raw(sdk, id).updatedAt = Date.now() - EVICT_AFTER_MS - 1_000;
      sdk.evict();
      expect(sdk.owns(id)).toBe(false);
      expect(events.some(e => e.type === 'session.removed' && e.sessionId === id)).toBe(true);
    });

    it('keeps at most 50 page sessions, evicting the oldest finished first', async () => {
      const optionsSeen: (Record<string, unknown> | undefined)[] = [];
      const sdk = new SdkSessions(() => {}, makeRecordingQuery(optionsSeen));
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) ids.push(sdk.start({ prompt: `session ${i}`, cwd: homeDir }));
      await vi.waitFor(() => {
        expect(ids.every(id => sdk.get(id)?.status === 'done')).toBe(true);
      });
      const now = Date.now();
      raw(sdk, ids[0]!).updatedAt = now - 5_000;
      raw(sdk, ids[1]!).updatedAt = now - 4_000;
      raw(sdk, ids[2]!).updatedAt = now - 3_000;
      // The map has 3 finished sessions; a cap of 2 evicts only the oldest.
      sdk.evict(Date.now(), EVICT_AFTER_MS, 2);
      expect(sdk.owns(ids[0]!)).toBe(false);
      expect(sdk.owns(ids[1]!)).toBe(true);
      expect(sdk.owns(ids[2]!)).toBe(true);
    });

    it('never evicts running or consuming sessions', async () => {
      const events: ServerEvent[] = [];
      const state: FakeState = {};
      const sdk = new SdkSessions(e => events.push(e), makeFakeQuery(state));
      const id = sdk.start({ prompt: 'still busy', cwd: homeDir });
      await vi.waitFor(() => {
        expect(events.some(e => e.type === 'permission.request')).toBe(true);
      });
      const session = raw(sdk, id);
      expect(session.consuming).toBe(true);
      session.updatedAt = 5; // very old, but the session is live
      sdk.evict();
      expect(sdk.owns(id)).toBe(true);
      sdk.stop(id);
    });
  });

  describe('resume (terminal adoption)', () => {
    it('adopts an ended terminal session: same id, rebuilt tree, page-owned', async () => {
      const optionsSeen: (Record<string, unknown> | undefined)[] = [];
      const events: ServerEvent[] = [];
      const sdk = new SdkSessions(e => events.push(e), makeRecordingQuery(optionsSeen));

      const priorChild: AgentNode = {
        id: 'toolu_old1',
        sessionId: 'term-1',
        parentId: 'root',
        kind: 'subagent',
        agentType: 'tester',
        status: 'done',
        startedAt: 1,
        costUsd: 0,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        toolCounts: {},
        events: [{ id: 'e1', ts: 2, kind: 'tool_use', tool: 'Bash', toolUseId: 'toolu_old1bash', summary: 'ran something' }],
      };
      const priorRoot: AgentNode = {
        id: 'root',
        sessionId: 'term-1',
        parentId: null,
        kind: 'main',
        agentType: 'main',
        prompt: 'Old session title',
        description: 'Old session title',
        status: 'done',
        startedAt: 1,
        endedAt: 3,
        costUsd: 0,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        toolCounts: {},
        events: [],
      };
      const id = await sdk.resume('term-1', { text: 'continue here' }, {
        cwd: homeDir,
        nodes: [priorRoot, priorChild],
        title: 'Old session title',
      });
      expect(id).toBe('term-1');
      expect(sdk.owns('term-1')).toBe(true);
      expect(optionsSeen.at(-1)!.resume).toBe('term-1');
      expect(optionsSeen.at(-1)!.sessionId).toBeUndefined();

      const detail = sdk.get('term-1')!;
      expect(detail.source).toBe('page');
      expect(detail.title).toBe('Old session title');
      expect(detail.nodes.map(n => n.id)).toEqual(['root', 'toolu_old1']);
      expect(detail.nodes.find(n => n.id === 'root')!.status).toBe('running');
      // The prior node is back, with its events and the rebuilt tool ownership.
      expect(detail.nodes.find(n => n.id === 'toolu_old1')!.events).toHaveLength(1);
      expect(detail.nodes.find(n => n.id === 'toolu_old1')!.sessionId).toBe('term-1');
      // The resumed session ran to done (the fake query ends immediately).
      await vi.waitFor(() => {
        expect(sdk.get('term-1')?.status).toBe('done');
      });
    });

    it('refuses terminal transcripts modified within the last minute (but not page-owned ids)', async () => {
      const optionsSeen: (Record<string, unknown> | undefined)[] = [];
      const sdk = new SdkSessions(() => {}, makeRecordingQuery(optionsSeen));
      const info: ResumeInfo = { cwd: homeDir, transcriptMtimeMs: Date.now() - 1_000 };
      try {
        await sdk.resume('term-live', { text: 'again' }, info);
        expect.unreachable('resume should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(SessionError);
        expect((err as SessionError).status).toBe(409);
        expect((err as SessionError).message).toBe('This session is still active in a terminal');
      }
      // The same mtime for a page-owned id does not count as "still live in a terminal".
      const pageId = sdk.start({ prompt: 'page owned', cwd: homeDir });
      await vi.waitFor(() => {
        expect(sdk.get(pageId)?.status).toBe('done');
      });
      sdk.stop(pageId);
      await expect(
        sdk.resume(pageId, { text: 'continue' }, { cwd: homeDir, transcriptMtimeMs: Date.now() - 1_000 }),
      ).resolves.toBe(pageId);
    });

    it('validates resume input: empty/oversized text and bad models are 400', async () => {
      const sdk = new SdkSessions(() => {}, makeRecordingQuery([]));
      for (const bad of [{ text: '' }, { text: 'x'.repeat(100_001) }, { text: 'ok', model: 'opencode-go/glm-5.3-flash' }]) {
        await expect(sdk.resume('term-1', bad, { cwd: homeDir })).rejects.toMatchObject({ status: 400 });
      }
    });

    it('survives a fileInfo lookup for a page session', () => {
      const sdk = new SdkSessions(() => {}, makeRecordingQuery([]));
      const id = sdk.start({ prompt: 'cwd source', cwd: homeDir });
      expect(sdk.fileInfo(id)).toEqual({ cwd: homeDir });
      expect(sdk.fileInfo('nope')).toBeUndefined();
    });
  });

  describe('effort', () => {
    it('validEffort accepts the five levels and passes undefined/null through', () => {
      for (const level of ['low', 'medium', 'high', 'xhigh', 'max'] as const) {
        expect(validEffort(level)).toBe(level);
      }
      expect(validEffort(undefined)).toBeUndefined();
      expect(validEffort(null)).toBeUndefined();
    });

    it('validEffort rejects anything else with the documented message', () => {
      for (const bad of ['', 'HIGH', 'ultra', 42, {}, []]) {
        try {
          validEffort(bad);
          expect.unreachable(`validEffort should have thrown for ${JSON.stringify(bad)}`);
        } catch (err) {
          expect(err).toBeInstanceOf(ValidationError);
          expect((err as Error).message).toBe('effort must be one of low, medium, high, xhigh, max');
        }
      }
    });

    it('start passes effort into the SDK options when given, omits it otherwise', async () => {
      const optionsSeen: (Record<string, unknown> | undefined)[] = [];
      const sdk = new SdkSessions(() => {}, makeRecordingQuery(optionsSeen));
      const id = sdk.start({ prompt: 'effortful', cwd: homeDir, effort: 'high' });
      await vi.waitFor(() => {
        expect(sdk.get(id)?.status).toBe('done');
      });
      expect(optionsSeen.at(0)?.effort).toBe('high');

      const optionsSeen2: (Record<string, unknown> | undefined)[] = [];
      const sdk2 = new SdkSessions(() => {}, makeRecordingQuery(optionsSeen2));
      const id2 = sdk2.start({ prompt: 'default effort', cwd: homeDir });
      await vi.waitFor(() => {
        expect(sdk2.get(id2)?.status).toBe('done');
      });
      expect(optionsSeen2.at(0)).not.toHaveProperty('effort');
    });

    it('resume uses the new effort if given, else the stored one', async () => {
      const optionsSeen: (Record<string, unknown> | undefined)[] = [];
      const sdk = new SdkSessions(() => {}, makeRecordingQuery(optionsSeen));
      const id = sdk.start({ prompt: 'first', cwd: homeDir, effort: 'high' });
      await vi.waitFor(() => {
        expect(sdk.get(id)?.status).toBe('done');
      });
      sdk.stop(id);

      await sdk.resume(id, { text: 'again' }, { cwd: homeDir });
      await vi.waitFor(() => {
        expect(sdk.get(id)?.status).toBe('done');
      });
      expect(optionsSeen.at(-1)?.effort).toBe('high');
      sdk.stop(id);

      await sdk.resume(id, { text: 'harder', effort: 'max' }, { cwd: homeDir });
      await vi.waitFor(() => {
        expect(sdk.get(id)?.status).toBe('done');
      });
      expect(optionsSeen.at(-1)?.effort).toBe('max');
      sdk.stop(id);

      // The new effort stuck: a later resume without one reuses 'max'.
      await sdk.resume(id, { text: 'still hard' }, { cwd: homeDir });
      await vi.waitFor(() => {
        expect(sdk.get(id)?.status).toBe('done');
      });
      expect(optionsSeen.at(-1)?.effort).toBe('max');
    });

    it('validates resume effort: bad levels are 400', async () => {
      const sdk = new SdkSessions(() => {}, makeRecordingQuery([]));
      await expect(
        sdk.resume('term-1', { text: 'ok', effort: 'ultra' as never }, { cwd: homeDir }),
      ).rejects.toMatchObject({ status: 400 });
    });
  });
});

