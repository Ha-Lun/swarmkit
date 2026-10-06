#!/usr/bin/env python3
"""First-turn prompt tokens of a trivial prompt under different configs: what a session costs before any work.

  overhead.py [--work DIR]

stock = no user settings or skills; nothing = an empty Claude config dir; slim = this checkout's `install.sh --claude`
in a scratch HOME; full = the real ~/.claude as installed. Target: slim - nothing <= LIMIT tokens.
"""
import argparse, json, os, shutil, subprocess, tempfile
from pathlib import Path

import run

PROMPT = 'Reply with the single word ok.'
LIMIT = 1500  # measured 1162 when the rework landed; a regression to the old +16k must not pass


def tokens(extra=(), config_dir=None, cwd=None):
    e = run.env()
    if config_dir:
        e['CLAUDE_CONFIG_DIR'] = str(config_dir)
    cmd = ['claude', '-p', PROMPT, '--model', 'sonnet', '--output-format', 'json', '--no-session-persistence',
           '--strict-mcp-config', '--mcp-config', str(run.HERE / 'empty-mcp.json'), *extra]
    j = json.loads(subprocess.run(cmd, cwd=cwd, env=e, capture_output=True, text=True, check=True).stdout)
    u = j['usage']
    return u['input_tokens'] + u.get('cache_creation_input_tokens', 0) + u.get('cache_read_input_tokens', 0), j['total_cost_usd']


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--work')
    a = ap.parse_args()
    work = Path(a.work or tempfile.mkdtemp(prefix='overhead_')); work.mkdir(parents=True, exist_ok=True)
    cwd = work / 'cwd'; cwd.mkdir(exist_ok=True)  # no project CLAUDE.md
    nothing = work / 'nothing'; shutil.rmtree(nothing, ignore_errors=True); nothing.mkdir()
    os.symlink(Path.home() / '.claude' / '.credentials.json', nothing / '.credentials.json')
    run.build_slim(work)
    rows = {
        'stock (flags)': tokens(['--setting-sources', 'project,local', '--disable-slash-commands'], cwd=cwd),
        'nothing installed': tokens(config_dir=nothing, cwd=cwd),
        'slim SwarmKit': tokens(config_dir=run.SLIM_DIR, cwd=cwd),
        'full install (~/.claude)': tokens(cwd=cwd),
    }
    for k, (t, c) in rows.items():
        print(f'{k:26s} {t:6d} tokens  ${c:.3f}')
    d = rows['slim SwarmKit'][0] - rows['nothing installed'][0]
    print(f'slim overhead over nothing: {d} tokens (target <= {LIMIT}): {"OK" if d <= LIMIT else "TOO HIGH"}')


if __name__ == '__main__':
    main()
