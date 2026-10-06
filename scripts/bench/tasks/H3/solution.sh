python3 - <<'PY'
p = 'svc/store.py'; s = open(p).read()
s = s.replace('def create_user(db, name, email):\n', 'def create_user(db, name, email):\n    if db.execute("SELECT 1 FROM users WHERE lower(email) = lower(?)", (email,)).fetchone():\n        raise sqlite3.IntegrityError("email already registered")\n')
open(p, 'w').write(s)
open('svc/tests/test_email_case.py', 'w').write('''import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import app  # noqa: E402
import store  # noqa: E402


class EmailCaseTests(unittest.TestCase):
    def test_case_insensitive_duplicate(self):
        db = store.connect()
        store.migrate(db)
        self.assertEqual(app.handle("POST", "/users", {}, {"name": "A", "email": "Ada@Example.com"}, db)[0], 201)
        self.assertEqual(app.handle("POST", "/users", {}, {"name": "A", "email": "ada@example.com"}, db)[0], 409)
''')
PY
