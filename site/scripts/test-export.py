#!/usr/bin/env python3
"""Checks for export-bench.py and export-run.py on synthetic data only. Run: python3 site/scripts/test-export.py"""
import importlib.util, json, os, sys, tempfile

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

# max_str is overridable for long benign prose such as the bench notes
harmless = "Small tasks cost more with the swarm. " * 4
export_run.check_private({"s": harmless}, max_str=300)
try:
    export_run.check_private({"s": harmless})
    raise AssertionError("150-char string should be rejected with default max_str")
except export_run.PrivacyError:
    pass
try:
    export_run.check_private({"s": ("word " * 61)[:301]}, max_str=300)
    raise AssertionError("301-char string should be rejected even with max_str=300")
except export_run.PrivacyError:
    pass
try:
    export_run.check_private({"s": ("word " * 29)[:143] + "ghp_abc"}, max_str=300)
    raise AssertionError("ghp token should be rejected even with max_str=300")
except export_run.PrivacyError:
    pass

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
events, files, t0, last, _base = export_run.parse_events(lines)
out = export_run.build_events(events, t0, last, True)
assert [e["type"] for e in out] == ["task", "dispatch", "worker_done", "merge", "verify", "done"], out
assert out[1]["slug"] == "alpha" and out[1]["lane"] == "agy" and out[-1]["t"] == 7.0
assert files == {"alpha": ["src/alpha.js"]}
export_run.check_private(out)  # the secret path from the prompt must not have leaked
assert secret not in json.dumps(out) and "node test" not in json.dumps(out)

# transcript shapes: loop merges, failed results, removed lanes, failed starts, resumes
def transcript(*calls):
    """calls = (command, result_text, is_error) -> stream-json lines, one second apart."""
    out = []
    for i, (command, result, is_error) in enumerate(calls):
        out.append({"type": "assistant", "timestamp": f"2026-01-01T00:00:{2 * i:02d}.000Z", "message": {"content": [
            {"type": "tool_use", "id": f"c{i}", "name": "Bash", "input": {"command": command}}]}})
        out.append({"type": "user", "timestamp": f"2026-01-01T00:00:{2 * i + 1:02d}.000Z", "message": {"content": [
            {"type": "tool_result", "tool_use_id": f"c{i}", "content": result, "is_error": is_error}]}})
    return out


def timeline(*calls):
    events, files, t0, last, base_of = export_run.parse_events(transcript(*calls))
    return export_run.build_events(events, t0, last, True), base_of


def pairs(evs, kind):
    return [(e.get("lane"), e.get("slug")) for e in evs if e["type"] == kind]


# two loops that reuse one variable name must not leak into each other (the old double-dispatch bug)
two_loops = ('for m in alpha beta; do opencode-task start $m --wait "p" > /tmp/o-$m.out 2>&1 & done\n'
             'for m in gamma delta; do agy-task start $m --wait "p" > /tmp/a-$m.out 2>&1 & done\nwait')
evs, _ = timeline((two_loops, "", False))
assert pairs(evs, "dispatch") == [("opencode", "alpha"), ("opencode", "beta"), ("agy", "gamma"), ("agy", "delta")], pairs(evs, "dispatch")

# a loop merge expands to one merge event per branch, in order, lane from the prefix
loop = 'for b in opencode/alpha agy/beta agy/fixer; do git merge -q --no-edit $b || echo "MERGE FAIL $b"; done'
evs, _ = timeline((loop, "", False))
assert pairs(evs, "merge") == [("opencode", "alpha"), ("agy", "beta"), ("agy", "fixer")], pairs(evs, "merge")
assert all("ok" not in e for e in evs if e["type"] == "merge")
# the loop's own MERGE FAIL line removes just that branch
evs, _ = timeline((loop, "MERGE FAIL agy/beta\n", False))
assert pairs(evs, "merge") == [("opencode", "alpha"), ("agy", "fixer")], pairs(evs, "merge")
# a conflict or a nonzero exit on the last command drops the merge; a quiet success and "Already up to date" keep it
evs, _ = timeline(("git merge --no-edit agy/beta", "CONFLICT (content): Merge conflict in src/beta.js\nAutomatic merge failed", True))
assert pairs(evs, "merge") == [], evs
evs, _ = timeline(("git merge --no-edit agy/beta", "merge: agy/beta - not something we can merge", True))
assert pairs(evs, "merge") == []
evs, _ = timeline(("git merge --no-edit agy/beta", "fatal: refusing to merge", True))
assert pairs(evs, "merge") == []
evs, _ = timeline(("git merge --no-edit agy/beta", "Already up to date.", False), ("git merge agy/gamma", "Merge made by the 'ort' strategy.", False),
                  ("git merge agy/delta", "Fast-forward", False))
assert pairs(evs, "merge") == [("agy", "beta"), ("agy", "gamma"), ("agy", "delta")]
# a merge that is not the last command is not blamed for a later test's exit code
evs, _ = timeline(("git merge --no-edit agy/beta && node test/beta.test.js", "AssertionError: nope", True))
assert pairs(evs, "merge") == [("agy", "beta")] and [e.get("ok") for e in evs if e["type"] == "verify"] == [False], evs
# git diff with a loop variable is an orchestrator review per branch, listed once
evs, _ = timeline(('for b in opencode/alpha agy/beta; do git diff --stat main...$b || git diff --stat HEAD...$b; done', "", False))
assert pairs(evs, "review") == [("opencode", "alpha"), ("agy", "beta")] and {e["by"] for e in evs if e["type"] == "review"} == {"orchestrator"}

# the removed codex lane never appears, even for reviews and merges
evs, _ = timeline(('codex-task start rev --review "x"', "codex-task rev: ok (no changes)", False), ("git merge --no-edit codex/rev", "", False),
                  ('codex-task start gone "x"', "codex-task gone: ok (1 file changed)", False))
assert all(e.get("lane") != "codex" for e in evs) and [e["type"] for e in evs] == ["task", "done"], evs

# a start that failed is dropped (with its worker_done); a NOT ok task that ran stays
evs, _ = timeline(('agy-task start alpha "x"', "usage: agy-task [-h] ...\nagy-task: error: unrecognized arguments: --nope", True),
                  ('opencode-task start beta "x"', "Reading additional input from stdin...", False),
                  ('agy-task start gamma "x" 2>&1 | tail -1', "agy-task gamma: NOT ok (no changes) DENIED: RunCommand", False),
                  ('opencode-task start delta "x"', "opencode: command not found", True),
                  ('agy-task start eps "x" --review', "agy-task: refusing to start: queue full", True))
assert pairs(evs, "dispatch") == [("agy", "gamma")] and pairs(evs, "review") == [], evs
assert [(e["slug"], e.get("ok")) for e in evs if e["type"] == "worker_done"] == [("gamma", False)], evs
# one wrapper failing inside a multi-task output does not take the others with it
evs, _ = timeline(('agy-task start alpha "x" & opencode-task start beta "x" & wait',
                   "==> /tmp/a-alpha.out <==\nagy-task alpha: ok (1 file changed)\n\n==> /tmp/b-beta.out <==\nusage: opencode-task [-h]\n", False))
assert pairs(evs, "dispatch") == [("agy", "alpha")], evs
# a resume whose later pipe segment exited nonzero still counts when the wrapper reported
evs, _ = timeline(('opencode-task resume alpha "x" 2>&1 | tail -1; node test/alpha.test.js', "opencode-task alpha: NOT ok (1 file changed)\nAssertionError", True))
assert pairs(evs, "resume") == [("opencode", "alpha")]
assert [e.get("ok") for e in evs if e["type"] == "verify"] == [False]
# verify ok comes from the result, never from echoed test source
evs, _ = timeline(("cat test/alpha.test.js; node test/alpha.test.js 2>&1 | head -3", "console.log('alpha tests passed');\nAssertionError [ERR_ASSERTION]", False),
                  ("node test/beta.test.js && node test/gamma.test.js; echo EXIT=$?", "beta tests passed\nEXIT=0", False))
assert [(e.get("slug"), e.get("ok")) for e in evs if e["type"] == "verify"] == [(None, False), (None, True), (None, True)], evs

# end to end: lanes_tried, resumes, merged, merged_via, extras, attempt metadata
def fixture(calls, workers, tmp, **meta):
    raw = os.path.join(tmp, "e.jsonl")
    with open(raw, "w") as f:
        for line in transcript(*calls):
            f.write(json.dumps(line) + "\n")
    record = run(case="scaffold", variant="hybrid", repeat=1, model="claude-sonnet-5-5", raw=raw, status="ok", verify={"ok": True}, workers=workers)
    compare = os.path.join(tmp, "x-compare.json")
    with open(compare, "w") as f:
        json.dump({"timestamp": "t", "args": {}, "runs": [record]}, f)
    return compare


def worker(slug, cli, ok=True, tokens=5):
    return {"slug": slug, "cli": cli, "ok": ok, "tokens": tokens, "denied": [] if ok else ["RunCommand"], "warnings": []}


with tempfile.TemporaryDirectory() as t:
    calls = [
        ('opencode-task start alpha "x"', "opencode-task alpha: NOT ok (1 file changed)", False),
        ('opencode-task start beta "x"', "usage: opencode-task\nerror: queue is full", True),  # failed start, then moved lanes
        ('agy-task start beta "x"', "agy-task beta: ok (1 file changed)", False),
        ('opencode-task resume alpha "y"', "opencode-task alpha: NOT ok (1 file changed)", False),
        ('agy-task start alphafix --base opencode/alpha "z"', "agy-task alphafix: ok (1 file changed)", False),
        ('agy-task start loner "z"', "agy-task loner: ok (1 file changed)", False),
        ('agy-task start fixall "z"', "agy-task fixall: ok (1 file changed)", False),
        ('opencode-task resume alpha "y"', "opencode-task alpha: ok (1 file changed)", False),
        ('for b in agy/beta agy/alphafix agy/fixall; do git merge -q --no-edit $b || echo "MERGE FAIL $b"; done; echo EXIT=0', "EXIT=0", False),
        ('git merge --no-edit agy/loner', "CONFLICT (content): Merge conflict in src/loner.js", True),
    ]
    compare = fixture(calls, [worker("alpha", "opencode", ok=False), worker("beta", "agy"), worker("loner", "agy")], t)
    meta = export_run.run_meta(2, 2, ["attempt 1 was cut off by an account usage limit; its verify had passed"], "automatic")
    out = export_run.export(compare, "scaffold", "hybrid", 1, t, meta)
    by = {w["slug"]: w for w in out["workers"]}
    assert by["beta"]["lane"] == "agy" and by["beta"]["lanes_tried"] == ["agy"], by["beta"]  # the failed opencode start is gone
    assert by["alpha"]["resumes"] == 2 and by["alpha"]["ok"] is False and by["alpha"]["merged"] is True and by["alpha"]["merged_via"] == "alphafix", by["alpha"]
    assert by["beta"]["merged"] is True and "merged_via" not in by["beta"]
    assert by["loner"]["merged"] is False and by["loner"]["resumes"] == 0, by["loner"]
    ev = out["events"]
    assert [e["slug"] for e in ev if e["type"] == "merge"] == ["beta", "alphafix", "fixall"]
    assert [e["slug"] for e in ev if e["type"] == "merge" and e.get("extra")] == ["alphafix", "fixall"]
    assert [e["slug"] for e in ev if e["type"] == "dispatch" and e.get("extra")] == ["alphafix", "fixall"]
    assert [e.get("base") for e in ev if e["type"] == "dispatch" and e["slug"] == "alphafix"] == ["alpha"]
    assert not [e for e in ev if e.get("slug") == "loner" and e["type"] == "merge"]
    assert [e["order"] for e in ev] == list(range(len(ev)))  # contiguous after filtering
    assert [(e["slug"], e["ok"]) for e in ev if e["type"] == "worker_done" and e["slug"] == "alpha"][-1] == ("alpha", False)
    assert all(e.get("lane") in (None, "agy", "opencode") for e in ev) and out["lanes"] == ["opencode", "agy"]
    assert (out["attempt"], out["attempts"], out["attempt_label"], out["plan_approval"]) == (2, 2, "Run 2 of 2", "automatic")
    assert out["earlier_attempts"] == ["attempt 1 was cut off by an account usage limit; its verify had passed"]
    assert out["label"] == "One real run, not a median"
    # the same run as a single attempt has no label
    single = export_run.export(compare, "scaffold", "hybrid", 1, t)
    assert (single["attempt"], single["attempts"], single["earlier_attempts"]) == (1, 1, []) and "attempt_label" not in single and "plan_approval" not in single
    # CLI flags reach the file; a leaking note trips the privacy check and leaves --out untouched
    target = os.path.join(t, "featured.json")
    argv = ["export-run.py", compare, "scaffold", "hybrid", "1", "--attempt", "2", "--attempts", "3", "--earlier", "attempt 1 hit a usage limit",
            "--earlier", "attempt 2 was rate limited", "--plan-approval", "human", "--out", target]
    old_argv = sys.argv
    try:
        sys.argv = argv
        export_run.main()
        written = json.load(open(target))
        assert (written["attempt"], written["attempts"], written["attempt_label"], written["plan_approval"]) == (2, 3, "Run 2 of 3", "human")
        assert len(written["earlier_attempts"]) == 2
        before = open(target).read()
        for bad in ("see /home/x/notes", "mail me@x.example", "token ghp_" + "a" * 36, "x" * 101, "C:\\Users\\x", ""):
            sys.argv = argv[:argv.index("--earlier")] + ["--earlier", bad, "--out", target]
            try:
                export_run.main()
            except SystemExit as exc:
                assert exc.code, "expected a failure message"
            else:
                raise AssertionError(f"bad --earlier accepted: {bad!r}")
            assert open(target).read() == before
        for bad_flags in (["--attempt", "0"], ["--attempt", "3", "--attempts", "2"], ["--plan-approval", "robot"]):
            sys.argv = argv[:5] + bad_flags + ["--out", target]
            try:
                export_run.main()
            except SystemExit as exc:
                assert exc.code
            else:
                raise AssertionError(f"bad flags accepted: {bad_flags}")
    finally:
        sys.argv = old_argv
    # the privacy check itself, not just the length rule, rejects a leaking note
    for bad in ("see /tmp/x", "mail me@x.example"):
        try:
            export_run.check_private({"earlier_attempts": [bad]})
        except export_run.PrivacyError:
            continue
        raise AssertionError(f"privacy check missed {bad!r}")

# privacy: newly listed leaks are rejected (case-insensitive)
import getpass
for bad in ("x@y.example", "1.2.3.4", "ghp_" + "a" * 36, "bearer secret",
            "0" * 40, "file:///tmp/x", "https://example.invalid/x"):
    try:
        export_run.check_private({"s": bad})
    except export_run.PrivacyError:
        continue
    raise AssertionError(f"privacy check missed {bad!r}")
try:
    username = getpass.getuser()
except Exception:
    username = ""
if len(username) >= 3:
    try:
        export_run.check_private({"s": username})
    except export_run.PrivacyError:
        pass
    else:
        raise AssertionError("privacy check missed username")

# validation: unknown cases, variants and models are rejected
def expect_rejected(make):
    try:
        make()
    except Exception:
        return
    raise AssertionError("expected rejection")

expect_rejected(lambda: build([run(case="not-a-case")]))
expect_rejected(lambda: build([run(variant="not-a-variant")]))
expect_rejected(lambda: build([run(model="not-claude-model")]))
try:
    export_run.export(os.path.join(tempfile.gettempdir(), "nope-compare.json"), "features", "hybrid", 1, tempfile.gettempdir())
    raise AssertionError("expected rejection")
except Exception:
    pass

# foreign worker slug in an event is dropped during export
with tempfile.TemporaryDirectory() as t:
    raw = os.path.join(t, "foreign.jsonl")
    command = 'agy-task start alpha "x" && agy-task start beta "y"'
    with open(raw, "w") as f:
        f.write(json.dumps({"type": "assistant", "timestamp": "2026-01-01T00:00:00.000Z",
                            "message": {"content": [{"type": "tool_use", "id": "u1", "name": "Bash",
                                                     "input": {"command": command, "run_in_background": False}}]}}) + "\n")
        f.write(json.dumps({"type": "user", "timestamp": "2026-01-01T00:00:01.000Z",
                            "message": {"content": [{"type": "tool_result", "tool_use_id": "u1", "content": "ok"}]}}) + "\n")
    record = run(case="features", variant="hybrid", repeat=1, model="claude-sonnet-5-5", raw=raw,
                 status="ok", verify={"ok": True},
                 workers=[{"slug": "alpha", "cli": "agy", "ok": True, "tokens": 1, "denied": [], "files": []}])
    compare = os.path.join(t, "x-compare.json")
    with open(compare, "w") as f:
        json.dump({"timestamp": "t", "args": {}, "runs": [record]}, f)
    exported = export_run.export(compare, "features", "hybrid", 1, t)
    assert all(e.get("slug") != "beta" for e in exported["events"]), exported["events"]
    assert sum(e.get("type") == "dispatch" for e in exported["events"]) == 1

# a failed privacy check leaves an --out target untouched
with tempfile.TemporaryDirectory() as t:
    raw = os.path.join(t, "privacy.jsonl")
    with open(raw, "w") as f:
        f.write(json.dumps({"type": "assistant", "timestamp": "2026-01-01T00:00:00.000Z",
                            "message": {"content": [{"type": "tool_use", "id": "u1", "name": "Bash",
                                                     "input": {"command": 'agy-task start alpha "x"', "run_in_background": False}}]}}) + "\n")
        f.write(json.dumps({"type": "user", "timestamp": "2026-01-01T00:00:01.000Z",
                            "message": {"content": [{"type": "tool_result", "tool_use_id": "u1", "content": "ok"}]}}) + "\n")
    record = run(case="features", variant="hybrid", repeat=1, model="claude-sonnet-5-5", raw=raw,
                 status="ok", verify={"ok": True},
                 workers=[{"slug": "alpha", "cli": "agy", "ok": True, "tokens": 1, "denied": [], "files": []}])
    compare = os.path.join(t, "x-compare.json")
    with open(compare, "w") as f:
        json.dump({"timestamp": "t", "args": {}, "runs": [record]}, f)
    target = os.path.join(t, "target.json")
    with open(target, "w") as f:
        f.write("ORIGINAL")
    old_argv = sys.argv
    sys.argv = ["export-run.py", compare, "features", "hybrid", "1", "--out", target]
    original_check = export_run.check_private
    export_run.check_private = lambda obj: (_ for _ in ()).throw(export_run.PrivacyError("forced"))
    try:
        try:
            export_run.main()
        except SystemExit:
            pass
    finally:
        export_run.check_private = original_check
        sys.argv = old_argv
    assert open(target).read() == "ORIGINAL", open(target).read()

print("export checks passed")
