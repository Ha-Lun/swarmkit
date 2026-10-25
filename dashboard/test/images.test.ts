// Pasted images: validation, the private store, the GET route helper, the user event,
// the per-runtime hand-off (claude blocks, ACP image blocks, agy paths) and the agy hook.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ImageAttachment, ServerEvent } from '../src/shared/types.ts';
import { MAX_IMAGE_BYTES } from '../src/shared/types.ts';
import { validImages, validMessageText, ValidationError } from '../server/validate.ts';
import { deleteImages, imageDir, readImage, resolveImagePath, saveImages } from '../server/images.ts';
import { SdkSessions } from '../server/sdk/sessions.ts';
import type { QueryFn } from '../server/sdk/sessions.ts';
import { createAcpQuery } from '../server/runtimes/acp.ts';
import { createAgyQuery } from '../server/runtimes/agy.ts';
import { applyMessage, createTree } from '../server/model/reducer.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeAcp = path.join(here, 'fixtures', 'fake-acp-agent.mjs');
const recordAgy = path.join(here, 'fixtures', 'record-agy.mjs');
const hookPy = path.join(here, '..', 'server', 'runtimes', 'agy-hook.py');

const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), 'images-test-')));
const homeDir = mkdtempSync(path.join(homedir(), 'fleet-images-test-'));
const prevCache = process.env.XDG_CACHE_HOME;
beforeAll(() => {
  process.env.XDG_CACHE_HOME = path.join(scratch, 'cache');
});
afterAll(() => {
  if (prevCache === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = prevCache;
  rmSync(scratch, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
});

const b64 = (bytes: number[], total = 24): string => Buffer.from([...bytes, ...new Array(Math.max(0, total - bytes.length)).fill(1)]).toString('base64');
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPG = [0xff, 0xd8, 0xff, 0xe0];
const ascii = (s: string): number[] => [...Buffer.from(s, 'latin1')];
const WEBP = [...ascii('RIFF'), 1, 2, 3, 4, ...ascii('WEBP')];
const png = (): ImageAttachment => ({ mediaType: 'image/png', data: b64(PNG) });
const sleep = (ms: number): Promise<void> => new Promise(res => setTimeout(res, ms));

describe('validImages', () => {
  it('accepts each type with matching magic bytes', () => {
    const ok: ImageAttachment[] = [
      png(),
      { mediaType: 'image/jpeg', data: b64(JPG) },
      { mediaType: 'image/gif', data: b64(ascii('GIF87a')) },
      { mediaType: 'image/gif', data: b64(ascii('GIF89a')) },
      { mediaType: 'image/webp', data: b64(WEBP) },
    ];
    expect(validImages(ok)).toEqual(ok);
  });

  it('treats undefined, null and an empty array as no images', () => {
    expect(validImages(undefined)).toBeUndefined();
    expect(validImages(null)).toBeUndefined();
    expect(validImages([])).toBeUndefined();
  });

  it('rejects a media type that does not match the bytes', () => {
    expect(() => validImages([{ mediaType: 'image/jpeg', data: b64(PNG) }])).toThrow(ValidationError);
    expect(() => validImages([{ mediaType: 'image/webp', data: b64([...ascii('RIFF'), 1, 2, 3, 4, ...ascii('WAVE')]) }])).toThrow(ValidationError);
    expect(() => validImages([{ mediaType: 'image/gif', data: b64(ascii('GIF90a')) }])).toThrow(ValidationError);
  });

  it('rejects unknown types, non-objects and bad base64', () => {
    expect(() => validImages([{ mediaType: 'image/svg+xml', data: b64(PNG) }])).toThrow(ValidationError);
    expect(() => validImages('x')).toThrow(ValidationError);
    expect(() => validImages([null])).toThrow(ValidationError);
    for (const data of ['', 'abc', `data:image/png;base64,${b64(PNG)}`, `${b64(PNG)}!!!!`, 'AAAA=AAA', 5]) {
      expect(() => validImages([{ mediaType: 'image/png', data }])).toThrow(ValidationError);
    }
  });

  it('rejects more than 6 images and decoded sizes over 5 MB', () => {
    expect(() => validImages(Array.from({ length: 7 }, png))).toThrow(/at most 6/);
    expect(validImages(Array.from({ length: 6 }, png))).toHaveLength(6);
    const big = Buffer.concat([Buffer.from(PNG), Buffer.alloc(MAX_IMAGE_BYTES)]).toString('base64');
    expect(() => validImages([{ mediaType: 'image/png', data: big }])).toThrow(/larger than/);
    const edge = Buffer.concat([Buffer.from(PNG), Buffer.alloc(MAX_IMAGE_BYTES - PNG.length)]).toString('base64');
    expect(validImages([{ mediaType: 'image/png', data: edge }])).toHaveLength(1);
  });

  it('never echoes image data in errors', () => {
    const data = b64(PNG);
    try {
      validImages([{ mediaType: 'image/jpeg', data }]);
    } catch (err) {
      expect((err as Error).message).not.toContain(data);
    }
  });

  it('lets blank text through only when images are attached', () => {
    expect(validMessageText('', [png()])).toBe('(image)');
    expect(validMessageText(undefined, [png()])).toBe('(image)');
    expect(validMessageText('hi', [png()])).toBe('hi');
    expect(() => validMessageText('  ', undefined)).toThrow(ValidationError);
  });
});

describe('image store', () => {
  it('numbers files per session, 0600 files in 0700 dirs', () => {
    const id = 'sess-numbering';
    const first = saveImages(id, [png(), { mediaType: 'image/jpeg', data: b64(JPG) }]);
    const second = saveImages(id, [{ mediaType: 'image/webp', data: b64(WEBP) }]);
    expect(first.urls).toEqual([`/api/sessions/${id}/images/1.png`, `/api/sessions/${id}/images/2.jpg`]);
    expect(second.urls).toEqual([`/api/sessions/${id}/images/3.webp`]);
    expect(first.paths[0]).toBe(path.join(imageDir(id), '1.png'));
    expect(statSync(first.paths[0]!).mode & 0o777).toBe(0o600);
    expect(statSync(imageDir(id)).mode & 0o777).toBe(0o700);
    expect(readFileSync(first.paths[0]!)).toEqual(Buffer.from(png().data, 'base64'));
    expect(readImage(id, '2.jpg')?.contentType).toBe('image/jpeg');
    deleteImages(id);
    expect(existsSync(imageDir(id))).toBe(false);
  });

  it('refuses a symlinked session directory and never writes through it', () => {
    const id = 'sess-symlink';
    const target = path.join(scratch, 'elsewhere');
    mkdirSync(target, { recursive: true });
    mkdirSync(path.dirname(imageDir(id)), { recursive: true });
    symlinkSync(target, imageDir(id));
    expect(() => saveImages(id, [png()])).toThrow();
    expect(readdirSync(target)).toEqual([]);
    expect(readImage(id, '1.png')).toBeUndefined();
    deleteImages(id);
    expect(existsSync(target)).toBe(true);
  });

  it('does not follow a planted symlink file', () => {
    const id = 'sess-planted';
    const outside = path.join(scratch, 'outside.png');
    writeFileSync(outside, 'secret');
    mkdirSync(imageDir(id), { recursive: true, mode: 0o700 });
    symlinkSync(outside, path.join(imageDir(id), '1.png'));
    const saved = saveImages(id, [png()]);
    expect(saved.urls[0]).toMatch(/\/2\.png$/);
    expect(readFileSync(outside, 'utf8')).toBe('secret');
    expect(readImage(id, '1.png')).toBeUndefined();
    deleteImages(id);
  });

  it('rejects unsafe session ids', () => {
    expect(() => imageDir('../x')).toThrow();
    expect(() => saveImages('a/b', [png()])).toThrow();
  });
});

describe('resolveImagePath', () => {
  it('accepts well-formed names and stays inside the store', () => {
    const file = resolveImagePath('abc-123', '12.png');
    expect(file).toBe(path.join(imageDir('abc-123'), '12.png'));
    expect(resolveImagePath('abc-123', '1.webp')).toBeDefined();
  });

  it('rejects traversal, odd names and odd session ids', () => {
    for (const name of ['../1.png', '1.png/..', '..%2f1.png', '1.svg', '1.PNG', '.png', 'a.png', '12345.png', '1.png\0', '1.png ', '/etc/passwd', '']) {
      expect(resolveImagePath('abc', name), name).toBeUndefined();
    }
    for (const id of ['', '..', '.', 'a/b', '../abc', '.hidden', 'a\0b', 'x'.repeat(65)]) {
      expect(resolveImagePath(id, '1.png'), id).toBeUndefined();
    }
  });
});

describe('reducer', () => {
  it('shows a marker per transcript image block and no base64', () => {
    const tree = createTree('s1', { startedAt: 1 });
    const data = b64(PNG);
    const events = applyMessage(tree, {
      type: 'user',
      uuid: 'u1',
      message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data } }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data } }, { type: 'text', text: 'what is this' }] },
    });
    const ev = events.flatMap(e => (e.type === 'node.event' ? [e.event] : []));
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ kind: 'user', summary: 'what is this' });
    expect(ev[0]!.detail).toBe('what is this\n🖼 image\n🖼 image');
    expect(JSON.stringify(events)).not.toContain(data);
  });

  it('keeps the page-sent images on the event and dedupes an echoed copy', () => {
    const tree = createTree('s1', { startedAt: 1 });
    const first = applyMessage(tree, { type: 'user', uuid: 'u2', message: { role: 'user', content: 'look' }, swarmkitImages: ['/api/sessions/s1/images/1.png'] });
    const echo = applyMessage(tree, { type: 'user', uuid: 'u2', message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64(PNG) } }, { type: 'text', text: 'look' }] } });
    expect(first.some(e => e.type === 'node.event' && e.event.images?.[0] === '/api/sessions/s1/images/1.png')).toBe(true);
    expect(echo.filter(e => e.type === 'node.event')).toHaveLength(0);
    expect(tree.nodes.get('root')!.events.filter(e => e.kind === 'user')).toHaveLength(1);
  });

  it('shows a page-sent message that starts with "<", but not a transcript injection', () => {
    const tree = createTree('s1', { startedAt: 1 });
    const page = applyMessage(tree, { type: 'user', uuid: 'p1', message: { role: 'user', content: '<div>hello</div>' }, swarmkitPage: true });
    const pageEvents = page.flatMap(e => (e.type === 'node.event' ? [e.event] : []));
    expect(pageEvents).toHaveLength(1);
    expect(pageEvents[0]).toMatchObject({ kind: 'user', summary: '<div>hello</div>' });
    const injected = applyMessage(tree, { type: 'user', uuid: 't1', message: { role: 'user', content: '<command-name>x</command-name>' } });
    expect(injected.filter(e => e.type === 'node.event')).toHaveLength(0);
  });
});

/** Reads the first queued user message and finishes with a result. */
function recordingQuery(seen: SDKUserMessage[]): QueryFn {
  return (params => {
    const it = (params.prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]();
    return (async function* gen(): AsyncGenerator<unknown> {
      yield { type: 'system', subtype: 'init', session_id: 'x', model: 'm' };
      for (;;) {
        const next = await it.next();
        if (next.done) return;
        seen.push(next.value);
        yield { type: 'result', subtype: 'success' };
      }
    })() as unknown as AsyncIterable<SDKMessage>;
  }) as QueryFn;
}

const userEvents = (events: ServerEvent[]) => events.flatMap(e => (e.type === 'node.event' && e.event.kind === 'user' ? [e.event] : []));

describe('page-sent user events', () => {
  it('start and send each produce exactly one user event; an echo with the same uuid dedupes', async () => {
    const seen: SDKUserMessage[] = [];
    const events: ServerEvent[] = [];
    const sdk = new SdkSessions(e => events.push(e), recordingQuery(seen));
    const id = sdk.start({ prompt: 'first line\nsecond line', cwd: homeDir });
    await vi_waitFor(() => seen.length === 1);
    await vi_waitFor(() => sdk.get(id)?.nodes.find(n => n.id === 'root')?.status !== 'running');
    sdk.send(id, 'follow up');
    await vi_waitFor(() => seen.length === 2);
    const users = userEvents(events);
    expect(users).toHaveLength(2);
    expect(users[0]).toMatchObject({ summary: 'first line', detail: 'first line\nsecond line' });
    expect(users[0]!.images).toBeUndefined();
    expect(users[1]).toMatchObject({ summary: 'follow up', detail: 'follow up' });
    // An echoed SDK copy of the queued message does not add a third event.
    const tree = (sdk as unknown as { sessions: Map<string, { tree: ReturnType<typeof createTree> }> }).sessions.get(id)!.tree;
    const echo = applyMessage(tree, { type: 'user', uuid: seen[1]!.uuid, message: { role: 'user', content: 'follow up' } });
    expect(userEvents(echo)).toHaveLength(0);
    expect(tree.nodes.get('root')!.events.filter(e => e.kind === 'user')).toHaveLength(2);
    expect(sdk.get(id)!.nodes.find(n => n.id === 'root')!.agentType).toBe('lead-dev-hybrid');
    // Resuming the idle live session adds exactly one more.
    await vi_waitFor(() => sdk.get(id)?.nodes.find(n => n.id === 'root')?.status !== 'running');
    await sdk.resume(id, { text: 'resumed' }, { cwd: homeDir });
    await vi_waitFor(() => seen.length === 3);
    expect(userEvents(events).map(e => e.detail)).toEqual(['first line\nsecond line', 'follow up', 'resumed']);
  });
});

describe('sessions with images', () => {
  it('claude: image blocks before the text, user event with URLs, no base64 emitted', async () => {
    const seen: SDKUserMessage[] = [];
    const events: ServerEvent[] = [];
    const sdk = new SdkSessions(e => events.push(e), recordingQuery(seen));
    const img = png();
    const id = sdk.start({ prompt: 'what is this', cwd: homeDir, images: [img] });
    await vi_waitFor(() => seen.length === 1);
    const content = (seen[0]!.message as { content: unknown }).content;
    expect(content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: img.data } },
      { type: 'text', text: 'what is this' },
    ]);
    expect(userEvents(events)).toHaveLength(1);
    expect(userEvents(events)[0]!.images).toEqual([`/api/sessions/${id}/images/1.png`]);
    // A follow-up message with images numbers on, and plain messages stay strings.
    sdk.send(id, 'again', [img]);
    await vi_waitFor(() => seen.length === 2);
    expect(userEvents(events)[1]!.images).toEqual([`/api/sessions/${id}/images/2.png`]);
    sdk.send(id, 'plain');
    await vi_waitFor(() => seen.length === 3);
    expect((seen[2]!.message as { content: unknown }).content).toBe('plain');
    expect(JSON.stringify(events)).not.toContain(img.data);
    expect(JSON.stringify(sdk.get(id))).not.toContain(img.data);
    expect(existsSync(imageDir(id))).toBe(true);
    // Eviction removes the files.
    sdk.stop(id);
    await sleep(50);
    sdk.evict(Date.now() + 10 * 24 * 3600 * 1000);
    expect(existsSync(imageDir(id))).toBe(false);
  });

  it('opencode: the ACP prompt gets image blocks first, then the text', async () => {
    const record = path.join(scratch, 'acp-record.jsonl');
    const events: ServerEvent[] = [];
    const sdk = new SdkSessions(e => events.push(e), undefined, {
      acp: o => createAcpQuery({ ...o, command: ['node', fakeAcp], env: { ...process.env, FAKE_ACP_RECORD: record } }),
    });
    const img = png();
    const id = sdk.start({ prompt: 'describe', cwd: homeDir, runtime: 'opencode', images: [img, { mediaType: 'image/jpeg', data: b64(JPG) }] });
    await vi_waitFor(() => existsSync(record) && readFileSync(record, 'utf8').includes('session/prompt'), 15000);
    const prompt = readFileSync(record, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as { method: string; blocks?: unknown[] }).find(r => r.method === 'session/prompt')!;
    expect(prompt.blocks).toEqual([
      { type: 'image', mimeType: 'image/png', dataLen: img.data.length },
      { type: 'image', mimeType: 'image/jpeg', dataLen: b64(JPG).length },
      { type: 'text', text: 'describe' },
    ]);
    expect(userEvents(events)[0]!.images).toHaveLength(2);
    expect(JSON.stringify(events)).not.toContain(img.data);
    sdk.stop(id);
    deleteImages(id);
  });

  it('agy: --add-dir on every turn, paths in the prompt, env for the hook', async () => {
    const record = path.join(scratch, 'agy-record.jsonl');
    const events: ServerEvent[] = [];
    const sdk = new SdkSessions(e => events.push(e), undefined, {
      agy: o => createAgyQuery({ ...o, commandPrefix: ['node', recordAgy], env: { RECORD_AGY: record } }),
    });
    const read = (): Array<{ args: string[]; imagesDir: string | null }> =>
      existsSync(record) ? readFileSync(record, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as { args: string[]; imagesDir: string | null }) : [];
    // Plain first turn: no image flag, no env.
    const id = sdk.start({ prompt: 'hello', cwd: homeDir, runtime: 'agy' });
    await vi_waitFor(() => read().length === 1);
    expect(read()[0]!.args).not.toContain('--add-dir');
    expect(read()[0]!.imagesDir).toBeNull();
    await vi_waitFor(() => sdk.get(id)?.nodes.find(n => n.id === 'root')?.status !== 'running');
    const img = png();
    sdk.send(id, 'see this', [img]);
    await vi_waitFor(() => read().length === 2);
    const dir = imageDir(id);
    const second = read()[1]!;
    expect(second.args[second.args.indexOf('--add-dir') + 1]).toBe(dir);
    expect(second.args[1]).toBe(`see this\n\nAttached images (open them with read_file):\n${path.join(dir, '1.png')}`);
    expect(second.imagesDir).toBe(dir);
    expect(userEvents(events)[1]!.images).toEqual([`/api/sessions/${id}/images/1.png`]);
    expect(JSON.stringify(events)).not.toContain(img.data);
    // The flag sticks on later plain turns.
    await vi_waitFor(() => sdk.get(id)?.nodes.find(n => n.id === 'root')?.status !== 'running');
    sdk.send(id, 'and now');
    await vi_waitFor(() => read().length === 3);
    expect(read()[2]!.args).toContain('--add-dir');
    sdk.stop(id);
    deleteImages(id);
  });
});

async function vi_waitFor(cond: () => boolean, timeoutMs = 8000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting for condition');
    await sleep(20);
  }
}

function runHook(name: string, args: Record<string, unknown>, env: Record<string, string>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const clean: NodeJS.ProcessEnv = { ...process.env, NO_PROXY: '*', no_proxy: '*' };
    for (const k of ['SWARMKIT_DASH_HOOK_URL', 'SWARMKIT_DASH_HOOK_SECRET', 'SWARMKIT_DASH_CWD', 'SWARMKIT_DASH_IMAGES_DIR']) delete clean[k];
    const child = spawn('python3', ['-I', hookPy], { env: { ...clean, ...env }, stdio: ['pipe', 'pipe', 'inherit'] });
    let text = '';
    child.stdout.on('data', (c: Buffer) => {
      text += c;
    });
    child.on('error', reject);
    child.on('close', () => resolve(JSON.parse(text.trim().split('\n')[0]!) as Record<string, unknown>));
    child.stdin.write(JSON.stringify({ conversationId: 'c', stepIdx: 1, toolCall: { name, args } }));
    child.stdin.end();
  });
}

describe('agy-hook.py images dir', () => {
  it('auto-allows reads in the images dir, asks for edits and for other places', async () => {
    const cwd = path.join(scratch, 'work');
    const images = path.join(scratch, 'imgs');
    mkdirSync(cwd, { recursive: true });
    mkdirSync(images, { recursive: true });
    const outside = path.join(scratch, 'other');
    mkdirSync(outside, { recursive: true });
    writeFileSync(path.join(images, '1.png'), 'x');
    symlinkSync(outside, path.join(images, 'link'));
    // An unreachable hook URL: "asks the dashboard" shows up as a deny from the failed call.
    const base = { SWARMKIT_DASH_HOOK_URL: 'http://127.0.0.1:1/x', SWARMKIT_DASH_HOOK_SECRET: 's', SWARMKIT_DASH_CWD: cwd };
    const withImages = { ...base, SWARMKIT_DASH_IMAGES_DIR: images };
    expect(await runHook('read_file', { Path: path.join(images, '1.png') }, withImages)).toEqual({ decision: 'allow' });
    expect(await runHook('view_file', { AbsolutePath: path.join(images, '1.png') }, withImages)).toEqual({ decision: 'allow' });
    expect(await runHook('list_dir', { DirectoryPath: images }, withImages)).toEqual({ decision: 'allow' });
    // Not set: the same read asks (the dashboard is unreachable here, so it denies).
    expect((await runHook('read_file', { Path: path.join(images, '1.png') }, base)).decision).toBe('deny');
    // Edits there ask, as do reads that escape through a symlink or traversal.
    expect((await runHook('write_to_file', { TargetFile: path.join(images, '2.png') }, withImages)).decision).toBe('deny');
    expect((await runHook('read_file', { Path: path.join(images, 'link', 'f') }, withImages)).decision).toBe('deny');
    expect((await runHook('read_file', { Path: path.join(images, '..', 'other', 'f') }, withImages)).decision).toBe('deny');
  });
});
