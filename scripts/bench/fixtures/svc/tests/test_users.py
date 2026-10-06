import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import app  # noqa: E402
import store  # noqa: E402


class UserTests(unittest.TestCase):
    def setUp(self):
        self.db = store.connect()
        store.migrate(self.db)

    def test_create_and_get(self):
        status, user = app.handle("POST", "/users", {}, {"name": "Ada", "email": "ada@example.com"}, self.db)
        self.assertEqual(status, 201)
        status, got = app.handle("GET", "/users/%d" % user["id"], {}, None, self.db)
        self.assertEqual((status, got["email"]), (200, "ada@example.com"))

    def test_invalid(self):
        status, body = app.handle("POST", "/users", {}, {"name": "", "email": "nope"}, self.db)
        self.assertEqual(status, 400)
        self.assertEqual(len(body["errors"]), 2)

    def test_duplicate_email(self):
        app.handle("POST", "/users", {}, {"name": "Ada", "email": "ada@example.com"}, self.db)
        status, _ = app.handle("POST", "/users", {}, {"name": "Ada 2", "email": "ada@example.com"}, self.db)
        self.assertEqual(status, 409)

    def test_list(self):
        app.handle("POST", "/users", {}, {"name": "A", "email": "a@example.com"}, self.db)
        app.handle("POST", "/users", {}, {"name": "B", "email": "b@example.com"}, self.db)
        status, body = app.handle("GET", "/users", {}, None, self.db)
        self.assertEqual([u["name"] for u in body["users"]], ["A", "B"])


if __name__ == "__main__":
    unittest.main()
