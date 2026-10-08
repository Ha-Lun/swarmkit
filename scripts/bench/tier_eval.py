#!/usr/bin/env python3
"""Tier A/B: the same agent, fixture and scripted check, run on two models (`claude -p --agent NAME --model M`).

  tier_eval.py --work DIR [--agents seo-worker,test-writer] [--models sonnet,haiku] [--reps 2] [--jobs 4]
  tier_eval.py --summary

Uses the SwarmKit install from this checkout (run.build_slim) so the agents are the shipped ones. No judge model:
each task scores itself with a script. Appends to results/tiers.jsonl; resumable.
"""
import argparse, json, re, shutil, subprocess, sys, tempfile, time
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import run  # the existing bench: slim install, env isolation, stream parsing

OUT = run.RESULTS / 'tiers.jsonl'
TOOLS = 'Bash,Edit,Write,Read,Glob,Grep,Skill'


def git(cwd, *a):
    return subprocess.run(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', *a], cwd=cwd, capture_output=True, text=True)


def commit_all(d, msg):
    git(d, 'add', '-A'); git(d, 'commit', '-qm', msg)


# ---------- seo-worker ----------
def seo_setup(d):
    head = '<!doctype html><html><head><meta charset="utf-8">{t}</head><body>{b}</body></html>'
    pages = {
        'index.html': head.format(t='<title>Acme Bakery - Fresh sourdough daily in Lund</title>', b='<h1>Acme Bakery</h1><p>Sourdough, baked daily.</p>'),
        'about.html': head.format(t='<title>About</title>', b='<h1>About us</h1><p>Family bakery since 1998.</p>'),
        'thank-you.html': head.format(t='<title>Thanks</title>', b='<h1>Thank you</h1>'),
        '404.html': head.format(t='<title>Not found</title>', b='<h1>404</h1>'),
    }
    for n, h in pages.items():
        (d / n).write_text(h)


def seo_check(d, out):
    U = 'https://acme-bakery.example'
    checks = {}
    def html(n): return (d / n).read_text() if (d / n).exists() else ''
    for n in ('index.html', 'about.html'):
        h = html(n)
        titles = re.findall(r'<title>(.*?)</title>', h, re.S)
        checks[f'{n} one title<=60'] = len(titles) == 1 and len(titles[0].strip()) <= 60
        descs = re.findall(r'<meta[^>]+name=["\']description["\'][^>]*content=["\']([^"\']*)', h) or re.findall(r'<meta[^>]+content=["\']([^"\']*)["\'][^>]+name=["\']description', h)
        checks[f'{n} one description<=160'] = len(descs) == 1 and 0 < len(descs[0]) <= 160
        canon = re.findall(r'<link[^>]+rel=["\']canonical["\'][^>]*href=["\']([^"\']*)', h)
        checks[f'{n} one absolute canonical'] = len(canon) == 1 and canon[0].startswith(U)
        og = dict(re.findall(r'<meta[^>]+property=["\'](og:[a-z:]+)["\'][^>]*content=["\']([^"\']*)', h))
        # the spec allows a TODO:SEO-IMAGE placeholder when no image can be made, so a flagged gap counts as well as a tag
        image_ok = og.get('og:image', '').startswith('http') or 'TODO:SEO-IMAGE' in h
        checks[f'{n} og title/url + image or flagged TODO'] = 'og:title' in og and og.get('og:url', '').startswith('http') and image_ok
        checks[f'{n} twitter:card'] = 'twitter:card' in h
        checks[f'{n} viewport+lang'] = 'name="viewport"' in h.replace("'", '"') and re.search(r'<html[^>]+lang=', h) is not None
    checks['index title untouched (human-written)'] = 'Acme Bakery - Fresh sourdough daily in Lund' in html('index.html')
    for n in ('thank-you.html', '404.html'):
        checks[f'{n} noindex'] = bool(re.search(r'name=["\']robots["\'][^>]*noindex', html(n)))
    try:
        locs = [e.text for e in ET.parse(d / 'sitemap.xml').iter() if e.tag.endswith('loc')]
        checks['sitemap lists real pages only'] = any(l.rstrip('/') in (U, f'{U}/index.html') for l in locs) and any('about' in l for l in locs) and not any(('thank-you' in l or '404' in l) for l in locs) and all(l.startswith(U) for l in locs)
    except Exception:
        checks['sitemap lists real pages only'] = False
    checks['robots.txt references sitemap'] = bool(re.search(r'(?i)^sitemap:\s*' + re.escape(U), (d / 'robots.txt').read_text() if (d / 'robots.txt').exists() else '', re.M))
    checks['report has Overall line'] = 'Overall' in out
    return checks


# ---------- showroom-intake ----------
def intake_setup(d):
    (d / 'brief.txt').write_text("Initial brief from the client:\n\nWe sell a smart lamp called Lumen. We want a showcase website for it. "
                                 "The feel should be calm and premium. We want a hero video and a product gallery. That's all I have for now.\n")


def intake_check(d, out):
    brief = (d / 'BRIEF.md').read_text() if (d / 'BRIEF.md').exists() else ''
    q = out
    checks = {
        'BRIEF.md written': bool(brief.strip()),
        'asks about audience': bool(re.search(r'(?i)audience|target (customer|user|market)|customers?|buyers?|persona|demographic|who (is|are) (it|this|the site|(this|it) for)', q)),
        'asks about deadline/timeline': bool(re.search(r'(?i)deadline|timeline|launch date|when (do|should)', q)),
        'asks about brand assets': bool(re.search(r'(?i)logo|brand (colou?r|asset|guideline)|palette|typograph|fonts?', q)),
        'one batch (>=3 questions)': q.count('?') >= 3,
        'halts at G1': 'G1' in q,
        'BRIEF.md invents no dates/budget': not re.search(r'20\d\d-\d\d-\d\d|[$€£]\s?\d|\b\d+\s?(usd|eur|sek)\b', brief, re.I),
    }
    return checks


# ---------- test-writer ----------
INV = '''def apply_discount(price, pct):
    if pct < 0 or pct > 100:
        raise ValueError("pct must be between 0 and 100")
    return round(price * (1 - pct / 100), 2)


def chunk(items, n):
    if n <= 0:
        raise ValueError("n must be positive")
    return [items[i:i + n] for i in range(0, len(items), n)]


def parse_qty(s):
    s = s.strip()
    if s.endswith("x"):
        s = s[:-1]
    if not s.isdigit():
        raise ValueError("bad quantity: %r" % s)
    return int(s)
'''
MUTANTS = [
    ('discount: 100% rejected', 'pct > 100', 'pct >= 100'),
    ('discount: no rounding', 'round(price * (1 - pct / 100), 2)', 'price * (1 - pct / 100)'),
    ('chunk: drops last partial', 'range(0, len(items), n)', 'range(0, len(items) - n + 1, n)'),
    ('parse_qty: accepts negatives', 'if not s.isdigit():', 'if not s.lstrip("-").isdigit():'),
    ('parse_qty: strips only one x', 's.endswith("x")', 's.endswith("xx")'),
]


def tw_setup(d):
    (d / 'inventory.py').write_text(INV)
    (d / 'tests').mkdir()
    (d / 'tests' / '__init__.py').write_text('')
    (d / 'tests' / 'test_existing.py').write_text(
        'import unittest\nfrom inventory import chunk\n\n\nclass TestChunk(unittest.TestCase):\n    def test_even(self):\n        self.assertEqual(chunk([1, 2, 3, 4], 2), [[1, 2], [3, 4]])\n\n\nif __name__ == "__main__":\n    unittest.main()\n')


def unittest_ok(d):
    return subprocess.run([sys.executable, '-m', 'unittest', 'discover', '-s', 'tests', '-t', '.'], cwd=d, capture_output=True, text=True, timeout=120).returncode == 0


def tw_check(d, out):
    checks = {}
    new = [p for p in (d / 'tests').glob('test_*.py') if p.name != 'test_existing.py']
    checks['new test file in tests/'] = bool(new)
    checks['production code untouched'] = (d / 'inventory.py').read_text() == INV
    checks['suite passes'] = unittest_ok(d)
    for name, old, new_s in MUTANTS:
        assert old in INV, name
        (d / 'inventory.py').write_text(INV.replace(old, new_s))
        checks[f'kills mutant: {name}'] = not unittest_ok(d)
    (d / 'inventory.py').write_text(INV)
    return checks


# ---------- code-proofreader ----------
APP_BASE = '''import json


def calc_total(items):
    return sum(i["price"] * i["qty"] for i in items)


def render_receipt(items):
    return json.dumps({"total": calc_total(items), "items": items})
'''
APP_DIFF = '''import hashlib
import json
import sys

_unused_cache = {}


def calc_total(items):
    return sum(i["price"] * i["qty"] for i in items)


def legacy_format_price(p):
    return "$%.2f" % p


def render_receipt(items):
    return json.dumps({"total": calc_total(items), "items": items})


def handle_refund(order):
    return {"refunded": order}


def handle_cancel(order):
    return {"cancelled": order}


def dispatch(kind, order):
    return getattr(sys.modules[__name__], "handle_" + kind)(order)
'''


def pr_setup(d):
    (d / 'app.py').write_text(APP_BASE)
    commit_all(d, 'base')
    (d / 'app.py').write_text(APP_DIFF)
    commit_all(d, 'feature: refunds and dispatch')


def pr_check(d, out):
    def flagged(sym): return any(sym in l for l in out.splitlines())
    def high(sym): return any(sym in l and re.search(r'\[?high\]?', l, re.I) and 'app.py' in l for l in out.splitlines())
    return {
        'finds legacy_format_price': flagged('legacy_format_price'),
        'finds unused import hashlib': flagged('hashlib'),
        'finds _unused_cache': flagged('_unused_cache'),
        'does not mark handle_refund [high]': not high('handle_refund'),
        'does not mark handle_cancel [high]': not high('handle_cancel'),
        'ends with net: line': bool(re.search(r'(?m)^#*\s*net:', out)),
    }


TASKS = {
    'seo-worker': (seo_setup, seo_check, 'Run the post-build SEO and sharing pass on this static site (no build step, files are already built). production_url=https://acme-bakery.example', 1.5),
    'showroom-intake': (intake_setup, intake_check, 'Intake for a new Showroom project. The initial brief is in brief.txt. Do the intake step; there is no human to answer questions in this session, so put the full batched question set in your final answer.', 1.0),
    'test-writer': (tw_setup, tw_check, 'Add tests for inventory.py following the project conventions, then report.', 1.5),
    'code-proofreader': (pr_setup, pr_check, 'Proofread the diff of the latest commit (HEAD~1..HEAD), diff scope.', 1.5),
}


PACKS = {'seo-worker': 'web', 'showroom-intake': 'creative'}


def one(agent, model, rep, work, version):
    rid = f'{agent}_{model}_rep{rep}'
    setup, check, prompt, budget = TASKS[agent]
    d = Path(tempfile.mkdtemp(prefix=rid + '_', dir=work))
    git(d, 'init', '-q')
    setup(d)
    if git(d, 'rev-parse', 'HEAD').returncode:  # setup made no commits of its own
        commit_all(d, 'start')
    if agent in PACKS:  # pack agents are linked per project, not installed globally
        subprocess.run(['bash', str(run.ROOT / 'install.sh'), '--pack', PACKS[agent], str(d)], env={**run.env('C'), 'HOME': str(Path(work) / 'slim_home')}, check=True, capture_output=True)
    cmd = ['claude', '-p', prompt, '--agent', agent, '--model', model, '--output-format', 'stream-json', '--verbose', '--no-session-persistence',
           '--strict-mcp-config', '--mcp-config', str(run.HERE / 'empty-mcp.json'), '--max-budget-usd', str(budget),
           '--permission-mode', 'acceptEdits', '--allowedTools', TOOLS]
    t0 = time.time()
    try:
        r = subprocess.run(cmd, cwd=d, env=run.env('C'), capture_output=True, text=True, timeout=900)
        out, err, rc = r.stdout, r.stderr, r.returncode
    except subprocess.TimeoutExpired as e:
        out, err, rc = (e.stdout or ''), 'timeout', -1
        out = out.decode() if isinstance(out, bytes) else out
    wall = time.time() - t0
    res, _, _ = run.parse(out)
    text = (res or {}).get('result') or ''
    checks = check(d, text)
    keep = run.RESULTS / 'tier_artifacts' / rid  # full answer and the files the agent left, for judging the scorer
    shutil.rmtree(keep, ignore_errors=True)
    shutil.copytree(d, keep, ignore=shutil.ignore_patterns('.git', '.claude', '__pycache__'))
    (keep / 'ANSWER.txt').write_text(text)
    shutil.rmtree(d, ignore_errors=True)
    return {'run_id': rid, 'agent': agent, 'model_arg': model, 'rep': rep, 'passed': sum(bool(v) for v in checks.values()), 'total': len(checks),
            'all_pass': all(checks.values()), 'failed': [k for k, v in checks.items() if not v], 'wall_s': round(wall, 1),
            'cost_usd': round((res or {}).get('total_cost_usd') or 0, 4), 'turns': (res or {}).get('num_turns'), 'stop': (res or {}).get('subtype'),
            'model': sorted(((res or {}).get('modelUsage') or {}).keys()), 'claude_version': version, 'stderr': err.strip()[-200:], 'rc': rc,
            'answer_tail': text[-500:], 'ts': int(time.time())}


def summary():
    rows = [json.loads(l) for l in OUT.read_text().splitlines() if l.strip()]
    print(f"{'agent':18} {'model':8} {'runs':>4} {'all-pass':>8} {'checks':>8} {'$/run':>7} {'s/run':>6}  resolved model")
    for agent in TASKS:
        for m in sorted({r['model_arg'] for r in rows}, reverse=True):
            g = [r for r in rows if r['agent'] == agent and r['model_arg'] == m]
            if not g:
                continue
            n = len(g)
            print(f"{agent:18} {m:8} {n:>4} {sum(r['all_pass'] for r in g):>4}/{n:<3} {sum(r['passed'] for r in g):>4}/{sum(r['total'] for r in g):<3} "
                  f"{sum(r['cost_usd'] for r in g) / n:>7.3f} {sum(r['wall_s'] for r in g) / n:>6.0f}  {sorted({x for r in g for x in r['model']})}")
            for r in g:
                if r['failed']:
                    print(f"{'':28} rep{r['rep']} failed: {r['failed']}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--work')
    ap.add_argument('--agents', default=','.join(TASKS))
    ap.add_argument('--models', default='sonnet,haiku')
    ap.add_argument('--reps', type=int, default=2)
    ap.add_argument('--jobs', type=int, default=4)
    ap.add_argument('--summary', action='store_true')
    a = ap.parse_args()
    if a.summary:
        return summary()
    Path(a.work).mkdir(parents=True, exist_ok=True)
    run.build_slim(a.work)
    version = subprocess.run(['claude', '--version'], capture_output=True, text=True).stdout.strip()
    done = {json.loads(l)['run_id'] for l in OUT.read_text().splitlines() if l.strip()} if OUT.exists() else set()
    plan = [(ag, m, r) for r in range(1, a.reps + 1) for ag in a.agents.split(',') for m in a.models.split(',') if f'{ag}_{m}_rep{r}' not in done]

    def go(p):
        rec = one(*p, a.work, version)
        with open(OUT, 'a') as f:
            f.write(json.dumps(rec) + '\n')
        print(f"{rec['run_id']}: {rec['passed']}/{rec['total']} ${rec['cost_usd']} {rec['wall_s']}s {rec['model']}", flush=True)
    with ThreadPoolExecutor(a.jobs) as ex:
        list(ex.map(go, plan))
    summary()


if __name__ == '__main__':
    main()
