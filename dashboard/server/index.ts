// SwarmKit dashboard server: plain node:http, serves the built UI and the JSON API.
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ViteDevServer } from 'vite';
import {
  allowedHosts,
  checkAuth,
  checkOrigin,
  cookieValueFor,
  createRateLimiter,
  fleetCookie,
  hostAllowed,
  loadToken,
  ownerAllows,
  redirectLocation,
  securityHeaders,
  tokenFilePath,
  tokenMatches,
} from './auth.ts';
import { listAgents } from './agents.ts';
import { DirError, listDirs } from './dirs.ts';
import { WorkerRegistry } from './registry.ts';
import { SdkSessions, SessionError } from './sdk/sessions.ts';
import { AGENT_RE, validModel, validText, ValidationError } from './validate.ts';
import { resolveDirInHome } from './paths.ts';
import { getUsage } from './usage.ts';
import { freshTranscriptMtimeMs, holderMessage, liveHolder } from './livesessions.ts';
import { TranscriptWatcher } from './watch/transcripts.ts';
import type { AgentNode, ResumeSessionBody, ServerEvent, SessionSummary, StartSessionBody } from '../src/shared/types.ts';

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT) || 4317;
/** Max JSON body size for POST endpoints. */
const MAX_BODY = 1024 * 1024;
/** SSE clients buffered more than this are dropped instead of written to. */
const MAX_STREAM_QUEUE = 4 * 1024 * 1024;
/** GET /api/usage?refresh=1 is honoured at most once per this window. */
const USAGE_REFRESH_GUARD_MS = 30_000;
/** Max concurrent SSE clients (the oldest is dropped beyond this). */
const MAX_SSE_CLIENTS = 50;
/** POST /api/auth attempts per remote address per minute. */
const AUTH_ATTEMPTS_PER_MINUTE = 10;
/** Hosts a dev server may bind to (Vite serves source files; never anywhere else). */
const DEV_HOSTS = ['127.0.0.1', 'localhost', '::1'];

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(data);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buf.length;
    if (size > MAX_BODY) throw new HttpError(413, 'request body too large (max 1 MB)');
    chunks.push(buf);
  }
  if (size === 0) throw new HttpError(400, 'expected a JSON body');
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid JSON body');
  }
}

function requireObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new HttpError(400, 'body must be a JSON object');
  }
  return body as Record<string, unknown>;
}

/** cwd must resolve to an existing directory inside (or equal to) $HOME. */
async function resolveCwd(raw: unknown): Promise<string> {
  const resolved = await resolveDirInHome(raw);
  if ('error' in resolved) throw new HttpError(400, resolved.error);
  return resolved.dir;
}

async function validateSessionBody(body: unknown): Promise<StartSessionBody> {
  const raw = requireObject(body);
  const prompt = validText(raw.prompt, 'prompt');
  const start: StartSessionBody = { prompt, cwd: await resolveCwd(raw.cwd) };
  if (raw.agent !== undefined && raw.agent !== null) {
    if (typeof raw.agent !== 'string' || !AGENT_RE.test(raw.agent)) {
      throw new ValidationError('agent must match /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/');
    }
    start.agent = raw.agent;
  }
  const model = validModel(raw.model);
  if (model !== undefined) start.model = model;
  return start;
}

function validateMessageBody(body: unknown): string {
  const raw = requireObject(body);
  return validText(raw.text);
}

function validateDecisionBody(body: unknown): { allow: boolean; message?: string } {
  const raw = requireObject(body);
  if (typeof raw.allow !== 'boolean') throw new HttpError(400, 'allow must be a boolean');
  const out: { allow: boolean; message?: string } = { allow: raw.allow };
  if (raw.message !== undefined) {
    if (typeof raw.message !== 'string') throw new HttpError(400, 'message must be a string');
    out.message = raw.message;
  }
  return out;
}

async function main(): Promise<void> {
  const development = process.env.NODE_ENV === 'development';
  if (development && !DEV_HOSTS.includes(HOST)) {
    // Development serves source files; never bind it to an exposed interface.
    console.error(
      `SwarmKit refuses NODE_ENV=development on HOST=${HOST}. ` +
      `Use 127.0.0.1, localhost or ::1, or run without NODE_ENV=development.`,
    );
    process.exit(1);
  }
  const dashboardDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const distDir = path.resolve(dashboardDir, 'dist');
  const load = loadToken(dashboardDir);
  const token = load.token;
  const tokenFile = load.file || tokenFilePath();
  const hosts = allowedHosts(PORT);
  const fleetOwner = process.env.FLEET_OWNER;
  const allowAuthAttempt = createRateLimiter(AUTH_ATTEMPTS_PER_MINUTE, 60_000);

  const clients = new Set<ServerResponse>();
  let vite: ViteDevServer | undefined;

  /** Writeable-by-us-now: not ended, not destroyed, not already flooding. */
  const clientWritable = (client: ServerResponse): boolean =>
    !client.destroyed && !client.writableEnded && client.writableLength <= MAX_STREAM_QUEUE;

  const dropClient = (client: ServerResponse): void => {
    clients.delete(client);
    client.destroy();
  };

  function broadcast(event: ServerEvent): void {
    // Serialise each event once, no matter how many clients receive it.
    const data = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of [...clients]) {
      if (!clientWritable(client)) {
        dropClient(client);
        continue;
      }
      try {
        client.write(data);
      } catch {
        dropClient(client);
      }
    }
  }

  const sdk = new SdkSessions(broadcast);
  const watcher = new TranscriptWatcher({ emit: broadcast, skip: id => sdk.owns(id) });
  watcher.start();

  const registry = new WorkerRegistry({
    emit: broadcast,
    link: (lane, slug) => sdk.findWorkerNode(lane, slug) ?? watcher.findWorkerNode(lane, slug),
  });
  registry.start();

  /** Last time ?refresh=1 actually bypassed the usage caches (the 30 s guard). */
  let lastUsageBypassMs = 0;

  /** POST /api/sessions/:id/resume: continue a page-owned or terminal session with a new message. */
  async function resumeSession(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
    const raw = requireObject(await readJson(req));
    let body: ResumeSessionBody;
    try {
      const text = validText(raw.text);
      const model = validModel(raw.model);
      body = model === undefined ? { text } : { text, model };
    } catch (err) {
      if (err instanceof ValidationError) return sendJson(res, 400, { error: err.message });
      throw err;
    }
    let info: { cwd: string; transcriptMtimeMs?: number; nodes?: AgentNode[]; title?: string };
    if (sdk.owns(id)) {
      const file = sdk.fileInfo(id)!;
      info = { cwd: file.cwd };
      // Page sessions are ours, but a leftover heartbeat from a non-dashboard process
      // means the id is still held: sdk.resume() refuses that restart with the same 409.
    } else {
      const file = watcher.fileInfo(id);
      if (!file) return sendJson(res, 404, { error: 'session not found' });
      // A terminal claude still holding this session id must not be forked: refuse
      // before anything else moves (the cached-mtime check below can be stale).
      const holder = await liveHolder(id);
      if (holder) return sendJson(res, 409, { error: holderMessage(holder.pid) });
      // Rebuild the tree from the watcher's current parse so the continued session keeps
      // its nodes; unknown cwd constellations fall back to the defaults inside resume().
      const detail = await watcher.get(id);
      // A fresh stat of the transcript beats the watcher's cached mtime (up to one scan
      // interval (2 s) stale, enough to miss a live terminal). Unstatable path: cached.
      const freshMtime = await freshTranscriptMtimeMs(id, file.cwd);
      info = {
        cwd: file.cwd,
        transcriptMtimeMs: freshMtime ?? file.mtimeMs,
        nodes: detail?.nodes ?? [],
        title: detail?.title,
      };
    }
    try {
      const sessionId = await sdk.resume(id, body, info);
      return sendJson(res, 200, { sessionId });
    } catch (err) {
      if (err instanceof SessionError) {
        return sendJson(res, err.status, { error: err.message });
      }
      throw err;
    }
  }

  const mergedSessions = (): SessionSummary[] =>
    [...sdk.list(), ...watcher.list()].sort((a, b) => b.updatedAt - a.updatedAt);

  const pingTimer = setInterval(() => {
    for (const client of [...clients]) {
      if (!clientWritable(client)) {
        dropClient(client);
        continue;
      }
      try {
        client.write(': ping\n\n');
      } catch {
        dropClient(client);
      }
    }
  }, 15_000);
  pingTimer.unref();

  function serveEvents(res: ServerResponse): void {
    // Cap the SSE fan-out: drop the oldest clients beyond the limit.
    while (clients.size >= MAX_SSE_CLIENTS) {
      const oldest = clients.values().next().value;
      if (!oldest) break;
      dropClient(oldest);
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    clients.add(res);
    res.write(`data: ${JSON.stringify({ type: 'hello', sessions: mergedSessions() })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: 'workers.update', workers: registry.list() })}\n\n`);
    res.on('close', () => clients.delete(res));
    res.on('error', () => clients.delete(res));
  }

  /** Static files (production). SPA fallback to index.html, no token needed. */
  async function serveStatic(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendJson(res, 405, { error: 'method not allowed' });
    }
    let pathname: string;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return sendJson(res, 400, { error: 'bad path' });
    }
    if (pathname === '/') pathname = '/index.html';
    const resolved = path.resolve(distDir, '.' + pathname);
    if (resolved !== distDir && !resolved.startsWith(distDir + path.sep)) {
      return sendJson(res, 403, { error: 'forbidden' });
    }
    let file = resolved;
    try {
      const stats = await stat(file);
      if (!stats.isFile()) throw new Error('not a file');
    } catch {
      file = path.join(distDir, 'index.html');
    }
    try {
      const data = await readFile(file);
      res.writeHead(200, {
        'Content-Type': CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
        'Content-Length': data.length,
      });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch {
      sendJson(res, 404, { error: 'not found — run `npm run build` to create dist/' });
    }
  }

  /**
   * POST /api/auth: exchange the raw token for the derived cookie. Needs no auth,
   * but the Origin must match; rate-limited to 10 attempts per minute per address.
   */
  async function handleAuthPost(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const remote = req.socket.remoteAddress ?? 'unknown';
    if (!allowAuthAttempt(remote)) {
      return sendJson(res, 429, { error: 'too many attempts; try again in a minute' });
    }
    if (!checkOrigin(req, 'header')) {
      return sendJson(res, 403, { error: 'cross-origin request rejected' });
    }
    const body = requireObject(await readJson(req));
    const provided = body.token;
    if (typeof provided !== 'string' || !tokenMatches(provided, token)) {
      return sendJson(res, 401, { error: 'invalid token' });
    }
    // Behind an HTTPS proxy (e.g. tailscale serve) the cookie must be marked Secure.
    const secure = req.headers['x-forwarded-proto'] === 'https';
    res.setHeader('Set-Cookie', fleetCookie(cookieValueFor(token), secure));
    return sendJson(res, 200, { ok: true });
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    // Security headers on every response (writeHead merges them).
    for (const [header, value] of Object.entries(securityHeaders(development))) res.setHeader(header, value);

    if (!hostAllowed(req.headers.host, hosts)) {
      return sendJson(res, 421, { error: 'unknown host; use one of ' + hosts.join(', ') });
    }

    if (url.pathname === '/api/auth' && (req.method ?? 'GET') === 'POST') {
      return handleAuthPost(req, res);
    }

    const isApi = url.pathname === '/api' || url.pathname.startsWith('/api/') || url.pathname === '/events';
    if (isApi) {
      const via = checkAuth(req, token);
      if (!via) return sendJson(res, 401, { error: 'unauthorized' });
      if (!ownerAllows(req.headers['tailscale-user-login'], fleetOwner)) {
        return sendJson(res, 403, { error: 'wrong tailscale user' });
      }
      const method = req.method ?? 'GET';
      if ((method === 'POST' || method === 'DELETE' || method === 'PUT' || method === 'PATCH') && !checkOrigin(req, via)) {
        return sendJson(res, 403, { error: 'cross-origin request rejected' });
      }
      res.setHeader('Cache-Control', 'no-store');
      if (url.pathname === '/events') {
        if (method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
        return serveEvents(res);
      }
      return handleApi(req, res, url);
    }

    // First visit with ?token=<valid>: hand out the derived cookie and drop the token from the URL.
    if (req.method === 'GET' && url.searchParams.has('token')) {
      const provided = url.searchParams.get('token') ?? '';
      if (tokenMatches(provided, token)) {
        const rest = new URLSearchParams(url.searchParams);
        rest.delete('token');
        const location = redirectLocation(url.pathname, rest.toString());
        const secure = req.headers['x-forwarded-proto'] === 'https';
        res.writeHead(302, {
          'Set-Cookie': fleetCookie(cookieValueFor(token), secure),
          Location: location,
        });
        res.end();
        return;
      }
      // Invalid ?token: serve the app normally; the UI shows its token screen on 401.
    }

    if (development) {
      vite?.middlewares(req, res, () => sendJson(res, 404, { error: 'not found' }));
      return;
    }
    await serveStatic(req, res, url);
  }

  async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const parts = url.pathname.split('/').filter(Boolean); // ['api', resource, ...]
    const method = req.method ?? 'GET';

    if (url.pathname === '/api/sessions') {
      if (method === 'GET') return sendJson(res, 200, mergedSessions());
      if (method === 'POST') {
        const body = await validateSessionBody(await readJson(req));
        return sendJson(res, 201, { sessionId: sdk.start(body) });
      }
      return sendJson(res, 405, { error: 'method not allowed' });
    }

    if (parts[1] === 'sessions' && parts.length >= 3) {
      const id = parts[2] ?? '';
      if (parts.length === 3 && method === 'GET') {
        const detail = sdk.get(id) ?? (await watcher.get(id));
        if (detail) return sendJson(res, 200, detail);
        return sendJson(res, 404, { error: 'session not found' });
      }
      if (parts.length === 4 && (parts[3] === 'message' || parts[3] === 'interrupt') && method === 'POST') {
        if (!sdk.owns(id)) return sendJson(res, 404, { error: 'session not found' });
        if (parts[3] === 'message') {
          const text = validateMessageBody(await readJson(req));
          if (!sdk.send(id, text)) return sendJson(res, 404, { error: 'session not found' });
        } else if (!sdk.interrupt(id)) {
          return sendJson(res, 404, { error: 'session not found' });
        }
        return sendJson(res, 200, { ok: true });
      }
      if (parts.length === 3 && method === 'DELETE') {
        return sdk.stop(id)
          ? sendJson(res, 200, { ok: true })
          : sendJson(res, 404, { error: 'session not found' });
      }
      if (parts.length === 4 && parts[3] === 'resume' && method === 'POST') {
        return resumeSession(req, res, id);
      }
      return sendJson(res, 404, { error: 'not found' });
    }

    if (parts[1] === 'permissions') {
      const permId = parts[2] ?? '';
      if (method !== 'POST' || parts.length !== 3) {
        return sendJson(res, 404, { error: 'not found' });
      }
      const decision = validateDecisionBody(await readJson(req));
      return sdk.decide(permId, decision)
        ? sendJson(res, 200, { ok: true })
        : sendJson(res, 404, { error: 'permission not found' });
    }

    if (url.pathname === '/api/agents') {
      if (method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
      const cwd = url.searchParams.get('cwd') ?? undefined;
      return sendJson(res, 200, { agents: await listAgents(cwd) });
    }

    if (url.pathname === '/api/cwds') {
      if (method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
      const cwds = [...new Set([...sdk.cwds(), ...watcher.recentCwds()])];
      return sendJson(res, 200, cwds);
    }

    if (url.pathname === '/api/workers') {
      if (method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
      return sendJson(res, 200, registry.list());
    }

    if (url.pathname === '/api/usage') {
      if (method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
      const now = Date.now();
      // Refresh bypasses the collector caches, but at most once per the guard window.
      let refresh = url.searchParams.get('refresh') === '1';
      if (refresh && now - lastUsageBypassMs < USAGE_REFRESH_GUARD_MS) refresh = false;
      if (refresh) lastUsageBypassMs = now;
      return sendJson(res, 200, await getUsage({ refresh }));
    }

    if (parts[1] === 'workers' && parts.length === 6 && parts[5] === 'log') {
      if (method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
      const seg = (i: number): string => {
        try {
          return decodeURIComponent(parts[i] ?? '');
        } catch {
          return parts[i] ?? '';
        }
      };
      const lines = await registry.log(seg(2), seg(3), seg(4));
      if (!lines) return sendJson(res, 404, { error: 'worker log not found' });
      return sendJson(res, 200, { lines });
    }

    if (url.pathname === '/api/dirs') {
      if (method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
      const target = url.searchParams.get('path') ?? undefined;
      const hidden = url.searchParams.get('hidden') === '1';
      return sendJson(res, 200, await listDirs(target, hidden));
    }

    return sendJson(res, 404, { error: 'not found' });
  }

  let viteReady: Promise<void> | undefined;
  if (development) {
    viteReady = (async () => {
      const { createServer } = await import('vite');
      vite = await createServer({
        root: dashboardDir,
        server: { middlewareMode: true },
        appType: 'spa',
      });
    })();
  }

  const server = http.createServer((req, res) => {
    void handle(req, res).catch(err => {
      // SessionError / DirError carry their own status; everything else stays hidden as a 500.
      const status = err instanceof HttpError || err instanceof SessionError || err instanceof DirError || err instanceof ValidationError
        ? err.status
        : 500;
      if (status === 500) console.error('Request failed:', err);
      if (!res.headersSent) {
        sendJson(res, status, { error: status === 500 ? 'internal error' : err.message });
      } else {
        res.destroy();
      }
    });
  });

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('Shutting down SwarmKit…');
    for (const s of sdk.list()) sdk.stop(s.id);
    watcher.stop();
    registry.stop();
    clearInterval(pingTimer);
    const exit = (): void => {
      server.close(() => process.exit(0));
      // SSE clients keep sockets open; force the exit.
      setTimeout(() => process.exit(0), 1500).unref();
    };
    if (viteReady) {
      void viteReady
        .then(() => vite?.close())
        .catch(() => {})
        .finally(exit);
    } else {
      exit();
    }
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  await viteReady;

  server.listen(PORT, HOST, () => {
    const shown = HOST === '0.0.0.0' ? 'localhost' : HOST;
    console.log(`SwarmKit: http://${shown}:${PORT}`);
    console.log(`SwarmKit: token: ${tokenFile}`);
    // The token-in-URL link leaks through logs; print it only on an interactive terminal.
    if (process.stdout.isTTY) {
      console.log(`SwarmKit: http://${shown}:${PORT}/?token=${token}`);
    }
    // Behind 0.0.0.0 (the LAN case), also print the LAN addresses worth reaching.
    if (HOST === '0.0.0.0') {
      for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
        if (/^(br-|docker|veth|lo)/.test(name)) continue; // bridges, containers, loopback noise
        for (const address of addresses ?? []) {
          if (address.family === 'IPv4' && !address.internal) {
            console.log(`SwarmKit: http://${address.address}:${PORT}`);
          }
        }
      }
    }
  });
}

main().catch(err => {
  console.error('SwarmKit failed to start:', err);
  process.exit(1);
});
