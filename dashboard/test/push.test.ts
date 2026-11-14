// Push store persistence/eviction and push notifier event-to-notification rules.
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createPushNotifier,
  createPushStore,
  MAX_TEXT,
  pushFilePath,
  type PushPayload,
  type PushStore,
  type Sender,
  type StoredSubscription,
} from '../server/push.ts';
import type { PushTarget, SendOptions, VapidKeys } from '../server/webpush.ts';
import type { PermissionRequest, PushEvents, PushSendResult, SessionSummary, WorkerTask } from '../src/shared/types.ts';

const TEST_KEYS: VapidKeys = { publicKey: 'pub-key-test', privateKey: 'priv-key-test' };

function allEvents(overrides: Partial<PushEvents> = {}): PushEvents {
  return {
    waiting: true,
    finished: true,
    error: true,
    workers: true,
    ...overrides,
  };
}

function makeSub(
  endpoint: string,
  overrides: Partial<StoredSubscription> = {},
): StoredSubscription {
  return {
    endpoint,
    keys: { p256dh: 'p256dh-key', auth: 'auth-key' },
    events: allEvents(),
    label: 'Test Device',
    createdAt: 1_000,
    ...overrides,
  };
}

function makeSession(
  overrides: Partial<SessionSummary> & Pick<SessionSummary, 'id' | 'status'>,
): SessionSummary {
  return {
    source: 'page',
    project: 'proj',
    cwd: '/tmp/proj',
    title: 'Fix bug',
    startedAt: 1_000,
    updatedAt: 1_000,
    costUsd: 0,
    nodeCount: 1,
    pendingPermissions: 0,
    resumable: false,
    ...overrides,
  };
}

function makeWorker(
  overrides: Partial<WorkerTask> & Pick<WorkerTask, 'slug' | 'state'>,
): WorkerTask {
  return {
    lane: 'opencode',
    repo: 'repo-1',
    startedAt: 1_000,
    elapsedS: 10,
    denied: 0,
    toolCounts: {},
    ...overrides,
  };
}

function makePermission(
  overrides: Partial<PermissionRequest> & Pick<PermissionRequest, 'id' | 'sessionId'>,
): PermissionRequest {
  return {
    nodeId: 'root',
    tool: 'Bash',
    input: {},
    createdAt: 1_000,
    ...overrides,
  };
}

function makeFakeStore(initial: StoredSubscription[] = [], keys: VapidKeys = TEST_KEYS): PushStore {
  const subs = new Map<string, StoredSubscription>(initial.map(s => [s.endpoint, { ...s }]));
  return {
    async keys() {
      return { ...keys };
    },
    async list() {
      return [...subs.values()].map(s => ({ ...s, keys: { ...s.keys }, events: { ...s.events } }));
    },
    async get(endpoint) {
      const s = subs.get(endpoint);
      return s ? { ...s, keys: { ...s.keys }, events: { ...s.events } } : undefined;
    },
    async upsert(sub) {
      const existing = subs.get(sub.endpoint);
      subs.set(sub.endpoint, {
        ...sub,
        keys: { ...sub.keys },
        events: { ...sub.events },
        createdAt: existing ? existing.createdAt : sub.createdAt,
      });
    },
    async remove(endpoint) {
      return subs.delete(endpoint);
    },
  };
}

interface RecordedSend {
  target: PushTarget;
  payload: PushPayload;
  keys: VapidKeys;
  opts: SendOptions;
}

function makeRecorder(resultFor?: (endpoint: string) => PushSendResult): {
  calls: RecordedSend[];
  send: Sender;
} {
  const calls: RecordedSend[] = [];
  const send: Sender = async (target, payload, keys, opts) => {
    calls.push({ target, payload: JSON.parse(payload) as PushPayload, keys, opts });
    return { result: resultFor ? resultFor(target.endpoint) : 'ok' };
  };
  return { calls, send };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await Promise.resolve();
  }
}

describe('pushFilePath', () => {
  let previousXdg: string | undefined;

  beforeEach(() => {
    previousXdg = process.env.XDG_CONFIG_HOME;
  });

  afterEach(() => {
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdg;
  });

  it('resolves under $XDG_CONFIG_HOME when set and falls back to ~/.config', () => {
    process.env.XDG_CONFIG_HOME = '/tmp/custom-xdg';
    expect(pushFilePath()).toBe(path.join('/tmp/custom-xdg', 'swarmkit', 'push.json'));

    delete process.env.XDG_CONFIG_HOME;
    expect(pushFilePath()).toBe(path.join(homedir(), '.config', 'swarmkit', 'push.json'));
  });
});

describe('createPushStore', () => {
  let tmpDir: string;
  let previousXdg: string | undefined;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), 'fleet-push-store-'));
    previousXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = tmpDir;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdg;
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('generates and persists VAPID keys with 0o600 file mode and 0o700 dir mode', async () => {
    const file = pushFilePath();
    const generate = vi.fn(() => TEST_KEYS);
    const store = createPushStore(file, generate);

    expect(await store.keys()).toEqual(TEST_KEYS);
    expect(await store.keys()).toEqual(TEST_KEYS);
    expect(generate).toHaveBeenCalledTimes(1);

    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(file))).mode & 0o777).toBe(0o700);
    const entries = await readdir(path.dirname(file));
    expect(entries.filter(f => f.endsWith('.tmp'))).toEqual([]);

    // A fresh store reads the persisted keys without invoking the generator again.
    const generate2 = vi.fn(() => ({ publicKey: 'other', privateKey: 'other' }));
    const reloaded = createPushStore(file, generate2);
    expect(await reloaded.keys()).toEqual(TEST_KEYS);
    expect(generate2).not.toHaveBeenCalled();
  });

  it('treats missing or corrupt storage as empty and logs corrupt once', async () => {
    const file = path.join(tmpDir, 'missing.json');
    const missingStore = createPushStore(file, () => TEST_KEYS);
    expect(await missingStore.list()).toEqual([]);

    const corruptFile = path.join(tmpDir, 'corrupt.json');
    await writeFile(corruptFile, 'not valid json{{{');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const corruptStore = createPushStore(corruptFile, () => TEST_KEYS);

    expect(await corruptStore.list()).toEqual([]);
    expect(await corruptStore.list()).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('upserts by endpoint preserving createdAt, removes, and persists across instances', async () => {
    const file = path.join(tmpDir, 'subs.json');
    const store = createPushStore(file, () => TEST_KEYS);

    await store.upsert(makeSub('https://push.example/1', { label: 'First', createdAt: 5_000 }));
    await store.upsert(
      makeSub('https://push.example/1', {
        label: 'Updated',
        events: allEvents({ finished: false }),
        createdAt: 99_999,
      }),
    );

    const got = await store.get('https://push.example/1');
    expect(got?.label).toBe('Updated');
    expect(got?.events.finished).toBe(false);
    expect(got?.createdAt).toBe(5_000);

    const reloaded = createPushStore(file, () => TEST_KEYS);
    expect(await reloaded.list()).toHaveLength(1);
    expect(await reloaded.remove('https://push.example/missing')).toBe(false);
    expect(await reloaded.remove('https://push.example/1')).toBe(true);
    expect(await reloaded.list()).toEqual([]);

    const raw = JSON.parse(await readFile(file, 'utf8')) as { subscriptions: StoredSubscription[] };
    expect(raw.subscriptions).toEqual([]);
  });

  it('evicts the subscription with the oldest createdAt when inserting a 21st', async () => {
    const file = path.join(tmpDir, 'cap.json');
    const store = createPushStore(file, () => TEST_KEYS);

    for (let i = 0; i < 20; i++) {
      // Put the oldest createdAt in the middle (index 7) to ensure eviction is by createdAt, not FIFO.
      const createdAt = i === 7 ? 10 : 1_000 + i;
      await store.upsert(makeSub(`https://push.example/${i}`, { createdAt }));
    }
    await store.upsert(makeSub('https://push.example/20', { createdAt: 2_000 }));

    const list = await store.list();
    expect(list).toHaveLength(20);
    expect(list.some(s => s.endpoint === 'https://push.example/7')).toBe(false);
    expect(list.some(s => s.endpoint === 'https://push.example/20')).toBe(true);
  });

  it('serialises concurrent upserts without losing entries', async () => {
    const file = path.join(tmpDir, 'concurrent.json');
    const store = createPushStore(file, () => TEST_KEYS);

    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        store.upsert(makeSub(`https://push.example/c-${i}`, { createdAt: 100 + i })),
      ),
    );

    expect(await store.list()).toHaveLength(10);
  });
});

describe('createPushNotifier', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('never notifies on first sight and baseline suppresses initial state', async () => {
    let clock = 100_000;
    const store = makeFakeStore([makeSub('https://push.example/1')]);
    const rec = makeRecorder();
    const notifier = createPushNotifier({
      store,
      send: rec.send,
      subject: 'mailto:test@example.com',
      now: () => clock,
      warmupMs: 0,
    });

    notifier.observe({ type: 'session.upsert', session: makeSession({ id: 's1', status: 'done' }) });
    notifier.observe({ type: 'session.upsert', session: makeSession({ id: 's2', status: 'error' }) });
    notifier.observe({ type: 'session.upsert', session: makeSession({ id: 's3', status: 'waiting' }) });
    await flush();
    expect(rec.calls).toHaveLength(0);

    notifier.baseline(
      [makeSession({ id: 's4', status: 'running' })],
      [makeWorker({ slug: 'w1', state: 'running' })],
    );
    await flush();
    expect(rec.calls).toHaveLength(0);

    // Transition from baselined running -> done notifies.
    notifier.observe({ type: 'session.upsert', session: makeSession({ id: 's4', status: 'done' }) });
    await flush();
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]?.payload.title).toBe('Finished');
  });

  it('suppresses notifications during warm-up while still updating state', async () => {
    let clock = 1_000;
    const store = makeFakeStore([makeSub('https://push.example/1')]);
    const rec = makeRecorder();
    const notifier = createPushNotifier({
      store,
      send: rec.send,
      subject: 'mailto:test@example.com',
      now: () => clock,
    });

    notifier.observe({ type: 'session.upsert', session: makeSession({ id: 's1', status: 'running' }) });
    clock = 45_999; // 44_999 ms elapsed: still in default 45_000 ms warm-up
    notifier.observe({ type: 'session.upsert', session: makeSession({ id: 's1', status: 'idle' }) });
    await flush();
    expect(rec.calls).toHaveLength(0);

    // State was updated to idle during warm-up, so going running -> done after warm-up notifies once.
    clock = 46_000;
    notifier.observe({ type: 'session.upsert', session: makeSession({ id: 's1', status: 'running' }) });
    notifier.observe({ type: 'session.upsert', session: makeSession({ id: 's1', status: 'done' }) });
    await flush();
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]?.payload.title).toBe('Finished');
  });

  it('notifies finished on running->idle and waiting->done, and error on ->error', async () => {
    const store = makeFakeStore([makeSub('https://push.example/1')]);
    const rec = makeRecorder();
    const notifier = createPushNotifier({
      store,
      send: rec.send,
      subject: 'mailto:test@example.com',
      now: () => 10_000,
      warmupMs: 0,
    });

    notifier.baseline(
      [
        makeSession({ id: 's/1', status: 'running', project: 'app', title: 'Task A' }),
        makeSession({ id: 's2', status: 'waiting', project: 'api', title: 'Task B' }),
        makeSession({ id: 's3', status: 'running', project: 'web', title: 'Task C' }),
        makeSession({ id: 's4', status: 'idle', project: 'cli', title: 'Task D' }),
      ],
      [],
    );

    notifier.observe({
      type: 'session.upsert',
      session: makeSession({ id: 's/1', status: 'idle', project: 'app', title: 'Task A' }),
    });
    notifier.observe({
      type: 'session.upsert',
      session: makeSession({ id: 's2', status: 'done', project: 'api', title: 'Task B' }),
    });
    notifier.observe({
      type: 'session.upsert',
      session: makeSession({ id: 's3', status: 'error', project: 'web', title: 'Task C' }),
    });
    // idle -> done should not notify
    notifier.observe({
      type: 'session.upsert',
      session: makeSession({ id: 's4', status: 'done', project: 'cli', title: 'Task D' }),
    });
    await flush();

    expect(rec.calls).toHaveLength(3);
    expect(rec.calls[0]?.payload).toEqual({
      title: 'Finished',
      body: 'app: Task A',
      tag: 's/1',
      url: '/?session=s%2F1',
    });
    expect(rec.calls[0]?.opts).toEqual({
      subject: 'mailto:test@example.com',
      urgency: 'high',
      ttl: 3600,
    });
    expect(rec.calls[1]?.payload).toEqual({
      title: 'Finished',
      body: 'api: Task B',
      tag: 's2',
      url: '/?session=s2',
    });
    expect(rec.calls[2]?.payload).toEqual({
      title: 'Error',
      body: 'web: Task C',
      tag: 's3',
      url: '/?session=s3',
    });
  });

  it('deduplicates waiting + permission.request and notifies again after permission.resolved', async () => {
    const store = makeFakeStore([makeSub('https://push.example/1')]);
    const rec = makeRecorder();
    const notifier = createPushNotifier({
      store,
      send: rec.send,
      subject: 'mailto:test@example.com',
      sessionInfo: (id) => (id === 's1' ? { project: 'myproj', title: 'Refactor' } : undefined),
      now: () => 10_000,
      warmupMs: 0,
    });

    notifier.baseline([makeSession({ id: 's1', status: 'running', project: 'myproj', title: 'Refactor' })], []);

    // ->waiting followed by permission.request sends only one Needs you.
    notifier.observe({
      type: 'session.upsert',
      session: makeSession({ id: 's1', status: 'waiting', project: 'myproj', title: 'Refactor' }),
    });
    notifier.observe({
      type: 'permission.request',
      request: makePermission({ id: 'p1', sessionId: 's1', kind: 'question', title: 'Which DB?' }),
    });
    await flush();
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]?.payload).toEqual({
      title: 'Needs you',
      body: 'myproj: Refactor',
      tag: 's1',
      url: '/?session=s1',
    });

    // After permission.resolved, a new permission.request sends again.
    notifier.observe({ type: 'permission.resolved', sessionId: 's1', id: 'p1', allow: true });
    notifier.observe({
      type: 'permission.request',
      request: makePermission({ id: 'p2', sessionId: 's1', kind: 'plan', title: 'Approve plan' }),
    });
    await flush();
    expect(rec.calls).toHaveLength(2);
    expect(rec.calls[1]?.payload).toEqual({
      title: 'Needs you: plan approval',
      body: 'myproj: Refactor',
      tag: 's1',
      url: '/?session=s1',
    });

    // Question kind + unknown sessionInfo falls back to "a session".
    notifier.observe({
      type: 'permission.request',
      request: makePermission({ id: 'p3', sessionId: 's-unknown', kind: 'question', title: 'Pick one' }),
    });
    await flush();
    expect(rec.calls).toHaveLength(3);
    expect(rec.calls[2]?.payload).toEqual({
      title: 'Needs you: question',
      body: 'a session',
      tag: 's-unknown',
      url: '/?session=s-unknown',
    });

    // Leaving waiting via session.upsert clears openWaits so a later permission.request notifies again.
    notifier.observe({
      type: 'session.upsert',
      session: makeSession({ id: 's1', status: 'running', project: 'myproj', title: 'Refactor' }),
    });
    notifier.observe({
      type: 'permission.request',
      request: makePermission({ id: 'p4', sessionId: 's1' }),
    });
    await flush();
    expect(rec.calls).toHaveLength(4);
    expect(rec.calls[3]?.payload.title).toBe('Needs you');
  });

  it('respects per-subscription event toggles and removes gone subscriptions', async () => {
    const store = makeFakeStore([
      makeSub('https://push.example/no-finished', { events: allEvents({ finished: false }) }),
      makeSub('https://push.example/gone', { events: allEvents() }),
      makeSub('https://push.example/keep', { events: allEvents() }),
    ]);
    const rec = makeRecorder(ep => (ep.endsWith('/gone') ? 'gone' : 'ok'));
    const notifier = createPushNotifier({
      store,
      send: rec.send,
      subject: 'mailto:test@example.com',
      now: () => 10_000,
      warmupMs: 0,
    });

    notifier.baseline([makeSession({ id: 's1', status: 'running' })], []);
    notifier.observe({ type: 'session.upsert', session: makeSession({ id: 's1', status: 'done' }) });
    await flush();

    expect(rec.calls.map(c => c.target.endpoint).sort()).toEqual([
      'https://push.example/gone',
      'https://push.example/keep',
    ]);
    expect(await store.get('https://push.example/gone')).toBeUndefined();
    expect(await store.get('https://push.example/keep')).toBeDefined();
    expect(await store.get('https://push.example/no-finished')).toBeDefined();
  });

  it('notifies for worker transitions and recent first-sight completions after warm-up', async () => {
    let clock = 100_000;
    const store = makeFakeStore([makeSub('https://push.example/1')]);
    const rec = makeRecorder();
    const notifier = createPushNotifier({
      store,
      send: rec.send,
      subject: 'mailto:test@example.com',
      now: () => clock,
      warmupMs: 45_000,
    });

    notifier.baseline(
      [],
      [
        makeWorker({ slug: 'w-ok', state: 'running', model: 'glm-5' }),
        makeWorker({ slug: 'w-fail', state: 'running' }),
        makeWorker({ slug: 'w-stop', state: 'running' }),
      ],
    );

    // Advance past warm-up.
    clock += 45_000;

    notifier.observe({
      type: 'workers.update',
      workers: [
        makeWorker({ slug: 'w-ok', state: 'ok', model: 'glm-5' }),
        makeWorker({ slug: 'w-fail', state: 'not-ok' }),
        makeWorker({ slug: 'w-stop', state: 'unfinished' }),
        // First sight ended 10 s ago -> notifies.
        makeWorker({ slug: 'w-fast', state: 'ok', endedAt: clock - 10_000, model: 'opus' }),
        // First sight ended 10 min ago -> does NOT notify.
        makeWorker({ slug: 'w-old', state: 'ok', endedAt: clock - 600_000 }),
      ],
    });
    await flush();

    // w-stop's first 'unfinished' only arms the stopped notice (it may be a worker mid-exit).
    expect(rec.calls).toHaveLength(3);
    notifier.observe({
      type: 'workers.update',
      workers: [makeWorker({ slug: 'w-stop', state: 'unfinished' })],
    });
    await flush();
    expect(rec.calls).toHaveLength(4);
    expect(rec.calls[0]?.payload).toEqual({
      title: 'Worker ok',
      body: 'opencode/w-ok · glm-5',
      tag: 'worker:opencode/repo-1/w-ok',
      url: '/?workers=1',
    });
    expect(rec.calls[1]?.payload.title).toBe('Worker NOT ok');
    expect(rec.calls[1]?.payload.body).toBe('opencode/w-fail');
    expect(rec.calls[2]?.payload).toEqual({
      title: 'Worker ok',
      body: 'opencode/w-fast · opus',
      tag: 'worker:opencode/repo-1/w-fast',
      url: '/?workers=1',
    });
    expect(rec.calls[3]?.payload.title).toBe('Worker stopped');
  });

  it('caps notifications at 30 per rolling 60 s across multiple subscriptions', async () => {
    let clock = 100_000;
    const store = makeFakeStore([
      makeSub('https://push.example/1'),
      makeSub('https://push.example/2'),
    ]);
    const rec = makeRecorder();
    const notifier = createPushNotifier({
      store,
      send: rec.send,
      subject: 'mailto:test@example.com',
      now: () => clock,
      warmupMs: 0,
    });

    const sessions = Array.from({ length: 35 }, (_, i) => makeSession({ id: `s-${i}`, status: 'running' }));
    notifier.baseline(sessions, []);

    for (let i = 0; i < 32; i++) {
      notifier.observe({ type: 'session.upsert', session: makeSession({ id: `s-${i}`, status: 'done' }) });
    }
    await flush();
    // 30 notifications * 2 subscriptions = 60 send calls; 31st & 32nd dropped.
    expect(rec.calls).toHaveLength(60);

    // Advance 60 s: window rolls over and notifications resume.
    clock += 60_000;
    notifier.observe({ type: 'session.upsert', session: makeSession({ id: 's-32', status: 'done' }) });
    await flush();
    expect(rec.calls).toHaveLength(62);
  });

  it('truncates title and body to MAX_TEXT (120) chars with trailing ellipsis', async () => {
    const store = makeFakeStore([makeSub('https://push.example/1')]);
    const rec = makeRecorder();
    const notifier = createPushNotifier({
      store,
      send: rec.send,
      subject: 'mailto:test@example.com',
      sessionInfo: () => ({ project: 'proj', title: 'A'.repeat(200) }),
      now: () => 10_000,
      warmupMs: 0,
    });

    notifier.observe({
      type: 'permission.request',
      request: makePermission({ id: 'p1', sessionId: 's1', title: 'B'.repeat(200) }),
    });
    await flush();

    const payload = rec.calls[0]?.payload;
    expect(payload?.body.length).toBe(MAX_TEXT);
    expect(payload?.body.endsWith('…')).toBe(true);
  });

  it('ignores hello/node events, cleans up on session.removed, and never throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store = makeFakeStore([makeSub('https://push.example/1')]);
    const failingSend: Sender = async () => {
      throw new Error('boom');
    };
    const notifier = createPushNotifier({
      store,
      send: failingSend,
      subject: 'mailto:test@example.com',
      now: () => 10_000,
      warmupMs: 0,
    });

    notifier.baseline([makeSession({ id: 's1', status: 'running' })], []);
    notifier.observe({ type: 'hello', sessions: [makeSession({ id: 's2', status: 'done' })] });
    notifier.observe({ type: 'session.removed', sessionId: 's1' });
    // After removal, seeing s1 as done is first sight; last active long ago -> does not send.
    notifier.observe({ type: 'session.upsert', session: makeSession({ id: 's1', status: 'done', updatedAt: 10_000 - 120_000 }) });
    await flush();
    expect(warn).not.toHaveBeenCalled();

    // Failing send inside background fan-out logs via console.warn and never throws synchronously.
    notifier.observe({ type: 'session.upsert', session: makeSession({ id: 's1', status: 'running' }) });
    expect(() => {
      notifier.observe({ type: 'session.upsert', session: makeSession({ id: 's1', status: 'error' }) });
    }).not.toThrow();
    await flush();
    expect(warn).toHaveBeenCalled();
  });

  it('sendTest returns error for unknown endpoint, sends test payload, and removes on gone', async () => {
    const store = makeFakeStore([
      makeSub('https://push.example/ok'),
      makeSub('https://push.example/gone'),
    ]);
    const rec = makeRecorder(ep => (ep.endsWith('/gone') ? 'gone' : 'ok'));
    const notifier = createPushNotifier({
      store,
      send: rec.send,
      subject: 'mailto:test@example.com',
    });

    expect(await notifier.sendTest('https://push.example/missing')).toBe('error');
    expect(await notifier.sendTest('https://push.example/ok')).toBe('ok');
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]?.payload).toEqual({
      title: 'SwarmKit',
      body: 'Test notification',
      tag: 'test',
      url: '/',
      test: true,
    });
    expect(rec.calls[0]?.opts.urgency).toBe('high');

    expect(await notifier.sendTest('https://push.example/gone')).toBe('gone');
    expect(await store.get('https://push.example/gone')).toBeUndefined();
  });
  it('review fixes: recent first sight, finished cooldown, unfinished then ok, resume re-end, muted kinds skip the rate limit', async () => {
    let clock = 1_000_000;
    const store = makeFakeStore([{ ...makeSub('https://push.example/1'), events: { waiting: true, finished: true, error: true, workers: false } }]);
    const rec = makeRecorder();
    const notifier = createPushNotifier({ store, send: rec.send, subject: 'mailto:t@example.com', now: () => clock, warmupMs: 0 });

    // First sight of a session active 5 s ago, now done -> Finished.
    notifier.observe({ type: 'session.upsert', session: makeSession({ id: 'a', status: 'done', updatedAt: clock - 5_000 }) });
    // Terminal exit re-reports the same turn within 45 s -> no second Finished.
    notifier.observe({ type: 'session.upsert', session: makeSession({ id: 'a', status: 'running', updatedAt: clock }) });
    clock += 20_000;
    notifier.observe({ type: 'session.upsert', session: makeSession({ id: 'a', status: 'done', updatedAt: clock }) });
    await flush();
    expect(rec.calls.map(c => c.payload.title)).toEqual(['Finished']);

    // 40 worker notifications for a muted kind must not use up the rate limit.
    for (let i = 0; i < 40; i++) {
      notifier.observe({ type: 'workers.update', workers: [makeWorker({ slug: `w${i}`, state: 'ok', endedAt: clock - 1_000 })] });
    }
    notifier.observe({ type: 'session.upsert', session: makeSession({ id: 'b', status: 'running', updatedAt: clock }) });
    notifier.observe({ type: 'session.upsert', session: makeSession({ id: 'b', status: 'error', updatedAt: clock }) });
    await flush();
    expect(rec.calls.map(c => c.payload.title)).toEqual(['Finished', 'Error']);
  });

  it('workers: unfinished then ok notifies ok once; a resume ending between scans notifies again', async () => {
    let clock = 1_000_000;
    const store = makeFakeStore([makeSub('https://push.example/1')]);
    const rec = makeRecorder();
    const notifier = createPushNotifier({ store, send: rec.send, subject: 'mailto:t@example.com', now: () => clock, warmupMs: 0 });
    notifier.baseline([], [makeWorker({ slug: 'w', state: 'running' })]);
    notifier.observe({ type: 'workers.update', workers: [makeWorker({ slug: 'w', state: 'unfinished' })] });
    notifier.observe({ type: 'workers.update', workers: [makeWorker({ slug: 'w', state: 'ok', endedAt: clock })] });
    await flush();
    expect(rec.calls.map(c => c.payload.title)).toEqual(['Worker ok']);
    clock += 60_000;
    notifier.observe({ type: 'workers.update', workers: [makeWorker({ slug: 'w', state: 'not-ok', endedAt: clock })] });
    await flush();
    expect(rec.calls.map(c => c.payload.title)).toEqual(['Worker ok', 'Worker NOT ok']);
  });
});
