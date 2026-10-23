// HTTP + SSE wrappers around the server contract in ../shared/types.
import type {
  AgentsResponse,
  DirListing,
  ServerEvent,
  SessionDetail,
  SessionSummary,
  StartSessionBody,
  StartSessionResponse,
  ResumeSessionBody,
  WorkerTask,
} from '../shared/types';

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Wraps promises so a 401 can flip the UI to the token screen; resolves undefined on 401, rethrows the rest. */
export type Guard = <T>(p: Promise<T>) => Promise<T | undefined>;

/** Prefer the server's `{ error }` message (e.g. a 409's "still active in a terminal") over a generic line. */
async function errorMessage(res: Response, url: string, method?: string): Promise<string> {
  const fallback = `${method ?? 'GET'} ${url} failed (${res.status})`;
  try {
    const data = (await res.json()) as { error?: unknown };
    if (data && typeof data.error === 'string' && data.error) return data.error;
  } catch {
    // not a JSON error body — keep the fallback
  }
  return fallback;
}

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
  if (!res.ok) throw new ApiError(res.status, await errorMessage(res, url, init?.method));
  return (await res.json()) as T;
}

/** Trade the access token for the session cookie (same-origin POST). */
export async function authenticate(token: string): Promise<void> {
  await request('/api/auth', { method: 'POST', body: JSON.stringify({ token }) });
}

/** Everything the UI can do against the fleet server. The mock implements the same surface. */
export interface FleetBackend {
  sessions(): Promise<SessionSummary[]>;
  detail(id: string): Promise<SessionDetail>;
  start(body: StartSessionBody): Promise<StartSessionResponse>;
  send(sessionId: string, text: string): Promise<unknown>;
  interrupt(sessionId: string): Promise<unknown>;
  stop(sessionId: string): Promise<unknown>;
  resume(sessionId: string, body: ResumeSessionBody): Promise<StartSessionResponse>;
  decide(permissionId: string, allow: boolean, message?: string): Promise<unknown>;
  agents(cwd: string): Promise<AgentsResponse>;
  cwds(): Promise<string[]>;
  dirs(path?: string, hidden?: boolean): Promise<DirListing>;
  workers(): Promise<WorkerTask[]>;
  workerLog(lane: string, repo: string, slug: string): Promise<{ lines: string[] }>;
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
  resume: (sessionId, body) =>
    request(`/api/sessions/${encodeURIComponent(sessionId)}/resume`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  decide: (permissionId, allow, message) =>
    request(`/api/permissions/${encodeURIComponent(permissionId)}`, {
      method: 'POST',
      body: JSON.stringify(message === undefined ? { allow } : { allow, message }),
    }),
  agents: (cwd) => request(`/api/agents?cwd=${encodeURIComponent(cwd)}`),
  cwds: () => request('/api/cwds'),
  dirs: (path, hidden) => {
    const q = new URLSearchParams();
    if (path) q.set('path', path);
    if (hidden) q.set('hidden', '1');
    const s = q.toString();
    return request(s ? `/api/dirs?${s}` : '/api/dirs');
  },
  workers: () => request('/api/workers'),
  workerLog: (lane, repo, slug) =>
    request(
      `/api/workers/${encodeURIComponent(lane)}/${encodeURIComponent(repo)}/${encodeURIComponent(slug)}/log`,
    ),
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
