// Client state: one reducer keyed by session id (details cache) and node id (nodes inside a detail).
import type {
  ActivityEvent,
  AgentNode,
  AgentNodeHead,
  PermissionRequest,
  ServerEvent,
  SessionDetail,
  SessionSummary,
} from '../shared/types';

export interface AppState {
  sessions: SessionSummary[];
  selectedId: string | null;
  details: Record<string, SessionDetail>;
  connected: boolean;
}

export type Action =
  | { type: 'sessions'; sessions: SessionSummary[] }
  | { type: 'ev'; ev: ServerEvent }
  | { type: 'detail'; detail: SessionDetail }
  | { type: 'select'; sessionId: string | null }
  | { type: 'connected'; connected: boolean };

export const initialState: AppState = { sessions: [], selectedId: null, details: {}, connected: false };

const byRecency = (a: SessionSummary, b: SessionSummary) => b.updatedAt - a.updatedAt;

function mergeSessions(list: SessionSummary[], s: SessionSummary): SessionSummary[] {
  const i = list.findIndex((x) => x.id === s.id);
  const next = i >= 0 ? list.map((x) => (x.id === s.id ? s : x)) : [...list, s];
  return next.sort(byRecency);
}

function pickDefault(list: SessionSummary[]): string | null {
  if (list.length === 0) return null;
  return (list.find((s) => s.source === 'page') ?? list[0]).id;
}

function mergeHead(detail: SessionDetail, head: AgentNodeHead): SessionDetail {
  const i = detail.nodes.findIndex((n) => n.id === head.id);
  const nodes: AgentNode[] =
    i >= 0
      ? detail.nodes.map((n) => (n.id === head.id ? { ...n, ...head, events: n.events } : n))
      : [...detail.nodes, { ...head, events: [] }];
  return { ...detail, nodes };
}

function appendEvent(detail: SessionDetail, nodeId: string, event: ActivityEvent): SessionDetail {
  const i = detail.nodes.findIndex((n) => n.id === nodeId);
  if (i < 0) return detail;
  return {
    ...detail,
    nodes: detail.nodes.map((n) =>
      n.id === nodeId && !n.events.some((e) => e.id === event.id)
        ? { ...n, events: [...n.events, event], lastActivity: event.summary }
        : n,
    ),
  };
}

function appendPermission(detail: SessionDetail, request: PermissionRequest): SessionDetail {
  if (detail.permissions.some((p) => p.id === request.id)) return detail;
  return { ...detail, permissions: [...detail.permissions, request] };
}

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'sessions': {
      const sessions = [...action.sessions].sort(byRecency);
      return { ...state, sessions, selectedId: state.selectedId ?? pickDefault(sessions) };
    }

    case 'ev': {
      const ev = action.ev;
      switch (ev.type) {
        case 'hello': {
          const sessions = [...ev.sessions].sort(byRecency);
          return { ...state, sessions, selectedId: state.selectedId ?? pickDefault(sessions) };
        }
        case 'session.upsert': {
          const sessions = mergeSessions(state.sessions, ev.session);
          const cached = state.details[ev.session.id];
          const details = cached
            ? { ...state.details, [ev.session.id]: { ...cached, ...ev.session } }
            : state.details;
          return { ...state, sessions, details };
        }
        case 'session.removed': {
          const sessions = state.sessions.filter((s) => s.id !== ev.sessionId);
          const details = { ...state.details };
          delete details[ev.sessionId];
          const selectedId =
            state.selectedId === ev.sessionId ? pickDefault(sessions) : state.selectedId;
          return { ...state, sessions, details, selectedId };
        }
        case 'node.upsert': {
          const cached = state.details[ev.node.sessionId];
          if (!cached) return state;
          return {
            ...state,
            details: { ...state.details, [ev.node.sessionId]: mergeHead(cached, ev.node) },
          };
        }
        case 'node.event': {
          const cached = state.details[ev.sessionId];
          if (!cached) return state;
          return {
            ...state,
            details: {
              ...state.details,
              [ev.sessionId]: appendEvent(cached, ev.nodeId, ev.event),
            },
          };
        }
        case 'permission.request': {
          const cached = state.details[ev.request.sessionId];
          if (!cached) return state;
          return {
            ...state,
            details: {
              ...state.details,
              [ev.request.sessionId]: appendPermission(cached, ev.request),
            },
          };
        }
        case 'permission.resolved': {
          const cached = state.details[ev.sessionId];
          if (!cached) return state;
          return {
            ...state,
            details: {
              ...state.details,
              [ev.sessionId]: {
                ...cached,
                permissions: cached.permissions.filter((p) => p.id !== ev.id),
              },
            },
          };
        }
      }
      return state;
    }

    case 'detail': {
      const sessions = mergeSessions(state.sessions, action.detail);
      return {
        ...state,
        sessions,
        details: { ...state.details, [action.detail.id]: action.detail },
        selectedId: state.selectedId ?? action.detail.id,
      };
    }

    case 'select':
      return { ...state, selectedId: action.sessionId };

    case 'connected':
      return { ...state, connected: action.connected };

    default:
      return state;
  }
}

export function nodeById(detail: SessionDetail | undefined, id: string): AgentNode | undefined {
  return detail?.nodes.find((n) => n.id === id);
}

export function permissionFor(
  detail: SessionDetail | undefined,
  nodeId: string,
): PermissionRequest | undefined {
  return detail?.permissions.find((p) => p.nodeId === nodeId);
}
