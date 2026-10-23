// Shared home-directory helpers: realpathed $HOME, inside-home checks, cwd resolution
// and the Claude config dir. Centralises the symlinked-$HOME handling.
import { realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

let cachedHomeReal: string | undefined;

/** realpath of os.homedir(), cached (the home dir does not move within a process). */
export async function homeReal(): Promise<string> {
  if (cachedHomeReal === undefined) cachedHomeReal = await realpath(os.homedir());
  return cachedHomeReal;
}

/** True when p is home itself or lives under it (string-prefix on the realpathed home). */
export function isInside(home: string, p: string): boolean {
  return p === home || p.startsWith(home + path.sep);
}

/**
 * Resolve `raw` to the realpath of an existing directory inside $HOME.
 * Returns `{ dir }` or `{ error }` so callers can map the message to their own status error.
 */
export async function resolveDirInHome(raw: unknown): Promise<{ dir: string } | { error: string }> {
  if (typeof raw !== 'string' || raw.length === 0) return { error: 'cwd is required' };
  let real: string;
  try {
    real = await realpath(raw);
    const st = await stat(real);
    if (!st.isDirectory()) return { error: 'cwd must be a directory' };
  } catch {
    return { error: 'cwd does not exist' };
  }
  if (!isInside(await homeReal(), real)) return { error: 'cwd must be inside your home directory' };
  return { dir: real };
}

/** Claude config dir: CLAUDE_CONFIG_DIR overrides ~/.claude (non-empty wins). */
export function claudeConfigDir(): string {
  const override = process.env.CLAUDE_CONFIG_DIR;
  if (typeof override === 'string' && override.trim().length > 0) return override;
  return path.join(os.homedir(), '.claude');
}
