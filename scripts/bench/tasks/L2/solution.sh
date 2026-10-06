python3 - <<'PY'
p = 'svc/store.py'; s = open(p).read()
s += '''

def create_users(db, rows):
    """Insert all rows in one transaction; either every row is created or none."""
    try:
        ids = [db.execute("INSERT INTO users (name, email) VALUES (?, ?)", r).lastrowid for r in rows]
        db.commit()
    except Exception:
        db.rollback()
        raise
    return [get_user(db, i) for i in ids]
'''
open(p, 'w').write(s)
p = 'svc/app.py'; s = open(p).read()
s = s.replace('    if method == "POST" and path == "/users":', '''    if method == "POST" and path == "/users/import":
        users = body.get("users") if isinstance(body, dict) else None
        if not isinstance(users, list) or not users:
            return 400, {"errors": [{"error": "users must be a non-empty list"}]}
        if len(users) > 100:
            return 413, {"error": "at most 100 users per request"}
        errs = []
        for i, u in enumerate(users):
            e = validate.validate_user(u) if isinstance(u, dict) else ["entry must be an object"]
            if e:
                errs.append({"index": i, "errors": e})
        if errs:
            return 400, {"errors": errs}
        seen = {r["email"].lower() for r in db.execute("SELECT email FROM users")}
        dups = []
        for i, u in enumerate(users):
            if u["email"].lower() in seen:
                dups.append({"index": i, "error": "email already registered"})
            seen.add(u["email"].lower())
        if dups:
            return 409, {"errors": dups}
        try:
            return 201, {"users": store.create_users(db, [(u["name"].strip(), u["email"]) for u in users])}
        except sqlite3.IntegrityError:
            return 409, {"error": "email already registered"}
    if method == "POST" and path == "/users":''', 1)
open(p, 'w').write(s)
open('svc/docs/API.md', 'a').write('\n`POST /users/import` creates up to 100 users from `{"users": [{name, email}, ...]}`, all or nothing. 201 `{"users": [...]}`; 400 with per-entry errors; 409 for duplicate emails (ignoring capitalisation, in the batch or already registered); 413 above 100 entries.\n')
open('svc/tests/test_import.py', 'w').write('''import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import app  # noqa: E402
import store  # noqa: E402


class ImportTests(unittest.TestCase):
    def setUp(self):
        self.db = store.connect()
        store.migrate(self.db)

    def imp(self, body):
        return app.handle("POST", "/users/import", {}, body, self.db)

    def count(self):
        return self.db.execute("SELECT COUNT(*) FROM users").fetchone()[0]

    def test_success(self):
        s, b = self.imp({"users": [{"name": "A", "email": "a@x.com"}, {"name": "B", "email": "b@x.com"}]})
        self.assertEqual((s, [u["email"] for u in b["users"]]), (201, ["a@x.com", "b@x.com"]))

    def test_invalid_entry_creates_nothing(self):
        s, b = self.imp({"users": [{"name": "A", "email": "a@x.com"}, {"name": "", "email": "bad"}]})
        self.assertEqual((s, b["errors"][0]["index"], self.count()), (400, 1, 0))

    def test_duplicates_ignore_case(self):
        s, b = self.imp({"users": [{"name": "A", "email": "a@x.com"}, {"name": "B", "email": "A@X.com"}]})
        self.assertEqual((s, b["errors"][0]["index"], self.count()), (409, 1, 0))

    def test_existing_email(self):
        app.handle("POST", "/users", {}, {"name": "A", "email": "A@x.com"}, self.db)
        s, _ = self.imp({"users": [{"name": "B", "email": "a@x.com"}]})
        self.assertEqual((s, self.count()), (409, 1))

    def test_limits_and_shape(self):
        self.assertEqual(self.imp({"users": [{"name": "N", "email": "u%d@x.com" % i} for i in range(101)]})[0], 413)
        for bad in ({"users": []}, {}, {"users": ["x"]}):
            self.assertEqual(self.imp(bad)[0], 400)
''')
PY
