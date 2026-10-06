"""SQLite storage for the user service."""
import glob
import os
import sqlite3

MIGRATIONS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "migrations")


def connect(path=":memory:"):
    db = sqlite3.connect(path)
    db.row_factory = sqlite3.Row
    return db


def migrate(db):
    """Apply every migrations/NNN_*.sql that has not been applied yet, in order."""
    db.execute("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY)")
    done = {r["name"] for r in db.execute("SELECT name FROM schema_migrations")}
    for path in sorted(glob.glob(os.path.join(MIGRATIONS, "*.sql"))):
        name = os.path.basename(path)
        if name in done:
            continue
        db.executescript(open(path).read())
        db.execute("INSERT INTO schema_migrations (name) VALUES (?)", (name,))
    db.commit()


def create_user(db, name, email):
    cur = db.execute("INSERT INTO users (name, email) VALUES (?, ?)", (name, email))
    db.commit()
    return get_user(db, cur.lastrowid)


def get_user(db, user_id):
    row = db.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    return dict(row) if row else None


def list_users(db):
    return [dict(r) for r in db.execute("SELECT * FROM users ORDER BY id")]
