python3 - <<'PY'
p = 'claude/hooks/guard.py'
s = open(p).read()
s = s.replace("    elif agent_name == 'test-writer':", """    elif agent_name == 'junior-dev':
        if tool_name == 'Bash' and any(x in cmd for x in ('rm -rf', 'git push --force', 'git push -f')):
            print(f"Command not allowed for {agent_name}: {cmd}", file=sys.stderr)
            sys.exit(2)

    elif agent_name == 'test-writer':""", 1)
open(p, 'w').write(s)
p = 'core/agents/junior-dev.md'
s = open(p).read()
s = s.replace("\n---\n", """
claude:
  hooks:
    PreToolUse:
    - matcher: Bash
      hooks:
      - type: command
        command: python3 ~/.claude/hooks/guard.py junior-dev
---
""", 1)
open(p, 'w').write(s)
PY
python3 scripts/build.py >/dev/null
