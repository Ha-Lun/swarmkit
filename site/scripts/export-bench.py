#!/usr/bin/env python3
"""Aggregate bench/results/*-compare.json into site/public/data/benchmark_metrics.json.

Honesty gates (the site only prints what passes them):
  * a run counts only if its status is ok AND verify.ok is true;
  * a cell is (case, variant, main model); 'stock' is reported as 'vanilla';
    different models never share a cell;
  * a cell is published only with >= MIN_RUNS counted runs and no failed/errored run;
    any failure voids the cell (listed under "voided", never with numbers);
  * cells with fewer runs are listed under "pending" (counts only).

Claude-side cost, model, turns and duration come from the run transcript when it exists: the compare
harness recorded only the FIRST result event of a session, which understates runs that continue after
background workers finish. The last result event carries the cumulative session total. Worker tokens
are quota on the opencode-go / Gemini subscriptions and are never converted to USD.

Usage: export-bench.py [--results DIR] [--out FILE]   (stdlib only)
"""
import argparse, datetime, glob, json, os, re, statistics, subprocess, sys

MIN_RUNS = 3
CASE_ORDER = ["small", "big", "features", "scaffold"]
VARIANT_ORDER = ["vanilla", "slim", "lead-dev", "hybrid", "hybrid-workflow"]
HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.dirname(HERE)
DEFAULT_OUT = os.path.join(SITE, "public", "data", "benchmark_metrics.json")

if HERE not in sys.path:
    sys.path.insert(0, HERE)
import privacy
from privacy import check_private, PrivacyError

VALID_CASES = set(CASE_ORDER)
VALID_VARIANTS = set(VARIANT_ORDER)
MODEL_RE = re.compile(r"^claude-[a-z0-9.-]{1,40}$")
VERSION_RE = re.compile(r"^\d+\.\d+\.\d+$")
VALID_STATUS = {"ok", "verify-failed", "timeout", "error"}


class ValidationError(SystemExit, ValueError):
    pass


def default_results_dir():
    """bench/results of this checkout, else of the main checkout (worktrees do not carry gitignored data)."""
    repo = os.path.dirname(SITE)
    cands = [os.path.join(repo, "bench", "results")]
    try:
        common = subprocess.run(["git", "-C", repo, "rev-parse", "--path-format=absolute", "--git-common-dir"],
                                capture_output=True, text=True, check=True).stdout.strip()
        cands.append(os.path.join(os.path.dirname(common), "bench", "results"))
    except (OSError, subprocess.CalledProcessError):
        pass
    return next((c for c in cands if glob.glob(os.path.join(c, "*-compare.json"))), cands[0])


def read_transcript(path):
    """Summarise a stream-json transcript: Claude Code version and every result event (cumulative cost)."""
    out = {"version": None, "results": []}
    if not path or not os.path.isfile(path):
        return out
    with open(path, encoding="utf8", errors="replace") as f:
        for line in f:
            try:
                e = json.loads(line)
            except ValueError:
                continue
            if e.get("type") == "system" and e.get("subtype") == "init" and not out["version"]:
                out["version"] = e.get("claude_code_version")
            elif e.get("type") == "result":
                out["results"].append(e)
    return out


def main_model(usage):
    """Model with the largest costUSD in a modelUsage map, or None."""
    if not usage:
        return None
    return max(usage, key=lambda m: (usage[m] or {}).get("costUSD") or 0)


def raw_path(run, results_dir):
    p = run.get("raw")
    if p and os.path.isfile(p):
        return p
    alt = os.path.join(results_dir, "raw", os.path.basename(p or ""))
    return alt if p and os.path.isfile(alt) else None


def infer_case(run, args):
    """Old compare files carry no case; use the args, else the legacy default 'small'."""
    if run.get("case"):
        return run["case"]
    if args.get("case") and args["case"] != "all":
        return args["case"]
    cases = args.get("cases") or []
    return cases[0] if len(cases) == 1 else "small"


def normalise(run, args, results_dir):
    """One flat record per run, with transcript-corrected cost/model/turns/duration where available."""
    t = read_transcript(raw_path(run, results_dir))
    variant = run.get("variant")
    rec = {
        "case": infer_case(run, args),
        "variant": "vanilla" if variant == "stock" else variant,
        "repeat": run.get("repeat"),
        "status": run.get("status"),
        "verify_ok": (run.get("verify") or {}).get("ok") is True,
        "cost": run.get("cost_usd") or 0.0,
        "wall": run.get("wall_s") or 0.0,
        "turns": run.get("turns") or 0,
        "duration": run.get("duration_s") or 0.0,
        "usage": run.get("model_usage") or {},
        "worker_tokens": run.get("worker_tokens") or {},
        "worker_tasks": run.get("worker_tasks") or 0,
        "worker_oks": run.get("worker_oks") or 0,
        "version": t["version"],
        "raw": run.get("raw"),
    }
    if t["results"]:
        last = t["results"][-1]
        rec["cost"] = max(r.get("total_cost_usd") or 0 for r in t["results"])
        rec["usage"] = last.get("modelUsage") or rec["usage"]
        rec["turns"] = sum(r.get("num_turns") or 0 for r in t["results"])
        rec["duration"] = sum((r.get("duration_ms") or 0) for r in t["results"]) / 1000
    rec["model"] = main_model(rec["usage"])
    if rec["version"] is not None and not VERSION_RE.fullmatch(str(rec["version"])):
        rec["version"] = None
    if rec["status"] not in VALID_STATUS:
        rec["status"] = "failed"
    if rec["case"] not in VALID_CASES:
        raise ValidationError(f"unknown case: {rec['case']}")
    if rec["variant"] not in VALID_VARIANTS:
        raise ValidationError(f"unknown variant: {rec['variant']}")
    if rec["model"] is not None and not MODEL_RE.fullmatch(rec["model"]):
        raise ValidationError(f"weird model string: {rec['model']}")
    rec["counted"] = rec["status"] == "ok" and rec["verify_ok"]
    return rec


def load_runs(results_dir):
    runs, seen = [], set()
    for f in sorted(glob.glob(os.path.join(results_dir, "*-compare.json"))):
        d = json.load(open(f, encoding="utf8"))
        for r in d.get("runs", []):
            rec = normalise(r, d.get("args") or {}, results_dir)
            key = rec["raw"] or (os.path.basename(f), rec["case"], rec["variant"], rec["repeat"])
            if key in seen:
                continue
            seen.add(key)
            runs.append(rec)
    return runs


def spread(xs, nd):
    return {"min": round(min(xs), nd), "median": round(statistics.median(xs), nd), "max": round(max(xs), nd)}


def group(runs):
    """-> {(case, variant, model): {"ok": [...], "bad": [...]}}. A failed run with no recorded model
    cannot be placed in one model's cell, so it voids every cell of its (case, variant)."""
    cells, orphans = {}, []
    for r in runs:
        if r["counted"] or r["model"]:
            c = cells.setdefault((r["case"], r["variant"], r["model"] or "unknown"), {"ok": [], "bad": []})
            c["ok" if r["counted"] else "bad"].append(r)
        else:
            orphans.append(r)
    for r in orphans:
        hit = [k for k in cells if k[:2] == (r["case"], r["variant"])]
        for k in hit or [(r["case"], r["variant"], "unknown")]:
            cells.setdefault(k, {"ok": [], "bad": []})["bad"].append(r)
    return cells


def cell_of(key, ok):
    case, variant, model = key
    clis = sorted({c for r in ok for c in r["worker_tokens"]})
    return {
        "case": case, "variant": variant, "model": model, "n": len(ok),
        "cost_usd": spread([r["cost"] for r in ok], 4),
        "wall_s": spread([r["wall"] for r in ok], 1),
        "turns": {"median": statistics.median(r["turns"] for r in ok)},
        "worker_tokens": {c: int(statistics.median(r["worker_tokens"].get(c, 0) for r in ok)) for c in clis},
        "worker_tasks_median": statistics.median(r["worker_tasks"] for r in ok),
        "worker_oks_median": statistics.median(r["worker_oks"] for r in ok),
        "pass_rate": 1.0,  # a published cell has no failed run by construction
    }


def void_reason(bad, total):
    why = sorted({(r["status"] if r["status"] != "ok" else "verify failed") for r in bad})
    return f"{len(bad)} of {total} runs failed ({', '.join(why)}); a failed run voids the cell"


def sort_key(k):
    return (CASE_ORDER.index(k[0]) if k[0] in CASE_ORDER else 99,
            VARIANT_ORDER.index(k[1]) if k[1] in VARIANT_ORDER else 99, k[2])


def money(x):
    return f"{x:.3f}"


def rows_of(cells):
    """Flat human-readable rows (the site renders any Record<string, string|number>)."""
    vanilla = {(c["case"], c["model"]): c for c in cells if c["variant"] == "vanilla"}
    out = []
    for c in cells:
        van = vanilla.get((c["case"], c["model"]))
        row = {
            "Case": c["case"], "Variant": c["variant"], "Model": c["model"], "Runs": c["n"],
            "Claude cost $ (median)": money(c["cost_usd"]["median"]),
            "Cost range $": f'{money(c["cost_usd"]["min"])} to {money(c["cost_usd"]["max"])}',
            "Wall s (median)": round(c["wall_s"]["median"]),
            "Wall range s": f'{round(c["wall_s"]["min"])} to {round(c["wall_s"]["max"])}',
            "Worker tokens (quota)": ", ".join(f"{k} {v:,}" for k, v in c["worker_tokens"].items()) or "none",
            "Pass": f'{c["n"]}/{c["n"]}',
        }
        row["vs vanilla (cost)"] = ("1.00x" if c is van else
                                    f'{c["cost_usd"]["median"] / van["cost_usd"]["median"]:.2f}x' if van else "n/a")
        out.append(row)
    return out


def build(runs):
    groups = group(runs)
    cells, voided, pending = [], [], []
    for key in sorted(groups, key=sort_key):
        ok, bad = groups[key]["ok"], groups[key]["bad"]
        base = {"case": key[0], "variant": key[1], "model": key[2]}
        if bad:
            voided.append({**base, "n": len(ok) + len(bad), "reason": void_reason(bad, len(ok) + len(bad))})
        elif len(ok) < MIN_RUNS:
            pending.append({**base, "n": len(ok)})
        else:
            cells.append(cell_of(key, ok))
    versions = sorted({r["version"] for k, g in groups.items() for r in g["ok"]
                       if r["version"] and VERSION_RE.fullmatch(str(r["version"]))
                       and any(c["case"] == k[0] and c["variant"] == k[1] and c["model"] == k[2] for c in cells)})
    harness = (f"Claude Code {', '.join(versions)} (headless, claude -p)" if versions
               else "headless Claude Code (claude -p)")
    rows = rows_of(cells)
    models = sorted({c["model"] for c in cells})
    notes = [
        "A run counts only if it finished and its verify command exited 0. Cells need at least "
        f"{MIN_RUNS} counted runs; any failed or errored run in a cell voids it.",
        "Worker tokens are quota on the opencode-go and Gemini subscriptions, including cache reads. "
        "They are never converted to USD and are not part of the Claude cost.",
        "Small tasks cost more with the swarm: where the work is only a few lines, delegation adds "
        "overhead. Value scales with writing volume, not file count.",
        "Wall time includes waiting for headless workers and varies a lot between runs; the range columns "
        "show the full spread, not a typical value.",
        "Claude cost, model, turns and duration come from the run transcript (last result event, "
        "cumulative); bench/compare.py recorded only the first result event of a session.",
        "Turns are summed over the result segments of a session. 'stock' runs in older files are reported as 'vanilla'.",
        "Different models never share a cell. The 'vs vanilla' ratio is shown only against a published "
        "vanilla cell of the same case and model; otherwise it is n/a.",
    ]
    if voided:
        notes.append("Voided cells are never shown with numbers, even when later runs in the same cell passed.")
    for case in sorted({c["case"] for c in cells}, key=lambda x: CASE_ORDER.index(x) if x in CASE_ORDER else 99):
        ms = {c["model"] for c in cells if c["case"] == case}
        if len(ms) > 1:
            notes.append(f"Case {case}: cells use different models ({', '.join(sorted(ms))}), so cost ratios "
                         "against vanilla are only given within the same model.")
    return {
        "harness": harness, "models": models,
        "generated": datetime.date.today().isoformat(), "minRuns": MIN_RUNS,
        "cells": cells, "voided": voided, "pending": pending, "rows": rows, "notes": notes,
    }


def summary(data):
    def line(c):
        return (f'{c["case"]:9} {c["variant"]:16} {c["model"]:20} n={c["n"]} '
                f'cost ${c["cost_usd"]["min"]:.3f}/{c["cost_usd"]["median"]:.3f}/{c["cost_usd"]["max"]:.3f} '
                f'wall {c["wall_s"]["min"]:.0f}/{c["wall_s"]["median"]:.0f}/{c["wall_s"]["max"]:.0f}s '
                f'workers {c["worker_tokens"] or "-"}')
    out = [f'PUBLISHED ({len(data["cells"])}): min/median/max']
    out += ["  " + line(c) for c in data["cells"]]
    out += [f'VOIDED ({len(data["voided"])})']
    out += [f'  {v["case"]:9} {v["variant"]:16} {v["model"]:20} n={v["n"]}: {v["reason"]}' for v in data["voided"]]
    out += [f'PENDING ({len(data["pending"])})']
    out += [f'  {p["case"]:9} {p["variant"]:16} {p["model"]:20} n={p["n"]}' for p in data["pending"]]
    return "\n".join(out)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--results", default=None, help="bench/results directory (default: this repo or the main checkout)")
    ap.add_argument("--out", default=DEFAULT_OUT)
    a = ap.parse_args()
    results = a.results or default_results_dir()
    runs = load_runs(results)
    if not runs:
        sys.exit(f"no runs found in {results}")
    data = build(runs)
    try:
        check_private(data, max_str=300)
    except PrivacyError as e:
        sys.exit(f"privacy check failed: {e}")
    os.makedirs(os.path.dirname(a.out), exist_ok=True)
    with open(a.out, "w", encoding="utf8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print(summary(data))
    print(f"wrote {a.out}")


if __name__ == "__main__":
    main()
