// ?mock=1 — a fully local scripted demo, no network. Same surface as the real backend.
import type {
  ActivityEvent,
  AgentNode,
  AgentNodeHead,
  AgentsResponse,
  PermissionRequest,
  ServerEvent,
  SessionDetail,
  SessionSummary,
  StartSessionBody,
  StartSessionResponse,
  TokenUsage,
} from '../shared/types';
import type { FleetBackend } from './api';

const tu = (input: number, output: number, cacheRead = 0, cacheWrite = 0): TokenUsage => ({
  input,
  output,
  cacheRead,
  cacheWrite,
});
const r4 = (x: number) => Math.round(x * 10_000) / 10_000;

function toHead(n: AgentNode): AgentNodeHead {
  const { events, ...head } = n;
  return head;
}

export function createMockBackend(): FleetBackend {
  let emit: ((ev: ServerEvent) => void) | null = null;
  const timers = new Set<number>();
  const at = (ms: number, fn: () => void) => {
    const id = window.setTimeout(() => {
      timers.delete(id);
      fn();
    }, ms);
    timers.add(id);
  };
  const clearAll = () => {
    for (const id of timers) window.clearTimeout(id);
    timers.clear();
  };

  let seq = 0;
  const uid = (p: string) => `${p}-${++seq}`;
  const base = Date.now();

  const sessions = new Map<string, SessionSummary>();
  const nodeMaps = new Map<string, Map<string, AgentNode>>();
  const permLists = new Map<string, PermissionRequest[]>();
  let pendingPerm: { id: string; auto: number } | null = null;

  const s1: SessionSummary = {
    id: 'mock-page-1',
    source: 'page',
    project: 'fleet-ui',
    cwd: '/home/ha-lun/work/fleet-ui',
    title: 'Launch the new pricing page by Friday',
    status: 'running',
    startedAt: base - 1000,
    updatedAt: base,
    costUsd: 0.02,
    agent: 'lead-dev-hybrid',
    model: 'claude-opus-5-5',
    nodeCount: 1,
    pendingPermissions: 0,
  };
  const t1: SessionSummary = {
    id: 'mock-term-1',
    source: 'terminal',
    project: 'fleet-ui',
    cwd: '/home/ha-lun/work/fleet-ui',
    title: 'claude "explain the SSE reducer"',
    status: 'done',
    startedAt: base - 3_600_000,
    updatedAt: base - 3_500_000,
    costUsd: 0.05,
    nodeCount: 1,
    pendingPermissions: 0,
  };
  const t2: SessionSummary = {
    id: 'mock-term-2',
    source: 'terminal',
    project: 'website',
    cwd: '/home/ha-lun/work/website',
    title: 'claude --resume "refactor the blog index"',
    status: 'stopped',
    startedAt: base - 86_400_000,
    updatedAt: base - 82_000_000,
    costUsd: 0.31,
    nodeCount: 2,
    pendingPermissions: 0,
  };
  for (const s of [s1, t1, t2]) {
    sessions.set(s.id, s);
    nodeMaps.set(s.id, new Map());
    permLists.set(s.id, []);
  }

  // --- static terminal sessions ---
  const t1root: AgentNode = {
    id: 'root',
    sessionId: t1.id,
    parentId: null,
    kind: 'main',
    agentType: 'main',
    model: 'claude-sonnet-5-5',
    description: 'Explain the SSE reducer',
    prompt: 'Explain how the SSE reducer merges node events.',
    status: 'done',
    startedAt: t1.startedAt,
    endedAt: t1.updatedAt,
    costUsd: 0.05,
    tokens: tu(1200, 3400),
    toolCounts: { Read: 2 },
    lastActivity: 'Explained the reducer merge rules.',
    result: 'Server events merge by session id, then node id; node.event appends to the cached detail.',
    events: [
      { id: 't1-e1', ts: t1.startedAt, kind: 'user', summary: 'Explain how the SSE reducer merges node events.' },
      {
        id: 't1-e2',
        ts: t1.startedAt + 800,
        kind: 'tool_use',
        tool: 'Read',
        summary: 'dashboard/src/client/state.ts',
        detail: '{\n  "file_path": "/home/ha-lun/work/fleet-ui/dashboard/src/client/state.ts"\n}',
      },
      { id: 't1-e3', ts: t1.startedAt + 1300, kind: 'tool_result', tool: 'Read', summary: 'Read 96 lines' },
      {
        id: 't1-e4',
        ts: t1.startedAt + 2600,
        kind: 'text',
        summary: 'Details are cached per session; node.event appends to the node inside that cache.',
      },
      { id: 't1-e5', ts: t1.updatedAt, kind: 'result', summary: 'Explained in 42s.' },
    ],
  };
  const t2root: AgentNode = {
    id: 'root',
    sessionId: t2.id,
    parentId: null,
    kind: 'main',
    agentType: 'main',
    description: 'Refactor the blog index',
    prompt: 'Refactor the blog index template into components.',
    status: 'stopped',
    startedAt: t2.startedAt,
    endedAt: t2.updatedAt,
    costUsd: 0.31,
    tokens: tu(18_400, 22_100, 61_000),
    toolCounts: { Read: 6, Edit: 3, Bash: 2 },
    lastActivity: 'Stopped by the user.',
    result: 'Stopped before finishing the third component.',
    events: [
      { id: 't2-e1', ts: t2.startedAt, kind: 'user', summary: 'Refactor the blog index template into components.' },
      { id: 't2-e2', ts: t2.startedAt + 1200, kind: 'tool_use', tool: 'Read', summary: 'blog/index.html' },
      { id: 't2-e3', ts: t2.startedAt + 1900, kind: 'tool_result', tool: 'Read', summary: 'Read 214 lines' },
      { id: 't2-e4', ts: t2.updatedAt - 1000, kind: 'system', summary: 'Stopped by the user from the CLI.' },
    ],
  };
  nodeMaps.get(t1.id)!.set('root', t1root);
  nodeMaps.get(t2.id)!.set('root', t2root);

  // --- the scripted page session ---
  const root: AgentNode = {
    id: 'root',
    sessionId: s1.id,
    parentId: null,
    kind: 'main',
    agentType: 'lead-dev-hybrid',
    model: 'claude-opus-5-5',
    description: 'Launch the new pricing page by Friday',
    prompt:
      'You are leading the fleet. Launch the new pricing page by Friday: plan first, then dispatch subagents for research and UI, and an opencode worker for the mechanical edits. Keep the build green.',
    status: 'running',
    startedAt: base - 1000,
    costUsd: 0.02,
    tokens: tu(9800, 1400, 32_000),
    toolCounts: {},
    events: [
      {
        id: 'r-e1',
        ts: base - 1000,
        kind: 'user',
        summary: 'Launch the new pricing page by Friday',
        detail:
          'Launch the new pricing page by Friday: plan first, then dispatch subagents for research and UI, and an opencode worker for the mechanical edits. Keep the build green.',
      },
    ],
  };
  nodeMaps.get(s1.id)!.set('root', root);

  const pushEvent = (
    n: AgentNode,
    kind: ActivityEvent['kind'],
    summary: string,
    extra: Partial<ActivityEvent> = {},
  ) => {
    const ev: ActivityEvent = { id: uid('ev'), ts: Date.now(), kind, summary, ...extra };
    n.events.push(ev);
    n.lastActivity = summary;
    emit?.({ type: 'node.event', sessionId: n.sessionId, nodeId: n.id, event: ev });
    return ev;
  };

  const bumpSession = (id: string) => {
    const s = sessions.get(id);
    if (!s) return;
    s.updatedAt = Date.now();
    emit?.({ type: 'session.upsert', session: { ...s } });
  };

  const upsertHead = (n: AgentNode) => emit?.({ type: 'node.upsert', node: toHead(n) });

  const toolCall = (n: AgentNode, tool: string, summary: string, detail?: string) => {
    pushEvent(n, 'tool_use', summary, { tool, detail });
    n.toolCounts[tool] = (n.toolCounts[tool] ?? 0) + 1;
    n.costUsd = r4(n.costUsd + 0.002);
    bumpSession(n.sessionId);
    upsertHead(n);
  };
  const toolBack = (n: AgentNode, tool: string, summary: string, detail?: string, isError = false) =>
    pushEvent(n, 'tool_result', summary, { tool, detail, isError });

  const spawn = (
    parent: AgentNode,
    id: string,
    kind: AgentNode['kind'],
    agentType: string,
    model: string | undefined,
    description: string,
    prompt: string,
    extra?: Partial<AgentNode>,
  ): AgentNode => {
    const n: AgentNode = {
      id,
      sessionId: parent.sessionId,
      parentId: parent.id,
      kind,
      agentType,
      model,
      description,
      prompt,
      status: 'running',
      startedAt: Date.now(),
      costUsd: 0,
      tokens: tu(0, 0, 0, 0),
      toolCounts: {},
      events: [],
      ...extra,
    };
    nodeMaps.get(parent.sessionId)!.set(id, n);
    const s = sessions.get(parent.sessionId);
    if (s) s.nodeCount += 1;
    upsertHead(n);
    toolCall(parent, 'Task', `${agentType} — ${description}`, JSON.stringify({ subagent_type: agentType, description, prompt }, null, 2).slice(0, 2000));
    bumpSession(parent.sessionId);
    return n;
  };

  const finishNode = (n: AgentNode, result: string, cost: number, tokens?: TokenUsage) => {
    n.status = 'done';
    n.endedAt = Date.now();
    n.result = result;
    n.costUsd = cost;
    if (tokens) n.tokens = tokens;
    pushEvent(n, 'result', result);
    upsertHead(n);
    const s = sessions.get(n.sessionId);
    if (s) {
      if (n.kind === 'main') s.status = 'done';
      s.costUsd = Math.max(s.costUsd, cost);
      bumpSession(n.sessionId);
    }
  };

  // ---- script ----

  const scheduleCompletion = (denied: boolean) => {
    at(1000, () => {
      if (!fs) return;
      pushEvent(fs, 'text', denied
        ? 'The shell step was denied — verifying via file reads instead.'
        : 'Build is green. Finishing the remaining card polish.');
    });
    at(2500, () => {
      if (!fs) return;
      toolCall(fs, 'Edit', 'dashboard/src/client/NodeCard.tsx');
    });
    at(3000, () => {
      if (!fs) return;
      toolBack(fs, 'Edit', 'Applied 1 hunk');
    });
    at(4500, () => {
      if (!fs) return;
      finishNode(fs, 'Tree UI, drawer, composer and new-session dialog shipped. Build and typecheck pass.', 0.031, tu(21_000, 9800, 84_000));
    });
    at(6000, () => {
      pushEvent(root, 'text', 'Fleet complete: research, UI and worker tracks all landed.');
    });
    at(7000, () => {
      finishNode(root, 'Pricing page launched. Explore mapped the repo, frontend-specialist shipped the tree UI, the opencode worker landed the renames. Build + typecheck green.', 0.142, tu(48_000, 16_400, 122_000));
    });
  };

  const resolvePermission = (allow: boolean, message?: string) => {
    const p = pendingPerm;
    if (!p) return;
    pendingPerm = null;
    window.clearTimeout(p.auto);
    timers.delete(p.auto);
    const list = permLists.get(s1.id)!;
    const req = list.find((r) => r.id === p.id) ?? null;
    const idx = list.findIndex((r) => r.id === p.id);
    if (idx >= 0) list.splice(idx, 1);
    emit?.({ type: 'permission.resolved', sessionId: s1.id, id: p.id, allow });
    s1.status = 'running';
    s1.pendingPermissions = 0;
    bumpSession(s1.id);
    if (req && fs) {
      pushEvent(fs, 'permission', `${req.tool} ${allow ? 'allowed' : 'denied'}${message ? `: “${message}”` : ''}`);
      if (!allow) toolBack(fs, req.tool, 'Permission denied by the user', undefined, true);
    }
    scheduleCompletion(!allow);
  };

  let explore: AgentNode | undefined;
  let fs: AgentNode | undefined;
  let worker: AgentNode | undefined;

  at(300, () => pushEvent(root, 'text', 'Planning the pricing page: research the current repo, then fan out UI and worker tracks.'));
  at(600, () =>
    pushEvent(root, 'thinking', 'Thinking through the fan-out', {
      detail: 'Plan: 1) explore maps the data flow, 2) frontend-specialist builds the tree UI, 3) an opencode worker does the mechanical renames. Gate everything on npm run build.',
    }),
  );
  at(900, () => toolCall(root, 'Read', 'dashboard/src/shared/types.ts', '{\n  "file_path": "/home/ha-lun/work/fleet-ui/dashboard/src/shared/types.ts"\n}'));
  at(1300, () => toolBack(root, 'Read', 'Read 163 lines', 'export type SessionSource = "page" | "terminal";\n… (truncated)'));
  at(1700, () => toolCall(root, 'Read', 'dashboard/package.json'));
  at(2100, () => toolBack(root, 'Read', 'Read 30 lines'));

  at(2600, () => {
    explore = spawn(root, 'task-explore', 'subagent', 'explore', 'claude-haiku-4-5-20251001', 'Map the dashboard data flow', 'Trace how ServerEvent reaches the client reducer. List the files involved and the merge rules.');
  });
  at(3000, () => {
    fs = spawn(root, 'task-fs', 'subagent', 'frontend-specialist', 'claude-sonnet-5-5', 'Build the agent tree UI', 'Implement the tree canvas, cards, drawer, composer and new-session dialog. Light theme, Inter, 1px borders, 12px radius.');
  });
  at(3400, () => {
    worker = spawn(root, 'task-worker', 'worker', 'agy-task', 'opencode-go/glm-5.3-flash', 'Rename session summary fields', 'Mechanical rename across the server model files; keep the build green.', {
      worker: { lane: 'opencode', slug: 'fleet-ui' },
    });
  });

  // explore ticks
  at(3800, () => { if (explore) toolCall(explore, 'Grep', 'ServerEvent in src/client'); });
  at(4300, () => { if (explore) toolBack(explore, 'Grep', '9 matches in 4 files'); });
  at(4700, () => { if (explore) toolCall(explore, 'Glob', 'server/**/*.ts'); });
  at(5200, () => { if (explore) toolBack(explore, 'Glob', '14 files'); });
  at(5600, () => { if (explore) toolCall(explore, 'Read', 'src/client/state.ts'); });
  at(6000, () => { if (explore) toolBack(explore, 'Read', 'Read 120 lines'); });
  at(6600, () => {
    if (!explore) return;
    pushEvent(explore, 'text', 'Events flow through EventSource into a reducer keyed by session id, then node id; details are cached per session.');
  });
  at(9800, () => {
    if (!explore) return;
    finishNode(explore, 'Events flow: server emits ServerEvent over SSE; the client reducer merges by session id then node id. Key files: server/index.ts, src/client/state.ts.', 0.004, tu(6800, 900));
  });

  // frontend ticks
  at(4200, () => { if (fs) toolCall(fs, 'Read', 'dashboard/src/client/main.tsx'); });
  at(4700, () => { if (fs) toolBack(fs, 'Read', 'Read 3 lines'); });
  at(5200, () => { if (fs) toolCall(fs, 'Write', 'dashboard/src/client/styles.css'); });
  at(5800, () => { if (fs) toolBack(fs, 'Write', 'Wrote 420 lines'); });
  at(6400, () => { if (fs) toolCall(fs, 'Edit', 'dashboard/src/client/Tree.tsx'); });
  at(7000, () => { if (fs) toolBack(fs, 'Edit', 'Applied 2 hunks'); });
  at(8300, () => {
    if (!fs) return;
    pushEvent(fs, 'thinking', 'Checking the build before the last edits', {
      detail: 'Cards and connectors render; run the build once before the drawer work so regressions surface early.',
    });
  });

  // worker ticks
  at(5200, () => { if (worker) pushEvent(worker, 'system', 'Worktree ready at ../fleet-ui-worker'); });
  at(6800, () => { if (worker) toolCall(worker, 'Bash', 'git status --short'); });
  at(7200, () => { if (worker) toolBack(worker, 'Bash', 'M 3 files'); });
  at(10_500, () => { if (worker) pushEvent(worker, 'system', 'Applied renames in server/model/*.ts'); });
  at(12_500, () => {
    if (worker) {
      worker.worker = { lane: 'opencode', slug: 'fleet-ui', ok: true };
      finishNode(worker, 'Renamed 3 files across server/model; build passes.', 0.009, tu(3100, 640));
    }
  });

  // pending permission on the frontend-specialist
  at(8000, () => {
    if (!fs) return;
    const req: PermissionRequest = {
      id: uid('perm'),
      sessionId: s1.id,
      nodeId: fs.id,
      tool: 'Bash',
      input: { command: 'npm run build --prefix dashboard' },
      title: 'Claude wants to run npm run build --prefix dashboard',
      createdAt: Date.now(),
    };
    permLists.get(s1.id)!.push(req);
    emit?.({ type: 'permission.request', request: req });
    s1.status = 'waiting';
    s1.pendingPermissions = 1;
    bumpSession(s1.id);
    const auto = window.setTimeout(() => resolvePermission(true), 6000);
    timers.add(auto);
    pendingPerm = { id: req.id, auto };
  });

  // ---- backend surface ----

  const detail = (id: string): SessionDetail => {
    const s = sessions.get(id);
    const map = nodeMaps.get(id);
    if (!s || !map) throw new Error(`mock: unknown session ${id}`);
    return {
      ...s,
      nodes: Array.from(map.values()).map((n) => ({
        ...n,
        events: n.events.slice(-500).map((e) => ({ ...e })),
        tokens: { ...n.tokens },
        toolCounts: { ...n.toolCounts },
        worker: n.worker ? { ...n.worker } : undefined,
      })),
      permissions: (permLists.get(id) ?? []).map((p) => ({ ...p, input: { ...p.input } })),
    };
  };

  return {
    sessions: () => Promise.resolve(Array.from(sessions.values()).map((s) => ({ ...s })).sort((a, b) => b.updatedAt - a.updatedAt)),
    detail: (id) => Promise.resolve(detail(id)),
    start: (body: StartSessionBody) => {
      const now = Date.now();
      const id = uid('page');
      const title = body.prompt.split('\n')[0].slice(0, 120) || 'New session';
      const s: SessionSummary = {
        id,
        source: 'page',
        project: body.cwd.split('/').filter(Boolean).pop() ?? body.cwd,
        cwd: body.cwd,
        title,
        status: 'running',
        startedAt: now,
        updatedAt: now,
        costUsd: 0,
        agent: body.agent,
        model: body.model,
        nodeCount: 1,
        pendingPermissions: 0,
      };
      sessions.set(id, s);
      nodeMaps.set(id, new Map());
      permLists.set(id, []);
      const n: AgentNode = {
        id: 'root',
        sessionId: id,
        parentId: null,
        kind: 'main',
        agentType: body.agent ?? 'main',
        model: body.model,
        description: title,
        prompt: body.prompt,
        status: 'running',
        startedAt: now,
        costUsd: 0,
        tokens: tu(0, 0, 0, 0),
        toolCounts: {},
        events: [{ id: uid('ev'), ts: now, kind: 'user', summary: body.prompt.split('\n')[0], detail: body.prompt }],
        lastActivity: body.prompt.split('\n')[0],
      };
      nodeMaps.get(id)!.set('root', n);
      emit?.({ type: 'session.upsert', session: { ...s } });
      upsertHead(n);
      at(2000, () => {
        if (n.status === 'running') pushEvent(n, 'text', 'Mock session started — this is a scripted demo reply.');
      });
      at(4500, () => {
        if (n.status === 'running') finishNode(n, 'Scripted demo session complete.', 0.003, tu(900, 210));
      });
      return Promise.resolve({ sessionId: id } satisfies StartSessionResponse);
    },
    send: (sessionId, text) => {
      const map = nodeMaps.get(sessionId);
      const s = sessions.get(sessionId);
      if (!map || !s) return Promise.reject(new Error('mock: unknown session'));
      if (s.source !== 'page') return Promise.reject(new Error('Terminal sessions are read-only'));
      const n = map.get('root');
      if (!n) return Promise.reject(new Error('mock: no root'));
      pushEvent(n, 'user', text.split('\n')[0], { detail: text });
      n.status = 'running';
      n.endedAt = undefined;
      n.result = undefined;
      upsertHead(n);
      s.status = 'running';
      bumpSession(sessionId);
      at(1400, () => {
        if (n.status === 'running') pushEvent(n, 'text', 'On it — scripted reply from the mock fleet.');
      });
      at(3000, () => {
        if (n.status === 'running') {
          n.status = 'done';
          n.endedAt = Date.now();
          n.result = 'Scripted reply recorded.';
          pushEvent(n, 'result', 'Scripted reply recorded.');
          upsertHead(n);
          s.status = 'done';
          bumpSession(sessionId);
        }
      });
      return Promise.resolve({ ok: true });
    },
    interrupt: (sessionId) => {
      const map = nodeMaps.get(sessionId);
      const s = sessions.get(sessionId);
      if (!map || !s) return Promise.reject(new Error('mock: unknown session'));
      const n = map.get('root');
      if (n && (n.status === 'running' || n.status === 'waiting')) {
        n.status = 'idle';
        upsertHead(n);
      }
      s.status = 'idle';
      bumpSession(sessionId);
      return Promise.resolve({ ok: true });
    },
    stop: (sessionId) => {
      const map = nodeMaps.get(sessionId);
      const s = sessions.get(sessionId);
      if (!map || !s) return Promise.reject(new Error('mock: unknown session'));
      clearAll();
      const now = Date.now();
      for (const n of map.values()) {
        if (n.status === 'running' || n.status === 'waiting' || n.status === 'idle') {
          n.status = 'stopped';
          n.endedAt = now;
          pushEvent(n, 'system', 'Session stopped by the user.');
          upsertHead(n);
        }
      }
      s.status = 'stopped';
      s.pendingPermissions = 0;
      pendingPerm = null;
      bumpSession(sessionId);
      return Promise.resolve({ ok: true });
    },
    decide: (permissionId, allow, message) => {
      if (pendingPerm?.id === permissionId) resolvePermission(allow, message);
      return Promise.resolve({ ok: true });
    },
    agents: (_cwd) =>
      Promise.resolve({
        agents: [
          { name: 'explore', description: 'Fast read-only codebase scout', scope: 'user' },
          { name: 'frontend-specialist', description: 'UI implementation specialist', scope: 'project' },
        ],
      } satisfies AgentsResponse),
    cwds: () =>
      Promise.resolve([
        '/home/ha-lun/work/fleet-ui',
        '/home/ha-lun/work/website',
        '/home/ha-lun/opencode-config/opencode',
      ]),
    connect(onEvent, onStatus) {
      emit = onEvent;
      onStatus(true);
      emit({ type: 'hello', sessions: Array.from(sessions.values()).map((s) => ({ ...s })) });
      upsertHead(root);
      return () => clearAll();
    },
  };
}
