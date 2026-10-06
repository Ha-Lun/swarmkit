cat > svc/migrations/002_soft_delete.sql <<'SQL'
CREATE TABLE users_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  deleted_at TEXT
);
INSERT INTO users_new (id, name, email) SELECT id, name, email FROM users;
DROP TABLE users;
ALTER TABLE users_new RENAME TO users;
CREATE UNIQUE INDEX users_email_active ON users (email) WHERE deleted_at IS NULL;
SQL
python3 - <<'PY'
p = 'svc/store.py'; s = open(p).read()
s = s.replace('"SELECT * FROM users WHERE id = ?"', '"SELECT * FROM users WHERE id = ? AND deleted_at IS NULL"')
s = s.replace('"SELECT * FROM users ORDER BY id"', '"SELECT * FROM users WHERE deleted_at IS NULL ORDER BY id"')
s += '''

def delete_user(db, user_id):
    cur = db.execute("UPDATE users SET deleted_at = datetime('now') WHERE id = ? AND deleted_at IS NULL", (user_id,))
    db.commit()
    return cur.rowcount == 1
'''
open(p, 'w').write(s)
p = 'svc/app.py'; s = open(p).read()
s = s.replace('    if method == "POST" and path == "/users":', '''    if method == "DELETE" and path.startswith("/users/"):
        uid = path.split("/")[2]
        if uid.isdigit() and store.delete_user(db, int(uid)):
            return 200, {"deleted": int(uid)}
        return 404, {"error": "not found"}
    if method == "POST" and path == "/users":''', 1)
open(p, 'w').write(s)
open('svc/docs/API.md', 'a').write('\n`DELETE /users/<id>` soft-deletes a user (200 `{"deleted": id}`, 404 if unknown or already deleted). A deleted user is hidden from the user endpoints and its email can be registered again.\n')
open('svc/tests/test_delete.py', 'w').write('''import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import app  # noqa: E402
import store  # noqa: E402


class DeleteTests(unittest.TestCase):
    def setUp(self):
        self.db = store.connect()
        store.migrate(self.db)
        self.uid = app.handle("POST", "/users", {}, {"name": "A", "email": "a@example.com"}, self.db)[1]["id"]

    def test_delete_hides_user(self):
        self.assertEqual(app.handle("DELETE", "/users/%d" % self.uid, {}, None, self.db), (200, {"deleted": self.uid}))
        self.assertEqual(app.handle("GET", "/users/%d" % self.uid, {}, None, self.db)[0], 404)
        self.assertEqual(app.handle("GET", "/users", {}, None, self.db)[1]["users"], [])

    def test_delete_twice_and_unknown(self):
        app.handle("DELETE", "/users/%d" % self.uid, {}, None, self.db)
        self.assertEqual(app.handle("DELETE", "/users/%d" % self.uid, {}, None, self.db)[0], 404)
        self.assertEqual(app.handle("DELETE", "/users/999", {}, None, self.db)[0], 404)

    def test_email_reuse(self):
        app.handle("DELETE", "/users/%d" % self.uid, {}, None, self.db)
        self.assertEqual(app.handle("POST", "/users", {}, {"name": "B", "email": "a@example.com"}, self.db)[0], 201)
        self.assertEqual(app.handle("POST", "/users", {}, {"name": "C", "email": "a@example.com"}, self.db)[0], 409)
''')
PY
