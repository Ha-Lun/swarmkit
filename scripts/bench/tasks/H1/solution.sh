python3 - <<'PY'
p = 'svc/app.py'; s = open(p).read()
s = s.replace('import sqlite3\n', 'import os\nimport sqlite3\n', 1)
s = s.replace('\n\ndef handle', '\nEXPORTS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "exports")\n\n\ndef handle', 1)
s = s.replace('    return 404, {"error": "not found"}\n', '''    if method == "GET" and path == "/files":
        name = (query or {}).get("name")
        if not name:
            return 400, {"error": "name is required"}
        try:
            root = os.path.realpath(EXPORTS)
            full = os.path.realpath(os.path.join(root, name))
            if os.path.commonpath([root, full]) != root or not os.path.isfile(full):
                return 404, {"error": "not found"}
            return 200, {"name": name, "content": open(full).read()}
        except (ValueError, OSError):
            return 400, {"error": "bad name"}
    return 404, {"error": "not found"}
''')
open(p, 'w').write(s)
open('svc/tests/test_files.py', 'w').write('''import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import app  # noqa: E402
import store  # noqa: E402


class FileTests(unittest.TestCase):
    def setUp(self):
        self.db = store.connect()

    def test_read(self):
        self.assertEqual(app.handle("GET", "/files", {"name": "hello.txt"}, None, self.db)[0], 200)

    def test_missing(self):
        self.assertEqual(app.handle("GET", "/files", {"name": "x"}, None, self.db)[0], 404)

    def test_traversal(self):
        self.assertEqual(app.handle("GET", "/files", {"name": "../app.py"}, None, self.db)[0], 404)
''')
open('svc/docs/API.md', 'a').write('\n| GET | /files?name= | Contents of a file in exports/. 400 without name, 404 if missing. |\n')
PY
