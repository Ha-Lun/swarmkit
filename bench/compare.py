#!/usr/bin/env python3
"""Compare Claude Code variants on one implementation task.

  python3 bench/compare.py --dry-run
  python3 bench/compare.py --yes
"""
import argparse, datetime, hashlib, json, os, pathlib, re, shutil, subprocess, sys, tempfile, time
import yaml

BENCH = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, BENCH)
import run  # noqa: E402

SUFFIX = ("Non-interactive bench run: do not ask questions or wait for approval; "
          "decide and proceed. Done when `node test.js && node test/api.test.js` both exit 0.")
BACKENDS = [("agy", "AGY_TASK_DIR", ".agy-tasks"), ("opencode", "OPENCODE_TASK_DIR", ".opencode-tasks"),
            ("codex", "CODEX_TASK_DIR", ".codex-tasks")]


def task_key(fx):
    p = pathlib.Path(fx).resolve()
    return f"{p.name}-{hashlib.sha1(str(p).encode()).hexdigest()[:6]}"


def worker_root(env, home, fx):
    return pathlib.Path(os.environ.get(env, str(pathlib.Path.home() / home))) / task_key(fx)


def snapshot(fx):
    out = {}
    for name, env, home in BACKENDS:
        root = worker_root(env, home, fx)
        if root.exists():
            for d in root.iterdir():
                if d.is_dir():
                    rf = d / "result.json"
                    out[(name, str(d))] = rf.stat().st_mtime if rf.exists() else 0
    return out


def sum_usage(u):
    if isinstance(u, int):
        return u
    return sum(sum_usage(v) for v in u.values()) if isinstance(u, dict) else 0


def diff_workers(before, after, fx, base_sha):
    workers = []
    for key, mtime in after.items():
        if before.get(key) == mtime:
            continue
        backend, d = key
        try:
            with open(pathlib.Path(d) / "result.json") as f:
                r = json.load(f)
        except Exception:
            continue
        if r.get("base") != base_sha:  # result.json["base"] is the fixture commit this worker started from
            continue
        workers.append({"cli": backend, "slug": r.get("slug", pathlib.Path(d).name), "ok": r.get("ok", False),
                        "usage": r.get("usage"), "tokens": sum_usage(r.get("usage")),
                        "denied": r.get("denied_actions", []), "warnings": r.get("warnings", [])})
    return workers


def parse_usage(u):
    u = u or {}
    total = sum(v for k, v in u.items() if isinstance(v, int) and "tokens" in k.lower())
    inp = sum(v for k, v in u.items() if isinstance(v, int) and "input" in k.lower() and "tokens" in k.lower())
    out = sum(v for k, v in u.items() if isinstance(v, int) and "output" in k.lower() and "tokens" in k.lower())
    cr = sum(v for k, v in u.items() if isinstance(v, int) and "cache_read" in k.lower() and "tokens" in k.lower())
    cc = sum(v for k, v in u.items() if isinstance(v, int) and "cache_creation" in k.lower() and "tokens" in k.lower())
    return total, inp, out, cr, cc


def help_modes():
    try:
        text = subprocess.run(["claude", "--help"], capture_output=True, text=True, timeout=30).stdout
    except Exception:
        return None
    for i, line in enumerate(text.splitlines()):
        if "--permission-mode" in line:
            return set(re.findall(r'"([^"]+)"', " ".join(text.splitlines()[i:i + 4]))) or None
    return None


def build_cmd(variant, prompt, args, modes):
    cmd = ["claude", "-p", prompt, "--output-format", "stream-json", "--verbose",
           "--no-session-persistence", "--max-budget-usd", str(args.budget)]
    if args.model:
        cmd += ["--model", args.model]
    if variant != "stock":
        cmd += ["--agent", "lead-dev" if variant == "lead-dev" else "lead-dev-hybrid"]
    mode = args.permission_mode
    if modes and mode not in modes:
        return cmd + ["--permission-mode", "acceptEdits", "--allowedTools", "Bash"], f"{mode!r} unavailable, using acceptEdits+Bash"
    return cmd + ["--permission-mode", mode], None


def verify(fx):
    rc, out, err, _ = run.run(["bash", "-c", "node test.js && node test/api.test.js"], cwd=fx, timeout=120)
    last = ((out or err).strip().splitlines() or [""])[-1]
    log = len(run.run(["git", "-C", fx, "log", "--oneline"], timeout=30)[1].strip().splitlines())
    dirty = len(run.run(["git", "-C", fx, "status", "--porcelain"], timeout=30)[1].strip().splitlines())
    return {"ok": rc == 0, "exit": rc, "last": last, "logs": log, "dirty": dirty}


def run_variant(variant, prompt, args, spec, ts, n):
    fx = run.make_fixture(spec, "plan", None, "claude")
    before = snapshot(fx)
    base_sha = run.run(["git", "-C", fx, "rev-parse", "HEAD"], timeout=30)[1].strip()
    cmd, note = build_cmd(variant, prompt, args, help_modes())
    print(f"  [{variant}#{n}] {fx}")
    t0 = time.time()
    rc, out, err, timed_out = run.run(cmd, cwd=fx, env=None, timeout=args.timeout)
    wall = round(time.time() - t0, 1)
    raw = f"{BENCH}/results/raw/{ts}-compare-{variant}-{n}.jsonl"
    os.makedirs(os.path.dirname(raw), exist_ok=True)
    with open(raw, "w") as f:
        f.write(out)
    result = next((e for e in run.events(out) if e.get("type") == "result"), None)
    notes = ([note] if note else []) + (["timed out"] if timed_out else [])
    r = {"variant": variant, "repeat": n, "status": "ok", "wall_s": wall, "raw": raw, "notes": notes,
         "workers": [], "worker_tokens": {}, "verify": {}}
    if not result:
        r["status"] = "error"
        notes.append("no result event" if not rc else (err.strip().splitlines() or [f"exit {rc}"])[-1][:160])
    else:
        total, inp, outt, cr, cc = parse_usage(result.get("usage"))
        r.update({"duration_s": round((result.get("duration_ms") or 0) / 1000, 1), "turns": result.get("num_turns"),
                  "input_tokens": inp, "output_tokens": outt, "cache_read": cr, "cache_creation": cc,
                  "total_tokens": total, "cost_usd": result.get("total_cost_usd"),
                  "model_usage": result.get("modelUsage") or {}})
        if result.get("subtype") == "error_max_budget_usd":
            notes.append("budget cap hit")
        if result.get("is_error"):
            r["status"] = "error"
            notes.append(str(result.get("result") or "")[:160])
    workers = diff_workers(before, snapshot(fx), fx, base_sha)
    r["workers"] = workers
    for w in workers:
        r["worker_tokens"][w["cli"]] = r["worker_tokens"].get(w["cli"], 0) + w["tokens"]
    r["worker_tasks"] = len(workers)
    r["worker_oks"] = sum(1 for w in workers if w["ok"])
    if any(w["denied"] for w in workers):
        notes.append(f"{sum(len(w['denied']) for w in workers)} worker tool denials")
    r["verify"] = verify(fx)
    if not r["verify"]["ok"]:
        r["status"] = "verify-failed"
        notes.append(f"verify exit {r['verify']['exit']}")
    shutil.rmtree(fx, ignore_errors=True)
    return r


def avg(rows, key):
    vals = [r[key] for r in rows if r.get(key) is not None]
    return round(sum(vals) / len(vals), 1) if vals else None


def report(runs, ts, args):
    os.makedirs(f"{BENCH}/results", exist_ok=True)
    md, js = f"{BENCH}/results/{ts}-compare.md", f"{BENCH}/results/{ts}-compare.json"
    json.dump({"timestamp": ts, "args": vars(args), "runs": runs}, open(js, "w"), indent=2)
    grouped = {v: [r for r in runs if r["variant"] == v] for v in args.variants}
    lines = [f"# Claude Code variant comparison ({ts})", "",
             "| variant | wall_s | duration_s | turns | input | output | cache_read | cache_creation | cost_usd | worker_tokens | verify | workers | notes |",
             "|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for v in args.variants:
        rows = grouped[v]
        if not rows:
            continue
        if args.repeat == 1:
            r = rows[0]
            wt = ", ".join(f"{k}={r['worker_tokens'][k]}" for k in sorted(r["worker_tokens"])) or "-"
            lines.append(f"| {v} | {r['wall_s']} | {r['duration_s']} | {r['turns']} | {r['input_tokens']} | "
                         f"{r['output_tokens']} | {r['cache_read']} | {r['cache_creation']} | {r.get('cost_usd')} | "
                         f"{wt} | {'pass' if r['verify'].get('ok') else 'FAIL'} | {r['worker_tasks']}/{r['worker_oks']} | "
                         f"{'; '.join(r['notes']) or '-'} |")
        else:
            wt = ", ".join(f"{k}={round(sum(r['worker_tokens'].get(k, 0) for r in rows)/len(rows), 0):.0f}"
                           for k in sorted({k for r in rows for k in r["worker_tokens"]})) or "-"
            pass_rate = sum(1 for r in rows if r["verify"].get("ok")) / len(rows)
            notes = "; ".join(sorted({n for r in rows for n in r["notes"]})) or "-"
            lines.append(f"| {v} (mean) | {avg(rows,'wall_s')} | {avg(rows,'duration_s')} | {avg(rows,'turns')} | "
                         f"{avg(rows,'input_tokens')} | {avg(rows,'output_tokens')} | {avg(rows,'cache_read')} | "
                         f"{avg(rows,'cache_creation')} | {avg(rows,'cost_usd')} | {wt} | {pass_rate:.0%} pass | "
                         f"{avg(rows,'worker_tasks')}/{avg(rows,'worker_oks')} | {notes} |")
    lines += ["", "## Verdict", "",
              "A fair read requires every variant to complete and pass verification.",
              "Worker tokens are backend-specific quota and are not converted to USD.",
              f"Lowest Claude-side spend among runs shown: inspect the cost_usd column above."]
    if args.repeat > 1:
        lines += ["", "## Per-run details", "",
                  "| variant | # | wall_s | duration_s | turns | cost_usd | verify | notes |",
                  "|---|---|---|---|---|---|---|---|"]
        for r in runs:
            lines.append(f"| {r['variant']} | {r['repeat']} | {r['wall_s']} | {r['duration_s']} | {r['turns']} | "
                         f"{r.get('cost_usd')} | {'pass' if r['verify'].get('ok') else 'FAIL'} | "
                         f"{'; '.join(r['notes']) or '-'} |")
    open(md, "w").write("\n".join(lines) + "\n")
    return md, js


def main():
    ap = argparse.ArgumentParser(description="Compare Claude Code variants on the same implementation task.")
    ap.add_argument("--yes", action="store_true", help="confirm spending model quota")
    ap.add_argument("--repeat", type=int, default=1)
    ap.add_argument("--timeout", type=int, default=1800)
    ap.add_argument("--budget", type=float, default=10.0)
    ap.add_argument("--model", help="override claude model")
    ap.add_argument("--variants", default="stock,lead-dev,hybrid")
    ap.add_argument("--permission-mode", default="bypassPermissions")
    ap.add_argument("--json", help="extra copy of machine-readable results")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    args.variants = [v.strip() for v in args.variants.split(",") if v.strip()]
    if not args.variants:
        ap.error("--variants must list at least one variant")

    spec = json.loads(run.read(os.path.join(BENCH, "cases.json")))
    prompt = next(c["prompt"] for c in spec["cases"] if c["id"] == "delegate-after-plan") + "\n\n" + SUFFIX
    ts = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")

    if args.dry_run:
        fx = run.make_fixture(spec, "plan", None, "claude")
        modes = help_modes()
        print(f"fixture: {fx}")
        print("worker roots:")
        for name, env, home in BACKENDS:
            print(f"  {name}: {worker_root(env, home, fx)}")
        for v in args.variants:
            cmd, note = build_cmd(v, prompt, args, modes)
            print(f"\n{v}:\n  {' '.join(cmd)}")
            if note:
                print(f"  # {note}")
        shutil.rmtree(fx, ignore_errors=True)
        return 0

    n = len(args.variants) * args.repeat
    print(f"Estimate: {len(args.variants)} variants x {args.repeat} repeat(s) x ~$1+ = ~${n}; "
          f"--max-budget-usd {args.budget} is a soft cap.")
    if not args.yes:
        print("Re-run with --yes to spend model quota.")
        return 2

    runs = []
    for v in args.variants:
        for i in range(1, args.repeat + 1):
            runs.append(run_variant(v, prompt, args, spec, ts, i))
    md, js = report(runs, ts, args)
    print(f"\nreport: {md}\njson:   {js}")
    if args.json:
        shutil.copy2(js, args.json)
    return 0


if __name__ == "__main__":
    sys.exit(main())
