// Shared file helpers: bounded reads, line splitting and tolerant JSON object parsing.
// Used by the transcript watcher and the worker registry (not the data-model files).
import { closeSync, openSync, readSync } from 'node:fs';
import { open } from 'node:fs/promises';

const TURN_SCAN_CHUNK = 64 * 1024;
const TURN_NEEDLES = [Buffer.from('"type":"assistant"'), Buffer.from('"type":"result"')] as const;
const TURN_NEEDLE_OVERLAP = Math.max(...TURN_NEEDLES.map(n => n.length));

/**
 * Scans a transcript file backwards in 64 KB overlapping chunks for an assistant or
 * result entry. Throws when the file cannot be opened or read; callers map to false.
 */
export function fileHasTurnScan(file: string, size: number): boolean {
  if (size <= 0) return false;
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(Math.min(TURN_SCAN_CHUNK, size));
    let end = size;
    while (end > 0) {
      const offset = Math.max(0, end - TURN_SCAN_CHUNK);
      const bytesRead = readSync(fd, buf, 0, end - offset, offset);
      if (bytesRead === 0) break;
      const chunk = buf.subarray(0, bytesRead);
      if (TURN_NEEDLES.some(needle => chunk.includes(needle))) return true;
      if (offset === 0) break;
      end = offset + TURN_NEEDLE_OVERLAP;
    }
    return false;
  } finally {
    closeSync(fd);
  }
}

/**
 * Reads [offset, offset+length) bytes of a file (to the end when length is undefined).
 * Throws when the file cannot be opened or read; callers map that to their own fallback.
 */
export async function readRange(path: string, offset: number, length?: number): Promise<Buffer> {
  const handle = await open(path, 'r');
  try {
    const st = await handle.stat();
    const end = length === undefined ? st.size : offset + length;
    const size = Math.max(0, Math.min(end, st.size) - offset);
    if (size === 0) return Buffer.alloc(0);
    const buf = Buffer.alloc(size);
    const { bytesRead } = await handle.read(buf, 0, size, offset);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close().catch(() => {});
  }
}

/** Splits a buffer into complete newline-terminated lines, keeping the trailing partial line. */
export function extractLines(buf: Buffer): { lines: string[]; rest: Buffer } {
  const lines: string[] = [];
  let start = 0;
  while (start < buf.length) {
    const nl = buf.indexOf(0x0a, start);
    if (nl < 0) break;
    let line = buf.subarray(start, nl).toString('utf8');
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (line.trim().length > 0) lines.push(line);
    start = nl + 1;
  }
  return { lines, rest: buf.subarray(start) };
}

/** Parses text as a JSON object; anything else (missing, invalid, array, scalar) becomes {}. */
export function parseObject(text: string | undefined): Record<string, unknown> {
  if (!text) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
