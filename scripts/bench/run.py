#!/usr/bin/env python3
"""Claude Code benchmark: stock vs SwarmKit config, headless (`claude -p`), on tasks against this repo. See README.md.

  run.py --work DIR --selftest            accept.sh must fail on the planted repo and pass on the reference solution
  run.py --work DIR --canary              show what each arm actually loads (isolation check)
  run.py --work DIR [--reps 1] [--tasks T1,T2] [--arms A,B] [--dry-run]
"""
import argparse, gzip, json, os, random, shutil, subprocess, sys, time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
TASKS = HERE / 'tasks'
RESULTS = HERE / 'results'
PINNED = 'cf8d6dec2ca16e78ca94f5f01d46d2a19838e3d1'  # every run starts from this commit
SEED = 2026
MODEL = 'sonnet'
ALLOWED = 'Bash,Edit,Write,Read,Glob,Grep,Agent'
GIT = ['git', '-c', 'user.name=bench', '-c', 'user.email=bench@local']
CANARY = ('Without using any tools: (1) does your context contain a heading "SwarmKit: Shared Agent Rules"? Answer yes or no. '
          '(2) List every subagent type you can launch, by name. (3) List every skill you can invoke, by name.')


SLIM_DIR = None  # config dir for arm C, built by build_slim()
NONE_DIR = None  # arm N: an empty config dir, i.e. Claude Code as shipped, built-in skills included


def env(arm=None):
    # a nested claude must not inherit this session's identity or settings
    e = {k: v for k, v in os.environ.items() if not (k.startswith('CLAUDE_CODE_') or k in ('CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_EFFORT'))}
    if arm == 'C':
        e['CLAUDE_CONFIG_DIR'] = str(SLIM_DIR)
    if arm == 'N':
        e['CLAUDE_CONFIG_DIR'] = str(NONE_DIR)
    return e


def build_none(work):
    global NONE_DIR
    NONE_DIR = Path(work) / 'none_cfg'
    shutil.rmtree(NONE_DIR, ignore_errors=True)
    NONE_DIR.mkdir(parents=True)
    os.symlink(Path.home() / '.claude' / '.credentials.json', NONE_DIR / '.credentials.json')


def build_slim(work):
    """Arm C: this checkout's `install.sh --claude` into a scratch HOME, used as the Claude config dir. Nothing else is installed."""
    global SLIM_DIR
    home = Path(work) / 'slim_home'
    shutil.rmtree(home, ignore_errors=True)
    home.mkdir(parents=True)
    subprocess.run(['bash', str(ROOT / 'install.sh'), '--claude'], env={**os.environ, 'HOME': str(home)}, check=True, capture_output=True)
    SLIM_DIR = home / '.claude'
    os.symlink(Path.home() / '.claude' / '.credentials.json', SLIM_DIR / '.credentials.json')


def sh(*a, cwd, check=True, **kw):
    return subprocess.run(a, cwd=cwd, check=check, capture_output=True, text=True, **kw)


def claude_cmd(arm, prompt, budget):
    # prompt first: the options after it take lists
    cmd = ['claude', '-p', prompt, '--model', MODEL, '--output-format', 'stream-json', '--verbose', '--no-session-persistence',
           '--strict-mcp-config', '--mcp-config', str(HERE / 'empty-mcp.json'), '--max-budget-usd', str(budget),
           '--permission-mode', 'acceptEdits', '--allowedTools', ALLOWED]
    if arm == 'A':  # bare: no user-level settings, hooks or any skills (built-in ones too), so cheaper than Claude Code as shipped; N is that
        cmd += ['--setting-sources', 'project,local', '--disable-slash-commands']
    return cmd


def worktree(work, name):
    wt = Path(work) / name
    if wt.exists():
        sh('git', 'worktree', 'remove', '--force', str(wt), cwd=ROOT, check=False)
        shutil.rmtree(wt, ignore_errors=True)
    sh('git', 'worktree', 'add', '--detach', str(wt), PINNED, cwd=ROOT)
    return wt


def drop(wt):
    sh('git', 'worktree', 'remove', '--force', str(wt), cwd=ROOT, check=False)
    shutil.rmtree(wt, ignore_errors=True)


def prepare(wt, task):
    """Plant the task's starting state and commit it; returns the base commit the accept check diffs against."""
    setup = TASKS / task / 'setup.sh'
    if setup.read_text().strip():
        subprocess.run(['bash', str(setup)], cwd=wt, env={**env(), 'TASK_DIR': str(TASKS / task)}, check=True, capture_output=True)
    sh('git', 'add', '-A', cwd=wt)
    sh(*GIT, 'commit', '--allow-empty', '-qm', 'bench: starting state', cwd=wt)
    return sh('git', 'rev-parse', 'HEAD', cwd=wt).stdout.strip()


def accept(wt, task, base):
    e = {**env(), 'BASE': base, 'TASK_DIR': str(TASKS / task)}
    r = subprocess.run(['bash', str(TASKS / task / 'accept.sh')], cwd=wt, env=e, capture_output=True, text=True, timeout=300)
    return r.returncode == 0, (r.stderr or r.stdout).strip()[-400:]


def parse(stream):
    res, subs, banner = None, 0, None
    for line in stream.splitlines():
        try:
            ev = json.loads(line)
        except ValueError:
            continue
        if ev.get('type') == 'assistant':
            for b in ev.get('message', {}).get('content', []):
                if b.get('type') == 'tool_use' and b.get('name') in ('Agent', 'Task'):
                    subs += 1
                if b.get('type') == 'text' and banner is None and not ev.get('parent_tool_use_id'):
                    banner = b['text'].strip().splitlines()[0] if b['text'].strip() else ''
        elif ev.get('type') == 'result':
            res = ev
    return res, subs, banner


def tokens(res):
    u = {'input': 0, 'output': 0, 'cache_read': 0, 'cache_write': 0}
    mu = (res or {}).get('modelUsage') or {}
    for m in mu.values():  # modelUsage covers the main thread and every subagent
        u['input'] += m.get('inputTokens', 0); u['output'] += m.get('outputTokens', 0)
        u['cache_read'] += m.get('cacheReadInputTokens', 0); u['cache_write'] += m.get('cacheCreationInputTokens', 0)
    if not mu and res:
        x = res.get('usage', {})
        u = {'input': x.get('input_tokens', 0), 'output': x.get('output_tokens', 0),
             'cache_read': x.get('cache_read_input_tokens', 0), 'cache_write': x.get('cache_creation_input_tokens', 0)}
    return u


def invoke(arm, prompt, budget, wall, cwd):
    p = subprocess.Popen(claude_cmd(arm, prompt, budget), cwd=cwd, env=env(arm), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
    t0 = time.time()
    try:
        out, err = p.communicate(timeout=wall)
        timeout = False
    except subprocess.TimeoutExpired:
        os.killpg(p.pid, 9)
        out, err = p.communicate()
        timeout = True
    return out, err, time.time() - t0, timeout, p.returncode


def run_one(rid, task, arm, rep, work, version):
    meta = json.loads((TASKS / task / 'task.json').read_text())
    prompt = (TASKS / task / 'prompt.txt').read_text().strip()
    wt = worktree(work, rid)
    try:
        base = prepare(wt, task)
        out, err, wall, timeout, rc = invoke(arm, prompt, meta['budget_usd'], meta['wall_s'], wt)
        (RESULTS / 'raw').mkdir(parents=True, exist_ok=True)
        with gzip.open(RESULTS / 'raw' / f'{rid}.jsonl.gz', 'wt') as f:
            f.write(out)
        res, subs, banner = parse(out)
        ok, log = accept(wt, task, base)
        sh('git', 'add', '-A', cwd=wt)
        stat = sh('git', 'diff', '--cached', '--numstat', base, cwd=wt).stdout.split('\n')
        rows = [l.split('\t') for l in stat if l.strip()]
        (RESULTS / 'diffs').mkdir(exist_ok=True)
        (RESULTS / 'diffs' / f'{rid}.diff').write_text(sh('git', 'diff', '--cached', base, cwd=wt).stdout)
    finally:
        drop(wt)
    stop = (res or {}).get('subtype')
    outcome = 'PASS' if ok else 'TIMEOUT' if timeout else 'BUDGET' if stop == 'error_max_budget_usd' else 'FAIL'
    return {
        'run_id': rid, 'task': task, 'name': meta['name'], 'expected_tier': meta['expected_tier'], 'arm': arm, 'rep': rep,
        'outcome': outcome, 'accepted': ok, 'accept_log': '' if ok else log, 'wall_s': round(wall, 1), 'api_s': round(((res or {}).get('duration_api_ms') or 0) / 1000, 1),
        'cost_usd': round((res or {}).get('total_cost_usd') or 0, 4), 'tokens': tokens(res), 'turns': (res or {}).get('num_turns'),
        'subagents': subs, 'files': len(rows), 'lines': sum(int(r[0]) + int(r[1]) for r in rows if r[0].isdigit() and r[1].isdigit()),
        'banner': banner if banner and banner.startswith('> **T') else None, 'stop': stop, 'exit_code': rc, 'stderr': err.strip()[-300:],
        'model': sorted(((res or {}).get('modelUsage') or {}).keys()), 'claude_version': version, 'pinned': PINNED, 'ts': int(time.time()),
    }


def done_ids():
    f = RESULTS / 'runs.jsonl'
    return {json.loads(l)['run_id'] for l in f.read_text().splitlines() if l.strip()} if f.exists() else set()


def cmd_selftest(work):
    bad = 0
    for t in sorted(p.name for p in TASKS.iterdir() if p.is_dir()):
        wt = worktree(work, f'selftest_{t}')
        try:
            base = prepare(wt, t)
            before, _ = accept(wt, t, base)
            sh('git', 'reset', '--hard', '-q', base, cwd=wt)
            sh('bash', str(TASKS / t / 'solution.sh'), cwd=wt)
            after, log = accept(wt, t, base)
        finally:
            drop(wt)
        good = (not before) and after
        bad += not good
        print(f'{t}: unsolved->{"pass" if before else "fail"} (want fail), solved->{"pass" if after else "fail"} (want pass)  {"OK" if good else "BAD " + log}')
    return bad


def cmd_canary(work):
    wt = worktree(work, 'canary')
    try:
        for arm in 'ABCN':
            out, err, wall, timeout, rc = invoke(arm, CANARY, 1.0, 180, wt)
            init = next((json.loads(l) for l in out.splitlines() if '"subtype":"init"' in l.replace(' ', '')), {})
            res, _, _ = parse(out)
            print(f'\n===== arm {arm} ({wall:.0f}s, exit {rc}) =====')
            print('init: agents=%s skills=%s tools=%s mcp=%s' % (len(init.get('agents', [])), len(init.get('skills', [])), len(init.get('tools', [])), init.get('mcp_servers')))
            print('agents:', init.get('agents'))
            print('answer:', (res or {}).get('result', err[-300:]))
    finally:
        drop(wt)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--work', required=True)
    ap.add_argument('--selftest', action='store_true')
    ap.add_argument('--canary', action='store_true')
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--reps', type=int, default=1)
    ap.add_argument('--tasks', default='T1,T2,T3,T4,T5')  # larger sets: H1,H2,H3 and L1,L2
    ap.add_argument('--arms', default='A,C')  # B (the full install before the rework) is recorded in runs.jsonl and not re-run
    a = ap.parse_args()
    assert set(a.arms.split(',')) <= set('ABCN'), f'unknown arm in --arms {a.arms}'
    Path(a.work).mkdir(parents=True, exist_ok=True)
    if a.selftest:
        sys.exit(1 if cmd_selftest(a.work) else 0)
    if a.canary or 'C' in a.arms.split(','):
        build_slim(a.work)
    if a.canary or 'N' in a.arms.split(','):
        build_none(a.work)
    if a.canary:
        return cmd_canary(a.work)
    version = sh('claude', '--version', cwd=ROOT).stdout.strip()
    rnd = random.Random(SEED)
    plan = []
    for t in a.tasks.split(','):
        for rep in range(1, a.reps + 1):
            arms = a.arms.split(',')
            rnd.shuffle(arms)
            plan += [(f'{t}_{arm}_rep{rep}', t, arm, rep) for arm in arms]
    skip = done_ids()
    for rid, t, arm, rep in plan:
        if rid in skip:
            print('skip', rid)
            continue
        if a.dry_run:
            print(rid, ' '.join(claude_cmd(arm, '<prompt>', json.loads((TASKS / t / 'task.json').read_text())['budget_usd'])))
            continue
        print('run', rid, flush=True)
        rec = run_one(rid, t, arm, rep, a.work, version)
        with open(RESULTS / 'runs.jsonl', 'a') as f:
            f.write(json.dumps(rec) + '\n')
        print(f"  {rec['outcome']} wall {rec['wall_s']}s cost ${rec['cost_usd']} subagents {rec['subagents']} files {rec['files']}", flush=True)


if __name__ == '__main__':
    main()
