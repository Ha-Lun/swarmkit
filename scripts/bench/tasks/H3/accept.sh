. "$TASK_DIR/../_lib.sh"
svc_tests
[ "$(svc_test_count)" -gt 5 ] || fail "no new tests"
git add -A >/dev/null 2>&1
git diff --cached --quiet "$BASE" -- svc/migrations/001_init.sql || fail "001_init.sql was edited"
cd svc && python3 - <<'PY' || fail "behaviour"
import sys
sys.path.insert(0, '.')
import app, store
def old_db(rows):
    db = store.connect()
    db.execute("CREATE TABLE schema_migrations (name TEXT PRIMARY KEY)")
    db.executescript(open('migrations/001_init.sql').read())
    db.execute("INSERT INTO schema_migrations (name) VALUES ('001_init.sql')")
    for n, e in rows: db.execute("INSERT INTO users (name, email) VALUES (?, ?)", (n, e))
    db.commit(); return db
post = lambda db, e: app.handle('POST', '/users', {}, {'name': 'X', 'email': e}, db)[0]
db = store.connect(); store.migrate(db)
assert post(db, 'Ada@Example.com') == 201 and post(db, 'ada@example.com') == 409 and post(db, 'ADA@EXAMPLE.COM') == 409
assert post(db, 'other@example.com') == 201
db = old_db([('Carl', 'Carl@Example.com')]); store.migrate(db)
assert post(db, 'carl@example.com') == 409, 'existing mixed-case account'
db = old_db([('Bob', 'Bob@x.com'), ('Bob2', 'bob@x.com')]); store.migrate(db)   # existing duplicates must not break migrate
assert post(db, 'new@x.com') == 201
PY
