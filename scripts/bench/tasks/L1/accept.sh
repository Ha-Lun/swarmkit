. "$TASK_DIR/../_lib.sh"
svc_tests
[ "$(svc_test_count)" -ge 8 ] || fail "too few new tests"
git add -A >/dev/null 2>&1
git diff --cached --quiet "$BASE" -- svc/migrations/001_init.sql || fail "001_init.sql was edited"
grep -qi 'DELETE' svc/docs/API.md || fail "endpoint not documented"
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
H = app.handle
def post(db, e): return H('POST', '/users', {}, {'name': 'X', 'email': e}, db)
def check(db):
    s, u = post(db, 'ada@example.com'); assert s == 201, s
    uid = u['id']
    assert post(db, 'ada@example.com')[0] == 409, 'active duplicate'
    s, b = H('DELETE', '/users/%d' % uid, {}, None, db); assert (s, b) == (200, {'deleted': uid}), (s, b)
    assert uid not in [x['id'] for x in H('GET', '/users', {}, None, db)[1]['users']], 'still listed'
    assert H('GET', '/users/%d' % uid, {}, None, db)[0] == 404
    assert H('DELETE', '/users/%d' % uid, {}, None, db)[0] == 404, 'second delete'
    assert H('DELETE', '/users/99999', {}, None, db)[0] == 404, 'unknown'
    row = db.execute('SELECT deleted_at FROM users WHERE id = ?', (uid,)).fetchone()
    assert row is not None and row[0] is not None, 'row must stay with deleted_at set'
    s, u2 = post(db, 'ada@example.com'); assert s == 201 and u2['id'] != uid, 'email reuse'
    assert post(db, 'ada@example.com')[0] == 409, 'active duplicate after reuse'
db = store.connect(); store.migrate(db); store.migrate(db); check(db)
db = old_db([('Bob', 'bob@x.com'), ('Cy', 'cy@x.com')]); store.migrate(db)
ids = [(x['id'], x['email']) for x in H('GET', '/users', {}, None, db)[1]['users']]
assert ids == [(1, 'bob@x.com'), (2, 'cy@x.com')], ('existing users lost or ids changed', ids)
assert H('DELETE', '/users/1', {}, None, db)[0] == 200
assert post(db, 'bob@x.com')[0] == 201, 'reuse on migrated db'
assert post(db, 'cy@x.com')[0] == 409, 'existing active user still unique'
store.migrate(db)
db = old_db([('Bob', 'bob@x.com')]); store.migrate(db); check(db)
PY
