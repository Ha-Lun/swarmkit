// Long-running `claude remote-control` / `claude rc` processes kept in tmux panes.
// The dashboard pins the live ones in a side rail: how many sessions they serve and a
// link to claude.ai. A `remote-control` server prints its environment URL; a `claude rc`
// TUI prints nothing, so its link comes from its ~/.claude/sessions/<pid>.json
// (`tmux` names the pane, `bridgeSessionId` the claude.ai session).
import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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

/** pane id (`%7`) -> claude.ai session URL, from live Claude processes' session files. */
async function sessionUrls(dir: string): Promise<Map<string, string>> {
  const urls = new Map<string, string>();
  const files = await readdir(dir).catch(() => [] as string[]);
  await Promise.all(
    files
      .filter((f) => f.endsWith('.json'))
      .map(async (f) => {
        try {
          const s = JSON.parse(await readFile(path.join(dir, f), 'utf8')) as { pid?: number; tmux?: string; bridgeSessionId?: string };
          const pane = /%\d+$/.exec(s.tmux ?? '')?.[0];
          if (!pane || !s.bridgeSessionId || !/^session_[A-Za-z0-9]+$/.test(s.bridgeSessionId)) return;
          if (s.pid) process.kill(s.pid, 0); // throws for a stale file
          urls.set(pane, `https://claude.ai/code/${s.bridgeSessionId}`);
        } catch {
          // unreadable, half-written or stale
        }
      }),
  );
  return urls;
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
  sessionsDir?: string;
}

export function createRemoteControls({
  exec = defaultExec,
  ttlMs = 5_000,
  sessionsDir = path.join(os.homedir(), '.claude', 'sessions'),
}: RemoteControlOptions = {}) {
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
      .filter((r) => r.pane_dead !== '1' && RC_COMMAND.test(r.pane_start_command ?? ''));
    const sessions = await sessionUrls(sessionsDir);

    const list = await Promise.all(
      rows.map(async (r): Promise<RemoteControl> => {
        let text = '';
        try {
          text = await exec(['capture-pane', '-p', '-J', '-S', '-400', '-t', r.pane_id]);
        } catch {
          // pane vanished between the two calls
        }
        const cap = lastMatch(CAPACITY, text);
        const url = lastMatch(ENV_URL, text)?.[0] ?? sessions.get(r.pane_id);
        return {
          id: r.pane_id.replace(/^%/, ''),
          name: nameFrom(r.pane_start_command) ?? r.window_name,
          cwd: r.pane_start_path ? tildify(r.pane_start_path) : undefined,
          target: `${r.session_name}:${r.window_index}`,
          activityAt: epochMs(r.window_activity),
          ...(cap ? { sessions: Number(cap[1]), capacity: Number(cap[2]) } : {}),
          ...(url ? { url } : {}),
        };
      }),
    );
    list.sort((a, b) => a.name.localeCompare(b.name));
    cache = { at: Date.now(), list };
    return list;
  }


  return { list };
}
