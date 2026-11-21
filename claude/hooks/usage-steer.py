#!/usr/bin/env python3
"""UserPromptSubmit hook: steer work to agy/OpenCode workers as the Claude plan limit nears.

Stdlib only, run as `python3 -I`. Reads GET /api/usage from the local SwarmKit dashboard
(loopback only, fleet token from <config>/swarmkit/token) and, when the Claude 5-hour or weekly
window is at STEER% or more, adds a short note to the prompt's context. Below that, or on any
problem (dashboard down, no token, timeout, bad reply), it prints nothing and exits 0.
"""
import json
import os
import sys
import urllib.request

STEER = 70     # send delegable work to workers
HANDOFF = 90   # hand the rest of the task to a worker now
WORKER_FULL = 95
TIMEOUT = 1.5
MAX_REPLY = 256 * 1024


def config_base():
    xdg = os.environ.get("XDG_CONFIG_HOME", "")
    return xdg if os.path.isabs(xdg) else os.path.join(os.path.expanduser("~"), ".config")


def fetch_usage():
    with open(os.path.join(config_base(), "swarmkit", "token")) as f:
        token = f.read(512).strip()
    if not token:
        raise ValueError("no token")
    port = int(os.environ.get("SWARMKIT_PORT", "4317"))
    req = urllib.request.Request(f"http://127.0.0.1:{port}/api/usage", headers={"x-fleet-token": token})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(req, timeout=TIMEOUT) as res:
        return json.loads(res.read(MAX_REPLY))


def pct(limit):
    v = limit.get("utilization") if isinstance(limit, dict) else None
    return round(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def worker_lanes(report):
    """('agy', worst %) and ('OpenCode', worst %) from the plan windows the dashboard reports."""
    lanes = []
    agy = [pct(l) for l in report.get("agy", {}).get("limits") or [] if l.get("group") in ("Gemini", "Argon")]
    oc = report.get("opencode", {}).get("limits") or []
    ocp = [100 if l.get("limited") else pct(l) for l in oc]
    for name, vals in (("agy", agy), ("OpenCode", ocp)):
        vals = [v for v in vals if v is not None]
        if vals:
            lanes.append((name, max(vals)))
    return lanes


def note(report):
    claude = report.get("claude") or {}
    five, week = pct(claude.get("fiveHour")), pct(claude.get("sevenDay"))
    level = max([v for v in (five, week) if v is not None], default=None)
    if level is None or level < STEER:
        return None
    lanes = worker_lanes(report)
    full = [n for n, v in lanes if v >= WORKER_FULL]
    open_lanes = [n for n, v in lanes if v < WORKER_FULL]
    parts = [f"Claude plan usage is at {level}% (5h {five if five is not None else '?'}%, "
             f"weekly {week if week is not None else '?'}%)."]
    if level >= HANDOFF:
        parts.append("Hand the rest of this task to a worker now: write a self-contained brief and start "
                     "the worker on the lane `agy-task lane` prints. Keep your own turns to review and merge.")
    else:
        parts.append("Send all implementation, tests, surveys and second-opinion reviews to agy/opencode "
                     "workers; spend your own turns on planning, security and final review only.")
    parts.append("Batch tool calls and avoid reading large files yourself.")
    if lanes:
        parts.append("Worker plans: " + ", ".join(f"{n} {v}%" for n, v in lanes) + ".")
    if full and open_lanes:
        parts.append(f"{' and '.join(full)} is near its limit: use {' or '.join(open_lanes)}.")
    elif full:
        parts.append("Both worker lanes are near their limits: tell the user before starting large work.")
    return " ".join(parts)


def main():
    try:
        sys.stdin.read(1024 * 1024)
        text = note(fetch_usage())
    except Exception:
        return
    if text:
        print(json.dumps({"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": text}}))


if __name__ == "__main__":
    main()
