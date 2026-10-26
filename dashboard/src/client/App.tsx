// Top-level app: routing state and chrome (the backend is resolved in main.tsx).
import { Component, useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import type { PermissionRequest, SessionSummary, WorkerTask } from '../shared/types';
import { ApiError, authenticate } from './api';
import type { FleetBackend, Guard } from './api';
import { Archive } from './Archive';
import { Composer } from './Composer';
import { Continue } from './Continue';
import { AgentTabs } from './AgentTabs';
import { ChatView } from './ChatView';
import { agentTabs } from './chat';
import { Drawer } from './Drawer';
import { Orb } from './Orb';
import { fmtCost, UNTRUSTED_NOTICE } from './format';
import { Logo } from './icons';
import { Landing } from './Landing';
import { NewSession } from './NewSession';
import { packInstallDone, RestartBanner } from './RestartBanner';
import { TopBar } from './TopBar';
import { initialState, nodeById, reducer } from './state';
import { Tree } from './Tree';
import { useUsage } from './Usage';
import { WorkerDrawer } from './WorkerDrawer';
import { workerKey, WorkersView } from './Workers';

const RESTART_KEY = 'fleet.restart-dismissed';

function readDismissed(): string[] {
  try {
    return JSON.parse(sessionStorage.getItem(RESTART_KEY) ?? '[]') as string[];
  } catch {
    return [];
  }
}

function useTicker(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [active]);
  return now;
}

/** Pad the composer zone above the on-screen keyboard (visualViewport, iOS-safe). */
function useKeyboardInset(): void {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const apply = () => {
      const kb = Math.max(0, Math.round(window.innerHeight - vv.height));
      document.documentElement.style.setProperty('--kb', `${kb}px`);
    };
    apply();
    vv.addEventListener('resize', apply);
    vv.addEventListener('scroll', apply);
    return () => {
      vv.removeEventListener('resize', apply);
      vv.removeEventListener('scroll', apply);
    };
  }, []);
}

/** True when an error looks like a stale lazy chunk after a redeploy. */
export function isStaleChunkError(message: string): boolean {
  return /dynamically imported module|importing a module script failed|failed to fetch dynamically imported module|error loading dynamically imported module/i.test(
    message,
  );
}

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  readonly state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('SwarmKit crashed:', error, info.componentStack);
  }
  render() {
    if (this.state.error) {
      if (isStaleChunkError(this.state.error.message)) {
        return (
          <div className="crash">
            <div>
              <Logo size={40} />
              <p style={{ fontWeight: 600 }}>SwarmKit was updated.</p>
              <p className="muted" style={{ fontSize: 12.5 }}>Reload to load the new version.</p>
              <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
                Reload
              </button>
            </div>
          </div>
        );
      }
      return (
        <div className="crash">
          <div>
            <Logo size={40} />
            <p style={{ fontWeight: 600 }}>SwarmKit hit an error.</p>
            <p className="muted" style={{ fontSize: 12.5 }}>{this.state.error.message}</p>
            <button type="button" className="btn btn-primary" onClick={() => this.setState({ error: null })}>
              Try again
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function TokenScreen() {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const signIn = useCallback(async (raw: string) => {
    const t = raw.trim();
    if (!t) return;
    setBusy(true);
    setError(null);
    try {
      await authenticate(t);
      window.location.reload();
    } catch (e) {
      setError(e instanceof ApiError && e.status === 401 ? 'That token was not accepted.' : e instanceof Error ? e.message : 'Sign-in failed.');
      setBusy(false);
    }
  }, []);

  // A `#token=…` fragment signs in once, then is stripped from the address bar.
  useEffect(() => {
    const fromHash = () => {
      const m = /^#token=(.+)$/.exec(window.location.hash);
      if (!m) return;
      let t = m[1];
      try {
        t = decodeURIComponent(t);
      } catch {
        // keep the raw fragment
      }
      history.replaceState(null, '', window.location.pathname + window.location.search);
      void signIn(t);
    };
    fromHash();
    window.addEventListener('hashchange', fromHash);
    return () => window.removeEventListener('hashchange', fromHash);
  }, [signIn]);

  return (
    <div className="center-screen">
      <div className="token-card">
        <Logo size={40} />
        <h1>SwarmKit</h1>
        <p>This dashboard needs an access token. Paste it and press Open — the server will set a cookie.</p>
        <p className="muted token-hint">Enter your SwarmKit access token once on this device; it stays signed in for 30 days.</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void signIn(token);
          }}
        >
          <input
            aria-label="Access token"
            type="password"
            autoComplete="off"
            placeholder="swarmkit access token"
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
          <button type="submit" className="btn btn-primary" disabled={busy || !token.trim()}>
            {busy ? 'Opening…' : 'Open'}
          </button>
        </form>
        {error && (
          <p className="dialog-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

function readSessionView(): 'chat' | 'map' {
  try {
    return localStorage.getItem('fleet.sessionView') === 'map' ? 'map' : 'chat';
  } catch {
    return 'chat';
  }
}

function Topbar({
  session,
  sessionView,
  onView,
}: {
  session: SessionSummary;
  sessionView: 'chat' | 'map';
  onView: (v: 'chat' | 'map') => void;
}) {
  return (
    <header className="topbar">
      <div className="topbar-title">
        <h1>{session.title || session.project}</h1>
        <p className="topbar-cwd" title={session.cwd}>
          {session.cwd}
        </p>
      </div>
      {session.runtime === 'opencode' && <span className="badge rt-opencode">OpenCode</span>}
      {session.runtime === 'agy' && <span className="badge rt-agy">Antigravity</span>}
      <div className="view-toggle" role="group" aria-label="Session view">
        <button
          type="button"
          aria-pressed={sessionView === 'chat'}
          className={sessionView === 'chat' ? 'is-active' : undefined}
          onClick={() => onView('chat')}
        >
          Chat
        </button>
        <button
          type="button"
          aria-pressed={sessionView === 'map'}
          className={sessionView === 'map' ? 'is-active' : undefined}
          onClick={() => onView('map')}
        >
          Map
        </button>
      </div>
      <div className="topbar-meta">
        {session.pendingPermissions > 0 && (
          <span className="pending-chip" title="Waiting on your decision">
            {session.pendingPermissions} pending
          </span>
        )}
        <span className={`node-status st-${session.status}`}>
          <i className="dot" aria-hidden="true" />
          {session.status}
        </span>
        <span className="topbar-cost">{fmtCost(session.costUsd)}</span>
      </div>
    </header>
  );
}

function App({ backend, mock }: { backend: FleetBackend; mock: boolean }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const stateRef = useRef(state);
  stateRef.current = state;
  const [authNeeded, setAuthNeeded] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [drawerNodeId, setDrawerNodeId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);
  const [view, setView] = useState<'session' | 'workers' | 'archive'>('session');
  const [workerDrawerKey, setWorkerDrawerKey] = useState<string | null>(null);
  const [endedDraft, setEndedDraft] = useState<{ id: string; text: string } | null>(null);
  const [restartBusy, setRestartBusy] = useState(false);
  const [dismissedRestart, setDismissedRestart] = useState<string[]>(readDismissed);
  const [sessionView, setSessionView] = useState<'chat' | 'map'>(readSessionView);
  const [activeAgentId, setActiveAgentId] = useState('root');
  const [returnStay, setReturnStay] = useState(false);
  const workersAtRef = useRef(Date.now());

  useEffect(() => {
    try {
      localStorage.setItem('fleet.sessionView', sessionView);
    } catch {
      // private mode — per pageload then
    }
  }, [sessionView]);

  /** Wrap every call: a 401 surfaces the token screen instead of crashing. */
  const guard = useCallback<Guard>(async (p) => {
    try {
      return await p;
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setAuthNeeded(true);
        return undefined;
      }
      throw e;
    }
  }, []);

  const guardSilent = useCallback(
    <T,>(p: Promise<T>) => guard(p).catch((): undefined => undefined),
    [guard],
  );

  useKeyboardInset();

  // Usage report shared by the landing panel and the sidebar pill.
  // Inactive until auth succeeds: the token screen shouldn't poll the API.
  const usage = useUsage(backend, guard, !authNeeded);

  // Live event stream.
  useEffect(() => {
    return backend.connect(
      (ev) => {
        if (ev.type === 'workers.update') workersAtRef.current = Date.now();
        dispatch({ type: 'ev', ev });
      },
      (up) => {
        dispatch({ type: 'connected', connected: up });
        if (up) {
          // Stream reopened (or first hello): refresh the selected detail so
          // anything missed while offline lands.
          const sel = stateRef.current.selectedId;
          if (sel) {
            guardSilent(backend.detail(sel)).then((d) => {
              if (d) dispatch({ type: 'detail', detail: d });
            });
          }
        }
      },
    );
  }, [backend, guardSilent]);

  // Initial session list (the hello event also refreshes it).
  useEffect(() => {
    guardSilent(backend.sessions()).then((sessions) => {
      if (sessions) dispatch({ type: 'ev', ev: { type: 'hello', sessions } });
    });
  }, [backend, guardSilent]);

  // Initial worker list (the workers.update event right after connect also refreshes it).
  useEffect(() => {
    guardSilent(backend.workers()).then((w) => {
      if (w) {
        workersAtRef.current = Date.now();
        dispatch({ type: 'ev', ev: { type: 'workers.update', workers: w } });
      }
    });
  }, [backend, guardSilent]);

  // Load (or retry) the selected session's detail.
  const detail = state.selectedId ? state.details[state.selectedId] : undefined;
  const selected = useMemo(
    () => state.sessions.find((s) => s.id === state.selectedId) ?? detail,
    [state.sessions, state.selectedId, detail],
  );

  const prevSelected = useRef<string | null>(null);
  useEffect(() => {
    if (prevSelected.current !== state.selectedId) {
      prevSelected.current = state.selectedId;
      setDrawerNodeId(null);
      setLoadError(false);
      setActiveAgentId('root');
      setReturnStay(false);
    }
    if (state.selectedId && !state.details[state.selectedId]) {
      guard(backend.detail(state.selectedId))
        .then((d) => {
          if (d) dispatch({ type: 'detail', detail: d });
          else setLoadError(true);
        })
        .catch(() => setLoadError(true));
    }
  }, [state.selectedId, state.details, backend, guard, retryNonce]);

  const baseActive =
    detail?.nodes.some((n) => n.status === 'running' || n.status === 'waiting') ||
    state.workers.some((w) => w.state === 'running') ||
    state.sessions.some((s) => s.status === 'running' || s.status === 'waiting');
  const recentEnd = detail?.nodes.some((n) => n.endedAt != null && Date.now() - n.endedAt < 10_000) ?? false;
  const anyActive = Boolean(baseActive) || recentEnd;
  const now = useTicker(anyActive);
  const tabs = detail ? agentTabs(detail.nodes, now, detail.permissions) : [];

  const visibleTabs = tabs.slice();
  if (detail && activeAgentId !== 'root' && !visibleTabs.some((t) => t.node.id === activeAgentId)) {
    const kept = nodeById(detail, activeAgentId);
    if (kept) {
      const phase =
        kept.status === 'waiting'
          ? 'waiting'
          : kept.status === 'running'
            ? 'live'
            : kept.status === 'done' || kept.status === 'idle'
              ? 'done'
              : 'error';
      visibleTabs.push({ node: kept, phase });
    }
  }
  const activeNode = detail
    ? (nodeById(detail, activeAgentId) ??
      detail.nodes.find((n) => n.kind === 'main') ??
      detail.nodes.find((n) => n.id === 'root') ??
      detail.nodes[0])
    : undefined;

  const drawerNode = detail && drawerNodeId ? nodeById(detail, drawerNodeId) : undefined;
  const drawerTask = workerDrawerKey
    ? state.workers.find((w) => workerKey(w) === workerDrawerKey)
    : undefined;

  const openNode = useCallback((nodeId: string) => setDrawerNodeId(nodeId), []);
  const selectSession = useCallback((id: string) => {
    dispatch({ type: 'select', sessionId: id });
    setView('session');
  }, []);
  const onStarted = useCallback((id: string) => {
    setNewOpen(false);
    setDrawerNodeId(null);
    dispatch({ type: 'select', sessionId: id });
    setView('session');
  }, []);

  const openWorker = useCallback((task: WorkerTask) => setWorkerDrawerKey(workerKey(task)), []);

  // Home just clears the selection: the landing page is the home screen, and the
  // reducer never re-selects a session, so later 'detail' events can't pull us
  // back into a session.
  const goHome = useCallback(() => {
    dispatch({ type: 'select', sessionId: null });
    setView('session');
  }, []);

  const viewWorkerInTree = useCallback(
    (sessionId: string, nodeId: string) => {
      setWorkerDrawerKey(null);
      selectSession(sessionId);
      setSessionView('map');
      setDrawerNodeId(nodeId);
    },
    [selectSession],
  );

  const decide = useCallback(
    (p: PermissionRequest, allow: boolean, message?: string, answers?: Record<string, string>) => {
      void guardSilent(backend.decide(p.id, allow, message, answers));
    },
    [backend, guardSilent],
  );

  // ---- restart after a pack install ----
  const restartNeeded = detail ? packInstallDone(detail.nodes) : false;
  const showRestart =
    view === 'session' && restartNeeded && selected != null && !dismissedRestart.includes(selected.id);

  const dismissRestart = useCallback(() => {
    const id = stateRef.current.selectedId;
    if (!id) return;
    setDismissedRestart((prev) => {
      const next = prev.includes(id) ? prev : [...prev, id];
      try {
        sessionStorage.setItem(RESTART_KEY, JSON.stringify(next));
      } catch {
        // private mode — dismissal is per pageload then
      }
      return next;
    });
  }, []);

  const restartSession = useCallback(async () => {
    const id = stateRef.current.selectedId;
    if (!id || restartBusy) return;
    setRestartBusy(true);
    try {
      await guard(backend.stop(id));
      await guard(
        backend.resume(id, {
          text: 'The new agents are installed and the session was restarted. Continue the task where you left off.',
        }),
      );
      const d = await guard(backend.detail(id));
      if (d) dispatch({ type: 'detail', detail: d });
      dismissRestart();
    } catch {
      // keep the banner up so the user can retry
    }
    setRestartBusy(false);
  }, [backend, guard, restartBusy, dismissRestart]);

  /** A 409 from message/interrupt means the query is gone: switch the composer to Continue, keeping the text. */
  const callSession = useCallback(
    async (call: (id: string) => Promise<unknown>, text = '') => {
      const id = stateRef.current.selectedId;
      if (!id) return;
      try {
        await guard(call(id));
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) {
          setEndedDraft({ id, text });
          return;
        }
        throw e;
      }
    },
    [guard],
  );

  // ---- continue (resume) ----
  const handleResumed = useCallback(
    (id: string) => {
      setEndedDraft(null);
      setView('session');
      guardSilent(backend.detail(id)).then((d) => {
        if (d) dispatch({ type: 'detail', detail: d });
      });
    },
    [backend, guardSilent],
  );

  const returnName = activeNode
    ? activeNode.kind === 'worker' && activeNode.worker
      ? `${activeNode.worker.lane} · ${activeNode.worker.slug}`
      : activeNode.agentType
    : '';
  // Auto-return only when the viewed agent finishes while we watch it; opening an
  // already finished agent stays put.
  const activeEnded =
    !!activeNode &&
    activeAgentId !== 'root' &&
    (activeNode.status === 'done' ||
      activeNode.status === 'idle' ||
      activeNode.status === 'error' ||
      activeNode.status === 'stopped');
  const activeLive = !!activeNode && (activeNode.status === 'running' || activeNode.status === 'waiting');
  const seenLiveRef = useRef<string | null>(null);
  if (activeAgentId === 'root') seenLiveRef.current = null;
  else if (activeLive) seenLiveRef.current = `${detail?.id}:${activeAgentId}`;
  const showReturn =
    sessionView === 'chat' && activeEnded && seenLiveRef.current === `${detail?.id}:${activeAgentId}`;

  useEffect(() => {
    setReturnStay(false);
  }, [activeAgentId, detail?.id]);

  useEffect(() => {
    if (!showReturn || returnStay) return;
    const t = window.setTimeout(() => setActiveAgentId('root'), 3000);
    return () => window.clearTimeout(t);
  }, [showReturn, returnStay, activeAgentId, detail?.id]);

  if (authNeeded) return <TokenScreen />;

  const ended = !!selected && endedDraft?.id === selected.id;
  const running = selected && !ended ? selected.status === 'running' || selected.status === 'waiting' : false;
  const canContinue = !!selected && !running;

  return (
    <div className="app">
      <div className="main">
        <TopBar
          sessions={state.sessions}
          workers={state.workers}
          selectedId={state.selectedId}
          connected={state.connected || mock}
          usage={usage.report ?? undefined}
          onHome={goHome}
          onSelect={selectSession}
          onOpenWorkers={() => setView('workers')}
          onOpenArchive={() => setView('archive')}
          onNew={() => setNewOpen(true)}
        />
        {view === 'session' && selected && (
          <Topbar session={selected} sessionView={sessionView} onView={setSessionView} />
        )}
        {view === 'session' && selected?.untrustedProject && (
          <p className="notice" role="note">
            {UNTRUSTED_NOTICE}
          </p>
        )}
        {!state.connected && !mock && (
          <div className="conn-banner" aria-live="polite">
            Connection lost — reconnecting…
          </div>
        )}

        {view === 'workers' ? (
          <WorkersView workers={state.workers} now={now} at={workersAtRef.current} onOpen={openWorker} />
        ) : view === 'archive' ? (
          <Archive sessions={state.sessions} now={now} onSelect={selectSession} />
        ) : !selected ? (
          <Landing
            backend={backend}
            guard={guard}
            sessions={state.sessions}
            workers={state.workers}
            now={now}
            connected={state.connected || mock}
            usage={usage.report}
            usageLoading={usage.loading}
            onRefreshUsage={usage.refresh}
            onSelect={selectSession}
            onOpenWorker={openWorker}
            onOpenWorkers={() => setView('workers')}
            onOpenArchive={() => setView('archive')}
            onStarted={onStarted}
          />
        ) : !detail ? (
          loadError ? (
            <div className="canvas-empty">
              <div>
                <p>Couldn’t load this session.</p>
                <button type="button" className="btn btn-ghost" onClick={() => setRetryNonce((n) => n + 1)}>
                  Retry
                </button>
              </div>
            </div>
          ) : (
            <div className="canvas-loading" aria-live="polite">
              <Orb size={32} state="connecting" color="#d9ccff" />
              Loading session…
            </div>
          )
        ) : sessionView === 'chat' && activeNode ? (
          <>
            {(visibleTabs.length > 0 || activeAgentId !== 'root') && (
              <AgentTabs
                tabs={visibleTabs}
                activeId={activeAgentId}
                now={now}
                workers={state.workers}
                workersAt={workersAtRef.current}
                onSelect={setActiveAgentId}
              />
            )}
            <ChatView
              key={`${detail.id}:${activeNode.id}`}
              node={activeNode}
              nodes={detail.nodes}
              permissions={detail.permissions}
              workers={state.workers}
              workersAt={workersAtRef.current}
              now={now}
              onOpenAgent={setActiveAgentId}
              onDecide={decide}
              onOpenWorkerLog={(task) => setWorkerDrawerKey(workerKey(task))}
            />
          </>
        ) : (
          <Tree
            key={`tree:${detail.id}`}
            nodes={detail.nodes}
            permissions={detail.permissions}
            workers={state.workers}
            workersAt={workersAtRef.current}
            now={now}
            openNodeId={drawerNodeId}
            onOpen={openNode}
            onDecide={decide}
          />
        )}

        {detail && showRestart && (
          <RestartBanner
            source={detail.source}
            busy={restartBusy}
            onRestart={() => void restartSession()}
            onDismiss={dismissRestart}
          />
        )}

        {view === 'session' && selected && showReturn && !returnStay && (
          <div className="chat-return" role="status">
            <span>✓ {returnName} finished — returning to Main</span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setReturnStay(true)}>
              Stay
            </button>
          </div>
        )}

        {view === 'session' && selected && (
          selected.source === 'page' && running ? (
            <Composer
              key={`composer:${selected.id}`}
              onSend={(text, images) => callSession((id) => backend.send(id, text, images), text)}
              onInterrupt={() => callSession((id) => backend.interrupt(id))}
              onStop={() => {
                if (state.selectedId) void guardSilent(backend.stop(state.selectedId));
              }}
              loadCommands={() => backend.commands(selected.id).then((r) => r.commands)}
            />
          ) : running ? (
            <div className="readonly-bar">
              Read-only — this session is running in a terminal. Continue becomes available when it stops.
            </div>
          ) : canContinue ? (
            <Continue
              key={`${selected.id}:${ended ? 'ended' : ''}`}
              initialText={ended ? endedDraft?.text : undefined}
              ended={ended}
              backend={backend}
              guard={guard}
              sessionId={selected.id}
              source={selected.source}
              onResumed={handleResumed}
              loadCommands={() => backend.commands(selected.id).then((r) => r.commands)}
            />
          ) : null
        )}
      </div>

      {drawerNode && sessionView === 'map' && view === 'session' && (
        <Drawer node={drawerNode} onClose={() => setDrawerNodeId(null)} />
      )}

      {drawerTask && (
        <WorkerDrawer
          task={drawerTask}
          backend={backend}
          guard={guard}
          now={now}
          at={workersAtRef.current}
          onClose={() => setWorkerDrawerKey(null)}
          onViewInTree={viewWorkerInTree}
        />
      )}

      {newOpen && (
        <NewSession
          backend={backend}
          guard={guard}
          onClose={() => setNewOpen(false)}
          onStarted={onStarted}
        />
      )}
    </div>
  );
}

export default function AppRoot({ backend, mock }: { backend: FleetBackend; mock: boolean }) {
  return (
    <ErrorBoundary>
      <App backend={backend} mock={mock} />
    </ErrorBoundary>
  );
}
