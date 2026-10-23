// HTTP + SSE wrappers around the server contract in ../shared/types.
import type {
  ActivityEvent,
  AgentNodeHead,
  AgentsResponse,
  PermissionRequest,
  ServerEvent,
  SessionDetail,
  SessionSummary,
  StartSessionBody,
  StartSessionResponse,
} from '../shared/types';

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Wraps promises so a 401 can flip the UI to the token screen; resolves undefined on 401, rethrows the rest. */
export type Guard = <T>(p: Promise<T>) => Promise<T | undefined>;

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      credentials: 'same-origin',
      ...init,
      headers: init?.body ? { 'content-type': 'application/json', ...init.headers } : init?.headers,
    });
  } catch (e) {
    throw new ApiError(0, `Network error: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) throw new ApiError(res.status, `${init?.method ?? 'GET'} ${url} failed (${res.status})`);
  return (await res.json()) as T;
}

/** Everything the UI can do against the fleet server. The mock implements the same surface. */
export interface FleetBackend {
  sessions(): Promise<SessionSummary[]>;
  detail(id: string): Promise<SessionDetail>;
  start(body: StartSessionBody): Promise<StartSessionResponse>;
  send(sessionId: string, text: string): Promise<unknown>;
  interrupt(sessionId: string): Promise<unknown>;
  stop(sessionId: string): Promise<unknown>;
  decide(permissionId: string, allow: boolean, message?: string): Promise<unknown>;
  agents(cwd: string): Promise<AgentsResponse>;
  cwds(): Promise<string[]>;
  connect(
    onEvent: (ev: ServerEvent) => void,
    onStatus: (connected: boolean) => void,
  ): () => void;
}

export const apiBackend: FleetBackend = {
  sessions: () => request('/api/sessions'),
  detail: (id) => request(`/api/sessions/${encodeURIComponent(id)}`),
  start: (body) =>
    request('/api/sessions', { method: 'POST', body: JSON.stringify(body) }),
  send: (sessionId, text) =>
    request(`/api/sessions/${encodeURIComponent(sessionId)}/message`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),
  interrupt: (sessionId) =>
    request(`/api/sessions/${encodeURIComponent(sessionId)}/interrupt`, { method: 'POST' }),
  stop: (sessionId) => request(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' }),
  decide: (permissionId, allow, message) =>
    request(`/api/permissions/${encodeURIComponent(permissionId)}`, {
      method: 'POST',
      body: JSON.stringify(message === undefined ? { allow } : { allow, message }),
    }),
  agents: (cwd) => request(`/api/agents?cwd=${encodeURIComponent(cwd)}`),
  cwds: () => request('/api/cwds'),
  connect(onEvent, onStatus) {
    // EventSource reconnects on its own with backoff; we surface the state and
    // let App refetch the selected detail when the stream reopens.
    const es = new EventSource('/events');
    es.onopen = () => onStatus(true);
    es.onmessage = (m) => {
      try {
        onEvent(JSON.parse(m.data) as ServerEvent);
      } catch {
        // malformed frame — ignore, the stream continues
      }
    };
    es.onerror = () => onStatus(false);
    return () => es.close();
  },
};

// Re-exported so other modules can share the exact event payload types.
export type { ActivityEvent, AgentNodeHead, PermissionRequest, SessionDetail, SessionSummary };
