#!/usr/bin/env python3
"""Compare Claude Code variants on one implementation task.

Variants (--variants, comma-separated; default is all four):
  vanilla          Claude Code with no agents, skills or rules: a temp config dir with auth and settings only
  slim             your installed config (slim core + swarm pack), plain session, no --agent (alias: stock)
  hybrid           installed config, --agent lead-dev-hybrid, dynamic workflows off: it runs the wrappers by hand

  python3 bench/compare.py --dry-run
  python3 bench/compare.py --yes --case features

--showcase records a session for the site replay instead of measuring cost: the prompt is what a user would type
(plan first, use both worker lanes, get a cross-model review) and the suffix no longer forbids plan mode.
Headless `claude -p` has no EnterPlanMode/ExitPlanMode/AskUserQuestion unless a permission prompt tool is
configured, and ExitPlanMode asks that tool for approval. --showcase therefore passes
`--permission-prompt-tool` pointing at bench/plan_approver.py (a tiny MCP server): ExitPlanMode is approved
automatically, anything else is denied, and every answer is logged to results/raw/<ts>-...approvals.jsonl.
No human approves the plan in such a run; say "approval was automatic in this headless run" wherever it is shown.
  python3 bench/compare.py --yes --showcase --case scaffold --variants hybrid --model opus --budget 1.5
"""
import argparse, datetime, hashlib, json, os, pathlib, re, shutil, subprocess, sys, tempfile, threading, time

BENCH = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, BENCH)
import run  # noqa: E402

CASES = {
    "small": {
        "fixture": "plan",
        "prompt": None,  # loaded from cases.json case delegate-after-plan
        "verify": "node test.js && node test/api.test.js",
    },
    "big": {
        "fixture": "migration",
        "prompt": ("Approved mechanical migration: rename the function `cents` to `toCents` in src/format.js "
                   "and update every import, destructuring and call site that references it, across src/index.js, "
                   "src/cart.js, src/orders.js, src/products.js, src/inventory.js, test.js, test/cart.test.js, "
                   "test/orders.test.js and test/inventory.test.js, plus the README references. Behavior must not change."),
        "verify": "node test.js && node test/cart.test.js && node test/orders.test.js && node test/inventory.test.js",
    },
    "features": {
        "fixture": "features",
        "prompt": ("Implement the five functions whose test files already exist and currently fail: "
                   "src/slugify.js, src/email.js, src/range.js, src/pad.js, src/unique.js. "
                   "Implement them independently; do NOT modify any test file (tests define the contract). "
                   "Behavior must match the tests exactly."),
        "verify": ("node test/slugify.test.js && node test/email.test.js && node test/range.test.js && "
                   "node test/pad.test.js && node test/unique.test.js"),
    },
    "scaffold": {
        "fixture": "scaffold",
        "prompt": ("Implement the eight modules whose test files already exist and currently fail: "
                   "src/csv.js, src/semver.js, src/lru.js, src/expr.js, src/cron.js, src/template.js, "
                   "src/diff.js, src/wrap.js. They are independent of each other; each is a real "
                   "implementation of 30 to 70 lines. Do NOT modify any test file (tests define the contract). "
                   "Behavior must match the tests exactly."),
        "verify": " && ".join(f"node test/{m}.test.js" for m in
                              ("csv", "semver", "lru", "expr", "cron", "template", "diff", "wrap")),
    },
}
SUFFIX = ("Non-interactive bench run: the plan is already approved, so do not enter plan mode, ask questions or "
          "wait for approval; decide and proceed. Done when `{verify}` exits 0.")
SHOWCASE_ASK =("Plan this first and get approval, then implement it using your headless worker lanes (both opencode "
                "and agy, whichever fits each module), and have the result cross-reviewed by a different model "
                "before you finish.")
SHOWCASE_SUFFIX = ("This is a recorded non-interactive run: nobody is at the keyboard, so your plan is approved "
                   "automatically when you submit it with ExitPlanMode (do not use AskUserQuestion, nobody can answer; "
                   "decide and proceed). Done when `{verify}` exits 0.")
VARIANTS = ["vanilla", "slim", "hybrid"]
ALIASES = {"stock": "slim"}
REPO = os.path.dirname(BENCH)
BACKENDS = [("agy", "AGY_TASK_DIR", ".agy-tasks"), ("opencode", "OPENCODE_TASK_DIR", ".opencode-tasks")]


def task_key(fx):
    p = pathlib.Path(fx).resolve()
    return f"{p.name}-{hashlib.sha1(str(p).encode()).hexdigest()[:6]}"


def worker_root(env, home, fx):
    return pathlib.Path(os.environ.get(env, str(pathlib.Path.home() / home))) / task_key(fx)


def sum_usage(u):
    if isinstance(u, int):
        return u
    return sum(sum_usage(v) for v in u.values()) if isinstance(u, dict) else 0


def sweep_worker_roots(fx):
    """Read every currently-present worker result.json under the three roots."""
    out = {}
    for name, env, home in BACKENDS:
        root = worker_root(env, home, fx)
        if not root.exists():
            continue
        for d in root.iterdir():
            if not d.is_dir():
                continue
            rf = d / "result.json"
            if not rf.exists():
                continue
            try:
                with open(rf) as f:
                    r = json.load(f)
            except Exception:
                continue
            out[(name, str(d))] = r
    return out


def sample_workers(fx, stop, seen):
    """Daemon sampler: repeatedly sweep worker roots until `stop` is set.

    Only reads files; never writes. Mid-write partials fail json.load and are
    skipped. The final sweep after the event catches anything written at the end.
    """
    while not stop.wait(5):
        seen.update(sweep_worker_roots(fx))
    seen.update(sweep_worker_roots(fx))


def collect_workers(fx, sample, base_sha):
    """Build worker list from in-run sample plus a final filesystem sweep.

    `sample` is the sampler's in-memory map of (backend, dir) -> result.json.
    It survives even when a worker's `<cli>-task clean` deletes the directory.
    A final sweep catches anything the sampler missed in the last interval.
    """
    workers = []
    cleaned = []
    seen = set()
    for (backend, d), r in sample.items():
        if r.get("base") != base_sha:
            continue
        seen.add((backend, d))
        workers.append({"cli": backend, "slug": r.get("slug", pathlib.Path(d).name), "ok": r.get("ok", False),
                        "usage": r.get("usage"), "tokens": sum_usage(r.get("usage")),
                        "denied": r.get("denied_actions", []), "warnings": r.get("warnings", [])})
        if not pathlib.Path(d).exists():
            cleaned.append((backend, r.get("slug", pathlib.Path(d).name)))
    for name, env, home in BACKENDS:
        root = worker_root(env, home, fx)
        if not root.exists():
            continue
        for d in root.iterdir():
            if not d.is_dir():
                continue
            key = (name, str(d))
            if key in seen:
                continue
            try:
                with open(d / "result.json") as f:
                    r = json.load(f)
            except Exception:
                continue
            if r.get("base") != base_sha:
                continue
            workers.append({"cli": name, "slug": r.get("slug", d.name), "ok": r.get("ok", False),
                            "usage": r.get("usage"), "tokens": sum_usage(r.get("usage")),
                            "denied": r.get("denied_actions", []), "warnings": r.get("warnings", [])})
    notes = [f"worker {cli}/{slug} cleaned up during the run (counted from in-run sampling)"
             for cli, slug in cleaned]
    return workers, notes


def parse_usage(u):
    u = u or {}
    total = sum(v for k, v in u.items() if isinstance(v, int) and "tokens" in k.lower())
    inp = sum(v for k, v in u.items() if isinstance(v, int) and "input" in k.lower() and "tokens" in k.lower())
    out = sum(v for k, v in u.items() if isinstance(v, int) and "output" in k.lower() and "tokens" in k.lower())
    cr = sum(v for k, v in u.items() if isinstance(v, int) and "cache_read" in k.lower() and "tokens" in k.lower())
    cc = sum(v for k, v in u.items() if isinstance(v, int) and "cache_creation" in k.lower() and "tokens" in k.lower())
    return total, inp, out, cr, cc


def merge_results(events):
    """One result for the whole session. A session that resumes after background work emits a result event
    per segment: total_cost_usd and modelUsage are cumulative (take the last), while usage (main thread
    tokens), num_turns and duration_ms are per segment (sum them). None if there is no result event."""
    results = [e for e in events if e.get("type") == "result"]
    if not results:
        return None
    merged = dict(results[-1])
    merged["total_cost_usd"] = max((e.get("total_cost_usd") or 0 for e in results), default=0)
    merged["num_turns"] = sum(e.get("num_turns") or 0 for e in results)
    merged["duration_ms"] = sum(e.get("duration_ms") or 0 for e in results)
    usage = {}
    for e in results:
        for k, v in (e.get("usage") or {}).items():
            if isinstance(v, int):
                usage[k] = usage.get(k, 0) + v
    merged["usage"] = usage
    merged["segments"] = len(results)
    merged["errors"] = [str(e.get("result") or "")[:160] for e in results[:-1] if e.get("is_error")]
    merged["budget_hit"] = any(e.get("subtype") == "error_max_budget_usd" for e in results)
    return merged


def help_modes():
    try:
        text = subprocess.run(["claude", "--help"], capture_output=True, text=True, timeout=30).stdout
    except Exception:
        return None
    for i, line in enumerate(text.splitlines()):
        if "--permission-mode" in line:
            return set(re.findall(r'"([^"]+)"', " ".join(text.splitlines()[i:i + 4]))) or None
    return None


def build_cmd(variant, prompt, args, modes, approvals_log=None):
    cmd = ["claude", "-p", prompt, "--output-format", "stream-json", "--verbose",
           "--no-session-persistence", "--max-budget-usd", str(args.budget)]
    if args.model:
        cmd += ["--model", args.model]
    if variant == "hybrid":
        cmd += ["--agent", "lead-dev-hybrid"]
    if args.showcase:
        server = {"mcpServers": {"approver": {"command": sys.executable, "args": [os.path.join(BENCH, "plan_approver.py")],
                                              "env": {"PLAN_APPROVER_LOG": approvals_log or "/dev/null"}}}}
        cmd += ["--mcp-config", json.dumps(server), "--permission-prompt-tool", "mcp__approver__approve"]
    mode = args.permission_mode
    if modes and mode not in modes:
        return cmd + ["--permission-mode", "acceptEdits", "--allowedTools", "Bash"], f"{mode!r} unavailable, using acceptEdits+Bash"
    return cmd + ["--permission-mode", mode], None


def variant_env(variant, tmp):
    """Environment for one run. Session variables of the shell that launched us (CLAUDE_CODE_AGENT and friends)
    would silently turn every variant into that agent, so they are dropped. Workflows are forced off for every
    variant so the runs stay comparable."""
    env = {k: v for k, v in os.environ.items() if not (k.startswith("CLAUDE_CODE_") or k == "CLAUDECODE")}
    env["CLAUDE_CODE_WORKFLOWS"] = "0"
    if variant != "vanilla":
        return env, None
    import types
    cfg_env, label = run.claude_env(types.SimpleNamespace(config="none"), REPO, tmp)
    if isinstance(cfg_env, str):  # claude_env returns (error text, None) when it cannot authenticate
        return None, cfg_env
    return {**env, "CLAUDE_CONFIG_DIR": cfg_env["CLAUDE_CONFIG_DIR"]}, None


def verify(fx, verify_cmd):
    rc, out, err, _ = run.run(["bash", "-c", verify_cmd], cwd=fx, timeout=120)
    last = ((out or err).strip().splitlines() or [""])[-1]
    log = len(run.run(["git", "-C", fx, "log", "--oneline"], timeout=30)[1].strip().splitlines())
    dirty = len(run.run(["git", "-C", fx, "status", "--porcelain"], timeout=30)[1].strip().splitlines())
    return {"ok": rc == 0, "exit": rc, "last": last, "logs": log, "dirty": dirty}


def case_prompt(case_spec, spec, showcase=False):
    prompt = case_spec["prompt"]
    if prompt is None:
        prompt = next(c["prompt"] for c in spec["cases"] if c["id"] == "delegate-after-plan")
    if showcase:
        return prompt + " " + SHOWCASE_ASK + "\n\n" + SHOWCASE_SUFFIX.format(verify=case_spec["verify"])
    return prompt + "\n\n" + SUFFIX.format(verify=case_spec["verify"])


def run_variant(case_key, case_spec, variant, args, spec, ts, n):
    prompt = case_prompt(case_spec, spec, args.showcase)
    fx = run.make_fixture(spec, case_spec["fixture"], None, "claude")
    base_sha = run.run(["git", "-C", fx, "rev-parse", "HEAD"], timeout=30)[1].strip()
    approvals = f"{BENCH}/results/raw/{ts}-compare-{case_key}-{variant}-{n}.approvals.jsonl"
    os.makedirs(os.path.dirname(approvals), exist_ok=True)
    cmd, note = build_cmd(variant, prompt, args, help_modes(), approvals)
    tmp = tempfile.mkdtemp(prefix="compare-cfg-")
    env, env_err = variant_env(variant, tmp)
    if env_err:
        shutil.rmtree(fx, ignore_errors=True)
        shutil.rmtree(tmp, ignore_errors=True)
        return {"case": case_key, "variant": variant, "repeat": n, "status": "skipped", "wall_s": 0, "duration_s": 0,
                "turns": None, "input_tokens": 0, "output_tokens": 0, "cache_read": 0, "cache_creation": 0,
                "raw": None, "notes": [env_err], "workers": [], "worker_tokens": {}, "worker_tasks": 0,
                "worker_oks": 0, "verify": {}}
    print(f"  [{case_key} {variant}#{n}] {fx}")
    seen = {}
    stop = threading.Event()
    sampler = threading.Thread(target=sample_workers, args=(fx, stop, seen), daemon=True)
    sampler.start()
    t0 = time.time()
    rc, out, err, timed_out = run.run(cmd, cwd=fx, env=env, timeout=args.timeout)
    shutil.rmtree(tmp, ignore_errors=True)
    wall = round(time.time() - t0, 1)
    stop.set()
    sampler.join(timeout=30)
    raw = f"{BENCH}/results/raw/{ts}-compare-{case_key}-{variant}-{n}.jsonl"
    os.makedirs(os.path.dirname(raw), exist_ok=True)
    with open(raw, "w") as f:
        f.write(out)
    result = merge_results(run.events(out))
    notes = ([note] if note else []) + (["timed out"] if timed_out else [])
    if args.showcase:
        asked = [json.loads(x) for x in open(approvals).read().splitlines()] if os.path.exists(approvals) else []
        notes.append("showcase: " + (", ".join(f"{a['tool_name']} {a['answer']}" for a in asked) or "no permission prompts")
                     + " (automatic, via plan_approver.py)")
    r = {"case": case_key, "variant": variant, "repeat": n, "status": "ok", "wall_s": wall,
         "raw": raw, "notes": notes, "workers": [], "worker_tokens": {}, "verify": {}}
    if not result:
        r["status"] = "error"
        notes.append("no result event" if not rc else (err.strip().splitlines() or [f"exit {rc}"])[-1][:160])
    else:
        total, inp, outt, cr, cc = parse_usage(result.get("usage"))
        r.update({"duration_s": round((result.get("duration_ms") or 0) / 1000, 1), "turns": result.get("num_turns"),
                  "input_tokens": inp, "output_tokens": outt, "cache_read": cr, "cache_creation": cc,
                  "total_tokens": total, "cost_usd": result.get("total_cost_usd"),
                  "model_usage": result.get("modelUsage") or {}})
        if result["segments"] > 1:
            notes.append(f"{result['segments']} result segments merged (cost from the last, turns and duration summed)")
        notes.extend(f"earlier segment error: {m}" for m in result["errors"])
        if result["budget_hit"]:
            notes.append("budget cap hit")
        if result.get("is_error"):
            r["status"] = "error"
            notes.append(str(result.get("result") or "")[:160])
    workers, cleaned_notes = collect_workers(fx, seen, base_sha)
    notes.extend(cleaned_notes)
    r["workers"] = workers
    for w in workers:
        r["worker_tokens"][w["cli"]] = r["worker_tokens"].get(w["cli"], 0) + w["tokens"]
    r["worker_tasks"] = len(workers)
    r["worker_oks"] = sum(1 for w in workers if w["ok"])
    if any(w["denied"] for w in workers):
        notes.append(f"{sum(len(w['denied']) for w in workers)} worker tool denials")
    r["verify"] = verify(fx, case_spec["verify"])
    if not r["verify"]["ok"]:
        r["status"] = "verify-failed"
        notes.append(f"verify exit {r['verify']['exit']}")
    shutil.rmtree(fx, ignore_errors=True)
    return r


def avg(rows, key):
    vals = [r[key] for r in rows if r.get(key) is not None]
    return round(sum(vals) / len(vals), 4 if key == "cost_usd" else 1) if vals else None


def report(runs, ts, args):
    os.makedirs(f"{BENCH}/results", exist_ok=True)
    md, js = f"{BENCH}/results/{ts}-compare.md", f"{BENCH}/results/{ts}-compare.json"
    json.dump({"timestamp": ts, "args": vars(args), "runs": runs}, open(js, "w"), indent=2)
    grouped = {}
    for row in runs:
        grouped.setdefault((row["case"], row["variant"]), []).append(row)
    lines = [f"# Claude Code variant comparison ({ts})", "",
             "| case | variant | wall_s | duration_s | turns | input | output | cache_read | cache_creation | cost_usd | worker_tokens | verify | workers | notes |",
             "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for key in grouped:
        rows = grouped[key]
        if not rows:
            continue
        case, v = key
        if args.repeat == 1:
            r = rows[0]
            wt = ", ".join(f"{k}={r['worker_tokens'][k]}" for k in sorted(r["worker_tokens"])) or "-"
            lines.append(f"| {case} | {v} | {r['wall_s']} | {r['duration_s']} | {r['turns']} | {r['input_tokens']} | "
                         f"{r['output_tokens']} | {r['cache_read']} | {r['cache_creation']} | {r.get('cost_usd')} | "
                         f"{wt} | {'pass' if r['verify'].get('ok') else 'FAIL'} | {r['worker_tasks']}/{r['worker_oks']} | "
                         f"{'; '.join(r['notes']) or '-'} |")
        else:
            wt = ", ".join(f"{k}={round(sum(r['worker_tokens'].get(k, 0) for r in rows)/len(rows), 0):.0f}"
                           for k in sorted({k for r in rows for k in r["worker_tokens"]})) or "-"
            pass_rate = sum(1 for r in rows if r["verify"].get("ok")) / len(rows)
            notes = "; ".join(sorted({n for r in rows for n in r["notes"]})) or "-"
            lines.append(f"| {case} | {v} (mean) | {avg(rows,'wall_s')} | {avg(rows,'duration_s')} | {avg(rows,'turns')} | "
                         f"{avg(rows,'input_tokens')} | {avg(rows,'output_tokens')} | {avg(rows,'cache_read')} | "
                         f"{avg(rows,'cache_creation')} | {avg(rows,'cost_usd')} | {wt} | {pass_rate:.0%} pass | "
                         f"{avg(rows,'worker_tasks')}/{avg(rows,'worker_oks')} | {notes} |")
    lines += ["", "## Claude-side cost per case, relative to vanilla", "",
              "| case | " + " | ".join(args.variants) + " |", "|---|" + "---|" * len(args.variants)]
    for case in dict.fromkeys(r["case"] for r in runs):
        base = avg(grouped.get((case, "vanilla"), []), "cost_usd")
        cells = []
        for v in args.variants:
            rows = grouped.get((case, v), [])
            c = avg(rows, "cost_usd")
            ok = rows and all(r["verify"].get("ok") for r in rows)
            cells.append("-" if c is None else f"${c:.3f}" + (f" ({c / base:.0%})" if base else "") + ("" if ok else " FAIL"))
        lines.append(f"| {case} | " + " | ".join(cells) + " |")
    lines += ["", "## Verdict", "",
              "A fair read requires every variant to complete and pass verification (a FAIL above voids that cell).",
              "Worker tokens are backend-specific quota and are not converted to USD.",
              "One run per cell is directional only; use --repeat 3 for medians.",
              "Cost is Claude Code's list-price total for the run; a cold prompt cache makes the first run of a session costlier."]
    if args.repeat > 1:
        lines += ["", "## Per-run details", "",
                  "| case | variant | # | wall_s | duration_s | turns | cost_usd | verify | notes |",
                  "|---|---|---|---|---|---|---|---|---|"]
        for r in runs:
            lines.append(f"| {r['case']} | {r['variant']} | {r['repeat']} | {r['wall_s']} | {r['duration_s']} | "
                         f"{r['turns']} | {r.get('cost_usd')} | {'pass' if r['verify'].get('ok') else 'FAIL'} | "
                         f"{'; '.join(r['notes']) or '-'} |")
    open(md, "w").write("\n".join(lines) + "\n")
    return md, js


def main():
    ap = argparse.ArgumentParser(description="Compare Claude Code variants on the same implementation task.")
    ap.add_argument("--yes", action="store_true", help="confirm spending model quota")
    ap.add_argument("--case", default="all", help="comma-separated case key(s): small, big, features, scaffold")
    ap.add_argument("--repeat", type=int, default=1)
    ap.add_argument("--timeout", type=int, default=1800)
    ap.add_argument("--budget", type=float, default=10.0)
    ap.add_argument("--model", help="override claude model")
    ap.add_argument("--variants", default=",".join(VARIANTS))
    ap.add_argument("--permission-mode", default="bypassPermissions")
    ap.add_argument("--json", help="extra copy of machine-readable results")
    ap.add_argument("--showcase", action="store_true",
                    help="record a plan-first session for the site: user-style prompt, plan mode allowed, "
                         "ExitPlanMode auto-approved through bench/plan_approver.py (see the module docstring)")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    args.variants = [ALIASES.get(v.strip(), v.strip()) for v in args.variants.split(",") if v.strip()]
    if not args.variants:
        ap.error("--variants must list at least one variant")
    unknown = [v for v in args.variants if v not in VARIANTS]
    if unknown:
        ap.error(f"unknown variant(s): {', '.join(unknown)}; known: {', '.join(VARIANTS)} (stock = slim)")
    if args.case == "all":
        args.cases = list(CASES.keys())
    else:
        args.cases = [k.strip() for k in args.case.split(",") if k.strip()]
    bad = [k for k in args.cases if k not in CASES]
    if bad:
        ap.error(f"unknown case(s): {', '.join(bad)}; known: {', '.join(CASES)}")

    spec = json.loads(run.read(os.path.join(BENCH, "cases.json")))
    ts = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")

    if args.dry_run:
        modes = help_modes()
        for case_key in args.cases:
            case_spec = CASES[case_key]
            fx = run.make_fixture(spec, case_spec["fixture"], None, "claude")
            prompt = case_prompt(case_spec, spec, args.showcase)
            print(f"\ncase: {case_key}")
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

    n = len(args.cases) * len(args.variants) * args.repeat
    print(f"Estimate: {len(args.cases)} case(s) x {len(args.variants)} variants x {args.repeat} repeat(s) = {n} runs, "
          f"roughly $0.2-1.5 of Claude quota each (a cold cache costs about $1 on the first run); "
          f"--max-budget-usd {args.budget} is a soft cap per run. Worker quota is separate.")
    if not args.yes:
        print("Re-run with --yes to spend model quota.")
        return 2

    runs = []
    for case_key in args.cases:
        case_spec = CASES[case_key]
        for v in args.variants:
            for i in range(1, args.repeat + 1):
                runs.append(run_variant(case_key, case_spec, v, args, spec, ts, i))
    md, js = report(runs, ts, args)
    print(f"\nreport: {md}\njson:   {js}")
    if args.json:
        shutil.copy2(js, args.json)
    return 0


if __name__ == "__main__":
    sys.exit(main())
