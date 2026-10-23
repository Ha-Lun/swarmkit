import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
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

/** Bounded git-root lookup cache shared by all trees (cwd -> git root / undefined). */
const GIT_ROOT_CACHE = new Map<string, string | undefined>();
const MAX_GIT_ROOT_CACHE = 200;

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
  const rest = command.slice(m.index + m[0].length);
  const cmdline = commandLinePart(rest);
  const model = flagValue(cmdline, 'model');
  const agent = flagValue(cmdline, 'agent');
  return { lane, slug, model, agent, prompt: extractPrompt(rest, cmdline) };
}

/** Matches `agy-task resume <slug>` / `opencode-task resume <slug>` anywhere in a command line. */
const WORKER_RESUME_RE = /(?:^|[\s;&|(])(agy|opencode)-task[ \t]+resume[ \t]+([A-Za-z0-9._-]+)/;

/**
 * Parses a Bash command that resumes an already started headless worker task. Resuming never
 * creates a worker node; the reducer reattaches the run to the node that started the slug.
 */
export function parseWorkerResumeCommand(command: string): { lane: 'agy' | 'opencode'; slug: string } | undefined {
  if (typeof command !== 'string') return undefined;
  const m = WORKER_RESUME_RE.exec(command);
  if (!m) return undefined;
  return { lane: m[1] as 'agy' | 'opencode', slug: m[2] };
}

/**
 * The command-line text before the prompt: cut at the first quoted argument after the slug,
 * at a heredoc marker `<<`, or at the standalone stdin dash (` - ` / trailing ` -`). Flags of
 * the prompt text itself (e.g. a --model inside a quoted setup command or heredoc body) must
 * not leak into the parsed flags.
 */
function commandLinePart(rest: string): string {
  let cut = rest.length;
  const quoted = rest.search(/['"]/);
  if (quoted >= 0 && quoted < cut) cut = quoted;
  const heredoc = rest.indexOf('<<');
  if (heredoc >= 0 && heredoc < cut) cut = heredoc;
  const dash = /\s-\s|\s-$/.exec(rest);
  if (dash && dash.index >= 0 && dash.index < cut) cut = dash.index;
  return rest.slice(0, cut);
}

function flagValue(command: string, name: string): string | undefined {
  const m = new RegExp(`--${name}(?:=|[ \\t]+)([^\\s"']+)`).exec(command);
  return m ? m[1] : undefined;
}

/** A standalone `-` argument: the prompt is read from stdin and is not part of the command. */
function hasStdinDash(cmdline: string): boolean {
  return /\s-\s|\s-$/.test(cmdline);
}

/** Prompt text following the slug: a heredoc body, the last quoted argument, or the leftover non-flag arguments. */
function extractPrompt(rest: string, cmdline: string): string | undefined {
  // The heredoc marker may sit behind flags/quoted values (`--setup "x" - <<'EOF'`).
  for (let idx = rest.indexOf('<<'); idx >= 0; idx = rest.indexOf('<<', idx + 1)) {
    const heredoc = extractHeredocBody(rest.slice(idx));
    if (heredoc) return heredoc;
  }
  if (hasStdinDash(cmdline)) return undefined;
  const quoted = lastQuotedArg(rest);
  if (quoted !== undefined) {
    const text = quoted.trim();
    return text.length > 0 ? text : undefined;
  }
  const leftover = rest
    .replace(/--[\w-]+(?:=|[ \t]+)[^\s"']+/g, ' ')
    .replace(/[ \t]*-+[ \t]*/g, ' ')
    .replace(/^["'\s]+|["'\s]+$/g, '');
  return leftover.length > 0 ? leftover : undefined;
}

/** The text between the last matching quote pair, when the command has one. */
function lastQuotedArg(rest: string): string | undefined {
  let best: string | undefined;
  let bestEnd = -1;
  for (const q of ['"', "'"]) {
    const close = rest.lastIndexOf(q);
    if (close <= 0) continue;
    const open = rest.lastIndexOf(q, close - 1);
    if (open < 0) continue;
    if (close > bestEnd) {
      bestEnd = close;
      best = rest.slice(open + 1, close);
    }
  }
  return best;
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
 * The task-dir repo key, exactly as scripts/agy-task computes it:
 * `<basename of the git root>-<first 6 hex of sha1(git root path)>`.
 */
export function repoKeyOf(gitRoot: string): string {
  const hash = createHash('sha1').update(gitRoot).digest('hex').slice(0, 6);
  return `${basename(gitRoot)}-${hash}`;
}

/** The `cd <dir> &&` prefix directory of a command line, when present. */
function cdPrefixDir(command: string | undefined): string | undefined {
  if (!command) return undefined;
  const m = /(?:^|[;&|\n])[ \t]*cd[ \t]+((?:"[^"]*"|'[^']*'|\S+))[ \t]*&&/.exec(command);
  if (!m) return undefined;
  return m[1].replace(/^["']|["']$/g, '');
}

/** Walks up from dir to the closest ancestor containing .git; cached per dir across polls. */
function findGitRoot(dir: string): string | undefined {
  if (GIT_ROOT_CACHE.has(dir)) return GIT_ROOT_CACHE.get(dir);
  let root: string | undefined;
  let cur = dir;
  outer: for (let hops = 0; hops < 48; hops++) {
    if (existsSync(join(cur, '.git'))) { root = cur; break; }
    const parent = dirname(cur);
    if (parent === cur) break outer;
    cur = parent;
  }
  if (root !== undefined) {
    if (GIT_ROOT_CACHE.size >= MAX_GIT_ROOT_CACHE) GIT_ROOT_CACHE.delete(GIT_ROOT_CACHE.keys().next().value!);
    GIT_ROOT_CACHE.set(dir, root);
  }
  return root;
}

/**
 * The repo key the node's worker task runs in, or undefined when unknown. Derived from the
 * command's `cd <dir> &&` prefix or the session cwd; recorded once on the tree.
 */
async function workerRepo(tree: SessionTree, node: AgentNode): Promise<string | undefined> {
  tree.workerRepos ??= new Map<string, string | undefined>();
  if (tree.workerRepos.has(node.id)) return tree.workerRepos.get(node.id);
  const fromCommand = cdPrefixDir(tree.workerCommands?.get(node.id));
  const startDir = fromCommand ?? tree.cwd;
  const gitRoot = startDir ? findGitRoot(startDir) : undefined;
  const key = gitRoot ? repoKeyOf(gitRoot) : undefined;
  tree.workerRepos.set(node.id, key);
  return key;
}

interface WorkerResultFile {
  path: string;
  text: string;
  opts: Record<string, unknown>;
}

/**
 * Checks every busy worker node in the tree against its result.json
 * (under root/<repo>/<slug>/result.json; root is AGY_TASK_DIR | ~/.agy-tasks for lane
 * agy, OPENCODE_TASK_DIR | ~/.opencode-tasks for lane opencode) and returns the events
 * for nodes that finished. Callers run it every few seconds for live sessions.
 *
 * A node that a task-notification already marked 'error' is rechecked until a result.json
 * shows up: result.json (`worker.ok`) settles done/error once it is known.
 */
export async function pollWorkers(tree: SessionTree): Promise<ServerEvent[]> {
  const out: ServerEvent[] = [];
  const candidates = [...tree.nodes.values()].filter(
    (node) =>
      node.kind === 'worker' && node.worker &&
      (node.status === 'running' || (node.status === 'error' && node.worker.ok === undefined)),
  );
  if (candidates.length === 0) return out;
  // One readdir per lane root per poll, shared across all nodes.
  const laneDirCache = new Map<'agy' | 'opencode', string[]>();
  for (const node of candidates) {
    const awaitingResult = node.status === 'error'; // a notification already failed this run
    try {
      const result = await findWorkerResult(tree, node, laneDirCache);
      if (result) {
        const events = await applyResult(tree, node, result);
        out.push(...events);
        continue;
      }
      if (!awaitingResult && tree.workerRepos?.get(node.id) !== undefined) {
        // The repo dir is known but has no result.json: the task either still runs or died.
        if (await taskDied(node, tree.workerRepos!.get(node.id)!)) out.push(...markFinished(node, 'error'));
      }
    } catch {
      // unreadable/task dirs missing: leave the worker running, retry next pass
    }
  }
  return out;
}

/** Marks a still-running worker node 'error' when its task noted a pid that is no longer alive. */
async function taskDied(node: AgentNode, repo: string): Promise<boolean> {
  const taskDir = join(workerRoot(node.worker!.lane), repo, node.worker!.slug);
  let pidText: string;
  try {
    // No pid file (yet) means we cannot tell: leave the node running.
    pidText = await readFile(join(taskDir, 'pid'), 'utf8');
  } catch {
    return false;
  }
  const pid = Number.parseInt(pidText.trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false; // still running
  } catch {
    return true;
  }
}

function markFinished(node: AgentNode, status: AgentNode['status']): ServerEvent[] {
  node.status = status;
  node.endedAt = Date.now();
  if (!node.result) node.lastActivity = status === 'error' ? 'unfinished (pid gone)' : node.lastActivity;
  return [{ type: 'node.upsert', node: headOf(node) }];
}

async function applyResult(
  tree: SessionTree,
  node: AgentNode,
  result: WorkerResultFile,
): Promise<ServerEvent[]> {
  const data = JSON.parse(result.text) as Record<string, unknown>;
  const worker = node.worker as WorkerInfo;
  worker.ok = data.ok === true;
  worker.stoppedBy = typeof data.stopped_by === 'string' ? data.stopped_by : undefined;
  // What the task was actually started with (opts.json of the matching task dir).
  const opts = result.opts;
  const optsModel = typeof opts.model === 'string' && opts.model ? opts.model : undefined;
  const optsAgent = typeof opts.agent === 'string' && opts.agent ? opts.agent : undefined;
  if (optsModel) worker.model = optsModel;
  if (optsAgent) worker.agent = optsAgent;
  const text =
    typeof data.response === 'string' ? data.response :
    typeof data.changes === 'string' ? data.changes :
    undefined;
  if (text !== undefined) node.result = cap(text);
  node.status = worker.ok ? 'done' : 'error';
  node.endedAt = Date.now();
  node.lastActivity = node.result ? node.result.split('\n', 1)[0] : undefined;
  if (optsModel && !node.model) node.model = optsModel;
  void tree;
  return [{ type: 'node.upsert', node: headOf(node) }];
}

/**
 * Finds the result.json of the worker task. When the repo key is known, only
 * <root>/<repo>/<slug>/result.json is consulted; unknown repos fall back to scanning
 * every lane dir (readdir shared across nodes through `laneDirCache`).
 */
async function findWorkerResult(
  tree: SessionTree,
  node: AgentNode,
  laneDirCache: Map<'agy' | 'opencode', string[]>,
): Promise<WorkerResultFile | undefined> {
  const lane = node.worker!.lane;
  const rootDir = workerRoot(lane);
  const repo = await workerRepo(tree, node);
  if (repo !== undefined) {
    const resultPath = join(rootDir, repo, node.worker!.slug, 'result.json');
    try {
      const st = await stat(resultPath);
      if (st.isFile() && st.mtimeMs >= node.startedAt - 5000) {
        return { path: resultPath, text: await readFile(resultPath, 'utf8'), opts: await readFileObject(join(dirname(resultPath), 'opts.json')) };
      }
      return undefined;
    } catch {
      return undefined; // no result yet for the known repo
    }
  }
  let laneDirs: string[];
  const cached = laneDirCache.get(lane);
  if (cached) laneDirs = cached;
  else {
    try {
      laneDirs = (await readdir(rootDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      laneDirs = [];
    }
    laneDirCache.set(lane, laneDirs);
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
  const opts: Record<string, unknown> = await readFileObject(join(dirname(best.path), 'opts.json'));
  return { path: best.path, text: await readFile(best.path, 'utf8'), opts };
}

async function readFileObject(path: string): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function headOf(node: AgentNode): Omit<AgentNode, 'events'> {
  const { events, ...head } = node;
  void events;
  return head;
}

function cap(text: string, max = MAX_DETAIL): string {
  return text.length > max ? text.slice(0, max) : text;
}
