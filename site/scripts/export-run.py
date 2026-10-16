#!/usr/bin/env python3
"""Export ONE real bench run as an allowlisted replay file for the site.

  export-run.py [<compare.json> [<case> [<variant> [<repeat>]]]] > site/public/data/featured-run.json

Defaults select the featured candidate: 20261014T133904Z-compare.json, features, hybrid, repeat 1.

The output is built field by field from an allowlist: task title, case/variant/model, Claude cost, wall time,
verify result, per-worker {slug, lane, ok, tokens, denied_count, files} and an event list derived from the raw
transcript's tool calls. Only a type, a slug and a lane are taken from commands: command lines, paths, prompts,
code, denied command text and worker warnings never reach the output. A final check fails (exit 1, nothing
printed) when the JSON contains a home or tmp path, a key-looking token, a task directory or an overlong string.
Stdlib only.
"""
import argparse, datetime, importlib.util, json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
LANES = ("agy", "opencode", "codex")
SLUG = re.compile(r"^[a-z0-9][a-z0-9_-]{0,39}$")
# Hand-written titles per bench case (the case prompt itself is not in the transcript).
TITLES = {
    "small": "Add retry with backoff to an API call, plus tests",
    "big": "Rename one function across eleven files",
    "features": "Implement five independent modules against their failing tests",
    "scaffold": "Implement eight independent modules against their failing tests",
}
FORBIDDEN = ("/home/", "/tmp/", "sk-", "Bearer", ".opencode-tasks", "EOF")
MAX_STR = 120

_bench = importlib.util.spec_from_file_location("export_bench", os.path.join(HERE, "export-bench.py"))
bench = importlib.util.module_from_spec(_bench)
_bench.loader.exec_module(bench)


class PrivacyError(Exception):
    pass


def check_private(obj):
    """Raise PrivacyError if the serialized object could leak a path, a secret or a prompt."""
    text = json.dumps(obj, ensure_ascii=False)
    for bad in FORBIDDEN:
        if bad in text:
            raise PrivacyError(f"forbidden string {bad!r} in output")

    def walk(x):
        if isinstance(x, str) and len(x) > MAX_STR:
            raise PrivacyError(f"string longer than {MAX_STR} chars")
        elif isinstance(x, dict):
            for k, v in x.items():
                walk(k), walk(v)
        elif isinstance(x, list):
            for v in x:
                walk(v)
    walk(obj)


# --- transcript parsing -------------------------------------------------------------------------

def epoch(ts):
    try:
        return datetime.datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()
    except (AttributeError, ValueError):
        return None


def strip_quotes(cmd):
    """Blank out quoted strings so prompt text can never be mistaken for a command."""
    return re.sub(r'"(?:\\.|[^"\\])*"|\'[^\']*\'', '""', cmd)


def loop_vars(cmd):
    return {m.group(1): [w for w in m.group(2).split() if re.fullmatch(r"[A-Za-z0-9_-]+", w)]
            for m in re.finditer(r"\bfor\s+(\w+)\s+in\s+([^;]+?);", cmd)}


def expand(token, loops):
    """A slug token or a $var bound by a for loop -> list of valid slugs."""
    m = re.fullmatch(r"\$\{?(\w+)\}?", token)
    words = loops.get(m.group(1), []) if m else [token]
    return [w for w in words if SLUG.match(w)]


def text_of(content):
    if isinstance(content, list):
        return " ".join(b.get("text", "") for b in content if isinstance(b, dict))
    return content if isinstance(content, str) else ""


def tool_failed(block):
    return bool(block.get("is_error")) or re.search(r"\[exited with code [1-9]", text_of(block.get("content"))) is not None


DISPATCH = re.compile(r"(?<![\w/.-])(agy|opencode|codex)-task\s+(start|resume)\s+([A-Za-z0-9_$-]+)")
REF = re.compile(r"(?<![\w/~-])(agy|opencode|codex)/(\$\{?\w+\}?|[A-Za-z0-9_-]+)")
FILE = re.compile(r"(?<![\w/.~-])((?:src|lib)/[A-Za-z0-9_.-]+\.(?:js|mjs|cjs|ts|py))")
TESTING = re.compile(r"\bnode\s+test|\bnpm\s+(?:run\s+)?test|\bpytest\b")


def bash_events(cmd, known):
    """Command text -> [(type, slug|None, lane|None, extra)] in textual order. Reads only structure."""
    out, loops = [], loop_vars(cmd)
    q = strip_quotes(cmd)
    masked = re.search(r"\becho\b|\|\||\bexit\b|;\s*$", q) is not None  # exit status unreliable
    for seg in re.split(r"&&|\|\||;|\n|\|", q):
        for m in DISPATCH.finditer(seg):
            for s in expand(m.group(3), loops):
                out.append(("dispatch" if m.group(2) == "start" else "resume", s, m.group(1), {}))
        if re.search(r"(?<![\w/.-])(?:agy|opencode|codex)-task\b[^\n]*--review\b", seg):
            lane = re.search(r"(agy|opencode|codex)-task", seg).group(1)
            out.append(("review", None, lane, {"by": "cross-model"}))
        refs = [(m.group(1), s) for m in REF.finditer(seg) for s in expand(m.group(2), loops)]
        if re.search(r"\bgit\s+merge\b", seg):
            out += [("merge", s, lane, {"masked": masked}) for lane, s in refs] or [("merge", None, None, {"masked": masked})]
        elif re.search(r"\bgit\s+diff\b", seg):
            out += [("review", s, lane, {"by": "orchestrator"}) for lane, s in refs]
        if TESTING.search(seg):
            names = [s for m in re.finditer(r"test/([\w$\{\}-]+)\.test\b", seg) for s in expand(m.group(1), loops)]
            out += [("verify", s if s in known else None, None, {"masked": masked}) for s in names] or [("verify", None, None, {"masked": masked})]
    return out


def dispatch_files(cmd):
    """Relative src/lib module names mentioned in each dispatch prompt, keyed by slug."""
    files, hits = {}, list(DISPATCH.finditer(cmd))
    for i, m in enumerate(hits):
        end = hits[i + 1].start() if i + 1 < len(hits) else len(cmd)
        if SLUG.match(m.group(3)):
            files.setdefault(m.group(3), []).extend(FILE.findall(cmd[m.end():end]))
    return files


def parse_events(lines):
    """-> (events, files_by_slug). Events carry t (seconds from start, or None) and a sequence order."""
    raw, files = [], {}
    task_tool, task_end, results = {}, {}, {}
    t0 = last = None
    known = set()
    for seq, e in enumerate(lines):
        ts = epoch(e.get("timestamp"))
        if ts is not None:
            t0 = ts if t0 is None else t0
            last = ts
        kind, sub = e.get("type"), e.get("subtype")
        if kind == "system" and sub == "task_started":
            task_tool[e.get("task_id")] = e.get("tool_use_id")
        elif kind == "system" and sub == "task_updated" and (e.get("patch") or {}).get("end_time"):
            task_end[e.get("task_id")] = e["patch"]["end_time"] / 1000
        elif kind == "system" and sub == "task_notification":
            end = task_end.get(e.get("task_id"), last)
            raw.append((end, seq, "_done", e.get("tool_use_id"), e.get("status") == "completed"))
        elif kind == "user" and isinstance(e.get("message", {}).get("content"), list):
            for b in e["message"]["content"]:
                if b.get("type") == "tool_result":
                    results[b.get("tool_use_id")] = (ts, tool_failed(b))
        elif kind == "assistant":
            for b in e.get("message", {}).get("content", []):
                if b.get("type") != "tool_use":
                    continue
                name, inp, uid = b.get("name"), b.get("input") or {}, b.get("id")
                if name == "EnterPlanMode":
                    raw.append((ts, seq, "plan_mode", uid, None))
                elif name == "ExitPlanMode":
                    raw.append((ts, seq, "_plan_exit", uid, None))
                elif name == "Workflow":
                    raw.append((ts, seq, "dispatch", uid, None))
                elif name == "Bash" and isinstance(inp.get("command"), str):
                    cmd = inp["command"]
                    for slug, fs in dispatch_files(cmd).items():
                        files.setdefault(slug, []).extend(fs)
                    evs = bash_events(cmd, known)
                    known.update(s for t, s, _, _ in evs if t in ("dispatch", "resume") and s)
                    for t, s, lane, extra in evs:
                        raw.append((ts, seq, t, uid, (s, lane, extra, bool(inp.get("run_in_background")))))
    # resolve: plan approval, worker completion, outcome of merge/verify from the tool result
    events, bg = [], {}
    for ts, seq, t, uid, extra in raw:
        if t == "_plan_exit":
            res = results.get(uid)
            if res and not res[1]:
                events.append((ts, seq, {"type": "plan_approved"}))
        elif t == "_done":
            if uid in bg:
                slug, lane = bg[uid]
                events.append((ts, seq, {"type": "worker_done", "slug": slug, "lane": lane, "ok": bool(extra)}))
        elif t in ("dispatch", "resume", "merge", "verify", "review", "plan_mode") and isinstance(extra, tuple):
            slug, lane, more, background = extra
            res = results.get(uid)
            ev = {"type": t}
            if slug:
                ev["slug"] = slug
            if lane:
                ev["lane"] = lane
            if t in ("verify", "merge") and res and not more.get("masked"):
                ev["ok"] = not res[1]
            ev.update({k: v for k, v in more.items() if k != "masked"})
            when = res[0] if t in ("merge", "verify") and res and res[0] else ts
            events.append((when, seq, ev))
            if t in ("dispatch", "resume") and slug:
                if background:
                    bg[uid] = (slug, lane)
                elif res:  # foreground wrapper: it finished when the tool returned
                    events.append((res[0], seq, {"type": "worker_done", "slug": slug, "lane": lane, "ok": not res[1]}))
        else:
            events.append((ts, seq, {"type": t}))
    return events, files, t0, last


def build_events(events, t0, last, verify_ok):
    """Add task/done, sort by time, attach t and order. t is dropped entirely when timestamps are unusable."""
    timed = t0 is not None
    if timed:
        events = [(max(t0, w if w is not None else t0), s, e) for w, s, e in events]
    else:
        events = [(0, s, e) for _, s, e in events]
    events.sort(key=lambda x: (x[0], x[1]))
    out = [{"type": "task"}] + [e for _, _, e in events] + [{"type": "done", "ok": bool(verify_ok)}]
    if timed:
        out[0]["t"] = 0.0
        for item, (w, _, _) in zip(out[1:-1], events):
            item["t"] = round(w - t0, 1)
        out[-1]["t"] = round(max([last or t0] + [w for w, _, _ in events]) - t0, 1)
    for i, e in enumerate(out):
        e["order"] = i
    return out


# --- run selection and assembly -------------------------------------------------------------

def find_run(compare, case, variant, repeat, results_dir):
    data = json.load(open(compare, encoding="utf8"))
    for r in data.get("runs", []):
        rec = bench.normalise(r, data.get("args") or {}, results_dir)
        if rec["case"] == case and rec["variant"] == ("vanilla" if variant == "stock" else variant) and rec["repeat"] == repeat:
            return r, rec
    raise SystemExit(f"no run {case}/{variant}/{repeat} in {compare}")


def export(compare, case, variant, repeat, results_dir):
    run, rec = find_run(compare, case, variant, repeat, results_dir)
    path = bench.raw_path(run, results_dir)
    if not path:
        raise SystemExit("transcript missing; cannot build events")
    with open(path, encoding="utf8", errors="replace") as f:
        lines = [j for j in (json.loads(l) if l.strip().startswith("{") else None for l in f) if j]
    events, files, t0, last = parse_events(lines)
    evs = build_events(events, t0, last, rec["verify_ok"])
    order = [e["slug"] for e in evs if e["type"] == "dispatch" and e.get("slug")]
    workers = []
    for w in sorted(run.get("workers") or [], key=lambda w: order.index(w["slug"]) if w.get("slug") in order else 99):
        if not SLUG.match(w.get("slug") or "") or w.get("cli") not in LANES:
            continue
        workers.append({"slug": w["slug"], "lane": w["cli"], "ok": bool(w.get("ok")), "tokens": int(w.get("tokens") or 0),
                        "denied_count": len(w.get("denied") or []), "files": sorted(set(files.get(w["slug"], [])))})
    out = {
        "label": "One real run, not a median",
        "task": TITLES.get(case, f"Benchmark case: {case}")[:90],
        "case": case, "variant": rec["variant"], "model": rec["model"],
        "cost_usd": round(rec["cost"], 4), "wall_s": round(rec["wall"], 1), "duration_s": round(rec["duration"], 1),
        "turns": rec["turns"], "verify_ok": rec["verify_ok"],
        "worker_tokens": {k: int(v) for k, v in (run.get("worker_tokens") or {}).items() if k in LANES},
        "lanes": list(dict.fromkeys(w["lane"] for w in workers)),
        "workers": workers, "events": evs,
    }
    check_private(out)
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    results = bench.default_results_dir()
    ap.add_argument("compare", nargs="?", default=os.path.join(results, "20261014T133904Z-compare.json"))
    ap.add_argument("case", nargs="?", default="features")
    ap.add_argument("variant", nargs="?", default="hybrid")
    ap.add_argument("repeat", nargs="?", type=int, default=1)
    a = ap.parse_args()
    try:
        out = export(a.compare, a.case, a.variant, a.repeat, os.path.dirname(os.path.abspath(a.compare)))
    except PrivacyError as e:
        sys.exit(f"privacy check failed: {e}")
    json.dump(out, sys.stdout, indent=2, ensure_ascii=False)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
