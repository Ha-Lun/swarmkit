import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { MAX_DETAIL } from '../../src/shared/types.ts';
import type { AgentNode, ServerEvent, WorkerInfo } from '../../src/shared/types.ts';
import type { SessionTree } from './reducer.ts';

export interface ParsedWorkerCommand {
  lane: 'agy' | 'opencode';
  slug: string;
  model?: string;
  agent?: string;
  /** Prompt text (heredoc body or remaining args), when present in the command. */
  prompt?: string;
}

/** Matches `agy-task start <slug>` / `opencode-task start <slug>` anywhere in a command line. */
const WORKER_RE = /(?:^|[\s;&|(])(agy|opencode)-task[ \t]+start[ \t]+([A-Za-z0-9._-]+)/;

/**
 * Parses a Bash command that starts a headless worker task. Returns undefined when the
 * command does not start a worker.
 */
export function parseWorkerCommand(command: string): ParsedWorkerCommand | undefined {
  if (typeof command !== 'string') return undefined;
  const m = WORKER_RE.exec(command);
  if (!m) return undefined;
  const lane = m[1] as 'agy' | 'opencode';
  const slug = m[2];
  const model = flagValue(command, 'model');
  const agent = flagValue(command, 'agent');
  return { lane, slug, model, agent, prompt: extractPrompt(command.slice(m.index + m[0].length)) };
}

function flagValue(command: string, name: string): string | undefined {
  const m = new RegExp(`--${name}(?:=|[ \\t]+)([^\\s"']+)`).exec(command);
  return m ? m[1] : undefined;
}

/** Prompt text following the slug: a heredoc body, or the leftover non-flag arguments. */
function extractPrompt(after: string): string | undefined {
  const heredoc = extractHeredocBody(after);
  if (heredoc) return heredoc;
  const rest = after
    .replace(/--[\w-]+(?:=|[ \t]+)[^\s"']+/g, ' ')
    .replace(/[ \t]*-+[ \t]*/g, ' ')
    .replace(/^["'\s]+|["'\s]+$/g, '');
  return rest.length > 0 ? rest : undefined;
}

function extractHeredocBody(text: string): string | undefined {
  const head = /^[ \t]*<<-?(['"]?)([A-Za-z_]\w*)\1/.exec(text);
  if (!head) return undefined;
  const delim = head[2];
  const lines = text.slice(head[0].length).split('\n');
  const body: string[] = [];
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === delim) break;
    body.push(lines[i]);
  }
  const joined = body.join('\n').trim();
  return joined.length > 0 ? joined : undefined;
}

function workerRoot(lane: 'agy' | 'opencode'): string {
  if (lane === 'agy') return process.env.AGY_TASK_DIR || join(homedir(), '.agy-tasks');
  return process.env.OPENCODE_TASK_DIR || join(homedir(), '.opencode-tasks');
}

/**
 * Checks every running worker node in the tree against its result.json
 * (under root/any-lane/slug/result.json; root is AGY_TASK_DIR | ~/.agy-tasks for lane
 * agy, OPENCODE_TASK_DIR | ~/.opencode-tasks for lane opencode) and returns the events
 * for nodes that finished. Callers run it every few seconds for live sessions.
 */
export async function pollWorkers(tree: SessionTree): Promise<ServerEvent[]> {
  const out: ServerEvent[] = [];
  for (const node of tree.nodes.values()) {
    if (node.kind !== 'worker' || !node.worker || node.status !== 'running') continue;
    try {
      const result = await findWorkerResult(node);
      if (!result) continue;
      const data = JSON.parse(result.text) as Record<string, unknown>;
      const worker = node.worker as WorkerInfo;
      worker.ok = data.ok === true;
      worker.stoppedBy = typeof data.stopped_by === 'string' ? data.stopped_by : undefined;
      const text =
        typeof data.response === 'string' ? data.response :
        typeof data.changes === 'string' ? data.changes :
        undefined;
      if (text !== undefined) node.result = cap(text);
      node.status = worker.ok ? 'done' : 'error';
      node.endedAt = Date.now();
      node.lastActivity = node.result ? node.result.split('\n', 1)[0] : undefined;
      out.push({ type: 'node.upsert', node: headOf(node) });
    } catch {
      // unreadable result file: leave the worker running, retry next pass
    }
  }
  return out;
}

async function findWorkerResult(node: AgentNode): Promise<{ path: string; text: string } | undefined> {
  const rootDir = workerRoot(node.worker!.lane);
  let laneDirs: string[];
  try {
    laneDirs = await readdir(rootDir);
  } catch {
    return undefined;
  }
  let best: { path: string; mtimeMs: number } | undefined;
  for (const laneDir of laneDirs) {
    const resultPath = join(rootDir, laneDir, node.worker!.slug, 'result.json');
    try {
      const st = await stat(resultPath);
      if (!st.isFile()) continue;
      if (st.mtimeMs >= node.startedAt - 5000 && (!best || st.mtimeMs > best.mtimeMs)) {
        best = { path: resultPath, mtimeMs: st.mtimeMs };
      }
    } catch {
      // not this lane dir
    }
  }
  if (!best) return undefined;
  return { path: best.path, text: await readFile(best.path, 'utf8') };
}

function headOf(node: AgentNode): Omit<AgentNode, 'events'> {
  const { events, ...head } = node;
  void events;
  return head;
}

function cap(text: string, max = MAX_DETAIL): string {
  return text.length > max ? text.slice(0, max) : text;
}
