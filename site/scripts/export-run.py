#!/usr/bin/env python3
"""Export ONE real bench run as an allowlisted replay file for the site.

  export-run.py [<compare.json> [<case> [<variant> [<repeat>]]]] > site/public/data/featured-run.json

Defaults select the featured candidate: 20261014T133904Z-compare.json, features, hybrid, repeat 1.
Run metadata flags (all validated): --attempt N --attempts N --earlier "short note" (repeatable) --plan-approval automatic|human.

The output is built field by field from an allowlist: task title, case/variant/model, Claude cost, wall time,
verify result, per-worker {slug, lane, ok, tokens, denied_count, files} and an event list derived from the raw
transcript's tool calls. Only a type, a slug and a lane are taken from commands: command lines, paths, prompts,
code, denied command text and worker warnings never reach the output. A final check fails (exit 1, nothing
printed) when the JSON contains a home or tmp path, a key-looking token, a task directory or an overlong string.
Stdlib only.
"""
import argparse, datetime, importlib.util, json, os, re, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
from privacy import check_private, PrivacyError
LANES = ("agy", "opencode")  # the Codex lane was removed from the project; its events never reach the file
PLAN_APPROVALS = ("automatic", "human")
MAX_EARLIER, MAX_EARLIER_LEN = 5, 100
SLUG = re.compile(r"^[a-z0-9][a-z0-9_-]{0,39}$")
# Hand-written titles per bench case (the case prompt itself is not in the transcript).
TITLES = {
    "small": "Add retry with backoff to an API call, plus tests",
    "big": "Rename one function across eleven files",
    "features": "Implement five independent modules against their failing tests",
    "scaffold": "Implement eight independent modules against their failing tests",
}
CASES = set(TITLES)


class ValidationError(SystemExit, ValueError):
    pass


_bench = importlib.util.spec_from_file_location("export_bench", os.path.join(HERE, "export-bench.py"))
bench = importlib.util.module_from_spec(_bench)
_bench.loader.exec_module(bench)


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
    """{var: [words]} for every `for var in words;` in a quote-stripped command (later loops win). Words may be branch
    names such as opencode/expr; expand() and branches() filter them."""
    return {m.group(1): [w for w in m.group(2).split() if re.fullmatch(r"[A-Za-z0-9_/-]+", w)]
            for m in re.finditer(r"\bfor\s+(\w+)\s+in\s+([^;]+?);", cmd)}


def loop_spans(q):
    """[(start, end, vars)] for each for loop, from `for` to its matching `done` (nesting handled).
    Two loops in one command may reuse a variable name, so a variable is resolved by position, never globally."""
    marks = sorted([(m.start(), "for", m) for m in re.finditer(r"\bfor\s+\w+\s+in\s+[^;]+?;", q)]
                   + [(m.start(), "done", m) for m in re.finditer(r"\bdone\b", q)], key=lambda x: x[0])
    stack, spans = [], []
    for pos, kind, m in marks:
        if kind == "for":
            stack.append((pos, loop_vars(m.group(0))))
        elif stack:
            start, vs = stack.pop()
            spans.append((start, pos, vs))
    spans += [(start, len(q), vs) for start, vs in stack]  # unterminated: runs to the end
    return sorted(spans, key=lambda s: s[0])


def vars_at(spans, pos):
    """Loop variables visible at a text position; an inner loop overrides an outer one."""
    out = {}
    for start, end, vs in spans:
        if start <= pos < end:
            out.update(vs)
    return out


def segments(q):
    """(position, text, separator that follows) for each command segment of a quote-stripped command."""
    start = 0
    for m in re.finditer(r"&&|\|\||;|\n|\|", q):
        yield start, q[start:m.start()], m.group(0)
        start = m.end()
    yield start, q[start:], ""


def expand(token, loops):
    """A slug token or a $var bound by a for loop -> list of valid slugs."""
    m = re.fullmatch(r"\$\{?(\w+)\}?", token)
    words = loops.get(m.group(1), []) if m else [token]
    return [w for w in words if SLUG.match(w)]


def branches(token, loops):
    """A branch token (lane/slug, lane/$var, $var bound to branch names) -> [(lane, slug)]."""
    parts = []
    for piece in re.split(r"\.{2,3}", token):
        m = re.fullmatch(r"\$\{?(\w+)\}?", piece)
        parts += loops.get(m.group(1), []) if m else [piece]
    out = []
    for p in parts:
        m = re.fullmatch(r"(agy|opencode|codex)/(\$\{?\w+\}?|[A-Za-z0-9_-]+)", p)
        if m:
            out += [(m.group(1), s) for s in expand(m.group(2), loops)]
    return out


def text_of(content):
    if isinstance(content, list):
        return " ".join(b.get("text", "") for b in content if isinstance(b, dict))
    return content if isinstance(content, str) else ""


def tool_failed(block):
    return bool(block.get("is_error")) or re.search(r"\[exited with code [1-9]", text_of(block.get("content"))) is not None


DISPATCH = re.compile(r"(?<![\w/.-])(agy|opencode|codex)-task\s+(start|resume)\s+([A-Za-z0-9_${}-]+)")
BASE = re.compile(r"--base\s+(?:agy|opencode|codex)/([A-Za-z0-9_-]+)")
FILE = re.compile(r"(?<![\w/.~-])((?:src|lib)/[a-z0-9_-]{1,40}\.(?:js|mjs|cjs|ts|py))")
TESTING = re.compile(r"\bnode\s+test|\bnpm\s+(?:run\s+)?test|\bpytest\b")


def bash_events(cmd, known):
    """Command text -> [(type, slug|None, lane|None, extra)] in textual order. Reads only structure.
    Keys of extra starting with _ are internal (used to read the tool result) and are stripped before output."""
    q = strip_quotes(cmd)
    spans = loop_spans(q)
    segs = list(segments(q))
    masked = re.search(r"\becho\b|\|\||\bexit\b|;\s*$", q) is not None  # exit status unreliable
    out, seen = [], set()
    last_idx = max((i for i, s in enumerate(segs) if s[1].strip()), default=-1)

    def add(t, slug, lane, extra):
        key = (t, slug, lane, extra.get("by"))
        if t in ("merge", "review") and key in seen:  # `a || b` fallbacks mention the same branch twice
            return
        seen.add(key)
        out.append((t, slug, lane, extra))

    for idx, (pos, seg, sep) in enumerate(segs):
        loops = vars_at(spans, pos)
        started = []
        for m in DISPATCH.finditer(seg):
            base = BASE.search(seg)
            for s in expand(m.group(3), loops):
                started.append((m.group(1), s))
                extra = {"_check": (m.group(1), s)}
                if base and m.group(2) == "start":
                    extra["base"] = base.group(1)
                add("dispatch" if m.group(2) == "start" else "resume", s, m.group(1), extra)
        if re.search(r"(?<![\w/.-])(?:agy|opencode|codex)-task\b[^\n]*--review\b", seg):
            lane = re.search(r"(agy|opencode|codex)-task", seg).group(1)
            add("review", None, lane, {"by": "cross-model", "_check": started[0] if started else (lane, None)})
        tokens = seg.split()
        if "git" in tokens and "merge" in tokens[tokens.index("git"):]:
            args = tokens[tokens.index("merge", tokens.index("git")) + 1:]
            for tok in args:
                if not tok.startswith("-"):
                    for lane, s in branches(tok, loops):
                        add("merge", s, lane, {"_branch": f"{lane}/{s}", "_last": idx == last_idx})
        elif "git" in tokens and "diff" in tokens[tokens.index("git"):]:
            for tok in tokens:
                for lane, s in branches(tok, loops):
                    add("review", s, lane, {"by": "orchestrator"})
        if TESTING.search(seg):
            names = [s for m in re.finditer(r"test/([\w$\{\}-]+)\.test\b", seg) for s in expand(m.group(1), loops)]
            piped = sep == "|"
            out += [("verify", s if s in known else None, None, {"masked": masked, "piped": piped}) for s in names] \
                or [("verify", None, None, {"masked": masked, "piped": piped})]
    return out


def dispatch_files(cmd):
    """Relative src/lib module names mentioned in each dispatch prompt, keyed by slug."""
    files, hits = {}, list(DISPATCH.finditer(cmd))
    for i, m in enumerate(hits):
        end = hits[i + 1].start() if i + 1 < len(hits) else len(cmd)
        if SLUG.match(m.group(3)):
            files.setdefault(m.group(3), []).extend(FILE.findall(cmd[m.end():end]))
    return files


# --- reading tool results ---------------------------------------------------------------------

# A wrapper that could not start (bad flags, stdin trouble) says so; these count even when a summary line exists.
HARD_FAIL = re.compile(r"Reading additional input from stdin|^usage:|unrecognized arguments|: error:|Traceback \(most recent", re.M)
# Weaker signs, only trusted when the wrapper printed no summary for this slug.
SOFT_FAIL = re.compile(r"\berror:|refus|permission denied|access denied|not found|\bcannot\b|\[exited with code [1-9]", re.I)
MERGE_OK = re.compile(r"Already up to date|Merge made|Fast-forward|^Updating \w", re.M)
MERGE_BAD = re.compile(r"CONFLICT|Automatic merge failed|not something we can merge|MERGE FAIL|^fatal:|^error:|would be overwritten|"
                       r"unmerged files|Merge conflict|refus", re.M)


def scoped(text, name):
    """The blocks of a multi-section output (`==> file <==` / `=== dir` headers) whose header names this slug;
    the whole text when none does."""
    pat = re.compile(rf"(?<![A-Za-z0-9]){re.escape(name)}(?![A-Za-z0-9])")
    blocks = re.split(r"(?m)^(?=(?:==>|===) )", text)
    hit = [b for b in blocks if pat.search(b.split("\n", 1)[0])]
    return "\n".join(hit) if hit else text


def summary_ok(lane, slug, text):
    """The wrapper's own `<lane>-task <slug>: ok|NOT ok` line -> bool, or None when it is not in the output."""
    found = re.findall(rf"\b{lane}-task {re.escape(slug)}: (NOT ok|ok)\b", scoped(text, slug))
    return None if not found else found[-1] == "ok"


def start_failed(lane, slug, text, errored):
    """True when a dispatch/resume/review did not actually start a task, judged from its own tool result."""
    sc = scoped(text, slug) if slug else text
    if HARD_FAIL.search(sc):
        return True
    if slug and (summary_ok(lane, slug, text) is not None or re.search(rf"/{re.escape(slug)}/result\.json|^=== \S*/{re.escape(slug)}\s*$", sc, re.M)):
        return False  # the wrapper ran (even if it reported NOT ok)
    return errored or bool(SOFT_FAIL.search(sc))


def merge_failed(branch, text, errored, last):
    """True when the result does not show this merge succeeded (conflict, refusal, MERGE FAIL <branch>, nonzero exit)."""
    if re.search(rf"MERGE FAIL {re.escape(branch)}(?![A-Za-z0-9_-])", text):
        return True
    if re.search(r"MERGE FAIL \S", text):
        return False  # the loop named its failures; this branch is not one of them
    if MERGE_BAD.search(text):
        return True
    # a nonzero exit says little when later commands could have produced it
    return errored and last and not MERGE_OK.search(text)


def verify_ok(slug, text, errored, masked, piped):
    """Pass/fail of a test command from its output; None when the status is not knowable."""
    if slug:
        if re.search(rf"(?m)^\s*{re.escape(slug)} tests? passed\s*$", text):  # the test's own line, not source echoed by cat
            return True
        m = re.search(rf"\b{re.escape(slug)}\b[^\n]*?\bexit=(\d+)", text)
        if m:
            return m.group(1) == "0"
    m = re.search(r"\bEXIT=(\d+)", text)
    if m:
        return m.group(1) == "0"
    if masked or piped:
        return False if re.search(r"AssertionError|\bFAIL\b|not ok \d|\bfailing\b", text) else None
    return not errored


def parse_events(lines):
    """-> (events, files_by_slug, t0, last, base_of). Events carry t (seconds from start, or None) and a sequence order."""
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
                    results[b.get("tool_use_id")] = (ts, tool_failed(b), text_of(b.get("content")))
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
    # resolve: plan approval, worker completion, outcome of merge/verify/dispatch from the tool result
    events, bg, base_of = [], {}, {}
    for ts, seq, t, uid, extra in raw:
        if t == "_plan_exit":
            res = results.get(uid)
            if res and not res[1]:
                events.append((ts, seq, {"type": "plan_approved"}))
        elif t == "_done":
            for slug, lane in bg.get(uid, []):
                events.append((ts, seq, {"type": "worker_done", "slug": slug, "lane": lane, "ok": bool(extra)}))
        elif t in ("dispatch", "resume", "merge", "verify", "review", "plan_mode") and isinstance(extra, tuple):
            slug, lane, more, background = extra
            res = results.get(uid)
            text, errored = (res[2], res[1]) if res else ("", False)
            if lane and lane not in LANES:
                continue  # codex and any other removed lane
            check = more.get("_check")
            if t in ("dispatch", "resume", "review") and check and res and start_failed(check[0], check[1], text, errored):
                continue  # the task never started
            if t == "merge":
                if not res or merge_failed(more["_branch"], text, errored, more["_last"]):
                    continue
            ev = {"type": t}
            if slug:
                ev["slug"] = slug
            if lane:
                ev["lane"] = lane
            if t == "verify" and res:
                ok = verify_ok(slug, text, errored, more.get("masked"), more.get("piped"))
                if ok is not None:
                    ev["ok"] = ok
            ev.update({k: v for k, v in more.items() if not k.startswith("_") and k not in ("masked", "piped", "base")})
            if t == "dispatch" and more.get("base") and slug:
                base_of[slug] = more["base"]
            when = res[0] if t in ("merge", "verify") and res and res[0] else ts
            events.append((when, seq, ev))
            if t in ("dispatch", "resume") and slug:
                if background:
                    bg.setdefault(uid, []).append((slug, lane))
                elif res:  # foreground wrapper: it finished when the tool returned
                    done = {"type": "worker_done", "slug": slug, "lane": lane}
                    own = summary_ok(lane, slug, text)  # the wrapper's own verdict, when it printed one
                    if own is not None:
                        done["ok"] = own
                    events.append((res[0], seq, done))
        else:
            events.append((ts, seq, {"type": t}))
    return events, files, t0, last, base_of


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


def run_meta(attempt=1, attempts=1, earlier=(), plan_approval=None):
    """Validated run metadata: which attempt this was and what happened before. Raises ValidationError."""
    if not (isinstance(attempt, int) and isinstance(attempts, int) and 1 <= attempt <= attempts <= 20):
        raise ValidationError(f"need 1 <= attempt <= attempts <= 20, got {attempt} of {attempts}")
    earlier = list(earlier)
    if len(earlier) > MAX_EARLIER:
        raise ValidationError(f"at most {MAX_EARLIER} earlier-attempt notes")
    for note in earlier:
        if not isinstance(note, str) or not note.strip() or len(note) > MAX_EARLIER_LEN or re.search(r"[/\\]|[\x00-\x1f]", note):
            raise ValidationError(f"earlier-attempt note must be 1-{MAX_EARLIER_LEN} plain characters with no path: {note[:30]!r}")
    if plan_approval is not None and plan_approval not in PLAN_APPROVALS:
        raise ValidationError(f"plan approval must be one of {PLAN_APPROVALS}")
    meta = {"attempt": attempt, "attempts": attempts, "earlier_attempts": earlier}
    if attempts > 1:
        meta["attempt_label"] = f"Run {attempt} of {attempts}"
    if plan_approval:
        meta["plan_approval"] = plan_approval
    return meta


def export(compare, case, variant, repeat, results_dir, meta=None):
    if case not in CASES:
        raise ValidationError(f"unknown case: {case}")
    meta = run_meta() if meta is None else meta
    run, rec = find_run(compare, case, variant, repeat, results_dir)
    if rec["variant"] not in bench.VARIANT_ORDER:
        raise ValidationError(f"unknown variant: {rec['variant']}")
    if not bench.MODEL_RE.fullmatch(rec.get("model") or ""):
        raise ValidationError(f"weird model string: {rec.get('model')}")
    path = bench.raw_path(run, results_dir)
    if not path:
        raise SystemExit("transcript missing; cannot build events")
    with open(path, encoding="utf8", errors="replace") as f:
        lines = [j for j in (json.loads(l) if l.strip().startswith("{") else None for l in f) if j]
    events, files, t0, last, base_of = parse_events(lines)
    evs = build_events(events, t0, last, rec["verify_ok"])
    order = [e["slug"] for e in evs if e["type"] == "dispatch" and e.get("slug")]
    workers = []
    for w in sorted(run.get("workers") or [], key=lambda w: order.index(w["slug"]) if w.get("slug") in order else 99):
        if not SLUG.match(w.get("slug") or "") or w.get("cli") not in LANES:
            continue
        record_files = set()
        for key in ("files", "changed_files", "touched_files", "file_list"):
            value = w.get(key)
            if isinstance(value, list):
                record_files.update(str(item) for item in value)
        allowed = sorted({f for f in files.get(w["slug"], [])
                         if os.path.splitext(os.path.basename(f))[0] == w["slug"]
                         or f in record_files
                         or os.path.basename(f) in record_files})
        # ok = the worker's own self-check as recorded by its wrapper (a denied command makes it false); it says
        # nothing about whether the code was right. lane = the final lane the wrapper recorded.
        workers.append({"slug": w["slug"], "lane": w["cli"], "ok": bool(w.get("ok")), "tokens": int(w.get("tokens") or 0),
                        "denied_count": len(w.get("denied") or []), "files": allowed})
    real_slugs = {w["slug"] for w in workers}
    # Branches merged that no original worker owns (a fixer started on top of a worker branch, a review-fix pass).
    # They keep their own dispatch/resume/done/merge events, marked extra; anything else foreign is dropped.
    extra_slugs = {e["slug"] for e in evs if e["type"] == "merge" and e.get("slug") and e["slug"] not in real_slugs}
    kept = []
    for e in evs:
        s = e.get("slug") if isinstance(e, dict) else None
        if isinstance(s, str) and s not in real_slugs:
            if s not in extra_slugs or e["type"] not in ("dispatch", "resume", "worker_done", "merge"):
                continue
            e["extra"] = True
        kept.append(e)
    evs = kept
    for e in evs:  # a fixer's base branch is the original worker it was stacked on
        if e.get("extra") and e["type"] == "dispatch" and base_of.get(e["slug"]) in real_slugs:
            e["base"] = base_of[e["slug"]]
    for i, e in enumerate(evs):
        e["order"] = i
    # the wrapper's result file is overwritten by a resume, so the last verdict per worker is the recorded one
    final = {w["slug"]: w["ok"] for w in workers}
    last_done = {}
    for e in evs:
        if e["type"] == "worker_done" and not e.get("extra"):
            last_done[e["slug"]] = e
    for slug, e in last_done.items():
        e["ok"] = final[slug]
    bases = {e["slug"]: e["base"] for e in evs if e["type"] == "dispatch" and e.get("base")}
    merged_extra = {e["slug"] for e in evs if e["type"] == "merge" and e.get("extra")}
    for w in workers:
        slug = w["slug"]
        tried = list(dict.fromkeys(e["lane"] for e in evs if e["type"] == "dispatch" and e.get("slug") == slug and e.get("lane")))
        w["lanes_tried"] = tried if w["lane"] in tried else tried + [w["lane"]]
        w["resumes"] = sum(1 for e in evs if e["type"] == "resume" and e.get("slug") == slug)
        w["merged"] = any(e["type"] == "merge" and e.get("slug") == slug for e in evs)
        via = [x for x in merged_extra if bases.get(x) == slug]
        if not w["merged"] and via:
            w["merged"], w["merged_via"] = True, via[0]
    out = {
        "label": "One real run, not a median",
        "task": TITLES[case][:90],
        "case": case, "variant": rec["variant"], "model": rec["model"],
        "cost_usd": round(rec["cost"], 4), "wall_s": round(rec["wall"], 1), "duration_s": round(rec["duration"], 1),
        "turns": rec["turns"], "verify_ok": rec["verify_ok"],
        "worker_tokens": {k: int(v) for k, v in (run.get("worker_tokens") or {}).items() if k in LANES},
        "lanes": list(dict.fromkeys(w["lane"] for w in workers)),
        **meta,
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
    ap.add_argument("--attempt", type=int, default=1, help="which attempt of the showcase this run was")
    ap.add_argument("--attempts", type=int, default=1, help="how many attempts the showcase took in total")
    ap.add_argument("--earlier", action="append", default=[], metavar="NOTE",
                    help=f"what happened in an earlier attempt (repeatable; <= {MAX_EARLIER_LEN} chars, no paths)")
    ap.add_argument("--plan-approval", choices=PLAN_APPROVALS, default=None, help="who approved the plan")
    ap.add_argument("--out", default=None, help="write the JSON to PATH atomically")
    a = ap.parse_args()
    try:
        meta = run_meta(a.attempt, a.attempts, a.earlier, a.plan_approval)
        out = export(a.compare, a.case, a.variant, a.repeat, os.path.dirname(os.path.abspath(a.compare)), meta)
    except PrivacyError as e:
        sys.exit(f"privacy check failed: {e}")
    except ValidationError as e:
        sys.exit(f"export failed: {e}")
    text = json.dumps(out, indent=2, ensure_ascii=False) + "\n"
    if a.out:
        out_dir = os.path.dirname(os.path.abspath(a.out))
        os.makedirs(out_dir, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=out_dir)
        try:
            with os.fdopen(fd, "w", encoding="utf8") as f:
                f.write(text)
            os.replace(tmp, a.out)
        except Exception:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
    else:
        sys.stdout.write(text)


if __name__ == "__main__":
    main()
