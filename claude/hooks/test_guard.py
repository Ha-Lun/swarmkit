"""Tests for guard.py's lead-dev-hybrid Bash rule. Run: python3 -I claude/hooks/test_guard.py"""
import importlib.util
import os
import unittest

HOOK = os.path.join(os.path.dirname(os.path.abspath(__file__)), "guard.py")
spec = importlib.util.spec_from_file_location("guard", HOOK)
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


def lead(cmd, agent_type=None):
    data = {"tool_name": "Bash", "tool_input": {"command": cmd}, "cwd": "/home/u/proj"}
    if agent_type:
        data["agent_type"] = agent_type
    return guard.decide("lead-dev-hybrid", data)


class LeadBash(unittest.TestCase):
    def test_allowed(self):
        for cmd in [
            "git status --short && git diff --stat",
            "git merge agy/slug && agy-task clean slug",
            "opencode-task start fix-x --base main - <<'EOF'\nWrite src/a.js so that x > 3 works; open('f','w')\nEOF",
            "npm test 2>&1 | tail -20",
            "grep -rn foo src > /dev/null; echo $?",
            "ls -la; cat package.json | head",
            "python3 -c 'import json; print(json.load(open(\"a.json\"))[\"x\"] > 2)'",
            "node -e 'console.log(1 > 0)'",
            "npm run build > /tmp/build.log 2>&1",
            "mkdir -p /tmp/scratch/x && cp a.txt /tmp/scratch/x/",
            "perl -Ilib -ne 'print if /x/' file",
            "sed -n '1,20p' src/a.js",
            "cd site && npm test",
            "rm -f /tmp/x 2>/dev/null; mkdir -p /tmp/a 2>&1",
            "git commit -q -m \"$(cat <<'EOF'\nfix: a > b\n\nCo-Authored-By: X\nEOF\n)\"",
            "timeout 5 npm test",
        ]:
            self.assertIsNone(lead(cmd), cmd)

    def test_blocked(self):
        for cmd in [
            "cat > src/a.js <<'EOF'\nconst x = 1;\nEOF",
            "echo hi >> README.md",
            "printf 'x' &> out.txt",
            "sed -i 's/a/b/' src/a.js",
            "sed -Ei 's/a/b/' src/a.js",
            "perl -pi -e 's/a/b/' x",
            "python3 - <<'EOF'\nopen('src/a.js','w').write('x')\nEOF",
            "python3 -c \"from pathlib import Path; Path('a').write_text('x')\"",
            "node -e \"require('fs').writeFileSync('a','x')\"",
            "bash -c 'echo x > src/a.js'",
            "cp a.js src/b.js",
            "rm -rf src/old",
            "git diff | tee patch.diff",
            "cd src && mv a.js b.js",
            "patch -p1 < fix.diff",
            "FOO=1 rm x",
            "env rm -rf src",
            "git ls-files | xargs rm",
            "timeout 5 cp a.js src/b.js",
            "cat <<<foo; rm src/x",
        ]:
            self.assertIsNotNone(lead(cmd), cmd)

    def test_subagent_calls_pass(self):
        # main-thread agent hooks also fire for its subagents; the lead rule is for the lead only
        self.assertIsNone(lead("cat > src/a.js <<'EOF'\nx\nEOF", agent_type="junior-dev"))

    def test_other_guards_unchanged(self):
        data = {"tool_name": "Bash", "tool_input": {"command": "rm -rf x"}, "cwd": "/tmp"}
        self.assertIsNotNone(guard.decide("code-proofreader", data))


if __name__ == "__main__":
    unittest.main()
