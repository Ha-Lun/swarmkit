import json, os, sys
from datetime import datetime, timezone

try:
    d = json.load(sys.stdin)
except json.JSONDecodeError:
    sys.exit(0)

root = os.environ.get("CLAUDE_PROJECT_DIR", os.getcwd())
os.makedirs(f"{root}/.buildlog", exist_ok=True)
entry = {
    "ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    "session_id": d.get("session_id"),
    "agent_id": d.get("agent_id"),
    "agent_type": d.get("agent_type"),
    "summary": (d.get("last_assistant_message") or "")[:200],
}
with open(f"{root}/.buildlog/dispatch.jsonl", "a") as f:
    f.write(json.dumps(entry) + "\n")
