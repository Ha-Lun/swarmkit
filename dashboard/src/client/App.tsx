// Top-level app: routing state and chrome (the backend is resolved in main.tsx).
import { Component, useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import type { DecideOptions, GitInfo, PermissionRequest, SessionSummary, WorkerTask } from '../shared/types';
import { ApiError, authenticate } from './api';
import type { FleetBackend, Guard } from './api';
import { Archive } from './Archive';
import { Composer } from './Composer';
import { Continue } from './Continue';
import { AgentTabs } from './AgentTabs';
import { ChatView } from './ChatView';
import { agentLabel, agentSubtitle, agentTabs } from './chat';
import { Drawer } from './Drawer';
import { Scanner } from './Scanner';
import { fmtCost, sessionHint, UNTRUSTED_NOTICE } from './format';
import { Logo } from './icons';
import { InfoPanel } from './InfoPanel';
import { RemoteRail } from './RemoteRail';
import { Landing } from './Landing';
import { NewSession } from './NewSession';
import { packInstallDone, RestartBanner } from './RestartBanner';
import { startPresence } from './presence';
import { StatusBar } from './StatusBar';
import { initialState, nodeById, reducer } from './state';
import { TopBar } from './TopBar';
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
      // the status bar sits below the composer: hide it while the keyboard is up
      document.documentElement.classList.toggle('kb-open', kb > 0);
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

const INFO_KEY = 'fleet.info';
const INFO_WIDE = '(min-width: 1200px)';

function readInfoPref(): boolean | null {
  try {
    const v = localStorage.getItem(INFO_KEY);
    return v === '1' ? true : v === '0' ? false : null;
  } catch {
    return null;
  }
}

/** Info panel: open by default on wide screens (remembered in localStorage); on narrow screens it is an overlay that opens per visit. */
function useInfoPanel(): { open: boolean; overlay: boolean; toggle: () => void; close: () => void } {
  const [wide, setWide] = useState(() => window.matchMedia(INFO_WIDE).matches);
  const [pref, setPref] = useState<boolean | null>(readInfoPref);
  const [narrowOpen, setNarrowOpen] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(INFO_WIDE);
    const on = () => setWide(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  const open = wide ? (pref ?? true) : narrowOpen;
  const set = useCallback(
    (next: boolean) => {
      if (!wide) {
        setNarrowOpen(next);
        return;
      }
      setPref(next);
      try {
        localStorage.setItem(INFO_KEY, next ? '1' : '0');
      } catch {
        // private mode — per pageload then
      }
    },
    [wide],
  );
  const toggle = useCallback(() => set(!open), [set, open]);
  const close = useCallback(() => set(false), [set]);
  return { open, overlay: !wide, toggle, close };
}

const RESTART_TEXT =
  'The new agents are installed and the session was restarted. Continue the task where you left off.';

/** Restart control: asks first while a turn is running, since restart stops it. */
function RestartControl({
  active,
  busy,
  error,
  onRestart,
}: {
  active: boolean;
  busy: boolean;
  error: string | null;
  onRestart: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const askRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!active) setConfirming(false);
  }, [active]);
  const cancel = () => {
    setConfirming(false);
    askRef.current?.focus();
  };
  return (
    <div className="restart-ctl">
      {error && !confirming && (
        <span className="restart-ctl-error" role="alert" title={error}>
          Restart failed: {error}
        </span>
      )}
      {confirming ? (
        <span
          className="restart-ctl-confirm"
          role="group"
          aria-label="Confirm restart"
          onKeyDown={(e) => {
            if (e.key === 'Escape') cancel();
          }}
        >
          <span>Restart stops the current turn.</span>
          <button
            type="button"
            className="btn btn-sm"
            autoFocus
            onClick={() => {
              setConfirming(false);
              onRestart();
            }}
          >
            Restart
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={cancel}>
            Cancel
          </button>
        </span>
      ) : (
        <button
          ref={askRef}
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={busy}
          aria-label={busy ? 'Restarting session' : 'Restart session'}
          onClick={() => (active ? setConfirming(true) : onRestart())}
        >
          {busy ? 'Restarting…' : 'Restart'}
        </button>
      )}
    </div>
  );
}

function Topbar({
  session,
  sessionView,
  onView,
  canRestart,
  restartBusy,
  restartError,
  onRestart,
  infoOpen,
  onToggleInfo,
  isLivePage,
  onStop,
  onCloseSession,
}: {
  session: SessionSummary;
  sessionView: 'chat' | 'map';
  onView: (v: 'chat' | 'map') => void;
  canRestart: boolean;
  restartBusy: boolean;
  restartError: string | null;
  onRestart: () => void;
  infoOpen: boolean;
  onToggleInfo: () => void;
  isLivePage: boolean;
  onStop: () => void;
  onCloseSession: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!menuOpen) {
      setConfirmStop(false);
      return;
    }
    const onDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setMenuOpen(false);
        btnRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const closeMenu = () => {
    setMenuOpen(false);
    btnRef.current?.focus();
  };

  return (
    <header className="topbar">
      <h1 className="topbar-title" title={sessionHint(session)}>
        {session.title || session.project}
      </h1>
      <span className={`node-status st-${session.status} topbar-status`} title={`Status ${session.status}`}>
        <i className="dot" aria-hidden="true" />
        <span className="sr-only">{session.status}</span>
      </span>
      {session.pendingPermissions > 0 && (
        <span className="pending-chip" title="Waiting on your decision">
          {session.pendingPermissions}
        </span>
      )}
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
      <div className="topbar-menu-wrap" ref={wrapRef}>
        <button
          ref={btnRef}
          type="button"
          className="topbar-menu-btn"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label="Session actions"
          title="Session actions"
          onClick={() => setMenuOpen((v) => !v)}
        >
          <span aria-hidden="true">⋯</span>
        </button>
        {menuOpen && (
          <div className="topbar-menu" role="menu" aria-label="Session actions">
            <button
              type="button"
              role="menuitem"
              className={`topbar-menu-item${infoOpen ? ' is-active' : ''}`}
              onClick={() => {
                onToggleInfo();
                setMenuOpen(false);
              }}
            >
              {infoOpen ? 'Hide session info' : 'Show session info'}
            </button>
            {canRestart && (
              <>
                <div className="topbar-menu-sep" aria-hidden="true" />
                <RestartControl
                  active={session.status === 'running' || session.status === 'waiting'}
                  busy={restartBusy}
                  error={restartError}
                  onRestart={() => {
                    onRestart();
                    setMenuOpen(false);
                  }}
                />
              </>
            )}
            <div className="topbar-menu-sep" aria-hidden="true" />
            {isLivePage ? (
              confirmStop ? (
                <span
                  className="restart-ctl-confirm"
                  role="group"
                  aria-label="Confirm stop"
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') setConfirmStop(false);
                  }}
                >
                  <span>Stop this session?</span>
                  <button
                    type="button"
                    className="btn btn-sm btn-danger"
                    autoFocus
                    onClick={() => {
                      setConfirmStop(false);
                      setMenuOpen(false);
                      onStop();
                    }}
                  >
                    Stop session
                  </button>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirmStop(false)}>
                    Cancel
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  role="menuitem"
                  className="topbar-menu-item is-danger"
                  onClick={() => setConfirmStop(true)}
                >
                  Stop session
                </button>
              )
            ) : (
              <button
                type="button"
                role="menuitem"
                className="topbar-menu-item"
                onClick={() => {
                  setMenuOpen(false);
                  onCloseSession();
                }}
              >
                Close
              </button>
            )}
            <div className="topbar-menu-note">
              {fmtCost(session.costUsd)} · {session.runtime ?? 'claude'}
            </div>
          </div>
        )}
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
  const [restartError, setRestartError] = useState<string | null>(null);
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

  // Tell the server this tab is visible (gates terminal prompts); the mock backend's presence() is a no-op.
  useEffect(() => (authNeeded ? undefined : startPresence(backend)), [backend, authNeeded]);

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

  // Git state of the open session's cwd: refetched on open, on status changes and every 10 s while visible,
  // since the lead and its workers change files and branches as it runs.
  const [git, setGit] = useState<{ id: string; info?: GitInfo } | null>(null);
  const gitId = view === 'session' ? state.selectedId : null;
  const gitStatus = selected?.status;
  useEffect(() => {
    if (!gitId) return;
    let live = true;
    const load = () => {
      if (document.visibilityState === 'hidden') return;
      backend.git(gitId).then(
        (r) => live && setGit({ id: gitId, info: r.git }),
        () => {},
      );
    };
    load();
    const t = window.setInterval(load, 10_000);
    return () => {
      live = false;
      window.clearInterval(t);
    };
  }, [backend, gitId, gitStatus]);
  const gitInfo = git && git.id === gitId ? git.info : undefined;

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

  // Info panel entries: agents open in the chat tab (or the map drawer), workers in the worker drawer.
  const info = useInfoPanel();
  const { overlay: infoOverlay, close: closeInfo } = info;
  const openFromInfo = useCallback(
    (nodeId: string) => {
      if (sessionView === 'map') setDrawerNodeId(nodeId);
      else setActiveAgentId(nodeId);
      if (infoOverlay) closeInfo();
    },
    [sessionView, infoOverlay, closeInfo],
  );
  const openWorkerFromInfo = useCallback(
    (task: WorkerTask) => {
      openWorker(task);
      if (infoOverlay) closeInfo();
    },
    [openWorker, infoOverlay, closeInfo],
  );

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
    (p: PermissionRequest, allow: boolean, message?: string, answers?: Record<string, string>, opts?: DecideOptions) => {
      void guardSilent(backend.decide(p.id, allow, message, answers, opts));
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

  useEffect(() => setRestartError(null), [state.selectedId]);

  const restartSession = useCallback(
    async (text?: string) => {
      const id = stateRef.current.selectedId;
      if (!id || restartBusy) return;
      setRestartBusy(true);
      setRestartError(null);
      try {
        await guard(backend.restart(id, text));
        const d = await guard(backend.detail(id));
        if (d) dispatch({ type: 'detail', detail: d });
        dismissRestart();
      } catch (e) {
        // errors go to restartError, shown by the Topbar RestartControl so the user can retry
        setRestartError(e instanceof Error ? e.message : 'Restart failed');
      }
      setRestartBusy(false);
    },
    [backend, guard, restartBusy, dismissRestart],
  );

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
    ? [agentLabel(activeNode), agentSubtitle(activeNode)].filter(Boolean).join(' — ').slice(0, 80)
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

  const isLivePageSession = (s: SessionSummary) =>
    s.source === 'page' && (s.status === 'running' || s.status === 'waiting');

  /** Close a session tab: stop live page sessions (after the tab's inline confirm),
      then go home when the closed tab was selected. */
  const closeSession = useCallback(
    (id: string) => {
      const s = stateRef.current.sessions.find((x) => x.id === id);
      if (s && isLivePageSession(s)) {
        void guardSilent(backend.stop(id));
      }
      if (stateRef.current.selectedId === id) goHome();
    },
    [backend, guardSilent, goHome],
  );

  const stopSelected = useCallback(() => {
    if (state.selectedId) void guardSilent(backend.stop(state.selectedId));
  }, [backend, guardSilent, state.selectedId]);

  return (
    <div className="app">
      <TopBar
        sessions={state.sessions}
        selectedId={state.selectedId}
        onHome={goHome}
        onSelect={selectSession}
        onNew={() => setNewOpen(true)}
        onClose={closeSession}
        isLivePage={isLivePageSession}
      />
      <div className="app-body">
        <RemoteRail backend={backend} guard={guard} now={now} />
        <div className="main">
          {view === 'session' && selected && (
            <Topbar
              key={selected.id}
              session={selected}
              sessionView={sessionView}
              onView={setSessionView}
              canRestart={selected.source === 'page' && (selected.runtime ?? 'claude') === 'claude'}
              restartBusy={restartBusy}
              restartError={restartError}
              onRestart={() => void restartSession()}
              infoOpen={info.open}
              onToggleInfo={info.toggle}
              isLivePage={isLivePageSession(selected)}
              onStop={stopSelected}
              onCloseSession={goHome}
            />
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
                <Scanner size="md" state="connecting" color="#e7e9ee" />
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
                untrusted={selected?.untrustedProject === true}
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
              untrusted={selected?.untrustedProject === true}
            />
          )}

          {detail && showRestart && (
            <RestartBanner
              source={detail.source}
              busy={restartBusy}
              onRestart={() => void restartSession(RESTART_TEXT)}
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
                session={selected}
                git={gitInfo}
                onSend={(text, images, files) => callSession((id) => backend.send(id, text, images, files), text)}
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
                session={selected}
                git={gitInfo}
                sessionId={selected.id}
                source={selected.source}
                onResumed={handleResumed}
                loadCommands={() => backend.commands(selected.id).then((r) => r.commands)}
              />
            ) : null
          )}
        </div>

        {view === 'session' && selected && info.open && (
          <InfoPanel
            key={selected.id}
            session={selected}
            detail={detail}
            git={gitInfo}
            workers={state.workers}
            activeAgentId={sessionView === 'map' ? (drawerNodeId ?? '') : activeAgentId}
            overlay={info.overlay}
            onOpenAgent={openFromInfo}
            onOpenWorker={openWorkerFromInfo}
            onClose={info.close}
          />
        )}
      </div>

      <StatusBar
        sessions={state.sessions}
        workers={state.workers}
        connected={state.connected || mock}
        usage={usage.report ?? undefined}
        usageLoading={usage.loading}
        onRefreshUsage={usage.refresh}
        onOpenWorkers={() => setView('workers')}
        onOpenArchive={() => setView('archive')}
      />

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
