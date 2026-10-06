import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import store  # noqa: E402


class MigrationTests(unittest.TestCase):
    def test_idempotent(self):
        db = store.connect()
        store.migrate(db)
        store.migrate(db)
        self.assertEqual(db.execute("SELECT COUNT(*) FROM schema_migrations").fetchone()[0], len(
            [f for f in os.listdir(store.MIGRATIONS) if f.endswith(".sql")]))


if __name__ == "__main__":
    unittest.main()
