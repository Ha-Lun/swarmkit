// Downloadable artifacts: store listing, name checks, the hardened open, written files,
// orphan pruning, the download headers and the HTTP serving (statuses, headers, HEAD,
// streaming) over a harness that drives the same server helpers as server/index.ts.
import { linkSync, mkdirSync, mkdtempSync, realpathSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { PublishedArtifact, WrittenArtifact } from '../src/shared/types.ts';
import {
  _setMaxDownloadBytesForTest,
  artifactContentType,
  artifactDir,
  artifactDisposition,
  downloadHeaders,
  ensureArtifactDir,
  listArtifacts,
  MAX_DOWNLOAD_BYTES,
  openForDownload,
  plainStoreDir,
  pruneOrphanArtifacts,
  resolveWritten,
  validArtifactName,
  writtenArtifacts,
} from '../server/artifacts.ts';
import { checkAuth } from '../server/auth.ts';
import { applyMessage, createTree } from '../server/model/reducer.ts';
import { SdkSessions } from '../server/sdk/sessions.ts';
import type { QueryFn } from '../server/sdk/sessions.ts';

const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), 'artifacts-test-')));
const prevCache = process.env.XDG_CACHE_HOME;
beforeAll(() => {
  process.env.XDG_CACHE_HOME = path.join(scratch, 'cache');
});
afterAll(() => {
  if (prevCache === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = prevCache;
  _setMaxDownloadBytesForTest(MAX_DOWNLOAD_BYTES);
  rmSync(scratch, { recursive: true, force: true });
});

const sleep = (ms: number): Promise<void> => new Promise(res => setTimeout(res, ms));
async function viWaitFor(cond: () => boolean, timeoutMs = 8000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting for condition');
    await sleep(20);
  }
}

describe('validArtifactName', () => {
  it('accepts plain basenames', () => {
    expect(validArtifactName('report.pdf')).toBe(true);
    expect(validArtifactName('my notes (2).txt')).toBe(true);
    expect(validArtifactName('résumé.pdf')).toBe(true);
    expect(validArtifactName('x'.repeat(200))).toBe(true);
  });

  it('rejects dots, slashes, NUL and overlong names', () => {
    for (const name of ['..', '.', '.env', '.hidden', 'a/b', 'a\\b', 'a\0b', '', 'x'.repeat(201)]) {
      expect(validArtifactName(name), JSON.stringify(name)).toBe(false);
    }
  });
});

describe('artifactContentType', () => {
  it('maps the extension table and defaults to octet-stream', () => {
    expect(artifactContentType('a.pdf')).toBe('application/pdf');
    expect(artifactContentType('a.png')).toBe('image/png');
    expect(artifactContentType('a.jpg')).toBe('image/jpeg');
    expect(artifactContentType('a.jpeg')).toBe('image/jpeg');
    expect(artifactContentType('a.gif')).toBe('image/gif');
    expect(artifactContentType('a.webp')).toBe('image/webp');
    expect(artifactContentType('a.svg')).toBe('image/svg+xml');
    expect(artifactContentType('a.zip')).toBe('application/zip');
    expect(artifactContentType('a.gz')).toBe('application/gzip');
    expect(artifactContentType('a.tar')).toBe('application/x-tar');
    expect(artifactContentType('a.mp4')).toBe('video/mp4');
    expect(artifactContentType('a.mp3')).toBe('audio/mpeg');
    expect(artifactContentType('a.docx')).toContain('wordprocessingml');
    expect(artifactContentType('a.xlsx')).toContain('spreadsheetml');
    expect(artifactContentType('a.pptx')).toContain('presentationml');
    expect(artifactContentType('a.bin')).toBe('application/octet-stream');
    expect(artifactContentType('noext')).toBe('application/octet-stream');
  });

  it('marks text types with a charset', () => {
    for (const ext of ['csv', 'json', 'txt', 'md', 'html', 'xml']) {
      expect(artifactContentType(`a.${ext}`), ext).toContain('; charset=utf-8');
    }
  });
});

describe('artifactDisposition', () => {
  it('is an attachment with an ASCII fallback and an RFC 5987 value', () => {
    expect(artifactDisposition('report.pdf')).toBe(`attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`);
    const out = artifactDisposition('résumé "final".pdf');
    expect(out.startsWith('attachment; ')).toBe(true);
    expect(out).toContain('filename="r_sum_ _final_.pdf"');
    expect(out).toContain(`filename*=UTF-8''${encodeURIComponent('résumé "final".pdf')}`);
  });
});

describe('listArtifacts', () => {
  it('lists regular files newest first and skips the rest; missing dir -> []', async () => {
    expect(await listArtifacts('artifacts-missing')).toEqual([]);
    const id = 'artifacts-list';
    const dir = ensureArtifactDir(id);
    writeFileSync(path.join(dir, 'old.txt'), 'old');
    writeFileSync(path.join(dir, 'new.txt'), 'new');
    writeFileSync(path.join(dir, '.hidden'), 'x');
    mkdirSync(path.join(dir, 'sub'));
    symlinkSync(path.join(dir, 'old.txt'), path.join(dir, 'link.txt'));
    const old = new Date(Date.now() - 60_000);
    utimesSync(path.join(dir, 'old.txt'), old, old);
    const listed = await listArtifacts(id);
    expect(listed.map(a => a.name)).toEqual(['new.txt', 'old.txt']);
    expect(listed[0]).toMatchObject({
      size: 3,
      url: `/api/sessions/${id}/artifacts/new.txt`,
    });
    expect(typeof listed[0]!.mtime).toBe('number');
  });

  it('caps the list at 100', async () => {
    const id = 'artifacts-cap';
    const dir = ensureArtifactDir(id);
    for (let i = 0; i < 105; i++) writeFileSync(path.join(dir, `f${i}.txt`), 'x');
    expect(await listArtifacts(id)).toHaveLength(100);
  });
});

describe('openForDownload', () => {
  it('opens a regular file and refuses the rest', async () => {
    const id = 'artifacts-open';
    const dir = ensureArtifactDir(id);
    const file = path.join(dir, 'ok.bin');
    writeFileSync(file, 'bytes');
    const opened = await openForDownload(file);
    expect(opened?.size).toBe(5);
    expect(typeof opened?.mtimeMs).toBe('number');
    await opened!.handle.close();
    expect(await openForDownload(path.join(dir, 'missing.bin'))).toBeUndefined();
    expect(await openForDownload(dir)).toBeUndefined(); // a directory
  });

  it('refuses symlinks and hardlinks (nlink 2)', async () => {
    const id = 'artifacts-links';
    const dir = ensureArtifactDir(id);
    const orig = path.join(dir, 'orig.txt');
    writeFileSync(orig, 'data');
    symlinkSync(orig, path.join(dir, 'soft.txt'));
    expect(await openForDownload(path.join(dir, 'soft.txt'))).toBeUndefined();
    linkSync(orig, path.join(dir, 'hard.txt'));
    expect(await openForDownload(orig)).toBeUndefined();
    expect(await openForDownload(path.join(dir, 'hard.txt'))).toBeUndefined();
  });

  it('refuses files over the cap', async () => {
    const id = 'artifacts-cap-bytes';
    const dir = ensureArtifactDir(id);
    const file = path.join(dir, 'big.bin');
    writeFileSync(file, '12345');
    _setMaxDownloadBytesForTest(4);
    try {
      expect(await openForDownload(file)).toBeUndefined();
    } finally {
      _setMaxDownloadBytesForTest(MAX_DOWNLOAD_BYTES);
    }
    const opened = await openForDownload(file);
    expect(opened?.size).toBe(5);
    await opened!.handle.close();
  });
});

describe('pruneOrphanArtifacts', () => {
  it('removes only old, unowned, well-named store directories', () => {
    const oldDir = ensureArtifactDir('art-old');
    ensureArtifactDir('art-fresh');
    ensureArtifactDir('art-live');
    writeFileSync(path.join(oldDir, 'a.txt'), 'x');
    const old = new Date(Date.now() - 31 * 86_400_000);
    utimesSync(path.join(oldDir, 'a.txt'), old, old);
    utimesSync(oldDir, old, old);
    const root = path.dirname(artifactDir('art-old'));
    mkdirSync(path.join(root, 'bad.name'));
    utimesSync(path.join(root, 'bad.name'), old, old);
    // A symlink whose name is not a session id is left alone.
    symlinkSync(path.join(scratch, 'outside'), path.join(root, 'art.link'));
    expect(pruneOrphanArtifacts(id => id === 'art-live', 30 * 86_400_000)).toBe(1);
    expect(readdirSync(root).sort()).toEqual(
      expect.arrayContaining(['art-fresh', 'art-live', 'art.link', 'bad.name']),
    );
    expect(readdirSync(root)).not.toContain('art-old');
  });

  it('unlinks orphaned session-id symlinks without following them', () => {
    const root = path.dirname(artifactDir('art-old'));
    const targetDir = path.join(root, 'real-target');
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(path.join(targetDir, 'keep.txt'), 'keep');
    // The adoption link of a gone placeholder id, plus a dangling one: both unlinked.
    symlinkSync(targetDir, path.join(root, 'art-ph'));
    symlinkSync(path.join(root, 'gone-target'), path.join(root, 'art-dangling'));
    expect(pruneOrphanArtifacts(id => id === 'art-live', 30 * 86_400_000)).toBeGreaterThanOrEqual(2);
    expect(readdirSync(root)).not.toContain('art-ph');
    expect(readdirSync(root)).not.toContain('art-dangling');
    // The link's target was never followed.
    expect(readdirSync(targetDir)).toContain('keep.txt');
  });
});

describe('writtenArtifacts and resolveWritten', () => {
  it('keeps files strictly inside cwd, dedupes, newest first, caps at 200', async () => {
    const cwd = mkdtempSync(path.join(scratch, 'work-'));
    const sub = path.join(cwd, 'sub');
    mkdirSync(sub);
    const a = path.join(cwd, 'a.txt');
    const b = path.join(sub, 'b.md');
    writeFileSync(a, 'a');
    await sleep(15);
    writeFileSync(b, 'b');
    const outside = path.join(scratch, 'outside.txt');
    writeFileSync(outside, 'outside');
    const listed = await writtenArtifacts('s1', cwd, ['a.txt', 'sub/b.md', './sub/../sub/b.md', 'missing.txt', '../outside.txt', outside, 'a.txt']);
    expect(listed.map(w => w.rel).sort()).toEqual(['a.txt', path.join('sub', 'b.md')]);
    expect(listed[0]).toMatchObject({ rel: path.join('sub', 'b.md'), size: 1 });
    expect(listed[0]!.path).toBe(realpathSync(b));
    expect(listed[0]!.url).toBe(`/api/sessions/s1/written?path=${encodeURIComponent(realpathSync(b))}`);
    expect(listed.find(w => w.rel === 'a.txt')!.path).toBe(realpathSync(a));
  });

  it('caps the list at 200', async () => {
    const cwd = mkdtempSync(path.join(scratch, 'workcap-'));
    const paths: string[] = [];
    for (let i = 0; i < 205; i++) {
      const name = `f${i}.txt`;
      writeFileSync(path.join(cwd, name), 'x');
      paths.push(name);
    }
    expect(await writtenArtifacts('s1', cwd, paths)).toHaveLength(200);
  });

  it('drops deleted files and refuses symlinks escaping the cwd', async () => {
    const cwd = mkdtempSync(path.join(scratch, 'work2-'));
    const gone = path.join(cwd, 'gone.txt');
    writeFileSync(gone, 'x');
    const outside = path.join(scratch, 'hidden.txt');
    writeFileSync(outside, 'secret');
    const link = path.join(cwd, 'link.txt');
    symlinkSync(outside, link);
    expect((await writtenArtifacts('s1', cwd, ['gone.txt', 'link.txt'])).map(w => w.rel)).toEqual(['gone.txt']);
    rmSync(gone);
    expect(await writtenArtifacts('s1', cwd, ['gone.txt', 'link.txt'])).toEqual([]);
    // The link resolves outside the cwd: not downloadable even when recorded.
    expect(await resolveWritten(cwd, ['link.txt'], link)).toBeUndefined();
  });

  it('resolveWritten opens only recorded entries, absolute and inside', async () => {
    const cwd = mkdtempSync(path.join(scratch, 'work3-'));
    const a = path.join(cwd, 'a.txt');
    writeFileSync(a, 'hello');
    const opened = await resolveWritten(cwd, ['a.txt'], a);
    expect(opened?.size).toBe(5);
    expect(opened?.real).toBe(realpathSync(a));
    await opened!.handle.close();
    // Not in the set, relative, outside the cwd: all refused.
    expect(await resolveWritten(cwd, ['a.txt'], path.join(cwd, 'other.txt'))).toBeUndefined();
    expect(await resolveWritten(cwd, ['a.txt'], 'a.txt')).toBeUndefined();
    const outside = path.join(scratch, 'outside2.txt');
    writeFileSync(outside, 'x');
    expect(await resolveWritten(cwd, [outside], outside)).toBeUndefined();
  });
});

describe('reducer writtenPaths', () => {
  const toolUse = (name: string, input: Record<string, unknown>, uuid = 'u1', toolUseId = 't1') => ({
    type: 'assistant',
    uuid,
    timestamp: 1,
    message: { id: 'm1', model: 'x', content: [{ type: 'tool_use', id: toolUseId, name, input }] },
  });

  it('records Write (file_path), Edit via agy (file_path) and opencode (filePath), and relative paths', () => {
    const tree = createTree('s1', { startedAt: 1 });
    applyMessage(tree, toolUse('Write', { file_path: '/repo/a.txt' }));
    applyMessage(tree, toolUse('Edit', { file_path: '/repo/b.txt' }, 'u2', 't2'));
    applyMessage(tree, toolUse('Edit', { filePath: '/repo/c.txt' }, 'u3', 't3'));
    applyMessage(tree, toolUse('MultiEdit', { file_path: 'rel/d.txt' }, 'u4', 't4'));
    applyMessage(tree, toolUse('NotebookEdit', { notebook_path: '/repo/nb.ipynb' }, 'u5', 't5'));
    applyMessage(tree, toolUse('Read', { file_path: '/repo/e.txt' }, 'u6', 't6'));
    expect([...tree.writtenPaths!]).toEqual(['/repo/a.txt', '/repo/b.txt', '/repo/c.txt', 'rel/d.txt', '/repo/nb.ipynb']);
  });

  it('records on subagent nodes and caps the set at 1000', () => {
    const tree = createTree('s1', { startedAt: 1 });
    applyMessage(tree, {
      type: 'assistant',
      uuid: 'parent',
      timestamp: 1,
      message: { id: 'm1', model: 'x', content: [{ type: 'tool_use', id: 'agent1', name: 'Agent', input: { description: 'd', prompt: 'p' } }] },
    });
    applyMessage(tree, toolUse('Write', { file_path: '/repo/sub.txt' }, 'child', 't-child'), { nodeId: 'agent1' });
    expect([...tree.writtenPaths!]).toEqual(['/repo/sub.txt']);
    const big = createTree('s2', { startedAt: 1 });
    for (let i = 0; i < 1001; i++) {
      applyMessage(big, toolUse('Write', { file_path: `/repo/f${i}.txt` }, `u${i}`, `t${i}`));
    }
    expect(big.writtenPaths!.size).toBe(1000);
    expect(big.writtenPaths!.has('/repo/f0.txt')).toBe(false);
    expect(big.writtenPaths!.has('/repo/f1000.txt')).toBe(true);
  });

  it('summarises NotebookEdit with its notebook_path', () => {
    const tree = createTree('s1', { startedAt: 1 });
    const events = applyMessage(tree, toolUse('NotebookEdit', { notebook_path: '/repo/nb.ipynb', new_source: 'x' }));
    const ev = events.flatMap(e => (e.type === 'node.event' ? [e.event] : []));
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ kind: 'tool_use', tool: 'NotebookEdit', summary: '/repo/nb.ipynb' });
  });
});

// ---------------------------------------------------------------------------
// HTTP harness: the same helpers and status codes as server/index.ts.
// ---------------------------------------------------------------------------

const TOKEN = 'test-token-for-artifacts-routes';

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

/** Mirrors the /api/sessions/:id dispatch in server/index.ts (auth + artifact routes only). */
function startHarness(sessions: Map<string, { cwd: string; paths: string[] }>): Promise<{ base: string; close: () => Promise<void> }> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (!checkAuth(req, TOKEN)) return sendJson(res, 401, { error: 'unauthorized' });
      const parts = url.pathname.split('/').filter(Boolean);
      const method = req.method ?? 'GET';

      const lookup = async (id: string): Promise<{ id: string; cwd: string; paths: string[] } | undefined> => {
        let sessionId: string;
        try {
          sessionId = decodeURIComponent(id);
        } catch {
          return undefined;
        }
        const found = sessions.get(sessionId);
        return found ? { id: sessionId, ...found } : undefined;
      };
      const serveDownload = async (filename: string, opened: Awaited<ReturnType<typeof openForDownload>>): Promise<void> => {
        if (!opened) return sendJson(res, 404, { error: 'file not found' });
        const headers = downloadHeaders(filename, opened.size);
        if (method === 'HEAD') {
          await opened.handle.close();
          res.writeHead(200, headers);
          return void res.end();
        }
        res.writeHead(200, headers);
        try {
          await pipeline(opened.handle.createReadStream(), res);
        } catch {
          try {
            res.destroy();
          } catch {
            // Best effort.
          }
        } finally {
          await opened.handle.close();
        }
      };

      if (parts[1] === 'sessions' && parts.length >= 3) {
        const id = parts[2] ?? '';
        if (parts.length === 4 && parts[3] === 'artifacts') {
          if (method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
          const session = await lookup(id);
          if (!session) return sendJson(res, 404, { error: 'session not found' });
          const written = await writtenArtifacts(session.id, session.cwd, session.paths);
          return sendJson(res, 200, { published: await listArtifacts(session.id), written });
        }
        if (parts.length === 5 && parts[3] === 'artifacts') {
          if (method !== 'GET' && method !== 'HEAD') return sendJson(res, 405, { error: 'method not allowed' });
          const session = await lookup(id);
          let fileName: string;
          try {
            fileName = decodeURIComponent(parts[4] ?? '');
          } catch {
            return sendJson(res, 404, { error: 'file not found' });
          }
          if (!session || !validArtifactName(fileName)) return sendJson(res, 404, { error: 'file not found' });
          let dir: string;
          try {
            dir = artifactDir(session.id);
          } catch {
            return sendJson(res, 404, { error: 'file not found' });
          }
          return serveDownload(fileName, await openForDownload(path.join(dir, fileName)));
        }
        if (parts.length === 4 && parts[3] === 'written') {
          if (method !== 'GET' && method !== 'HEAD') return sendJson(res, 405, { error: 'method not allowed' });
          const session = await lookup(id);
          const requested = url.searchParams.get('path');
          if (!session || !requested) return sendJson(res, 404, { error: 'file not found' });
          const opened = await resolveWritten(session.cwd, session.paths, requested);
          if (!opened) return sendJson(res, 404, { error: 'file not found' });
          return serveDownload(path.basename(opened.real), opened);
        }
      }
      return sendJson(res, 404, { error: 'not found' });
    })().catch(err => {
      console.error('Harness failed:', err);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
      else res.destroy();
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ base: `http://127.0.0.1:${port}`, close: () => new Promise<void>(res => server.close(() => res())) });
    });
  });
}

describe('artifact routes', () => {
  it('serves the list, downloads bytes with headers, HEAD without a body, and enforces auth', async () => {
    const id = 'route-session';
    const dir = ensureArtifactDir(id);
    writeFileSync(path.join(dir, 'résumé.pdf'), '%PDF-bytes');
    const cwd = mkdtempSync(path.join(scratch, 'routecwd-'));
    const a = path.join(cwd, 'a.txt');
    writeFileSync(a, 'written-bytes');
    const sessions = new Map([[id, { cwd, paths: ['a.txt'] }]]);
    const { base, close } = await startHarness(sessions);
    try {
      const auth = { 'x-fleet-token': TOKEN };
      // Unauthenticated -> 401.
      expect((await fetch(`${base}/api/sessions/${id}/artifacts`)).status).toBe(401);
      // List.
      const listRes = await fetch(`${base}/api/sessions/${id}/artifacts`, { headers: auth });
      expect(listRes.status).toBe(200);
      const body = (await listRes.json()) as { published: PublishedArtifact[]; written: WrittenArtifact[] };
      expect(body.published.map(p => p.name)).toEqual(['résumé.pdf']);
      expect(body.written.map(w => w.rel)).toEqual(['a.txt']);
      // Download.
      const name = encodeURIComponent('résumé.pdf');
      const get = await fetch(`${base}/api/sessions/${id}/artifacts/${name}`, { headers: auth });
      expect(get.status).toBe(200);
      expect(await get.text()).toBe('%PDF-bytes');
      expect(get.headers.get('content-type')).toBe('application/pdf');
      expect(get.headers.get('content-length')).toBe(String('%PDF-bytes'.length));
      expect(get.headers.get('content-disposition')).toBe(artifactDisposition('résumé.pdf'));
      expect(get.headers.get('x-content-type-options')).toBe('nosniff');
      expect(get.headers.get('content-security-policy')).toBe('sandbox');
      expect(get.headers.get('cache-control')).toBe('private, no-store');
      // HEAD: headers, no body.
      const head = await fetch(`${base}/api/sessions/${id}/artifacts/${name}`, { method: 'HEAD', headers: auth });
      expect(head.status).toBe(200);
      expect(head.headers.get('content-length')).toBe(String('%PDF-bytes'.length));
      expect(await head.text()).toBe('');
      // Written download.
      const written = await fetch(`${base}/api/sessions/${id}/written?path=${encodeURIComponent(a)}`, { headers: auth });
      expect(written.status).toBe(200);
      expect(await written.text()).toBe('written-bytes');
      expect(written.headers.get('content-type')).toBe('text/plain; charset=utf-8');
      // Unknown session -> 404.
      expect((await fetch(`${base}/api/sessions/nope/artifacts`, { headers: auth })).status).toBe(404);
      // Other methods -> 405.
      for (const m of ['POST', 'DELETE', 'PUT']) {
        expect((await fetch(`${base}/api/sessions/${id}/artifacts/${name}`, { method: m, headers: auth })).status).toBe(405);
        expect((await fetch(`${base}/api/sessions/${id}/written?path=${encodeURIComponent(a)}`, { method: m, headers: auth })).status).toBe(405);
      }
    } finally {
      await close();
    }
  });

  it('404s on bad names, planted links, hardlinks, over-cap files and unrecorded paths', async () => {
    const id = 'route-rejects';
    const dir = ensureArtifactDir(id);
    writeFileSync(path.join(dir, 'ok.txt'), 'ok');
    writeFileSync(path.join(dir, 'cap.txt'), '12345');
    symlinkSync(path.join(dir, 'ok.txt'), path.join(dir, 'soft.txt'));
    linkSync(path.join(dir, 'ok.txt'), path.join(dir, 'hard.txt'));
    writeFileSync(path.join(scratch, 'shared-outside.txt'), 'outside');
    const cwd = mkdtempSync(path.join(scratch, 'rejectcwd-'));
    const inside = path.join(cwd, 'inside.txt');
    writeFileSync(inside, 'in');
    const sessions = new Map([[id, { cwd, paths: ['inside.txt', '../shared-outside.txt'] }]]);
    const { base, close } = await startHarness(sessions);
    try {
      const auth = { 'x-fleet-token': TOKEN };
      const get = (p: string): Promise<number> =>
        fetch(`${base}${p}`, { headers: auth }).then(r => r.status);
      for (const bad of ['..', '.env', 'a%2Fb', 'x'.repeat(201)]) {
        expect(await get(`/api/sessions/${id}/artifacts/${bad}`), bad).toBe(404);
      }
      expect(await get(`/api/sessions/${id}/artifacts/soft.txt`)).toBe(404);
      expect(await get(`/api/sessions/${id}/artifacts/hard.txt`)).toBe(404);
      expect(await get(`/api/sessions/${id}/artifacts/missing.txt`)).toBe(404);
      _setMaxDownloadBytesForTest(1);
      try {
        expect(await get(`/api/sessions/${id}/artifacts/cap.txt`)).toBe(404);
      } finally {
        _setMaxDownloadBytesForTest(MAX_DOWNLOAD_BYTES);
      }
      expect(MAX_DOWNLOAD_BYTES).toBe(500 * 1024 * 1024);
      // Written: not in the set, in the set but outside the cwd, missing path param.
      expect(await get(`/api/sessions/${id}/written?path=${encodeURIComponent(inside)}`)).toBe(200);
      expect(await get(`/api/sessions/${id}/written?path=${encodeURIComponent(path.join(scratch, 'shared-outside.txt'))}`)).toBe(404);
      expect(await get(`/api/sessions/${id}/written?path=${encodeURIComponent(path.join(scratch, 'other.txt'))}`)).toBe(404);
      expect(await get(`/api/sessions/${id}/written`)).toBe(404);
      expect(await get(`/api/sessions/${id}/written?path=relative.txt`)).toBe(404);
    } finally {
      await close();
    }
  });
});

describe('SdkSessions writtenPaths', () => {
  it('exposes paths the reducer recorded from a Write tool call', async () => {
    const recording: QueryFn = () =>
      (async function* (): AsyncGenerator<unknown> {
        yield { type: 'system', subtype: 'init', session_id: 'x', model: 'm' };
        yield {
          type: 'assistant',
          uuid: 'a1',
          message: {
            id: 'm1',
            model: 'm',
            content: [{ type: 'tool_use', id: 't1', name: 'Write', input: { file_path: 'notes.txt' } }],
          },
        };
        yield { type: 'result', subtype: 'success' };
      })() as unknown as AsyncIterable<SDKMessage>;
    const homeCwd = mkdtempSync(path.join(scratch, 'sdkcwd-'));
    const sdk = new SdkSessions(() => {}, recording);
    const id = sdk.start({ prompt: 'write something', cwd: homeCwd });
    await viWaitFor(() => sdk.get(id)?.status === 'done');
    expect(sdk.writtenPaths(id)).toEqual(['notes.txt']);
    expect(sdk.writtenPaths('nope')).toBeUndefined();
    sdk.stop(id);
  });
});

describe('hardening (security review)', () => {
  it('refuses a store dir swapped for a symlink', async () => {
    const id = 'swapped-store';
    const target = path.join(scratch, 'pretend-ssh');
    mkdirSync(target, { recursive: true });
    writeFileSync(path.join(target, 'id_ed25519'), 'secret');
    ensureArtifactDir('another-one'); // makes the store root
    symlinkSync(target, artifactDir(id));
    expect(await listArtifacts(id)).toEqual([]);
    expect(await plainStoreDir(id)).toBeUndefined();
  });

  it('rejects control characters in names and in the header fallback', () => {
    expect(validArtifactName('a\r\nb.pdf')).toBe(false);
    expect(validArtifactName('a\x01.pdf')).toBe(false);
    expect(artifactDisposition('a\\b\x7f.pdf')).toContain('filename="a_b_.pdf"');
  });

  it('does not block on a FIFO', async () => {
    const dir = ensureArtifactDir('fifo-session');
    const fifo = path.join(dir, 'pipe.pdf');
    execFileSync('mkfifo', [fifo]);
    expect(await openForDownload(fifo)).toBeUndefined();
  });

  it('never offers written files under a dot-named part of the cwd', async () => {
    const cwd = mkdtempSync(path.join(scratch, 'home-'));
    mkdirSync(path.join(cwd, '.ssh'));
    writeFileSync(path.join(cwd, '.ssh', 'id_ed25519'), 'secret');
    writeFileSync(path.join(cwd, '.env'), 'X=1');
    writeFileSync(path.join(cwd, 'ok.txt'), 'ok');
    const recorded = ['.ssh/id_ed25519', '.env', 'ok.txt'];
    expect((await writtenArtifacts('s1', cwd, recorded)).map(w => w.rel)).toEqual(['ok.txt']);
    expect(await resolveWritten(cwd, recorded, path.join(cwd, '.ssh', 'id_ed25519'))).toBeUndefined();
    const ok = await resolveWritten(cwd, recorded, path.join(cwd, 'ok.txt'));
    expect(ok).toBeDefined();
    await ok!.handle.close();
  });
});
