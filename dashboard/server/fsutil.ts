// Shared file helpers: bounded reads, line splitting and tolerant JSON object parsing.
// Used by the transcript watcher and the worker registry (not the data-model files).
import { open } from 'node:fs/promises';

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
