// Last slash-command list seen per runtime and cwd. Filled by live page sessions; optionally
// saved to disk ($XDG_CONFIG_HOME/swarmkit/commands.json) so a restart doesn't empty the menu.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Runtime, SlashCommandInfo } from '../src/shared/types.ts';

/** At most this many runtime+cwd lists are kept; the least recently updated go first. */
const MAX_ENTRIES = 50;

export function commandCacheFilePath(): string {
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  const base = xdg && path.isAbsolute(xdg) ? path.resolve(xdg) : path.join(os.homedir(), '.config');
  return path.join(base, 'swarmkit', 'commands.json');
}

function validList(v: unknown): SlashCommandInfo[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((c): c is SlashCommandInfo =>
    typeof c === 'object' && c !== null && typeof (c as SlashCommandInfo).name === 'string');
  return out.length ? out : undefined;
}

export class CommandCache {
  /** Map order = least recently updated first. Key: `${runtime}\0${cwd}`. */
  private lists = new Map<string, SlashCommandInfo[]>();
  private writeChain: Promise<void> = Promise.resolve();

  /** `file` null: memory only (tests). */
  constructor(private file: string | null = null) {
    if (!file) return;
    try {
      const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        for (const [key, list] of Object.entries(raw as Record<string, unknown>)) {
          const valid = validList(list);
          if (valid && key.includes('\0')) this.lists.set(key, valid);
        }
      }
    } catch {
      // Missing or corrupt: start empty; the next live list rewrites it.
    }
  }

  /** The list for this cwd, else the most recent list for the runtime ([] when none). */
  get(runtime: Runtime, cwd: string): SlashCommandInfo[] {
    const exact = this.lists.get(`${runtime}\0${cwd}`);
    if (exact) return exact;
    const prefix = `${runtime}\0`;
    const keys = [...this.lists.keys()].filter(k => k.startsWith(prefix));
    return keys.length ? this.lists.get(keys[keys.length - 1]!)! : [];
  }

  /** Exact entry only, no fallback. */
  has(runtime: Runtime, cwd: string): boolean {
    return this.lists.has(`${runtime}\0${cwd}`);
  }

  set(runtime: Runtime, cwd: string, list: SlashCommandInfo[]): void {
    const key = `${runtime}\0${cwd}`;
    this.lists.delete(key);
    this.lists.set(key, list);
    for (const k of this.lists.keys()) {
      if (this.lists.size <= MAX_ENTRIES) break;
      this.lists.delete(k);
    }
    if (this.file) this.save(this.file);
  }

  private save(file: string): void {
    const data = JSON.stringify(Object.fromEntries(this.lists));
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
      await writeFile(tmp, data, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await rename(tmp, file);
    }).catch(err => {
      console.warn('Could not save the command cache:', err instanceof Error ? err.message : err);
    });
  }
}
