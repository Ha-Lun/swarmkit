#!/usr/bin/env python3
"""SwarmKit benchmark: prove the config works in Claude Code, Antigravity and OpenCode.

  python3 bench/run.py                         static tier (free, deterministic)
  python3 bench/run.py --installed             + check the install symlinks
  python3 bench/run.py --live claude --yes     + live tier (spends model quota)

See bench/README.md.
"""
import argparse
import datetime
import glob
import hashlib
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time

import yaml

BENCH = os.path.dirname(os.path.abspath(__file__))
TTY = sys.stdout.isatty()
COLOURS = {'PASS': '32', 'FAIL': '31', 'SKIP': '33', 'WARN': '33'}
GEN = ['claude/agents', 'claude/packs', 'claude/CLAUDE.md', 'opencode/agents', 'opencode/AGENTS.md',
       'antigravity/plugins/swarmkit']
SRC = ['core', 'scripts', 'claude/rules.md', 'opencode/rules.md', 'antigravity/rules.md']
AGENT_DIRS = {'core': 'core/agents', 'claude': 'claude/agents', 'opencode': 'opencode/agents',
              'antigravity': 'antigravity/plugins/swarmkit/agents'}
RULES = {'claude': 'claude/CLAUDE.md', 'opencode': 'opencode/AGENTS.md',
         'antigravity': 'antigravity/plugins/swarmkit/rules/AGENTS.md'}
CLAUDE_TOOLS = {'Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash', 'WebFetch', 'WebSearch', 'Agent',
                'TodoWrite', 'AskUserQuestion'}
AGY_ONLY = ['write_to_file', 'ask_question', 'invoke_subagent', 'appDataDir', 'ArtifactMetadata']
CLAUDE_ONLY = ['Task tool', 'AskUserQuestion', 'TodoWrite']
GUARDED = ['security-auditor', 'code-proofreader', 'release-tester', 'test-writer', 'git-specialist']
STATUS_RE = r'^> \*\*T\d operation: '
RESULTS = []


def paint(text, status):
    return f'\033[{COLOURS[status]}m{text}\033[0m' if TTY else text


def rec(cat, name, ok, detail='', status=None):
    status = status or ('PASS' if ok else 'FAIL')
    if not RESULTS or RESULTS[-1]['category'] != cat:
        print(f'\n{cat}')
    RESULTS.append({'category': cat, 'check': name, 'status': status, 'detail': detail})
    print(f'  {paint(status, status)}  {name}' + (f' -- {detail}' if detail else ''))


def read(path):
    with open(path, encoding='utf-8') as f:
        return f.read()


def frontmatter(path):
    parts = read(path).split('---\n', 2)
    if len(parts) < 3 or parts[0].strip():
        raise ValueError('no frontmatter block')
    fm = yaml.safe_load(parts[1])
    if not isinstance(fm, dict):
        raise ValueError('frontmatter is not a mapping')
    return fm, parts[2]


def agent_files(repo, cli):
    # Claude ships core agents in claude/agents and the rest in claude/packs/<pack>/agents.
    pats = [f'{repo}/{AGENT_DIRS[cli]}/*.md'] + ([f'{repo}/claude/packs/*/agents/*.md'] if cli == 'claude' else [])
    return {os.path.basename(p)[:-3]: p for pat in pats for p in sorted(glob.glob(pat))}


def tree(root):
    out = {}
    for rel in GEN:
        p = os.path.join(root, rel)
        files = [p] if os.path.isfile(p) else [os.path.join(d, f) for d, _, fs in os.walk(p) for f in fs]
        for f in files:
            with open(f, 'rb') as fh:
                out[os.path.relpath(f, root)] = hashlib.sha256(fh.read()).hexdigest()
    return out


def diff(a, b):
    return sorted(k for k in set(a) | set(b) if a.get(k) != b.get(k))


def run(cmd, cwd=None, env=None, timeout=240, stdin=None):
    """Run a command in its own process group; kill the whole group on timeout."""
    p = subprocess.Popen(cmd, cwd=cwd, env=env, stdin=subprocess.PIPE if stdin else subprocess.DEVNULL,
                         stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
    try:
        out, err = p.communicate(stdin, timeout=timeout)
        return p.returncode, out, err, False
    except subprocess.TimeoutExpired:
        os.killpg(p.pid, signal.SIGKILL)
        out, err = p.communicate()
        return -9, out, err, True


def jsonc(text):
    """Parse JSONC: drop comments outside strings, then trailing commas."""
    text = re.sub(r'("(?:\\.|[^"\\])*")|//[^\n]*|/\*.*?\*/', lambda m: m.group(1) or '', text, flags=re.S)
    return json.loads(re.sub(r',(\s*[}\]])', r'\1', text))


# ---------------------------------------------------------------- static tier

def s1_build(repo):
    cat = 'S1 build idempotent'
    with tempfile.TemporaryDirectory() as tmp:
        for rel in SRC:
            src, dst = os.path.join(repo, rel), os.path.join(tmp, rel)
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            if os.path.isdir(src):
                shutil.copytree(src, dst, ignore=shutil.ignore_patterns('__pycache__'))
            else:
                shutil.copy2(src, dst)
        trees = []
        for i in (1, 2):
            rc, _, err, _ = run([sys.executable, 'scripts/build.py'], cwd=tmp, timeout=120)
            if rc:
                return rec(cat, f'build.py run {i}', False, (err.strip().splitlines() or ['?'])[-1])
            trees.append(tree(tmp))
        rec(cat, 'second build identical to first', trees[0] == trees[1],
            f'{len(trees[0])} generated files' if trees[0] == trees[1] else ', '.join(diff(*trees)[:5]))
        d = diff(trees[1], tree(repo))
        rec(cat, 'committed outputs match a fresh build', not d,
            'outputs in sync with sources' if not d else f'{len(d)} differ: ' + ', '.join(d[:5]))


def s2_roster(repo):
    cat = 'S2 roster parity'
    files = {cli: agent_files(repo, cli) for cli in AGENT_DIRS}
    base = set(files['core'])
    for cli in ('claude', 'opencode', 'antigravity'):
        missing, extra = sorted(base - set(files[cli])), sorted(set(files[cli]) - base)
        rec(cat, f'{cli} roster == core ({len(base)} agents)', not missing and not extra,
            '; '.join(filter(None, [missing and f'missing {missing}', extra and f'extra {extra}'])))
    for cli in ('claude', 'opencode', 'antigravity'):
        errors = []
        for name, path in files[cli].items():
            try:
                fm, _ = frontmatter(path)
            except Exception as e:  # noqa: BLE001 - report any parse failure
                errors.append(f'{name}: {e}')
                continue
            if not str(fm.get('description') or '').strip():
                errors.append(f'{name}: empty description')
            if cli != 'opencode' and fm.get('name') != name:
                errors.append(f'{name}: name field {fm.get("name")!r}')
            if cli == 'claude' and fm.get('model') not in ('haiku', 'sonnet', 'opus'):
                errors.append(f'{name}: model {fm.get("model")!r}')
        rec(cat, f'{cli} frontmatter valid, descriptions set' + (', models valid' if cli == 'claude' else ''),
            not errors, '; '.join(errors[:4]))


def s3_signals(repo):
    cat = 'S3 delegation signals'
    trigger = re.compile(r'\bproactively\b|\buse (?:it |this agent )?when(?:ever)?\b', re.I)
    # Core agents (claude/agents) keep one-line descriptions; pack specialists need trigger wording.
    lacking = [n for n, p in agent_files(repo, 'claude').items()
               if '/packs/' in p and n != 'lead-dev' and not trigger.search(frontmatter(p)[0].get('description', ''))]
    rec(cat, 'every Claude pack specialist description has trigger wording', not lacking,
        f'no "proactively"/"Use when" in: {", ".join(lacking)}' if lacking else '')
    for cli in ('claude', 'antigravity'):
        desc = frontmatter(agent_files(repo, cli)['lead-dev'])[0].get('description', '')
        rec(cat, f'{cli} lead-dev description forbids subagent use',
            bool(re.search(r'never (?:delegate|invoke)', desc, re.I) and 'subagent' in desc))
    for cli, rel in RULES.items():
        rec(cat, f'{cli} rules say never to wait for approval when non-interactive', 'never wait' in read(f'{repo}/{rel}'))
    claude = read(f'{repo}/{RULES["claude"]}')
    rec(cat, 'claude rules: large or risky work calls EnterPlanMode first', '`EnterPlanMode` first' in claude)
    size = len(claude.encode())
    rec(cat, 'claude rules under 2200 bytes', size < 2200, f'{size} bytes')


def s4_leakage(repo, mcp_servers):
    cat = 'S4 foreign-tool leakage'
    for cli, words in (('claude', AGY_ONLY), ('opencode', AGY_ONLY + CLAUDE_ONLY)):
        hits = [f'{n}: {w}' for n, p in agent_files(repo, cli).items()
                for w in words if w in frontmatter(p)[1]]
        rec(cat, f'{cli} agent bodies free of other CLIs\' tool names', not hits, '; '.join(hits[:5]))
    bad = []
    for name, path in agent_files(repo, 'claude').items():
        for tool in frontmatter(path)[0].get('tools') or []:
            parts = tool.split('__')
            if tool not in CLAUDE_TOOLS and not (len(parts) == 3 and parts[0] == 'mcp' and parts[1] in mcp_servers):
                bad.append(f'{name}: {tool}')
    rec(cat, 'claude tool lists use known tools / core/mcp.json servers', not bad, '; '.join(bad[:5]))


def s5_guard(repo, guard_cases):
    cat = 'S5 hooks and guard'
    for name in GUARDED:
        path = agent_files(repo, 'claude').get(name, '')
        cmds = []
        if os.path.exists(path):
            for entry in (frontmatter(path)[0].get('hooks') or {}).get('PreToolUse') or []:
                cmds += [h.get('command', '') for h in entry.get('hooks') or []]
        rec(cat, f'{name} has PreToolUse guard hook',
            any(re.search(rf'~/\.claude/hooks/guard\.py {re.escape(name)}$', c) for c in cmds),
            '' if cmds else 'no PreToolUse hook')
    guard = f'{repo}/claude/hooks/guard.py'
    for agent, tool, arg, want in guard_cases:
        key = 'command' if tool == 'Bash' else 'file_path'
        payload = json.dumps({'tool_name': tool, 'tool_input': {key: arg}})
        rc, _, _, _ = run([sys.executable, guard, agent], stdin=payload, timeout=20)
        verdict = {0: 'allow', 2: 'block'}.get(rc, f'exit {rc}')
        rec(cat, f'guard {agent} {tool} {arg!r} -> {"allow" if want == 0 else "block"}', rc == want,
            '' if rc == want else f'got {verdict}')


def skill_refs(text):
    pats = [r'Load \*\*`([a-z0-9-]+)`\*\*', r'`([a-z0-9-]+)` skill\b', r'[Ss]kills? to load\**:\s*`([a-z0-9-]+)`']
    return {m for p in pats for m in re.findall(p, text)}


def s6_rules(repo, cfg):
    cat = 'S6 rules sanity'
    size = os.path.getsize(f'{repo}/{RULES["antigravity"]}')
    rec(cat, 'antigravity rules under 24000 bytes', size < 24000, f'{size} bytes')
    skills = {os.path.basename(os.path.dirname(p)) for p in glob.glob(f'{repo}/core/skills/*/SKILL.md')}
    known = skills | set(agent_files(repo, 'core')) | set(cfg.get('external_skills', [])) | {
        os.path.basename(p)[:-3] for p in glob.glob(f'{repo}/opencode/command/*.md')}
    texts = [read(f'{repo}/{r}') for r in RULES.values()]
    texts += [frontmatter(p)[1] for cli in ('claude', 'opencode', 'antigravity')
              for p in agent_files(repo, cli).values()]
    refs = set().union(*map(skill_refs, texts))
    dead = sorted(refs - known)
    rec(cat, f'skill references resolve ({len(refs)} distinct, conservative match)', not dead,
        f'missing in core/skills: {", ".join(dead)}' if dead else ', '.join(sorted(refs)))


def s7_native(repo):
    cat = 'S7 native validators'
    n_agents = len(agent_files(repo, 'core'))
    if shutil.which('agy'):
        rc, out, err, _ = run(['agy', 'plugin', 'validate', f'{repo}/antigravity/plugins/swarmkit'], timeout=60)
        text = re.sub(r'\x1b\[[0-9;]*m', '', out + err)
        m = re.search(r'agents\s*:\s*(\d+) processed', text)
        got = int(m.group(1)) if m else None
        rec(cat, 'agy plugin validate', rc == 0 and got == n_agents, f'agents {got} processed, expected {n_agents}')
    else:
        rec(cat, 'agy plugin validate', False, 'agy not on PATH', status='SKIP')
    try:
        cfg = jsonc(read(f'{repo}/opencode/opencode.jsonc'))
        rec(cat, 'opencode.jsonc parses', True)
    except Exception as e:  # noqa: BLE001
        return rec(cat, 'opencode.jsonc parses', False, str(e))
    default = cfg.get('default_agent')
    rec(cat, 'opencode default_agent exists', default is None or default in agent_files(repo, 'opencode'), str(default))
    problems, notes = [], []
    for ref in list(cfg.get('instructions') or []) + list(cfg.get('plugin') or []):
        if not (ref.startswith('file://') or '{env:HOME}' in ref):
            notes.append(f'{ref} (npm package)')
            continue
        # Paths under ~/.config/opencode are installed from opencode/ (or created from a .example copy).
        rel = ref.split('/.config/opencode/', 1)[-1] if '/.config/opencode/' in ref else None
        path = os.path.expanduser(ref.replace('file://', '').replace('{env:HOME}', '~'))
        if rel and (os.path.exists(f'{repo}/opencode/{rel}') or os.path.exists(f'{repo}/opencode/{rel}.example')):
            notes.append(f'{rel} (installed from opencode/, optional if only a .example exists)')
        else:
            (notes if os.path.exists(path) else problems).append(ref)
    rec(cat, 'opencode plugin/instruction paths resolve', not problems,
        f'missing: {problems}' if problems else '; '.join(notes))
    shipped = [p for p in ('claude/settings.json', 'claude/settings.local.json') if os.path.exists(f'{repo}/{p}')]
    hooks = ('guard.py',)
    needed = [p for p in ('claude/CLAUDE.md', 'claude/agents') + tuple(f'claude/hooks/{h}' for h in hooks)
              if not os.path.exists(f'{repo}/{p}')]
    err = ''
    for h in hooks:
        try:  # in memory: py_compile would drop a __pycache__ into the repo
            compile(read(f'{repo}/claude/hooks/{h}'), h, 'exec')
        except (OSError, SyntaxError) as e:
            err = f'{h}: {e}'
    rec(cat, 'claude structure (CLAUDE.md, agents, hooks compile, no shipped settings)',
        not shipped and not needed and not err, '; '.join(filter(None, [
            shipped and f'ships {shipped}', needed and f'missing {needed}', err])))


def s8_installed(repo):
    cat = 'S8 installed links'
    home = os.path.expanduser('~')
    links = [('.claude/CLAUDE.md', 'claude/CLAUDE.md', 'claude'), ('.claude/agents', 'claude/agents', 'claude'),
             ('.claude/hooks/guard.py', 'claude/hooks/guard.py', 'claude'),
             ('.config/opencode/AGENTS.md', 'opencode/AGENTS.md', 'opencode'),
             ('.config/opencode/agents', 'opencode/agents', 'opencode'),
             ('.config/opencode/opencode.jsonc', 'opencode/opencode.jsonc', 'opencode'),
             ('.gemini/config/plugins/swarmkit', 'antigravity/plugins/swarmkit', 'agy')]
    real_repo = os.path.realpath(repo)
    for rel, target, flag in links:
        path = os.path.join(home, rel)
        want = os.path.join(real_repo, target)
        hint = f'run ./install.sh --{flag} from {repo}'
        if not os.path.lexists(path):
            rec(cat, f'~/{rel}', False, f'not installed; {hint}', status='WARN')
        elif not os.path.exists(path):
            rec(cat, f'~/{rel}', False, f'dead link -> {os.readlink(path)}; {hint}', status='WARN')
        elif os.path.realpath(path) == want:
            rec(cat, f'~/{rel}', True, 'points into this repo')
        elif rel.endswith('opencode.jsonc') and not os.path.islink(path):
            rec(cat, f'~/{rel}', False, 'regular file (free-mode copy?), not a link', status='WARN')
        else:
            rec(cat, f'~/{rel}', False, f'points at another checkout: {os.path.realpath(path)}; {hint}', status='WARN')


# ---------------------------------------------------------------- live tier

def make_fixture(spec, name, repo, cli, d=None):
    """Throwaway git repo: base project + the case's overlay (+ the agy plugin)."""
    d = d or tempfile.mkdtemp(prefix=f'swarmbench-{name}-')
    os.makedirs(d, exist_ok=True)

    def git(*a):
        subprocess.run(['git', '-c', 'user.name=bench', '-c', 'user.email=bench@example.invalid',
                        '-c', 'commit.gpgsign=false', '-C', d, *a], check=True, stdout=subprocess.DEVNULL)

    def put(files):
        for rel, content in files.items():
            os.makedirs(os.path.dirname(os.path.join(d, rel)), exist_ok=True)
            with open(os.path.join(d, rel), 'w') as f:
                f.write(content)

    overlay = spec['fixtures'].get(name, {})
    put(spec['fixtures']['base'])
    put({k: v for k, v in overlay.items() if not k.startswith('_')})
    if cli == 'agy':
        shutil.copytree(f'{repo}/antigravity/plugins/swarmkit', f'{d}/.agents/plugins/swarmkit')
    git('init', '-q', '-b', 'main')
    git('add', '-A')
    git('commit', '-qm', 'Initial commit')
    if overlay.get('_branch'):
        git('checkout', '-qb', overlay['_branch'])
    for c in overlay.get('_commits', []):
        put(c['files'])
        git('add', '-A')
        git('commit', '-qm', c['msg'])
    put(overlay.get('_uncommitted', {}))
    return d


def events(out):
    for line in out.splitlines():
        try:
            yield json.loads(line)
        except ValueError:
            continue


def first_line(text):
    return next((ln for ln in (text or '').splitlines() if ln.strip()), '')


def claude_env(args, repo, tmp):
    """installed = the user's ~/.claude; repo/none = a temp CLAUDE_CONFIG_DIR with auth + settings only."""
    if args.config == 'installed':
        return None, os.path.realpath(os.path.expanduser('~/.claude/agents'))
    real = os.path.expanduser('~/.claude')
    cfg = os.path.join(tmp, 'claude-config')
    os.makedirs(f'{cfg}/hooks')
    if not os.path.exists(f'{real}/.credentials.json'):
        return 'no ~/.claude/.credentials.json to authenticate with', None
    os.symlink(f'{real}/.credentials.json', f'{cfg}/.credentials.json')
    settings = json.loads(read(f'{real}/settings.json')) if os.path.exists(f'{real}/settings.json') else {}
    # Drop a plan-gate hook left by older installs (the hook no longer exists).
    ups = [e for e in (settings.get('hooks') or {}).get('UserPromptSubmit') or []
           if not any('plan-gate.py' in h.get('command', '') for h in e.get('hooks') or [])]
    if args.config == 'repo':
        os.symlink(f'{repo}/claude/CLAUDE.md', f'{cfg}/CLAUDE.md')
        os.symlink(f'{repo}/claude/agents', f'{cfg}/agents')
        os.symlink(f'{repo}/claude/hooks/guard.py', f'{cfg}/hooks/guard.py')
        os.symlink(f'{repo}/core/skills', f'{cfg}/skills')
    if ups:
        settings.setdefault('hooks', {})['UserPromptSubmit'] = ups
    else:
        (settings.get('hooks') or {}).pop('UserPromptSubmit', None)
    with open(f'{cfg}/settings.json', 'w') as f:  # written, never printed
        json.dump(settings, f, indent=2)
    return {**os.environ, 'CLAUDE_CONFIG_DIR': cfg}, (repo if args.config == 'repo' else 'none (vanilla Claude Code)')


def finish(r, result, rc, err, timed_out):
    status = 'timeout' if timed_out else ('ok' if result else 'error')
    if status == 'error':
        r['notes'].append(f'exit {rc}: ' + (err.strip().splitlines() or ['no output'])[-1][:160])
    return {**r, 'status': status}


def adapter_claude(prompt, cwd, args, env):
    cmd = ['claude', '-p', prompt, '--output-format', 'stream-json', '--verbose', '--no-session-persistence',
           '--max-budget-usd', str(args.budget), '--permission-mode', 'acceptEdits',
           '--disallowedTools', 'Edit Write NotebookEdit'] + (['--model', args.model] if args.model else [])
    rc, out, err, timed_out = run(cmd, cwd=cwd, env=env, timeout=args.timeout)
    r = {'dispatched': [], 'evidence': [], 'text': '', 'notes': [], 'raw': out, 'tools': [], 'planner_models': []}
    result = None
    for e in events(out):
        if e.get('type') == 'assistant' and not e.get('parent_tool_use_id'):
            model = e.get('message', {}).get('model')
            if 'EnterPlanMode' in r['tools'] and model and model not in r['planner_models']:
                r['planner_models'].append(model)
            for b in e.get('message', {}).get('content', []):
                if b.get('type') == 'tool_use':
                    r['tools'].append(b.get('name'))
                if b.get('type') == 'text' and not r['text']:
                    r['text'] = b.get('text', '')
                if b.get('type') == 'tool_use' and b.get('name') in ('Agent', 'Task'):
                    sub = (b.get('input') or {}).get('subagent_type') or '?'
                    r['dispatched'].append(sub)
                    r['evidence'].append({'event': 'assistant.message.content[tool_use]', 'name': b['name'],
                                          'subagent_type': sub})
        elif e.get('type') == 'result':
            result = e
    if result:
        def count(u):  # usage is snake_case, modelUsage (per model) is camelCase
            return sum(v for k, v in u.items() if isinstance(v, int) and re.search(r'(?i)(input|output)_?tokens$', k))
        tokens = count(result.get('usage') or {}) or sum(map(count, (result.get('modelUsage') or {}).values()))
        r.update(cost_usd=result.get('total_cost_usd'), duration_s=(result.get('duration_ms') or 0) / 1000,
                 tokens=tokens or None)
        if result.get('subtype') == 'error_max_budget_usd':
            r['notes'].append('budget cap hit')
        msg = str(result.get('result') or '')
        if result.get('is_error') and re.search(r'log ?in|auth|api key|credential', msg, re.I) and not r['dispatched']:
            return {**r, 'status': 'skipped', 'notes': [f'auth failure: {msg[:120]}']}
    return finish(r, result, rc, err, timed_out)


def adapter_agy(prompt, cwd, args, env):
    cmd = ['agy', '-p', prompt, '--output-format', 'stream-json'] + (['--model', args.model] if args.model else [])
    if args.agy_skip_permissions:
        cmd.append('--dangerously-skip-permissions')
    rc, out, err, timed_out = run(cmd, cwd=cwd, env=env, timeout=args.timeout)
    r = {'dispatched': [], 'evidence': [], 'text': '', 'notes': [], 'raw': out}
    seen, result, denied = set(), None, 0
    for e in events(out):
        su = e.get('step_update') or {}
        if su.get('tool_name') == 'invoke_subagent':
            subs = [s.get('TypeName') for s in ((su.get('tool_info') or {}).get('parameters') or {}).get('Subagents') or []]
            subs += [s.get('type_name') for s in (su.get('subagent_info') or {}).get('subagents') or []]
            for s in filter(None, subs):
                if (su.get('step_index'), s) not in seen:
                    seen.add((su.get('step_index'), s))
                    r['dispatched'].append(s)
                    r['evidence'].append({'event': f'step_update[{su.get("step_type")}].invoke_subagent',
                                          'step_index': su.get('step_index'), 'type_name': s})
        if su.get('step_type') == 'tool' and re.search(r'denied|not permitted|permission',
                                                         json.dumps(su.get('tool_info', {}).get('output', '')), re.I):
            denied += 1
        if e.get('event') == 'result':
            result = e['result']
    if denied:
        r['notes'].append(f'{denied} tool call(s) denied by headless permissions (dispatch still scored)')
    if result:
        r.update(text=result.get('response', ''), duration_s=result.get('duration_seconds'),
                 tokens=(result.get('usage') or {}).get('total_tokens'))
        if result.get('status') != 'SUCCESS':
            r['notes'].append(f'agy status {result.get("status")}')
    return finish(r, result, rc, err, timed_out)


def adapter_opencode(prompt, cwd, args, env):
    # Unverified: the free tier refuses headless runs, so this parser was never exercised.
    rc, out, err, timed_out = run(['opencode', 'run', '--format', 'json', '--dir', cwd, prompt],
                                  cwd=cwd, env=env, timeout=args.timeout)
    r = {'dispatched': [], 'evidence': [], 'text': '', 'notes': ['opencode parser unverified'], 'raw': out}
    for e in events(out):
        part = e.get('part') or {}
        if part.get('tool') == 'task':
            sub = ((part.get('state') or {}).get('input') or {}).get('subagent_type') or '?'
            if sub not in r['dispatched']:
                r['dispatched'].append(sub)
                r['evidence'].append({'event': f'{e.get("type")}.part[tool=task]', 'subagent_type': sub})
        if part.get('type') == 'text' and not r['text']:
            r['text'] = part.get('text', '')
    return {**r, 'status': 'timeout' if timed_out else ('ok' if rc == 0 else 'error')}


def opencode_headless():
    if not shutil.which('opencode'):
        return False, 'opencode not on PATH'
    with tempfile.TemporaryDirectory() as d:
        rc, out, err, _ = run(['opencode', 'run', '--format', 'json', 'Reply with just the word hi.'], cwd=d, timeout=90)
    errors = [e for e in events(out) if e.get('type') == 'error']
    if rc or errors:
        msg = errors and ((errors[0].get('error') or {}).get('data') or {}).get('message')
        return False, (msg or (err.strip().splitlines() or [f'exit {rc}'])[-1])[:160]
    return True, 'headless run works'


def opencode_manual(spec, cases, ts):
    out = f'{BENCH}/results/opencode-manual-checklist.md'
    fx_root = f'{BENCH}/results/opencode-fixtures'
    shutil.rmtree(fx_root, ignore_errors=True)
    lines = ['# OpenCode manual delegation checklist', '',
             f'Generated {ts}. OpenCode\'s free tier refuses non-interactive runs, so run these by hand in the TUI.', '',
             '1. `cd` into the fixture directory listed for the case and start `opencode` (default agent: lead-dev).',
             '2. Paste the prompt exactly.',
             '3. A delegation shows up as a `task` tool call naming the subagent (the subagent session is listed '
             'under the message). No `task` call means it answered inline.',
             '4. Check the first line of the reply matches `> **T<n> operation: ...**`.', '',
             '| # | Case | Fixture dir | Expected | Dispatched (fill in) | Status line ok (fill in) |',
             '|---|---|---|---|---|---|']
    prompts = []
    for i, case in enumerate(cases, 1):
        dst = make_fixture(spec, case['fixture'], None, 'opencode', f'{fx_root}/{case["id"]}')
        exp = case['expect']['agent'] or 'nothing (inline)'
        lines.append(f'| {i} | {case["id"]} | `{dst}` | {exp} | | |')
        prompts += ['', f'### {i}. {case["id"]}: {case["title"]}', '', '```', case['prompt'], '```']
    with open(out, 'w') as f:
        f.write('\n'.join(lines + ['', '## Prompts'] + prompts) + '\n')
    return out


def select(spec, cli, args):
    only = tuple(filter(None, (args.only or '').split(',')))
    cases = [c for c in spec['cases'] if cli in c.get('applies_to', []) and (not only or c['id'].startswith(only))]
    return cases[:args.max_cases or None]


def live(cli, args, spec, repo, ts):
    print(f'\nLIVE {cli}')
    cases = select(spec, cli, args)
    meta = {'cli': cli, 'version': shutil.which(cli) and (run([cli, '--version'], timeout=30)[1].strip() or '?'),
            'config': args.config,
            'repo_commit': run(['git', '-C', repo, 'describe', '--always', '--dirty'], timeout=30)[1].strip()}
    if not shutil.which(cli):
        print(f'  {paint("SKIP", "SKIP")}  {cli} not on PATH')
        return {**meta, 'skipped': f'{cli} not on PATH', 'runs': []}
    if cli == 'opencode':
        ok, why = opencode_headless()
        print(f'  headless probe: {why}')
        if not ok:
            path = opencode_manual(spec, cases, ts)
            print(f'  manual protocol written to {path}')
            return {**meta, 'skipped': f'headless refused ({why}); manual checklist at {path}', 'runs': []}
    if cli == 'agy' and args.config == 'none':
        return {**meta, 'skipped': 'agy supports only --config repo (workspace plugin)', 'runs': []}
    tmp = tempfile.mkdtemp(prefix='swarmbench-')
    try:
        env, source = (None, f'{repo}/antigravity/plugins/swarmkit (workspace copy)') if cli != 'claude' \
            else claude_env(args, repo, tmp)
        if cli == 'claude' and isinstance(env, str):
            return {**meta, 'skipped': env, 'runs': []}
        meta['config_source'] = source
        meta['config_commit'] = run(['git', '-C', source.split(' ')[0], 'describe', '--always',
                                     '--dirty'], timeout=30)[1].strip() or 'n/a'
        os.makedirs(f'{BENCH}/results/raw', exist_ok=True)
        spent = 0.0
        adapter = {'claude': adapter_claude, 'agy': adapter_agy, 'opencode': adapter_opencode}[cli]
        runs = []
        for case in cases:
            for n in range(args.repeat):
                if spent >= args.max_total_usd:
                    print(f'  {paint("SKIP", "SKIP")}  {case["id"]}#{n + 1}: --max-total-usd ${args.max_total_usd} reached')
                    continue
                fx = make_fixture(spec, case['fixture'], repo, cli)
                t0 = time.time()
                try:
                    r = adapter(case['prompt'], fx, args, env)
                finally:
                    shutil.rmtree(fx, ignore_errors=True)
                raw = f'{BENCH}/results/raw/{ts}-{cli}-{case["id"]}-{n + 1}.jsonl'
                with open(raw, 'w') as f:
                    f.write(r.pop('raw', ''))
                r['raw_file'] = raw
                spent += r.get('cost_usd') or 0
                r['duration_s'] = round(r.get('duration_s') or time.time() - t0, 1)
                x = case['expect']
                exp = x.get('agent')
                line = first_line(r.pop('text'))
                tools = r.get('tools') or []
                if cli == 'claude':
                    pm = r.pop('planner_models', [])
                    r['planner_model'] = ', '.join(pm) or None  # None: no top-level message after EnterPlanMode
                    r['planner_opus'] = None if not pm else any('opus' in m for m in pm)
                checks = [(not r['dispatched']) if exp is None else exp in r['dispatched']] if 'agent' in x else []
                if x.get('first_tool'):
                    checks.append(tools[:1] == [x['first_tool']])
                if x.get('no_tool'):
                    checks.append(x['no_tool'] not in tools)
                r.update(case=case['id'], category=case['category'], repeat=n + 1, expected=exp, expect=x,
                         first_line=line,
                         status_line_ok=bool(re.search(x.get('status_line') or STATUS_RE, line)),
                         correct=all(checks), first_tool=(tools or [None])[0],
                         wrong_agent='agent' in x and any(d != exp for d in r['dispatched']))
                runs.append(r)
                st = 'SKIP' if r['status'] == 'skipped' else ('PASS' if live_ok(r) else 'FAIL')
                want = expectation(x)
                print(f'  {paint(st, st)}  {case["id"]}#{n + 1}: expected {want}, dispatched '
                      f'{r["dispatched"] or "nothing"}, first tool {r["first_tool"]}, '
                      f'status line {"ok" if r["status_line_ok"] else "MISSING"}, '
                      + (f'planner model {r["planner_model"] or "null"}, ' if x.get('first_tool') == 'EnterPlanMode' else '') +
                      f'{r["duration_s"]}s' + (f', ${r["cost_usd"]:.3f}' if r.get('cost_usd') else '')
                      + (f' [{r["status"]}]' if r['status'] != 'ok' else '')
                      + (f' ({"; ".join(r["notes"])})' if r['notes'] else ''))
        return {**meta, 'runs': runs, 'metrics': metrics(runs)}
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def expectation(x):
    return ', '.join(filter(None, ['agent' in x and f'agent {x["agent"] or "inline"}',
                                   x.get('first_tool') and f'first tool {x["first_tool"]}',
                                   x.get('no_tool') and f'no {x["no_tool"]}']))


def live_ok(r):
    return r['status'] == 'skipped' or (r['status'] == 'ok' and r['correct'])


def metrics(runs):
    done = [r for r in runs if r['status'] == 'ok']
    pos = [r for r in done if r['category'] == 'positive']
    neg = [r for r in done if r['category'] == 'negative']
    plan = [r for r in done if r['category'] == 'plan']
    ratio = lambda a, b: f'{a}/{b}' if b else 'n/a'  # noqa: E731
    return {'delegation_accuracy': ratio(sum(r['correct'] for r in pos), len(pos)),
            'false_delegation': ratio(sum(bool(r['dispatched']) for r in neg), len(neg)),
            'plan_gate': ratio(sum(r['correct'] for r in plan), len(plan)),
            'planner_opus': ratio(sum(bool(r.get('planner_opus')) for r in plan if r.get('planner_model')),
                                  sum(bool(r.get('planner_model')) for r in plan)),
            'status_line': ratio(sum(r['status_line_ok'] for r in done), len(done)),
            'mean_duration_s': round(sum(r['duration_s'] for r in done) / len(done), 1) if done else None,
            'cost_usd': round(sum(r.get('cost_usd') or 0 for r in done), 4),
            'tokens': sum(r.get('tokens') or 0 for r in done),
            'completed': ratio(len(done), len(runs))}


def write_reports(live_results, ts):
    os.makedirs(f'{BENCH}/results', exist_ok=True)
    md = [f'# SwarmKit live benchmark {ts}', '']
    for res in live_results:
        with open(f'{BENCH}/results/{ts}-{res["cli"]}.json', 'w') as f:
            json.dump(res, f, indent=2)
        md += [f'## {res["cli"]}', '', f'- CLI version: {res["version"]}', f'- Repo commit: {res["repo_commit"]}',
               f'- Config: `{res["config"]}` -> {res.get("config_source", "n/a")} (commit {res.get("config_commit", "n/a")})']
        if res.get('skipped'):
            md += [f'- Skipped: {res["skipped"]}', '']
            continue
        m = res['metrics']
        md += [f'- **Delegation accuracy (positives): {m["delegation_accuracy"]}**',
               f'- **False delegation (negatives): {m["false_delegation"]}**',
               f'- **Plan-mode gate (plan cases): {m["plan_gate"]}**; planner model was Opus: {m["planner_opus"]}',
               f'- **Status-line compliance: {m["status_line"]}**',
               f'- Mean duration: {m["mean_duration_s"]}s; cost: ${m["cost_usd"]}; completed runs: {m["completed"]}', '',
               '| Case | Expected | Dispatched | First tool | Correct | Status line | Duration | Cost / tokens | Notes |',
               '|---|---|---|---|---|---|---|---|---|']
        for r in res['runs']:
            spend = f'${r["cost_usd"]:.3f}' if r.get('cost_usd') else (f'{r["tokens"]} tok' if r.get('tokens') else '')
            notes = r['notes'] + ([f'planner model {r["planner_model"] or "null (no message after EnterPlanMode)"}']
                                  if r.get('first_tool') == 'EnterPlanMode' else [])
            md.append(f'| {r["case"]}#{r["repeat"]} | {expectation(r["expect"])} | {", ".join(r["dispatched"]) or "-"} '
                      f'| {r.get("first_tool") or "-"} | {"yes" if r["correct"] else "NO"}{" (wrong agent)" if r["wrong_agent"] else ""} '
                      f'| {"ok" if r["status_line_ok"] else "missing"} | {r["duration_s"]}s | {spend} '
                      f'| {r["status"]}{"; " + "; ".join(notes) if notes else ""} |')
        md.append('')
    path = f'{BENCH}/results/{ts}.md'
    with open(path, 'w') as f:
        f.write('\n'.join(md))
    return path


# ---------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(description='SwarmKit benchmark (static tier by default).')
    ap.add_argument('--repo', default=os.path.dirname(BENCH), help='repo root (default: the one containing bench/)')
    ap.add_argument('--installed', action='store_true', help='also check the install symlinks (WARN only)')
    ap.add_argument('--live', choices=['claude', 'agy', 'opencode', 'all'], help='run the live tier (spends quota)')
    ap.add_argument('--yes', action='store_true', help='confirm live-tier spending')
    ap.add_argument('--config', choices=['installed', 'repo', 'none'], default='installed',
                    help='claude config used by the live tier (agy always uses the repo plugin)')
    ap.add_argument('--max-cases', type=int, default=0)
    ap.add_argument('--repeat', type=int, default=1)
    ap.add_argument('--timeout', type=int, default=240, help='seconds per live CLI call')
    ap.add_argument('--budget', type=float, default=0.75,
                    help='claude --max-budget-usd per case (soft: checked after each turn)')
    ap.add_argument('--max-total-usd', type=float, default=3.0,
                    help='stop a CLI\'s live run before the next case once it spent this')
    ap.add_argument('--only', help='comma-separated case-id prefixes, e.g. plan- (applied before --max-cases)')
    ap.add_argument('--model', help='override the main-session model (claude/agy)')
    ap.add_argument('--agy-skip-permissions', action='store_true',
                    help='pass --dangerously-skip-permissions to agy (fixtures are disposable temp dirs)')
    ap.add_argument('--json', help='write machine-readable results here')
    args = ap.parse_args()
    repo = os.path.abspath(args.repo)
    spec = json.loads(read(f'{BENCH}/cases.json'))
    ts = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')

    if args.live in ('claude', 'all'):
        n = len(select(spec, 'claude', args)) * args.repeat
        print(f'Claude estimate: {n} run(s) x about $1 (the installed config\'s first turn alone is ~$1) = ~${n}; '
              f'stops before the next case at --max-total-usd ${args.max_total_usd}. '
              f'--max-budget-usd is only checked after a turn, so one case can overshoot --budget.')
    if args.live and not args.yes:
        print(f'The live tier sends ~{len(spec["cases"])} prompts per CLI and spends your model quota '
              f'(claude cap ${args.budget}/case). Re-run with --yes to proceed.')
        return 2

    print(f'SwarmKit benchmark -- repo {repo}')
    mcp = set(json.loads(read(f'{repo}/core/mcp.json')).get('mcpServers', {}))
    for check in (s1_build, s2_roster, s3_signals, lambda r: s4_leakage(r, mcp),
                  lambda r: s5_guard(r, spec['guard_cases']), lambda r: s6_rules(r, spec['static']), s7_native):
        try:
            check(repo)
        except Exception as e:  # noqa: BLE001 - a crashing check is a failing check
            rec('crash', getattr(check, '__name__', 'check'), False, f'{type(e).__name__}: {e}')
    if args.installed:
        s8_installed(repo)

    live_results = []
    if args.live:
        for cli in (['claude', 'agy', 'opencode'] if args.live == 'all' else [args.live]):
            live_results.append(live(cli, args, spec, repo, ts))
        print(f'\n  report: {write_reports(live_results, ts)}')

    print('\nSCOREBOARD')
    cats = list(dict.fromkeys(r['category'] for r in RESULTS))
    for cat in cats:
        rows = [r for r in RESULTS if r['category'] == cat]
        n = sum(r['status'] == 'PASS' for r in rows)
        bad = [r['status'] for r in rows if r['status'] != 'PASS']
        st = 'FAIL' if 'FAIL' in bad else ('WARN' if 'WARN' in bad else ('SKIP' if bad else 'PASS'))
        print(f'  {paint(st, st)}  {cat:<26} {n}/{len(rows)}')
    for res in live_results:
        if res.get('skipped'):
            print(f'  {paint("SKIP", "SKIP")}  live {res["cli"]:<21} {res["skipped"]}')
        else:
            m = res['metrics']
            st = 'PASS' if all(map(live_ok, res['runs'])) else 'FAIL'
            print(f'  {paint(st, st)}  live {res["cli"]:<21} '
                  f'delegation {m["delegation_accuracy"]}, false delegation {m["false_delegation"]}, '
                  f'plan gate {m["plan_gate"]}, '
                  f'status line {m["status_line"]}, mean {m["mean_duration_s"]}s, '
                  + (f'${m["cost_usd"]}' if m['cost_usd'] else f'{m["tokens"]} tokens'))
    fails = sum(r['status'] == 'FAIL' for r in RESULTS)
    live_fails = sum(not live_ok(r) for res in live_results for r in res.get('runs', []))
    verdict = 'FAIL' if fails or live_fails else 'PASS'
    print(f'\n{paint(verdict, verdict)}: {sum(r["status"] == "PASS" for r in RESULTS)}/{len(RESULTS)} static checks '
          f'passed' + (f', {fails} failed' if fails else '') + (f'; {live_fails} live run(s) failed' if live_fails else ''))
    if args.json:
        with open(args.json, 'w') as f:
            json.dump({'timestamp': ts, 'repo': repo, 'static': RESULTS, 'live': live_results}, f, indent=2)
    return 1 if fails or live_fails else 0


if __name__ == '__main__':
    sys.exit(main())
