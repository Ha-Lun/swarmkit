// Long-running `claude remote-control` / `claude rc` processes kept in tmux panes.
// The dashboard pins them in a side rail: live or stopped, how many sessions they
// serve, a link to their claude.ai environment, and a restart for a dead pane
// (`tmux respawn-pane` reruns the pane's original command; never on a live pane).
import { execFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';
import type { RemoteControl } from '../src/shared/types.ts';

const run = promisify(execFile);

export type TmuxExec = (args: string[]) => Promise<string>;

const defaultExec: TmuxExec = async (args) => (await run('tmux', args, { timeout: 3_000, maxBuffer: 1 << 20 })).stdout;

const SEP = '\u001f';
const FIELDS = [
  'pane_id',
  'session_name',
  'window_index',
  'window_name',
  'pane_dead',
  'pane_dead_time',
  'pane_start_command',
  'pane_start_path',
  'window_activity',
] as const;
const FORMAT = FIELDS.map((f) => `#{${f}}`).join(SEP);

/** `claude remote-control …` or `claude rc …`, possibly quoted by tmux. */
const RC_COMMAND = /(?:^|[\s"'/])claude\s+(?:remote-control|rc)\b/;
const ENV_URL = /https:\/\/claude\.ai\/code\?environment=[A-Za-z0-9_]+/g;
const CAPACITY = /Capacity:\s*(\d+)\s*\/\s*(\d+)/g;

/** `--name X` / `--name=X` from the start command, unquoted. */
export function nameFrom(command: string): string | undefined {
  const m = /--name(?:=|\s+)(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(command);
  const raw = m?.[1] ?? m?.[2] ?? m?.[3];
  return raw?.replace(/["']+$/, '') || undefined;
}

function lastMatch(re: RegExp, text: string): RegExpExecArray | undefined {
  let last: RegExpExecArray | undefined;
  for (const m of text.matchAll(re)) last = m as RegExpExecArray;
  return last;
}

function epochMs(s: string | undefined): number | undefined {
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n * 1000 : undefined;
}

/** Display path: the home folder as `~`. */
function tildify(p: string, home = os.homedir()): string {
  return home && (p === home || p.startsWith(`${home}/`)) ? `~${p.slice(home.length)}` : p;
}

export interface RemoteControlOptions {
  exec?: TmuxExec;
  ttlMs?: number;
}

export function createRemoteControls({ exec = defaultExec, ttlMs = 5_000 }: RemoteControlOptions = {}) {
  let cache: { at: number; list: RemoteControl[] } | undefined;

  async function list(): Promise<RemoteControl[]> {
    if (cache && Date.now() - cache.at < ttlMs) return cache.list;
    let out: string;
    try {
      out = await exec(['list-panes', '-a', '-F', FORMAT]);
    } catch {
      return []; // no tmux server, or tmux not installed
    }
    const rows = out
      .split('\n')
      .filter(Boolean)
      .map((line) => Object.fromEntries(line.split(SEP).map((v, i) => [FIELDS[i], v])) as Record<(typeof FIELDS)[number], string>)
      .filter((r) => RC_COMMAND.test(r.pane_start_command ?? ''));

    const list = await Promise.all(
      rows.map(async (r): Promise<RemoteControl> => {
        let text = '';
        try {
          text = await exec(['capture-pane', '-p', '-J', '-S', '-400', '-t', r.pane_id]);
        } catch {
          // pane vanished between the two calls
        }
        const alive = r.pane_dead !== '1';
        const cap = alive ? lastMatch(CAPACITY, text) : undefined;
        const url = lastMatch(ENV_URL, text)?.[0];
        return {
          id: r.pane_id.replace(/^%/, ''),
          name: nameFrom(r.pane_start_command) ?? r.window_name,
          cwd: r.pane_start_path ? tildify(r.pane_start_path) : undefined,
          target: `${r.session_name}:${r.window_index}`,
          alive,
          ...(alive ? {} : { stoppedAt: epochMs(r.pane_dead_time) }),
          activityAt: epochMs(r.window_activity),
          ...(cap ? { sessions: Number(cap[1]), capacity: Number(cap[2]) } : {}),
          ...(url ? { url } : {}),
        };
      }),
    );
    list.sort((a, b) => Number(b.alive) - Number(a.alive) || a.name.localeCompare(b.name));
    cache = { at: Date.now(), list };
    return list;
  }

  /** Respawn a dead remote-control pane. Returns false when the id is unknown or the pane is live. */
  async function restart(id: string): Promise<boolean> {
    if (!/^\d{1,6}$/.test(id)) return false;
    cache = undefined;
    const target = (await list()).find((r) => r.id === id);
    if (!target || target.alive) return false;
    await exec(['respawn-pane', '-t', `%${id}`]); // no -k: never kills a running process
    cache = undefined;
    return true;
  }

  return { list, restart };
}
