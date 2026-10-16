#!/usr/bin/env python3
"""Checks for export-bench.py and export-run.py on synthetic data only. Run: python3 site/scripts/test-export.py"""
import importlib.util, json, os, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))


def load(name):
    spec = importlib.util.spec_from_file_location(name.replace("-", "_"), os.path.join(HERE, name + ".py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


bench, export_run = load("export-bench"), load("export-run")


def run(case="scaffold", variant="vanilla", repeat=1, cost=0.3, wall=70.0, model="claude-sonnet-5-5", ok=True, **extra):
    r = {"case": case, "variant": variant, "repeat": repeat, "status": "ok" if ok else "verify-failed", "wall_s": wall,
         "cost_usd": cost, "turns": 4, "duration_s": 60.0, "model_usage": {model: {"costUSD": cost}},
         "verify": {"ok": ok}, "worker_tokens": {}, "worker_tasks": 0, "worker_oks": 0}
    r.update(extra)
    return r


def build(runs):
    with tempfile.TemporaryDirectory() as d:
        json.dump({"timestamp": "t", "args": {}, "runs": runs}, open(os.path.join(d, "x-compare.json"), "w"))
        return bench.build(bench.load_runs(d))


def keys(items):
    return {(i["case"], i["variant"], i["model"]) for i in items}


# a cell with 2 runs is pending, with counts only
d = build([run(repeat=1), run(repeat=2)])
assert d["cells"] == [] and d["rows"] == []
assert d["pending"] == [{"case": "scaffold", "variant": "vanilla", "model": "claude-sonnet-5-5", "n": 2}], d["pending"]

# 3 ok runs publish with correct min/median/max
d = build([run(repeat=1, cost=0.1, wall=10), run(repeat=2, cost=0.3, wall=30), run(repeat=3, cost=0.2, wall=1000)])
(c,) = d["cells"]
assert c["n"] == 3 and c["pass_rate"] == 1.0
assert c["cost_usd"] == {"min": 0.1, "median": 0.2, "max": 0.3}, c["cost_usd"]
assert c["wall_s"] == {"min": 10, "median": 30, "max": 1000}, c["wall_s"]
assert d["pending"] == [] and d["voided"] == []
row = d["rows"][0]
assert row["Runs"] == 3 and row["Pass"] == "3/3" and row["Wall range s"] == "10 to 1000"
assert all(isinstance(v, (str, int, float)) for v in row.values())

# one failed verify among 3 voids the cell: listed as voided, never with numbers
d = build([run(repeat=1), run(repeat=2), run(repeat=3, ok=False)])
assert d["cells"] == [] and keys(d["voided"]) == {("scaffold", "vanilla", "claude-sonnet-5-5")}
assert d["voided"][0]["n"] == 3 and "cost_usd" not in d["voided"][0]
# even with 3 passing runs besides the failure
d = build([run(repeat=i) for i in (1, 2, 3)] + [run(repeat=4, ok=False)])
assert d["cells"] == [] and len(d["voided"]) == 1
# a failed run with no recorded model voids the (case, variant) cell too
d = build([run(repeat=i) for i in (1, 2, 3)] + [run(repeat=4, ok=False, model_usage={})])
assert d["cells"] == [] and len(d["voided"]) == 1

# 'stock' merges into 'vanilla'
d = build([run(variant="stock", repeat=1), run(variant="stock", repeat=2), run(variant="vanilla", repeat=3)])
assert [(c["variant"], c["n"]) for c in d["cells"]] == [("vanilla", 3)], d["cells"]

# different models never mix: 2 + 2 runs are two pending cells, not one published cell
d = build([run(repeat=1), run(repeat=2), run(repeat=3, model="claude-opus-5-5"), run(repeat=4, model="claude-opus-5-5")])
assert d["cells"] == [] and keys(d["pending"]) == {("scaffold", "vanilla", "claude-sonnet-5-5"), ("scaffold", "vanilla", "claude-opus-5-5")}

# cost ratio only against a published vanilla of the same model
d = build([run(repeat=i, cost=0.2) for i in (1, 2, 3)]
          + [run(variant="hybrid", repeat=i, cost=0.1) for i in (1, 2, 3)]
          + [run(variant="lead-dev", repeat=i, cost=1.0, model="claude-opus-5-5") for i in (1, 2, 3)])
ratio = {r["Variant"]: r["vs vanilla (cost)"] for r in d["rows"]}
assert ratio == {"vanilla": "1.00x", "hybrid": "0.50x", "lead-dev": "n/a"}, ratio

# cost comes from the last (cumulative) result event of the transcript when it exists
with tempfile.TemporaryDirectory() as t:
    raw = os.path.join(t, "r.jsonl")
    with open(raw, "w") as f:
        f.write(json.dumps({"type": "system", "subtype": "init", "claude_code_version": "9.9.9"}) + "\n")
        for cost in (0.1, 0.4):
            f.write(json.dumps({"type": "result", "total_cost_usd": cost, "num_turns": 2, "duration_ms": 1000,
                                "modelUsage": {"claude-sonnet-5-5": {"costUSD": cost}}}) + "\n")
    rec = bench.normalise(run(cost=0.1, raw=raw), {}, t)
    assert rec["cost"] == 0.4 and rec["turns"] == 4 and rec["version"] == "9.9.9"

# run exporter: privacy check trips on leaks
for bad in ({"task": "see /home/x/file"}, {"a": ["/tmp/y"]}, {"k": "sk-abc"}, {"h": "Bearer abc"},
            {"p": "~/.opencode-tasks/z"}, {"e": "EOF"}, {"long": "x" * 121}):
    try:
        export_run.check_private(bad)
    except export_run.PrivacyError:
        continue
    raise AssertionError(f"privacy check missed {bad}")
export_run.check_private({"ok": "a short and clean string", "n": 3})

# run exporter: events keep only type/slug/lane, never command text
secret = "/home/x/secret-token"
cmd = f'agy-task start alpha --timeout 5m "edit {secret} in src/alpha.js; node test/alpha.test.js"'
lines = [
    {"type": "assistant", "timestamp": "2026-01-01T00:00:00.000Z", "message": {"content": [
        {"type": "tool_use", "id": "u1", "name": "Bash", "input": {"command": cmd, "run_in_background": False}}]}},
    {"type": "user", "timestamp": "2026-01-01T00:00:05.000Z", "message": {"content": [
        {"type": "tool_result", "tool_use_id": "u1", "content": f"done {secret}"}]}},
    {"type": "assistant", "timestamp": "2026-01-01T00:00:06.000Z", "message": {"content": [
        {"type": "tool_use", "id": "u2", "name": "Bash", "input": {"command": "git merge --no-edit agy/alpha && node test/alpha.test.js"}}]}},
    {"type": "user", "timestamp": "2026-01-01T00:00:07.000Z", "message": {"content": [
        {"type": "tool_result", "tool_use_id": "u2", "content": "ok"}]}},
]
events, files, t0, last = export_run.parse_events(lines)
out = export_run.build_events(events, t0, last, True)
assert [e["type"] for e in out] == ["task", "dispatch", "worker_done", "merge", "verify", "done"], out
assert out[1]["slug"] == "alpha" and out[1]["lane"] == "agy" and out[-1]["t"] == 7.0
assert files == {"alpha": ["src/alpha.js"]}
export_run.check_private(out)  # the secret path from the prompt must not have leaked
assert secret not in json.dumps(out) and "node test" not in json.dumps(out)

print("export checks passed")
