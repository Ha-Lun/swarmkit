// ?mock=1 — a fully local scripted demo, no network. Same surface as the real backend.
import type {
  ActivityEvent,
  AgentNode,
  AgentNodeHead,
  AgentsResponse,
  DirEntry,
  DirListing,
  PermissionRequest,
  ServerEvent,
  SessionDetail,
  SessionSummary,
  StartSessionBody,
  StartSessionResponse,
  ResumeSessionBody,
  TokenUsage,
  UsageReport,
  WorkerTask,
} from '../shared/types';
import { ApiError } from './api';
import type { FleetBackend } from './api';

const MOCK_HOME = '/home/demo';

/** Tiny fake filesystem for the folder picker: home → a few well-known folders. */
const dirTree = new Map<string, DirEntry[]>([
  [
    MOCK_HOME,
    [
      { name: 'work', path: `${MOCK_HOME}/work`, isGitRepo: false },
      { name: 'projects', path: `${MOCK_HOME}/projects`, isGitRepo: false },
      { name: 'swarmkit', path: `${MOCK_HOME}/swarmkit`, isGitRepo: true },
      { name: '.config', path: `${MOCK_HOME}/.config`, isGitRepo: false },
      { name: '.agy-tasks', path: `${MOCK_HOME}/.agy-tasks`, isGitRepo: false },
      { name: '.opencode-tasks', path: `${MOCK_HOME}/.opencode-tasks`, isGitRepo: false },
    ],
  ],
  [
    `${MOCK_HOME}/work`,
    [
      { name: 'acme-web', path: `${MOCK_HOME}/work/acme-web`, isGitRepo: true },
      { name: 'docs-site', path: `${MOCK_HOME}/work/docs-site`, isGitRepo: true },
      { name: 'scratch', path: `${MOCK_HOME}/work/scratch`, isGitRepo: false },
    ],
  ],
  [
    `${MOCK_HOME}/work/acme-web`,
    [
      { name: 'dashboard', path: `${MOCK_HOME}/work/acme-web/dashboard`, isGitRepo: false },
      { name: 'docs', path: `${MOCK_HOME}/work/acme-web/docs`, isGitRepo: false },
    ],
  ],
  [
    `${MOCK_HOME}/work/acme-web/dashboard`,
    [
      { name: 'server', path: `${MOCK_HOME}/work/acme-web/dashboard/server`, isGitRepo: false },
      { name: 'src', path: `${MOCK_HOME}/work/acme-web/dashboard/src`, isGitRepo: false },
      { name: 'test', path: `${MOCK_HOME}/work/acme-web/dashboard/test`, isGitRepo: false },
    ],
  ],
  [
    `${MOCK_HOME}/projects`,
    [
      { name: 'api-gateway', path: `${MOCK_HOME}/projects/api-gateway`, isGitRepo: true },
      { name: 'docs-site', path: `${MOCK_HOME}/projects/docs-site`, isGitRepo: true },
    ],
  ],
  [
    `${MOCK_HOME}/swarmkit`,
    [{ name: 'cli', path: `${MOCK_HOME}/swarmkit/cli`, isGitRepo: true }],
  ],
]);

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
    project: 'acme-web',
    cwd: '/home/demo/work/acme-web',
    title: 'Launch the new pricing page by Friday',
    status: 'running',
    startedAt: base - 1000,
    updatedAt: base,
    costUsd: 0.02,
    agent: 'lead-dev-hybrid',
    model: 'claude-opus-5-5',
    nodeCount: 1,
    pendingPermissions: 0,
    resumable: false,
  };
  const t1: SessionSummary = {
    id: 'mock-term-1',
    source: 'terminal',
    project: 'acme-web',
    cwd: '/home/demo/work/acme-web',
    title: 'claude "explain the SSE reducer"',
    status: 'done',
    startedAt: base - 3_600_000,
    updatedAt: base - 3_500_000,
    costUsd: 0.05,
    nodeCount: 1,
    pendingPermissions: 0,
    resumable: true,
  };
  const t2: SessionSummary = {
    id: 'mock-term-2',
    source: 'terminal',
    project: 'docs-site',
    cwd: '/home/demo/work/docs-site',
    title: 'claude --resume "refactor the blog index"',
    status: 'stopped',
    startedAt: base - 86_400_000,
    updatedAt: base - 82_000_000,
    costUsd: 0.31,
    nodeCount: 2,
    pendingPermissions: 0,
    resumable: true,
  };
  const t3: SessionSummary = {
    id: 'mock-term-3',
    source: 'terminal',
    project: 'acme-web',
    cwd: '/home/demo/work/acme-web',
    title: 'claude "draft the migration notes"',
    status: 'done',
    startedAt: base - 50_000_000,
    updatedAt: base - 49_000_000,
    costUsd: 0.12,
    nodeCount: 1,
    pendingPermissions: 0,
    resumable: true,
  };
  const t4: SessionSummary = {
    id: 'mock-term-4',
    source: 'terminal',
    project: 'scratch',
    cwd: '/home/demo/work/scratch',
    title: 'claude "aborted before the first reply"',
    status: 'error',
    startedAt: base - 20_000_000,
    updatedAt: base - 19_900_000,
    costUsd: 0.0,
    nodeCount: 1,
    pendingPermissions: 0,
    resumable: false,
  };
  for (const s of [s1, t1, t2, t3, t4]) {
    sessions.set(s.id, s);
    nodeMaps.set(s.id, new Map());
    permLists.set(s.id, []);
  }

  // --- mock workers (live via workers.update, linked to the tree's worker node) ---
  const workerTasks: WorkerTask[] = [
    {
      lane: 'opencode',
      repo: 'swarmkit',
      slug: 'acme-web',
      state: 'running',
      model: 'opencode-go/glm-5.3-flash',
      agent: 'frontend-specialist',
      startedAt: base - 420_000,
      elapsedS: 420,
      denied: 2,
      changes: 'dashboard/src/client +12 -4',
      lastTool: 'edit dashboard/src/client/Workers.tsx',
      toolCounts: { edit: 14, bash: 3, read: 9 },
      sessionId: s1.id,
      nodeId: 'task-worker',
    },
    {
      lane: 'agy',
      repo: 'swarmkit',
      slug: 'docs-refresh',
      state: 'ok',
      model: 'claude-sonnet-5-5',
      agent: 'release-tester',
      startedAt: base - 1_500_000,
      endedAt: base - 688_000,
      elapsedS: 812,
      denied: 0,
      changes: 'README.md +3 -1',
      toolCounts: { read: 6 },
      response: 'Docs refreshed against the current build; no regressions found.',
    },
    {
      lane: 'agy',
      repo: 'api-gateway',
      slug: 'flaky-migrate',
      state: 'not-ok',
      model: 'claude-opus-5-5',
      startedAt: base - 7_200_000,
      endedAt: base - 6_900_000,
      elapsedS: 300,
      denied: 5,
      stoppedBy: 'denied-tools',
      warnings: ['5 tool calls were denied by the user'],
      toolCounts: { bash: 8 },
      response: 'Migration aborted: the user denied a run of shell commands.',
    },
    {
      lane: 'opencode',
      repo: 'swarmkit',
      slug: 'lint-sweep',
      state: 'unfinished',
      model: 'opencode-go/glm-4.5-air',
      startedAt: base - 86_400_000,
      elapsedS: 3600,
      denied: 0,
      toolCounts: {},
    },
  ];

  const workerLogLines = (t: WorkerTask): string[] => {
    const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour12: false });
    const head = `[${clock(t.startedAt)}] ${t.lane}-task: starting ${t.repo} · ${t.slug}`;
    if (t.state === 'running') {
      return [
        head,
        `[${clock(t.startedAt + 4000)}] worktree ready`,
        `[${clock(t.startedAt + 9000)}] edit dashboard/src/client/Workers.tsx`,
        `[${clock(t.startedAt + 15_000)}] edit dashboard/src/client/WorkerDrawer.tsx`,
        `[${clock(t.startedAt + 21_000)}] bash npm run typecheck --prefix dashboard`,
        `[${clock(t.startedAt + 27_000)}] edit dashboard/src/client/styles.css`,
      ];
    }
    if (t.state === 'not-ok') {
      return [head, `[${clock(t.startedAt + 8000)}] bash npx drizzle-kit push`, `[${clock(t.endedAt ?? base)}] stopped: denied tools`];
    }
    if (t.state === 'ok') {
      return [head, `[${clock(t.startedAt + 7000)}] read README.md`, `[${clock(t.endedAt ?? base)}] done in ${t.elapsedS}s`];
    }
    return [head, '[…] no result.json yet'];
  };

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
        detail: '{\n  "file_path": "/home/demo/work/acme-web/dashboard/src/client/state.ts"\n}',
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
  nodeMaps.get(t3.id)!.set('root', {
    id: 'root',
    sessionId: t3.id,
    parentId: null,
    kind: 'main',
    agentType: 'main',
    model: 'claude-sonnet-5-5',
    description: 'Draft the migration notes',
    prompt: 'Draft the migration notes for the pricing tables.',
    status: 'done',
    startedAt: t3.startedAt,
    endedAt: t3.updatedAt,
    costUsd: 0.12,
    tokens: tu(6400, 2100),
    toolCounts: { Read: 3 },
    lastActivity: 'Drafted the migration notes.',
    result: 'Migration notes drafted: three tables, two backfills, one flag flip.',
    events: [
      { id: 't3-e1', ts: t3.startedAt, kind: 'user', summary: 'Draft the migration notes for the pricing tables.' },
      { id: 't3-e2', ts: t3.startedAt + 900, kind: 'text', summary: 'Here are the migration notes.' },
      { id: 't3-e3', ts: t3.updatedAt, kind: 'result', summary: 'Drafted in 3m.' },
    ],
  });
  // t4 died before the first assistant response: no result, not resumable, hidden everywhere.
  nodeMaps.get(t4.id)!.set('root', {
    id: 'root',
    sessionId: t4.id,
    parentId: null,
    kind: 'main',
    agentType: 'main',
    description: 'Aborted before the first reply',
    prompt: 'Aborted before the first reply.',
    status: 'error',
    startedAt: t4.startedAt,
    endedAt: t4.updatedAt,
    costUsd: 0,
    tokens: tu(0, 0, 0, 0),
    toolCounts: {},
    lastActivity: 'Exited before responding.',
    events: [
      { id: 't4-e1', ts: t4.startedAt, kind: 'user', summary: 'Aborted before the first reply.' },
    ],
  });

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
      if (n.kind === 'main') {
        s.status = 'done';
        s.resumable = true;
      }
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
  at(900, () => toolCall(root, 'Read', 'dashboard/src/shared/types.ts', '{\n  "file_path": "/home/demo/work/acme-web/dashboard/src/shared/types.ts"\n}'));
  at(1300, () => toolBack(root, 'Read', 'Read 163 lines', 'export type SessionSource = "page" | "terminal";\n… (truncated)'));
  at(1700, () => toolCall(root, 'Read', 'dashboard/package.json'));
  at(2100, () => toolBack(root, 'Read', 'Read 30 lines'));

  // A finished pack install — triggers the amber restart banner above the composer.
  at(2400, () => {
    pushEvent(root, 'tool_use', 'bash install.sh --pack fleet-agents', {
      tool: 'Bash',
      toolUseId: 'mock-pack-1',
      detail: 'bash ~/.fleet/install.sh --pack fleet-agents   # installs planner, reviewer, tester',
    });
    root.toolCounts.Bash = (root.toolCounts.Bash ?? 0) + 1;
    root.costUsd = r4(root.costUsd + 0.002);
    bumpSession(root.sessionId);
    upsertHead(root);
  });
  at(2800, () => {
    pushEvent(root, 'tool_result', 'Installed 3 agents from the pack', { tool: 'Bash', toolUseId: 'mock-pack-1' });
  });

  at(2600, () => {
    explore = spawn(root, 'task-explore', 'subagent', 'explore', 'claude-haiku-4-5-20251001', 'Map the dashboard data flow', 'Trace how ServerEvent reaches the client reducer. List the files involved and the merge rules.');
  });
  at(3000, () => {
    fs = spawn(root, 'task-fs', 'subagent', 'frontend-specialist', 'claude-sonnet-5-5', 'Build the agent tree UI', 'Implement the tree canvas, cards, drawer, composer and new-session dialog. Dark SwarmKit theme, Space Grotesk, hairline borders.');
  });
  at(3400, () => {
    worker = spawn(root, 'task-worker', 'worker', 'agy-task', 'opencode-go/glm-5.3-flash', 'Rename session summary fields', 'Mechanical rename across the server model files; keep the build green.', {
      worker: { lane: 'opencode', slug: 'acme-web' },
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
  at(5200, () => { if (worker) pushEvent(worker, 'system', 'Worktree ready at ../acme-web-worker'); });
  at(6800, () => { if (worker) toolCall(worker, 'Bash', 'git status --short'); });
  at(7200, () => { if (worker) toolBack(worker, 'Bash', 'M 3 files'); });
  at(10_500, () => { if (worker) pushEvent(worker, 'system', 'Applied renames in server/model/*.ts'); });
  at(12_500, () => {
    if (worker) {
      worker.worker = { lane: 'opencode', slug: 'acme-web', ok: true };
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

  // ---- crowded demo tree: leaf pills, one wrapped audit group, one nested backend ----
  // The lead's direct leaves exercise the compact pill; the audit node (7 leaf-only
  // children) exercises the wrapped grid + group box; backend-specialist under the
  // frontend-specialist keeps a nested (non-leaf) branch in the demo.
  const leafSpecs: Array<[string, string, string, string, string]> = [
    ['task-sc-routes', 'explore', 'claude-haiku-4-5-20251001', 'Survey pricing page routes', 'List the routes and loaders behind /pricing.'],
    ['task-sc-copy', 'explore', 'claude-haiku-4-5-20251001', 'Audit checkout copy', 'Collect every checkout string that mentions price or trial.'],
    ['task-sc-analytics', 'explore', 'claude-haiku-4-5-20251001', 'Map analytics events', 'Find where pricing events are tracked and their payloads.'],
    ['task-sc-tests', 'test-writer', 'claude-sonnet-5-5', 'Cover the new price tiers', 'Add tests for monthly/annual tier switching.'],
    ['task-sc-proof', 'code-proofreader', 'claude-sonnet-5-5', 'Proofread the plan disclosures', 'Review the fine print under each plan card.'],
    ['task-sc-seo', 'seo-worker', 'claude-haiku-4-5-20251001', 'Draft pricing page metadata', 'Write title, description and OG tags for /pricing.'],
    ['task-sc-faq', 'junior-dev', 'claude-haiku-4-5-20251001', 'Scaffold the FAQ section', 'Stub the FAQ accordion with placeholder copy.'],
  ];
  leafSpecs.forEach(([id, agentType, model, desc, prompt], i) => {
    const t0 = 3600 + i * 1400;
    at(t0, () => {
      const n = spawn(root, id, 'subagent', agentType, model, desc, prompt);
      if (agentType === 'test-writer') {
        // One leaf with a denied tool result exercises the amber "N" badge.
        at(500, () => toolCall(n, 'Bash', 'npm run coverage -- --tier'));
        at(900, () => toolBack(n, 'Bash', 'Bash denied by the user', undefined, true));
        at(1600, () => {
          pushEvent(n, 'text', 'Coverage run was denied — asserting from existing fixtures instead.');
        });
        at(2600, () => finishNode(n, 'Tier tests added against fixtures; coverage run denied.', 0.006, tu(4200, 1100)));
      } else if (i >= leafSpecs.length - 2) {
        // Keep the last two leaves running so live pills stay visible.
        at(600, () => toolCall(n, 'Read', `pricing/${agentType === 'seo-worker' ? 'meta.ts' : 'faq.tsx'}`));
        at(1200, () => toolBack(n, 'Read', 'Read 48 lines'));
        at(2000, () => pushEvent(n, 'text', 'Working through the draft.'));
      } else {
        at(500, () => toolCall(n, 'Grep', `${desc} in dashboard/src`));
        at(1000, () => toolBack(n, 'Grep', '4 matches in 2 files'));
        at(2200, () => finishNode(n, `${desc} — done.`, 0.003, tu(3100, 700)));
      }
    });
  });

  // Nested specialist under the frontend-specialist, with two children of its own.
  at(5200, () => {
    if (!fs) return;
    const be = spawn(fs, 'task-backend', 'subagent', 'backend-specialist', 'claude-sonnet-5-5', 'Shape the pricing API', 'Define the plan/tier endpoints the pricing page reads.');
    at(800, () => {
      const m = spawn(be, 'task-be-migrate', 'subagent', 'explore', 'claude-haiku-4-5-20251001', 'Check the plans table', 'Confirm the plans table has the new tier columns.');
      at(800, () => toolCall(m, 'Read', 'server/model/plans.ts'));
      at(1400, () => toolBack(m, 'Read', 'Read 88 lines'));
      at(2600, () => finishNode(m, 'Plans table already carries the tier columns.', 0.002, tu(2400, 500)));
    });
    at(1700, () => {
      const e = spawn(be, 'task-be-endpoint', 'subagent', 'junior-dev', 'claude-haiku-4-5-20251001', 'Stub the tiers endpoint', 'Add GET /api/plans/tiers returning the static tier list.');
      at(800, () => toolCall(e, 'Write', 'server/routes/tiers.ts'));
      at(1400, () => toolBack(e, 'Write', 'Wrote 64 lines'));
    });
  });

  // Audit branch: 7 leaf-only children so the wrapped grid + group box renders.
  at(4200, () => {
    const audit = spawn(root, 'task-audit', 'subagent', 'release-tester', 'claude-sonnet-5-5', 'Audit the release checklist', 'Verify the pricing release against the launch checklist; fan out one checker per item.');
    const checks: Array<[string, string, string]> = [
      ['task-au-links', 'Check every pricing link', 'Click through each plan CTA and confirm the target.'],
      ['task-au-a11y', 'Axe the pricing cards', 'Run axe on the plan cards and record violations.'],
      ['task-au-perf', 'Weigh the pricing bundle', 'Measure the JS added by the pricing route.'],
      ['task-au-copy', 'Spellcheck the plan copy', 'Proof every headline, price and footnote.'],
      ['task-au-i18n', 'Check locale formatting', 'Verify currency formatting in three locales.'],
      ['task-au-dark', 'Screenshot dark mode', 'Capture the pricing page in dark mode.'],
      ['task-au-flags', 'Verify the launch flag', 'Confirm the flag defaults and kill-switch.'],
    ];
    checks.forEach(([id, desc, prompt], i) => {
      const t0 = 4800 + i * 900;
      at(t0, () => {
        const n = spawn(audit, id, 'subagent', 'explore', 'claude-haiku-4-5-20251001', desc, prompt);
        at(500, () => toolCall(n, 'Read', `pricing/checks/${i + 1}.md`));
        at(1000, () => toolBack(n, 'Read', 'Read 32 lines'));
        if (i < checks.length - 1) {
          at(2100, () => finishNode(n, `${desc} — pass.`, 0.002, tu(2200, 400)));
        } else {
          at(1800, () => pushEvent(n, 'text', 'Flag defaults look right; confirming the kill-switch.'));
        }
      });
    });
  });

  // ---- demo keep-alive: the landing page's "Running now" must never go empty ----
  // The script above finishes s1 (~7s) and the worker node (~12.5s). This chained
  // heartbeat restores s1/root to running when the script ends and keeps the first
  // opencode worker running with a ticking elapsedS, so the static demo always feels
  // alive. Everything goes through at()/clearAll(), so a user stop() still halts it,
  // and nothing here touches the network.
  const keepAlive = () => {
    at(9000, () => {
      const r = nodeMaps.get(s1.id)?.get('root');
      if (s1.status === 'done' || s1.status === 'stopped' || (r && (r.status === 'done' || r.status === 'stopped'))) {
        s1.status = 'running';
        s1.pendingPermissions = 0;
        s1.resumable = false;
        if (r) {
          r.status = 'running';
          r.endedAt = undefined;
          r.result = undefined;
          pushEvent(r, 'text', 'Demo loop: replaying the scripted run — nothing actually executes.');
          upsertHead(r);
        }
        bumpSession(s1.id);
      } else if (r && (r.status === 'running' || r.status === 'waiting')) {
        pushEvent(r, 'text', 'Demo heartbeat: scripted activity continues.');
        bumpSession(s1.id);
      }
      const w = workerTasks[0];
      if (w.lane === 'opencode') {
        if (w.state !== 'running') {
          w.state = 'running';
          delete w.endedAt;
        }
        w.elapsedS += 9;
        emit?.({ type: 'workers.update', workers: workerTasks.map((t) => ({ ...t, toolCounts: { ...t.toolCounts } })) });
      }
      keepAlive();
    });
  };
  keepAlive();

  // ---- backend surface ----

  const mockUsage: UsageReport = {
    claude: {
      available: true,
      asOf: new Date(base).toISOString(),
      subscription: 'max',
      source: 'probe',
      fiveHour: { utilization: 42, resetsAt: new Date(base + 1_800_000).toISOString() },
      sevenDay: { utilization: 18, resetsAt: new Date(base + 40_000_000).toISOString() },
      sevenDayOpus: { utilization: 11, resetsAt: new Date(base + 40_000_000).toISOString() },
    },
    opencode: {
      available: true,
      asOf: new Date(base).toISOString(),
      windows: [
        { days: 1, tokens: 184_000, costUsd: 0.34 },
        { days: 7, tokens: 1_120_000, costUsd: 2.11 },
        { days: 30, tokens: 3_450_000, costUsd: 6.4 },
      ],
    },
    agy: {
      available: true,
      asOf: new Date(base).toISOString(),
      windows: [
        { days: 1, tokens: 96_000, runs: 5, stopped: 1 },
        { days: 7, tokens: 640_000, runs: 23, stopped: 4 },
      ],
      limits: [
        { group: 'Gemini', window: '5h', utilization: 12, resetsAt: new Date(base + 4 * 3_600_000).toISOString() },
        { group: 'Gemini', window: 'weekly', utilization: 31, resetsAt: new Date(base + 3 * 86_400_000).toISOString() },
        { group: 'Claude/GPT', window: '5h', utilization: 0, resetsAt: new Date(base + 5 * 3_600_000).toISOString() },
        { group: 'Claude/GPT', window: 'weekly', utilization: 8, resetsAt: new Date(base + 4 * 86_400_000).toISOString() },
      ],
    },
  };

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
        resumable: false,
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
      s.resumable = false;
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
          s.resumable = true;
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
      s.resumable = true;
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
          { name: 'lead-dev-hybrid', description: 'Plans and fans work out to a swarm', scope: 'user' },
          { name: 'explore', description: 'Fast read-only codebase scout', scope: 'user' },
          { name: 'frontend-specialist', description: 'UI implementation specialist', scope: 'project' },
        ],
      } satisfies AgentsResponse),
    cwds: () =>
      Promise.resolve([
        '/home/demo/work/acme-web',
        '/home/demo/work/docs-site',
        '/home/demo/swarmkit/cli',
      ]),
    dirs: (rawPath, hidden) => {
      const path = rawPath && rawPath.trim() ? rawPath.trim() : MOCK_HOME;
      const entries = dirTree.get(path) ?? [];
      const parent = path === MOCK_HOME ? undefined : path.slice(0, path.lastIndexOf('/')) || undefined;
      const listing: DirListing = {
        path,
        parent,
        entries: entries
          .filter((e) => hidden || !e.name.startsWith('.'))
          .map((e) => ({ ...e })),
      };
      return Promise.resolve(listing);
    },
    workers: () =>
      Promise.resolve(workerTasks.map((t) => ({ ...t, toolCounts: { ...t.toolCounts } }))),
    workerLog: (lane, repo, slug) => {
      const t = workerTasks.find((w) => w.lane === lane && w.repo === repo && w.slug === slug);
      if (!t) return Promise.reject(new ApiError(404, 'worker log not found'));
      return Promise.resolve({ lines: workerLogLines(t) });
    },
    usage: () => Promise.resolve<UsageReport>(mockUsage),
    resume: (sessionId, body: ResumeSessionBody) => {
      const s = sessions.get(sessionId);
      const map = nodeMaps.get(sessionId);
      if (!s || !map) return Promise.reject(new ApiError(404, 'session not found'));
      const root = map.get('root');
      if (s.status === 'running' || s.status === 'waiting') {
        return Promise.reject(new ApiError(409, 'This session is still active in a terminal'));
      }
      // Terminal resume becomes page-owned; the same session id keeps its transcript.
      s.source = 'page';
      s.status = 'running';
      s.resumable = false;
      if (root) {
        root.status = 'running';
        root.endedAt = undefined;
        root.result = undefined;
        pushEvent(root, 'user', body.text.split('\n')[0], { detail: body.text });
        upsertHead(root);
        at(1800, () => {
          if (root.status === 'running') pushEvent(root, 'text', 'Continuing — scripted mock reply.');
        });
        at(3600, () => {
          if (root.status === 'running') finishNode(root, 'Continued and finished (mock).', 0.012, tu(2400, 700));
        });
      }
      bumpSession(sessionId);
      return Promise.resolve({ sessionId } satisfies StartSessionResponse);
    },
    connect(onEvent, onStatus) {
      emit = onEvent;
      onStatus(true);
      emit({ type: 'hello', sessions: Array.from(sessions.values()).map((s) => ({ ...s })) });
      emit({ type: 'workers.update', workers: workerTasks.map((t) => ({ ...t, toolCounts: { ...t.toolCounts } })) });
      upsertHead(root);
      return () => clearAll();
    },
  };
}
