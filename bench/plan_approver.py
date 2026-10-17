#!/usr/bin/env python3
"""Minimal MCP stdio server used as `claude --permission-prompt-tool` by `compare.py --showcase`.

In a headless `claude -p` run, EnterPlanMode/ExitPlanMode/AskUserQuestion only exist when a permission prompt
tool is configured, and ExitPlanMode asks for approval through it. No human is present, so this server answers:
  ExitPlanMode     -> allow (automatic approval; the plan itself is unchanged)
  anything else    -> deny, telling the model nobody can answer
Every request and answer is appended as one JSON line to $PLAN_APPROVER_LOG, so a run can state exactly what
was approved. Stdlib only.
"""
import json, os, sys, time

LOG = os.environ.get("PLAN_APPROVER_LOG")
TOOL = {"name": "approve", "description": "Auto-answer a permission prompt in a headless run.",
        "inputSchema": {"type": "object", "properties": {"tool_name": {"type": "string"}, "input": {"type": "object"},
                                                          "tool_use_id": {"type": "string"}},
                        "required": ["tool_name", "input"]}}


def decide(args):
    name = args.get("tool_name")
    if name == "ExitPlanMode":
        return {"behavior": "allow", "updatedInput": args.get("input") or {}}
    return {"behavior": "deny", "message": "No human is available in this headless run, so this cannot be answered. "
                                           "Decide yourself and proceed."}


def log(args, answer):
    if LOG:
        with open(LOG, "a") as f:
            f.write(json.dumps({"t": time.time(), "tool_name": args.get("tool_name"),
                                "tool_use_id": args.get("tool_use_id"), "answer": answer["behavior"]}) + "\n")


def reply(i, result):
    sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": i, "result": result}) + "\n")
    sys.stdout.flush()


for line in sys.stdin:
    try:
        m = json.loads(line)
    except ValueError:
        continue
    method, i = m.get("method"), m.get("id")
    if i is None:
        continue
    if method == "initialize":
        reply(i, {"protocolVersion": (m.get("params") or {}).get("protocolVersion", "2024-11-05"),
                  "capabilities": {"tools": {}}, "serverInfo": {"name": "plan-approver", "version": "1"}})
    elif method == "tools/list":
        reply(i, {"tools": [TOOL]})
    elif method == "tools/call":
        args = (m.get("params") or {}).get("arguments") or {}
        answer = decide(args)
        log(args, answer)
        reply(i, {"content": [{"type": "text", "text": json.dumps(answer)}]})
    else:
        sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": i, "error": {"code": -32601, "message": "unsupported"}}) + "\n")
        sys.stdout.flush()
