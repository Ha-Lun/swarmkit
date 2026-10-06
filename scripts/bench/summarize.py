#!/usr/bin/env python3
"""runs.jsonl -> site/public/data/benchmark_metrics.json (medians per task and arm, every run attached). Writes only what was measured."""
import json, statistics, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE.parent.parent / 'site' / 'public' / 'data' / 'benchmark_metrics.json'
ARM = {'A': 'bare (no skills, no user settings)', 'N': 'stock defaults', 'B': 'SwarmKit before rework', 'C': 'SwarmKit slim'}


def tok(r):  # all tokens the model processed, cached or not, main thread plus subagents
    return sum(r['tokens'].values())


def med(xs):
    return statistics.median(xs) if xs else 0


def row(label, arm, rs):
    n = len(rs)
    return {
        'Task': label, 'Arm': ARM[arm], 'Runs': n,
        'Passed': f"{sum(r['accepted'] for r in rs)}/{n}",
        'Time (s)': round(med([r['wall_s'] for r in rs])),
        'Cost ($)': round(med([r['cost_usd'] for r in rs]), 2),
        'Tokens (k)': round(med([tok(r) for r in rs]) / 1000),
        'Subagents': med([r['subagents'] for r in rs]),
    }


def main():
    runs = [json.loads(l) for l in (HERE / 'results' / 'runs.jsonl').read_text().splitlines() if l.strip()]
    if not runs:
        raise SystemExit('no runs recorded')
    rows = []
    for t in sorted({r['task'] for r in runs}):
        for arm in 'ANBC':
            rs = [r for r in runs if r['task'] == t and r['arm'] == arm]
            if rs:
                rows.append(row(f"{t} {rs[0]['name']}", arm, rs))
    SETS = [('Small tasks T1-T5 (sum)', lambda t: t.startswith('T')), ('Larger tasks H1-H3 (sum)', lambda t: t.startswith('H')), ('Large tasks L1-L2 (sum)', lambda t: t.startswith('L'))]
    for label, pick in SETS:
      for arm in 'ANBC':  # whole set: sums, because medians across tasks of different size say nothing
        rs = [r for r in runs if r['arm'] == arm and pick(r['task'])]
        if rs:
            n = len(rs)
            rows.append({'Task': label, 'Arm': ARM[arm], 'Runs': n, 'Passed': f"{sum(r['accepted'] for r in rs)}/{n}",
                         'Time (s)': round(sum(r['wall_s'] for r in rs)), 'Cost ($)': round(sum(r['cost_usd'] for r in rs), 2),
                         'Tokens (k)': round(sum(tok(r) for r in rs) / 1000), 'Subagents': sum(r['subagents'] for r in rs)})
    reps = min(len([r for r in runs if r['task'] == t and r['arm'] == a]) for t in {r['task'] for r in runs if r['arm'] in 'NC'} for a in 'NC')
    for r in rows:
        print(' | '.join(str(r[k]) for k in ('Task', 'Arm', 'Runs', 'Passed', 'Time (s)', 'Cost ($)', 'Tokens (k)', 'Subagents')))
    if '--write' not in sys.argv:
        return print('(printed only; pass --write to update site/public/data/benchmark_metrics.json)')
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({
        'harness': f"Claude Code {runs[0]['claude_version']}, headless (claude -p)",
        'model': ', '.join(sorted({m for r in runs for m in r['model']})) or 'sonnet',
        'notes': [
            f"Runs per task and arm: {reps}" + (' (pilot: each figure is a single run, not a median)' if reps < 3 else ''),
            'Tasks run against this repository at one pinned commit; pass/fail from a script per task, no judge.',
            'Small tasks T1-T5 were run first. Larger tasks H1-H3 (a new endpoint that reads files, a new field through storage, validation and docs, a bug with existing data) were added after seeing the T1-T5 result, because T1-T5 are too small for delegation to matter. L1-L2 (soft delete on existing databases, all-or-nothing bulk import) were added for the rework. Every set is published.',
            'Arms: N = Claude Code as shipped (empty config dir, built-in skills included): the baseline. A = bare: no user settings and no skills at all, cheaper than N. B = the full SwarmKit install before the rework (one run per task, not re-run). C = the slim SwarmKit, installed by install.sh --claude into a scratch HOME.',
            'All arms get the same prompt and the project CLAUDE.md. Headless runs cannot answer an approval prompt, so the slim rules say to state the plan and continue when non-interactive.',
            'Tokens: input, output and cached, main thread and subagents. Cost: total_cost_usd reported by Claude Code.',
        ],
        'rows': rows, 'runs': runs,
    }, indent=1) + '\n')
    print(f'wrote {OUT} ({len(rows)} rows, {len(runs)} runs)')


if __name__ == '__main__':
    main()
