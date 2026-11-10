// General file attachments: name sanitising, validation, the combined caps, the
// per-session file store (f<n>-<name>, never served over HTTP) and the client gate.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_ATTACHMENTS, MAX_ATTACHMENT_TOTAL_BYTES, MAX_FILE_BYTES } from '../src/shared/types.ts';
import type { FileAttachment } from '../src/shared/types.ts';
import { safeFileName, validAttachmentTotals, validFiles, validMessageText, ValidationError } from '../server/validate.ts';
import { deleteImages, imageDir, readImage, resolveImagePath, saveFiles } from '../server/images.ts';
import { checkOtherFiles } from '../src/client/attachments.ts';
import type { FileLike } from '../src/client/attachments.ts';

const scratch = mkdtempSync(path.join(tmpdir(), 'files-test-'));
const prevCache = process.env.XDG_CACHE_HOME;
beforeAll(() => {
  process.env.XDG_CACHE_HOME = path.join(scratch, 'cache');
});
afterAll(() => {
  if (prevCache === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = prevCache;
  rmSync(scratch, { recursive: true, force: true });
});

const b64byte = Buffer.from([1]).toString('base64');
const file = (over: Partial<FileAttachment> = {}): FileAttachment => ({
  name: 'a.pdf',
  mediaType: 'application/pdf',
  data: Buffer.from('hello').toString('base64'),
  ...over,
});
const other = (size: number, name = 'a.pdf'): FileLike => ({ type: 'application/pdf', size, name });
const MB = 1024 * 1024;

describe('safeFileName', () => {
  it('strips directories', () => {
    expect(safeFileName('../../etc/passwd')).toBe('passwd');
    expect(safeFileName('C:\\x\\a b.pdf')).toBe('a b.pdf');
  });
  it('strips leading dots and falls back when empty', () => {
    expect(safeFileName('.env')).toBe('env');
    expect(safeFileName('')).toBe('file');
    expect(safeFileName('...')).toBe('file');
  });
  it('replaces unicode and emoji with underscores', () => {
    const out = safeFileName('réport🎉.pdf');
    expect(out).not.toContain('é');
    expect(out).not.toContain('🎉');
    expect(out).toMatch(/^[A-Za-z0-9._ -]+$/);
    expect(safeFileName('🎉')).toMatch(/^[A-Za-z0-9._ -]+$/);
  });
  it('caps a 200-char name at 80 chars keeping .pdf', () => {
    const out = safeFileName(`${'a'.repeat(200)}.pdf`);
    expect(out.length).toBeLessThanOrEqual(80);
    expect(out.endsWith('.pdf')).toBe(true);
  });
});

describe('validFiles', () => {
  it('treats undefined, null and an empty array as no files', () => {
    expect(validFiles(undefined)).toBeUndefined();
    expect(validFiles(null)).toBeUndefined();
    expect(validFiles([])).toBeUndefined();
  });
  it('accepts a small file and sanitises the name', () => {
    expect(validFiles([{ name: '../../etc/passwd', mediaType: 'text/plain', data: b64byte }])).toEqual([
      { name: 'passwd', mediaType: 'text/plain', data: b64byte },
    ]);
  });
  it('rejects bad base64, empty or oversized payloads', () => {
    expect(() => validFiles([{ name: 'a.bin', mediaType: 'application/octet-stream', data: 'abc' }])).toThrow(ValidationError);
    expect(() => validFiles([{ name: 'a.bin', mediaType: 'application/octet-stream', data: 'data:application/pdf;base64,AQ==' }])).toThrow(ValidationError);
    const big = Buffer.alloc(MAX_FILE_BYTES + 1).toString('base64');
    expect(() => validFiles([file({ data: big })])).toThrow(/must decode/);
    const edge = Buffer.alloc(MAX_FILE_BYTES).toString('base64');
    expect(validFiles([file({ data: edge })])).toHaveLength(1);
  });
  it('rejects more than MAX_ATTACHMENTS files', () => {
    expect(() => validFiles(Array.from({ length: MAX_ATTACHMENTS + 1 }, () => file()))).toThrow(/at most 6/);
    expect(validFiles(Array.from({ length: MAX_ATTACHMENTS }, () => file()))).toHaveLength(MAX_ATTACHMENTS);
  });
  it('replaces a bad mediaType with application/octet-stream', () => {
    expect(validFiles([{ name: 'a.bin', mediaType: 'not a type!', data: b64byte }])?.[0]?.mediaType).toBe('application/octet-stream');
    expect(validFiles([{ name: 'a.bin', mediaType: 'x'.repeat(101), data: b64byte }])?.[0]?.mediaType).toBe('application/octet-stream');
  });
  it('never echoes file data in errors', () => {
    const data = Buffer.alloc(16).toString('base64');
    try {
      validFiles([{ name: 'a.bin', mediaType: 'application/octet-stream', data: `${data}!!!!` }]);
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).not.toContain(data);
    }
  });
  it('lets blank text through as (file) when files are attached', () => {
    expect(validMessageText('', undefined, [file()])).toBe('(file)');
    expect(validMessageText(undefined, undefined, [file()])).toBe('(file)');
    expect(validMessageText('hi', undefined, [file()])).toBe('hi');
    expect(() => validMessageText('  ', undefined, [])).toThrow(ValidationError);
  });
});

describe('validAttachmentTotals', () => {
  it('passes within the caps', () => {
    expect(validAttachmentTotals(undefined, undefined)).toBeUndefined();
    expect(validAttachmentTotals([{ mediaType: 'image/png', data: b64byte }], [file()])).toBeUndefined();
  });
  it('rejects more than MAX_ATTACHMENTS images + files combined', () => {
    const imgs = Array.from({ length: 4 }, () => ({ mediaType: 'image/png' as const, data: b64byte }));
    const files = Array.from({ length: 3 }, () => file());
    expect(() => validAttachmentTotals(imgs, files)).toThrow(/at most 6/);
  });
  it('rejects a decoded total over 24 MB', () => {
    const big = Buffer.alloc(13 * MB).toString('base64');
    expect(() => validAttachmentTotals(undefined, [file({ data: big }), file({ data: big })])).toThrow(/24 MB/);
    expect(MAX_ATTACHMENT_TOTAL_BYTES).toBe(24 * MB);
  });
});

describe('file store', () => {
  it('numbers f<n>-<name> per session, 0600 files in 0700 dirs, numbering on', () => {
    const id = 'file-numbering';
    const first = saveFiles(id, [file({ name: 'a.pdf' }), file({ name: 'b.txt', mediaType: 'text/plain' })]);
    expect(first.names).toEqual(['a.pdf', 'b.txt']);
    expect(first.paths).toEqual([path.join(imageDir(id), 'f1-a.pdf'), path.join(imageDir(id), 'f2-b.txt')]);
    expect(statSync(first.paths[0]!).mode & 0o777).toBe(0o600);
    expect(statSync(imageDir(id)).mode & 0o777).toBe(0o700);
    expect(readFileSync(first.paths[0]!)).toEqual(Buffer.from('hello'));
    const second = saveFiles(id, [file({ name: 'a.pdf' })]);
    expect(second.paths[0]).toBe(path.join(imageDir(id), 'f3-a.pdf'));
    deleteImages(id);
    expect(existsSync(imageDir(id))).toBe(false);
  });

  it('refuses a symlinked session directory and never writes through it', () => {
    const id = 'file-symlink';
    const target = path.join(scratch, 'elsewhere');
    mkdirSync(target, { recursive: true });
    mkdirSync(path.dirname(imageDir(id)), { recursive: true });
    symlinkSync(target, imageDir(id));
    expect(() => saveFiles(id, [file()])).toThrow();
    expect(readdirSync(target)).toEqual([]);
    deleteImages(id);
    expect(existsSync(target)).toBe(true);
  });

  it('never overwrites: a planted f1- file is skipped', () => {
    const id = 'file-planted';
    mkdirSync(imageDir(id), { recursive: true, mode: 0o700 });
    const planted = path.join(imageDir(id), 'f1-a.pdf');
    writeFileSync(planted, 'original');
    const saved = saveFiles(id, [file({ name: 'a.pdf' })]);
    expect(saved.paths[0]).toBe(path.join(imageDir(id), 'f2-a.pdf'));
    expect(readFileSync(planted, 'utf8')).toBe('original');
    deleteImages(id);
  });
});

describe('resolveImagePath', () => {
  it('rejects f<n>- file names (files are never served over HTTP)', async () => {
    expect(resolveImagePath('abc', 'f1-a.pdf')).toBeUndefined();
    expect(resolveImagePath('abc', 'f12-report.zip')).toBeUndefined();
    expect(await readImage('abc', 'f1-a.pdf')).toBeUndefined();
  });
});

describe('checkOtherFiles', () => {
  it('accepts ordinary and empty-typed files', () => {
    const r = checkOtherFiles([other(100, 'a.pdf'), { type: '', size: 10, name: 'blob' }], 0);
    expect(r.accepted).toHaveLength(2);
    expect(r.error).toBeNull();
  });
  it('refuses files over 8 MB with the file name', () => {
    const r = checkOtherFiles([other(9 * MB, 'x.zip'), other(10, 'ok.txt')], 0);
    expect(r.accepted).toHaveLength(1);
    expect(r.error).toContain('x.zip');
    expect(r.error).toContain('8 MB per file');
  });
  it('caps at MAX_ATTACHMENTS including the already-pending count', () => {
    const r = checkOtherFiles([other(10, 'a.pdf'), other(10, 'b.pdf')], MAX_ATTACHMENTS - 1);
    expect(r.accepted).toHaveLength(1);
    expect(r.error).toContain(`${MAX_ATTACHMENTS}`);
    const full = checkOtherFiles([other(10, 'a.pdf')], MAX_ATTACHMENTS);
    expect(full.accepted).toEqual([]);
    expect(full.error).toContain(`${MAX_ATTACHMENTS}`);
  });
  it('refuses when the running total would exceed 24 MB', () => {
    const big = other(8 * MB, 'big.bin');
    const r = checkOtherFiles([big, big, big, big], 0);
    expect(r.accepted).toHaveLength(3);
    expect(r.error).toContain('24 MB');
  });
});
