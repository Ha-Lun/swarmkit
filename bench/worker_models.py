#!/usr/bin/env python3
"""Worker-only model comparison: drive `opencode-task` on the `scaffold` fixture, one worker per module.

  python3 bench/worker_models.py --repeats 3                    scaffold fixture, default arms muse,beam (spends model quota)
  python3 bench/worker_models.py --arms muse                    only the named arms
  python3 bench/worker_models.py --fixture hard                 harder fixture (4 modules, 12m per worker)
  python3 bench/worker_models.py --summarize F1 [F2 ...]        one combined table; an arm is taken from the
                                                                first file (in the order given) that has it

Never starts a `claude` session. Only `opencode-go/*` models are accepted. Results are written
incrementally to bench/results/worker-models-<UTC>.json (the directory is gitignored).
"""
import argparse
import datetime
import json
import os
import re
import shutil
import statistics
import subprocess
import sys
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor

BENCH = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, BENCH)
import run  # noqa: E402  (make_fixture)

# fixture -> (modules, default per-worker timeout). `scaffold` lives in cases.json; `hard` lives in
# bench/fixtures/hard (its reference solutions are in bench/fixtures/hard-reference, never given to workers).
FIXTURES = {
    'scaffold': (['csv', 'semver', 'lru', 'expr', 'cron', 'template', 'diff', 'wrap'], '9m'),
    'hard': (['ini', 'merge3', 'ratelimit', 'glob'], '12m'),
}
MODULES = FIXTURES['scaffold'][0]
# label -> (model id, effort or None). Effort None = wrapper default ("max"); '' = the model's own default
# (passed explicitly, which switches the wrapper default off). muse rejects "max" ("Variant unavailable").
ARMS = {
    'muse': ('opencode-go/muse-spark-1.3-contributor', ''),
    'beam': ('opencode-go/beam-free', ''),
}
PROMPT = ("You are in a git worktree of a small Node project. Implement `src/{m}.js` so that "
          "`node test/{m}.test.js` passes. Read the test first. Edit only `src/{m}.js`; do not touch "
          "tests or any other file. You are already in the worktree: do not cd. Run the test with "
          "`node test/{m}.test.js` when done.")
EDIT_TOOLS = {'edit', 'write', 'multiedit', 'patch', 'apply_patch'}
TASK_ROOT = os.path.expanduser(os.environ.get('OPENCODE_TASK_DIR', '~/.opencode-tasks'))
LOCK = threading.Lock()


def sh(*cmd, cwd=None, timeout=60, stdin=None):
    return subprocess.run(cmd, cwd=cwd, text=True, capture_output=True, timeout=timeout, input=stdin)


def task_dir(fx, slug):
    """Mirror agy-task: <root>/<repo name>-<sha1(path)[:6]>/<slug>, keyed by the first worktree entry."""
    import hashlib
    first = sh('git', 'worktree', 'list', '--porcelain', cwd=fx).stdout.splitlines()[0].split(' ', 1)[1]
    return os.path.join(TASK_ROOT, f'{os.path.basename(first)}-{hashlib.sha1(first.encode()).hexdigest()[:6]}', slug)


def bare(names):
    """Bare relative paths only (no absolute paths, no ..), trimmed."""
    return [n[:100] for n in names if n and not n.startswith('/') and '..' not in n.split('/')]


def parse_log(path):
    """Tool-call statistics from opencode.log (JSON lines, `type == tool_use`)."""
    st = {'tool_calls': 0, 'edit_write_calls': 0, 'edit_write_errors': 0, 'tools': {}, 'errors_by_tool': {},
          'first_edit_error': None, 'log_events': 0, 'log_error': None}
    try:
        lines = open(path, errors='replace').read().splitlines()
    except OSError:
        return st
    for line in lines:
        try:
            e = json.loads(line)
        except ValueError:
            continue
        st['log_events'] += 1
        if e.get('type') == 'error' and not st['log_error']:  # e.g. provider.no-route: Model unavailable
            err = e.get('error') or {}
            st['log_error'] = f"{err.get('type', '')}: {err.get('message', '')}"[:200]
        if e.get('type') != 'tool_use':
            continue
        part = e.get('part') or {}
        tool, state = part.get('tool', '?'), part.get('state') or {}
        status = state.get('status')
        st['tool_calls'] += 1
        st['tools'][tool] = st['tools'].get(tool, 0) + 1
        if status == 'error':
            st['errors_by_tool'][tool] = st['errors_by_tool'].get(tool, 0) + 1
        if tool in EDIT_TOOLS:
            st['edit_write_calls'] += 1
            if status == 'error':
                st['edit_write_errors'] += 1
                if not st['first_edit_error']:
                    st['first_edit_error'] = str(state.get('error', ''))[:100]
    return st


def node_test(wt, rel):
    try:
        p = sh('node', rel, cwd=wt, timeout=30)
        return p.returncode == 0, (p.stderr or p.stdout).strip()[-150:]
    except subprocess.TimeoutExpired:
        return False, 'timeout (30s)'


def verify(wt, base, m):
    """Run the worker's test file and, independently, the original from the base commit."""
    as_found, note = node_test(wt, f'test/{m}.test.js')
    orig = os.path.join(wt, 'test', f'__orig_{m}.test.js')
    try:
        with open(orig, 'w') as f:
            f.write(sh('git', 'show', f'{base}:test/{m}.test.js', cwd=wt).stdout)
        pass_orig, note_o = node_test(wt, f'test/__orig_{m}.test.js')
    finally:
        if os.path.exists(orig):
            os.unlink(orig)
    return pass_orig, as_found, note_o if not pass_orig else ''


def run_worker(job, args, state):
    model_label, rep, m, cell = job
    model, effort = ARMS[model_label]
    fx, base = cell['fx'], cell['base']
    slug = f'w-{m}'
    cmd = ['opencode-task', 'start', slug, '--model', model, '--base', base, '--wait', '--timeout', args.timeout, '-']
    if effort is not None:
        cmd[2:2] = ['--effort', effort]  # explicit, so '' disables the wrapper default of max
    t0 = time.time()
    rec = {'model_label': model_label, 'model': model, 'effort': effort, 'repeat': rep, 'module': m,
           'start_utc': datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds')}
    try:
        p = sh(*cmd, cwd=fx, timeout=args.hard_timeout, stdin=PROMPT.format(m=m))
        rec['wrapper_exit'], rec['wrapper_stdout'] = p.returncode, p.stdout.strip()[-300:]
        rec['wrapper_stderr'] = p.stderr.strip()[-300:]
    except subprocess.TimeoutExpired:
        rec['wrapper_exit'], rec['wrapper_stdout'] = None, 'harness hard timeout'
    rec['wall_s'] = round(time.time() - t0, 1)
    td = task_dir(fx, slug)
    wt = os.path.join(td, 'worktree')
    try:
        r = json.load(open(os.path.join(td, 'result.json')))
    except (OSError, ValueError):
        r = {}
    u = r.get('usage') or {}
    rec.update(ok=bool(r.get('ok')), has_result=bool(r), denied_n=len(r.get('denied_actions') or []),
               denied_first=[str(d)[:100] for d in (r.get('denied_actions') or [])[:5]],
               usage=u, tokens_total=sum(u.get(k, 0) for k in ('input', 'output', 'reasoning')),
               cache_read=u.get('cache_read', 0), warnings=[w[:160] for w in r.get('warnings') or []],
               timed_out=any('timed out' in w for w in r.get('warnings') or []),
               response=(r.get('response') or '')[:200], changes=r.get('changes'),
               stderr_tail=(r.get('stderr') or '')[-200:])
    rec.update(parse_log(os.path.join(td, 'opencode.log')))
    if os.path.isdir(wt):
        rec['pass'], rec['pass_as_found'], rec['test_note'] = verify(wt, base, m)
        changed = sh('git', 'diff', '--name-only', f'{base}..HEAD', cwd=wt).stdout.splitlines()
        changed += [l[3:] for l in sh('git', 'status', '--porcelain', '-uall', cwd=wt).stdout.splitlines()]
        rec['changed_files'] = bare(sorted(set(changed)))
        rec['scope_violation'] = [c for c in rec['changed_files'] if c != f'src/{m}.js']
    else:
        rec.update({'pass': False, 'pass_as_found': False, 'test_note': 'no worktree', 'changed_files': [],
                    'scope_violation': []})
    rec['main_dirty_now'] = bare(l[3:] for l in sh('git', 'status', '--porcelain', '-uall', cwd=fx).stdout.splitlines())
    sh('opencode-task', 'clean', slug, '--force', cwd=fx)
    return rec


def finish_cell(cell, args, state):
    """All 8 workers of a cell are done: record main-checkout leaks, delete the fixture."""
    cell['leak'] = bare(l[3:] for l in sh('git', 'status', '--porcelain', '-uall', cwd=cell['fx']).stdout.splitlines())
    state['cells'].append({'model_label': cell['model_label'], 'repeat': cell['rep'], 'main_leak_files': cell['leak']})
    shutil.rmtree(cell['fx'], ignore_errors=True)
    sh('git', 'worktree', 'prune', cwd=BENCH)


def save(state, path):
    tmp = path + '.tmp'
    with open(tmp, 'w') as f:
        json.dump({'meta': state['meta'], 'cells': state['cells'], 'workers': state['workers']}, f, indent=1)
    os.replace(tmp, path)


def load_spec(fixture):
    spec = json.loads(run.read(os.path.join(BENCH, 'cases.json')))
    if fixture == 'hard':
        root = os.path.join(BENCH, 'fixtures', 'hard')
        files = {}
        for d, _, names in os.walk(root):
            for n in names:
                files[os.path.relpath(os.path.join(d, n), root)] = run.read(os.path.join(d, n))
        spec['fixtures']['hard'] = files
    return spec


def make_cell(model_label, rep, spec, args):
    fx = run.make_fixture(spec, args.fixture, BENCH, 'opencode', tempfile.mkdtemp(prefix='wm-', dir=args.tmp))
    base = sh('git', 'rev-parse', 'HEAD', cwd=fx).stdout.strip()
    return {'model_label': model_label, 'rep': rep, 'fx': fx, 'base': base, 'left': len(args.modules), 'init': False}


def med(xs):
    return statistics.median(xs) if xs else None


def pct(n, d):
    return f'{100 * n / d:.0f}%' if d else 'n/a'


def merge_results(datas):
    """Combine several results files: an arm comes from the first file that has it (cells likewise)."""
    seen, workers, cells, arms = set(), [], [], {}
    for d in datas:
        for l in {w['model_label'] for w in d['workers']} - seen:
            workers += [w for w in d['workers'] if w['model_label'] == l]
            cells += [c for c in d['cells'] if c['model_label'] == l]
            arms[l] = d['meta'].get('arms', {}).get(l) or list(ARMS.get(l, ('?', None)))
            seen.add(l)
    meta = dict(datas[0]['meta'])
    meta['arms'] = arms
    meta['sources'] = [d['meta'].get('started_utc') for d in datas]
    return {'meta': meta, 'cells': cells, 'workers': workers}


def summarize(data):
    ws, out = data['workers'], []
    meta = data['meta']
    fixture = meta.get('fixture', 'scaffold')
    modules = meta.get('modules') or FIXTURES.get(fixture, FIXTURES['scaffold'])[0]
    out.append(f"# Worker model comparison ({', '.join(str(x) for x in meta.get('sources') or [meta.get('started_utc')])})\n")
    out.append(f"Fixture `{fixture}` ({len(modules)} independent modules), 1 worker per module, per-worker timeout "
               f"{meta.get('timeout')}. Arms: " + '; '.join(
                   f"`{l}` = `{m}` effort `{e or '(model default)'}`" for l, (m, e) in meta.get('arms', {}).items()) + '.')
    out.append(f"\n**n is small: {meta.get('repeats', 3)} repeats x {len(modules)} modules = at most "
               f"{meta.get('repeats', 3) * len(modules)} workers per arm, and only {meta.get('repeats', 3)} per module. "
               'Treat differences as indications, not proof.** Arms that differ in effort setting confound model '
               'and effort (muse rejects `max`).\n')
    # arms of old result files (e.g. withdrawn cat-jam) are not in ARMS: keep them, labelled as found
    labels = [l for l in dict.fromkeys([*ARMS, *(w['model_label'] for w in ws)]) if any(w['model_label'] == l for w in ws)]
    rows = {l: [w for w in ws if w['model_label'] == l] for l in labels}
    leaks = {l: [c for c in data['cells'] if c['model_label'] == l] for l in labels}

    def cols(fn):
        return ' | '.join(fn(rows[l]) for l in labels)

    def rng(xs):
        return f'{med(xs):g} (max {max(xs):g})' if xs else 'n/a'

    def p90(xs):
        if not xs:
            return 'n/a'
        xs = sorted(xs)
        return f'{xs[min(len(xs) - 1, int(0.9 * len(xs)))]:g}'

    out.append('| metric | ' + ' | '.join(f'{l} (n={len(rows[l])})' for l in labels) + ' |')
    out.append('|---|' + '---|' * len(labels))
    table = [
        ('tests pass (original test, independent run)', lambda r: pct(sum(w['pass'] for w in r), len(r))),
        ('tests pass (test file as left by worker)', lambda r: pct(sum(w['pass_as_found'] for w in r), len(r))),
        ('wrapper ok', lambda r: pct(sum(w['ok'] for w in r), len(r))),
        ('hit the timeout (workers)', lambda r: str(sum(w['timed_out'] for w in r))),
        ('denied commands, median (max)', lambda r: rng([w['denied_n'] for w in r])),
        ('workers with >=1 denied', lambda r: str(sum(w['denied_n'] > 0 for w in r))),
        ('tool calls, median (max)', lambda r: rng([w['tool_calls'] for w in r])),
        ('tool calls p90', lambda r: p90([w['tool_calls'] for w in r])),
        ('workers with >50 tool calls', lambda r: str(sum(w['tool_calls'] > 50 for w in r))),
        ('edit/write error rate', lambda r: (lambda e, c: f'{e}/{c} = {pct(e, c)}')(
            sum(w['edit_write_errors'] for w in r), sum(w['edit_write_calls'] for w in r))),
        ('workers with scope violation', lambda r: str(sum(bool(w['scope_violation']) for w in r))),
        ('main-checkout leaks (cells / workers saw dirty main)', lambda r: '{} / {}'.format(
            sum(bool(c['main_leak_files']) for c in leaks[r[0]['model_label']]),
            sum(bool(w['main_dirty_now']) for w in r)) if r else 'n/a'),
        ('wall seconds, median (max)', lambda r: rng([w['wall_s'] for w in r])),
        ('wall seconds p90', lambda r: p90([w['wall_s'] for w in r])),
        ('tokens in+out+reasoning, median (max)', lambda r: rng([w['tokens_total'] for w in r])),
        ('cache-read tokens, median (max)', lambda r: rng([w['cache_read'] for w in r])),
    ]
    for name, fn in table:
        out.append(f'| {name} | ' + cols(fn) + ' |')

    out.append('\n## Pass count per module (original test)\n')
    out.append('| module | ' + ' | '.join(labels) + ' |')
    out.append('|---|' + '---|' * len(labels))
    for m in modules:
        cells = []
        for l in labels:
            sub = [w for w in rows[l] if w['module'] == m]
            cells.append(f"{sum(w['pass'] for w in sub)}/{len(sub)}")
        out.append(f'| {m} | ' + ' | '.join(cells) + ' |')

    out.append('\n## Worst three workers per arm\n')
    for l in labels:
        worst = sorted(rows[l], key=lambda w: (not w['pass'], w['denied_n'], w['edit_write_errors'], w['tool_calls']),
                       reverse=True)[:3]
        out.append(f'**{l}**')
        for w in worst:
            out.append(f"- r{w['repeat']} `{w['module']}`: pass={w['pass']} ok={w['ok']} timed_out={w['timed_out']} "
                       f"denied={w['denied_n']} tool_calls={w['tool_calls']} "
                       f"edit/write errors={w['edit_write_errors']}/{w['edit_write_calls']} "
                       f"wall={w['wall_s']}s tokens={w['tokens_total']} cache_read={w['cache_read']} "
                       f"scope={w['scope_violation'] or 'clean'}")
            for d in w['denied_first']:
                out.append(f'  - denied: `{d}`')
            if w['first_edit_error']:
                out.append(f"  - first edit/write error: `{w['first_edit_error']}`")
            if w['test_note']:
                out.append(f"  - test: `{w['test_note'][-100:]}`")
        out.append('')
    scope = [w for w in ws if w['scope_violation']]
    if scope:
        out.append('## Scope violations\n')
        for w in scope:
            out.append(f"- {w['model_label']} r{w['repeat']} {w['module']}: {w['scope_violation']}")
    leak = [c for c in data['cells'] if c['main_leak_files']]
    if leak:
        out.append('\n## Main-checkout leaks\n')
        for c in leak:
            out.append(f"- {c['model_label']} r{c['repeat']}: {c['main_leak_files']}")
    return '\n'.join(out) + '\n'


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--repeats', type=int, default=3)
    ap.add_argument('--concurrency', type=int, default=3)
    ap.add_argument('--fixture', default='scaffold', choices=sorted(FIXTURES))
    ap.add_argument('--timeout', default=None, help='per-worker timeout passed to opencode-task (default: per fixture)')
    ap.add_argument('--hard-timeout', type=int, default=None, help='harness-side kill for one wrapper call')
    ap.add_argument('--tmp', default=tempfile.gettempdir(), help='where fixtures are created')
    ap.add_argument('--arms', default='muse,beam', help='comma list of arm labels')
    ap.add_argument('--modules', default=None, help='comma list (default: all of the fixture)')
    ap.add_argument('--summarize', metavar='FILE', nargs='+')
    args = ap.parse_args()
    if args.summarize:
        sys.stdout.write(summarize(merge_results([json.load(open(f)) for f in args.summarize])))
        return 0
    fx_modules, fx_timeout = FIXTURES[args.fixture]
    args.timeout = args.timeout or fx_timeout
    if args.hard_timeout is None:  # harness-side kill: the per-worker timeout plus slack
        args.hard_timeout = (int(args.timeout.rstrip('m')) + 6) * 60
    args.modules = args.modules.split(',') if args.modules else fx_modules
    arms = args.arms.split(',')
    for l in arms:
        if l not in ARMS:
            sys.exit(f'unknown arm {l}; known: {", ".join(ARMS)}')
        if not ARMS[l][0].startswith('opencode-go/'):
            sys.exit(f'refusing non opencode-go model {ARMS[l][0]}')
    modules = args.modules
    spec = load_spec(args.fixture)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    os.makedirs(os.path.join(BENCH, 'results'), exist_ok=True)
    path = os.path.join(BENCH, 'results', f'worker-models-{stamp}.json')
    state = {'meta': {'started_utc': stamp, 'timeout': args.timeout, 'repeats': args.repeats,
                      'arms': {l: ARMS[l] for l in arms}, 'fixture': args.fixture, 'modules': modules, 'prompt': PROMPT, 'stopped_early': None},
             'cells': [], 'workers': []}
    jobs, cells = [], {}
    for rep in range(1, args.repeats + 1):
        for l in arms:
            cells[(l, rep)] = {'model_label': l, 'rep': rep, 'fx': None, 'left': len(modules)}
            jobs += [(l, rep, m, cells[(l, rep)]) for m in modules]
    stop = threading.Event()
    streak = [0]
    t_start = time.time()

    def work(job):
        if stop.is_set():
            return
        l, rep, m, cell = job
        with LOCK:  # lazily build the cell's fixture on its first job
            if cell['fx'] is None:
                cell.update(make_cell(l, rep, spec, args))
        rec = run_worker(job, args, state)
        with LOCK:
            state['workers'].append(rec)
            save(state, path)
            # wrapper/quota failure: not ok and not a single tool call
            streak[0] = streak[0] + 1 if (not rec['ok'] and rec['tool_calls'] == 0) else 0
            if streak[0] >= 5 and not stop.is_set():
                stop.set()
                state['meta']['stopped_early'] = (f'5 workers in a row failed before any tool call; last: '
                                                  f"{rec.get('log_error') or rec['wrapper_stdout'][-200:]} {rec.get('stderr_tail', '')}")
            cell['left'] -= 1
            if cell['left'] == 0:
                finish_cell(cell, args, state)
                save(state, path)
        print(f"[{time.time() - t_start:6.0f}s] {l} r{rep} {m}: pass={rec['pass']} ok={rec['ok']} "
              f"tools={rec['tool_calls']} denied={rec['denied_n']} wall={rec['wall_s']}s "
              f"{rec['log_error'] or ''}", flush=True)

    with ThreadPoolExecutor(args.concurrency) as ex:
        list(ex.map(work, jobs))
    for cell in cells.values():  # cells cut short by an early stop still get cleaned up
        if cell['fx'] and cell['left'] > 0 and os.path.isdir(cell['fx']):
            finish_cell(cell, args, state)
    state['meta']['duration_s'] = round(time.time() - t_start)
    save(state, path)
    md = path.replace('.json', '.md')
    with open(md, 'w') as f:
        f.write(summarize(state))
    if state['meta']['stopped_early']:
        print('STOPPED EARLY:', state['meta']['stopped_early'])
    print(f'results: {path}\nsummary: {md}')
    return 2 if stop.is_set() else 0


if __name__ == '__main__':
    sys.exit(main())
