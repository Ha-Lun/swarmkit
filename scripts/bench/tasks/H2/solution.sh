python3 - <<'PY'
open('svc/migrations/002_phone.sql', 'w').write('ALTER TABLE users ADD COLUMN phone TEXT;\n')
p = 'svc/store.py'; s = open(p).read()
s = s.replace('def create_user(db, name, email):\n    cur = db.execute("INSERT INTO users (name, email) VALUES (?, ?)", (name, email))', 'def create_user(db, name, email, phone=None):\n    cur = db.execute("INSERT INTO users (name, email, phone) VALUES (?, ?, ?)", (name, email, phone))')
open(p, 'w').write(s)
p = 'svc/validate.py'; s = open(p).read()
s = s.replace('EMAIL =', 'PHONE = re.compile(r"^\\+?[0-9 -]+$")\nEMAIL =', 1)
s = s.replace('    return errors', '''    phone = payload.get("phone")
    if phone is not None:
        digits = sum(c.isdigit() for c in phone) if isinstance(phone, str) else 0
        if not isinstance(phone, str) or not PHONE.match(phone) or not 7 <= digits <= 15:
            errors.append("phone is invalid")
    return errors''')
open(p, 'w').write(s)
p = 'svc/app.py'; s = open(p).read()
s = s.replace('store.create_user(db, body["name"].strip(), body["email"])', 'store.create_user(db, body["name"].strip(), body["email"], body.get("phone"))')
open(p, 'w').write(s)
open('svc/docs/API.md', 'a').write('\nA user may also have an optional `phone` (digits, spaces, dashes, optional leading +, 7 to 15 digits). It is returned by the user endpoints.\n')
open('svc/tests/test_phone.py', 'w').write('''import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import app  # noqa: E402
import store  # noqa: E402


class PhoneTests(unittest.TestCase):
    def setUp(self):
        self.db = store.connect()
        store.migrate(self.db)

    def test_valid(self):
        s, u = app.handle("POST", "/users", {}, {"name": "A", "email": "a@example.com", "phone": "+46 70-123 45 67"}, self.db)
        self.assertEqual((s, u["phone"]), (201, "+46 70-123 45 67"))

    def test_invalid(self):
        s, _ = app.handle("POST", "/users", {}, {"name": "A", "email": "a@example.com", "phone": "abc"}, self.db)
        self.assertEqual(s, 400)

    def test_optional(self):
        s, u = app.handle("POST", "/users", {}, {"name": "A", "email": "a@example.com"}, self.db)
        self.assertEqual((s, u["phone"]), (201, None))
''')
PY
