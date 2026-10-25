// Pure attachment helpers: sizing math and the mime/count/size gate.
import { describe, expect, it } from 'vitest';
import { MAX_IMAGE_BYTES, MAX_IMAGES } from '../src/shared/types.ts';
import { checkFiles, fitWithin, MAX_LONG_EDGE } from '../src/client/attachments.ts';
import type { FileLike } from '../src/client/attachments.ts';

const png = (size = 1024, name = 'a.png'): FileLike => ({ type: 'image/png', size, name });
const jpg = (size = 1024, name = 'a.jpg'): FileLike => ({ type: 'image/jpeg', size, name });

describe('fitWithin', () => {
  it('leaves small images untouched', () => {
    expect(fitWithin(800, 600, MAX_LONG_EDGE)).toEqual({ w: 800, h: 600 });
    expect(fitWithin(MAX_LONG_EDGE, 100, MAX_LONG_EDGE)).toEqual({ w: MAX_LONG_EDGE, h: 100 });
  });
  it('scales the long edge down to max, keeping the ratio', () => {
    expect(fitWithin(2000, 1000, 1568)).toEqual({ w: 1568, h: 784 });
    expect(fitWithin(1000, 2000, 1568)).toEqual({ w: 784, h: 1568 });
    expect(fitWithin(3136, 3136, 1568)).toEqual({ w: 1568, h: 1568 });
  });
  it('guards degenerate input', () => {
    expect(fitWithin(0, 10, 1568)).toEqual({ w: 0, h: 0 });
    expect(fitWithin(-5, 10, 1568)).toEqual({ w: 0, h: 0 });
    expect(fitWithin(10, 10, 0)).toEqual({ w: 0, h: 0 });
  });
});

describe('checkFiles', () => {
  it('accepts the four supported types', () => {
    const files: FileLike[] = [
      png(),
      jpg(),
      { type: 'image/gif', size: 10, name: 'a.gif' },
      { type: 'image/webp', size: 10, name: 'a.webp' },
    ];
    const r = checkFiles(files, 0);
    expect(r.accepted).toEqual(files);
    expect(r.error).toBeNull();
  });
  it('rejects unsupported mime types with a message', () => {
    const r = checkFiles([{ type: 'image/svg+xml', size: 10, name: 'evil.svg' }], 0);
    expect(r.accepted).toEqual([]);
    expect(r.error).toContain('evil.svg');
    expect(r.error).toContain('PNG, JPEG, GIF or WebP');
  });
  it('rejects empty and unknown types', () => {
    const r = checkFiles([{ type: '', size: 10, name: 'blob' }], 0);
    expect(r.accepted).toEqual([]);
    expect(r.error).not.toBeNull();
  });
  it('caps at MAX_IMAGES and says so when more are added', () => {
    const files = Array.from({ length: MAX_IMAGES + 2 }, (_, i) => png(10, `${i}.png`));
    const r = checkFiles(files, 0);
    expect(r.accepted.length).toBe(MAX_IMAGES);
    expect(r.error).toContain(`${MAX_IMAGES}`);
  });
  it('counts already-attached images against the cap', () => {
    const r = checkFiles([png(), png()], MAX_IMAGES - 1);
    expect(r.accepted.length).toBe(1);
    expect(r.error).toContain(`${MAX_IMAGES}`);
  });
  it('refuses everything when the tray is full', () => {
    const r = checkFiles([png()], MAX_IMAGES);
    expect(r.accepted).toEqual([]);
    expect(r.error).toContain(`${MAX_IMAGES}`);
  });
  it('rejects files over MAX_IMAGE_BYTES', () => {
    const r = checkFiles([png(MAX_IMAGE_BYTES + 1, 'huge.png'), jpg(10, 'ok.jpg')], 0);
    expect(r.accepted).toEqual([jpg(10, 'ok.jpg')]);
    expect(r.error).toContain('huge.png');
    expect(r.error).toContain('5 MB');
  });
  it('accepts a file exactly at the byte cap', () => {
    const r = checkFiles([png(MAX_IMAGE_BYTES, 'edge.png')], 0);
    expect(r.accepted.length).toBe(1);
    expect(r.error).toBeNull();
  });
});
