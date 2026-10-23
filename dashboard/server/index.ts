// Claude Fleet dashboard server: plain node:http, serves the built UI and the JSON API.
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { readFile, realpath, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ViteDevServer } from 'vite';
import { checkOrigin, isAuthorized, loadToken, tokenMatches } from './auth.ts';
import { listAgents } from './agents.ts';
import { SdkSessions } from './sdk/sessions.ts';
import { TranscriptWatcher } from './watch/transcripts.ts';
import type { ServerEvent, SessionSummary, StartSessionBody } from '../src/shared/types.ts';

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT) || 4317;
/** Max JSON body size for POST endpoints. */
const MAX_BODY = 1024 * 1024;
const MAX_TEXT = 100_000;

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
  if (typeof raw !== 'string' || raw.length === 0) throw new HttpError(400, 'cwd is required');
  let real: string;
  let stats;
  try {
    real = await realpath(raw);
    stats = await stat(real);
  } catch {
    throw new HttpError(400, 'cwd does not exist');
  }
  if (!stats.isDirectory()) throw new HttpError(400, 'cwd must be a directory');
  const home = await realpath(os.homedir());
  if (real !== home && !real.startsWith(home + path.sep)) {
    throw new HttpError(400, 'cwd must be inside your home directory');
  }
  return real;
}

async function validateSessionBody(body: unknown): Promise<StartSessionBody> {
  const raw = requireObject(body);
  const prompt = raw.prompt;
  if (typeof prompt !== 'string' || prompt.trim().length === 0) {
    throw new HttpError(400, 'prompt must be a non-empty string');
  }
  if (prompt.length > MAX_TEXT) throw new HttpError(400, `prompt must be at most ${MAX_TEXT} characters`);
  const start: StartSessionBody = { prompt, cwd: await resolveCwd(raw.cwd) };
  if (raw.agent !== undefined && raw.agent !== null) {
    if (typeof raw.agent !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(raw.agent)) {
      throw new HttpError(400, 'agent must match /^[A-Za-z0-9._-]{1,64}$/');
    }
    start.agent = raw.agent;
  }
  if (raw.model !== undefined && raw.model !== null) {
    const model = raw.model;
    if (typeof model !== 'string' || !/^(opus|sonnet|haiku|claude-[a-z0-9.-]{1,60})$/.test(model)) {
      throw new HttpError(400, "model must be 'opus', 'sonnet', 'haiku' or a 'claude-*' model id");
    }
    start.model = model;
  }
  return start;
}

function validateMessageBody(body: unknown): string {
  const raw = requireObject(body);
  const text = raw.text;
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new HttpError(400, 'text must be a non-empty string');
  }
  if (text.length > MAX_TEXT) throw new HttpError(400, `text must be at most ${MAX_TEXT} characters`);
  return text;
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
  const dashboardDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const development = process.env.NODE_ENV === 'development';
  const distDir = path.resolve(dashboardDir, 'dist');
  const token = loadToken(dashboardDir);

  const clients = new Set<ServerResponse>();
  let vite: ViteDevServer | undefined;

  function broadcast(event: ServerEvent): void {
    for (const client of clients) client.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  const sdk = new SdkSessions(broadcast);
  const watcher = new TranscriptWatcher({ emit: broadcast, skip: id => sdk.owns(id) });
  watcher.start();

  const mergedSessions = (): SessionSummary[] =>
    [...sdk.list(), ...watcher.list()].sort((a, b) => b.updatedAt - a.updatedAt);

  const pingTimer = setInterval(() => {
    for (const client of clients) client.write(': ping\n\n');
  }, 15_000);
  pingTimer.unref();

  function serveEvents(res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    clients.add(res);
    res.write(`data: ${JSON.stringify({ type: 'hello', sessions: mergedSessions() })}\n\n`);
    res.on('close', () => clients.delete(res));
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

    return sendJson(res, 404, { error: 'not found' });
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const isApi = url.pathname === '/api' || url.pathname.startsWith('/api/') || url.pathname === '/events';

    if (isApi) {
      if (!isAuthorized(req, token)) return sendJson(res, 401, { error: 'unauthorized' });
      const method = req.method ?? 'GET';
      if ((method === 'POST' || method === 'DELETE' || method === 'PUT' || method === 'PATCH') && !checkOrigin(req)) {
        return sendJson(res, 403, { error: 'cross-origin request rejected' });
      }
      if (url.pathname === '/events') {
        if (method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
        return serveEvents(res);
      }
      return handleApi(req, res, url);
    }

    // First visit with ?token=<valid>: hand out the cookie and drop the token from the URL.
    if (req.method === 'GET' && url.searchParams.has('token')) {
      const provided = url.searchParams.get('token') ?? '';
      if (tokenMatches(provided, token)) {
        const rest = new URLSearchParams(url.searchParams);
        rest.delete('token');
        const query = rest.toString();
        res.writeHead(302, {
          'Set-Cookie': `fleet_token=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`,
          Location: url.pathname + (query ? `?${query}` : ''),
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
      const httpError = err instanceof HttpError;
      if (!httpError) console.error('Request failed:', err);
      if (!res.headersSent) {
        sendJson(res, httpError ? err.status : 500, { error: httpError ? err.message : 'internal error' });
      } else {
        res.destroy();
      }
    });
  });

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('Shutting down Claude Fleet…');
    for (const s of sdk.list()) sdk.stop(s.id);
    watcher.stop();
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
    console.log(`Claude Fleet: http://localhost:${PORT}/?token=${token}`);
    for (const addresses of Object.values(os.networkInterfaces())) {
      for (const address of addresses ?? []) {
        if (address.family === 'IPv4' && !address.internal) {
          console.log(`Claude Fleet: http://${address.address}:${PORT}/?token=${token}`);
        }
      }
    }
  });
}

main().catch(err => {
  console.error('Claude Fleet failed to start:', err);
  process.exit(1);
});
