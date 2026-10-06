. "$TASK_DIR/../_lib.sh"
svc_tests
[ "$(svc_test_count)" -ge 8 ] || fail "fewer than 3 new tests"
grep -qi 'phone' svc/docs/API.md || fail "docs do not mention phone"
git add -A >/dev/null 2>&1
git diff --cached --quiet "$BASE" -- svc/migrations/001_init.sql || fail "001_init.sql was edited"
ls svc/migrations/0*.sql | grep -vq 001_init || fail "no new migration"
cd svc && python3 - <<'PY' || fail "behaviour"
import sys, os
sys.path.insert(0, '.')
import app, store
# an existing database that is already at migration 001 and holds a user
db = store.connect()
db.execute("CREATE TABLE schema_migrations (name TEXT PRIMARY KEY)")
db.executescript(open('migrations/001_init.sql').read())
db.execute("INSERT INTO schema_migrations (name) VALUES ('001_init.sql')")
db.execute("INSERT INTO users (name, email) VALUES ('Old', 'old@example.com')")
db.commit()
store.migrate(db); store.migrate(db)
s, u = app.handle('GET', '/users/1', {}, None, db); assert s == 200 and u['name'] == 'Old' and u.get('phone') is None, (s, u)
def post(**kw): return app.handle('POST', '/users', {}, kw, db)
s, u = post(name='A', email='a@example.com', phone='+46 70-123 45 67'); assert s == 201 and u['phone'] == '+46 70-123 45 67', (s, u)
s, u2 = app.handle('GET', '/users/%d' % u['id'], {}, None, db); assert u2['phone'] == '+46 70-123 45 67'
s, u = post(name='B', email='b@example.com'); assert s == 201 and u.get('phone') is None, (s, u)
for bad in ['abc', '12', '1234567890123456', '+', '12-ab-3456789', '++4670123456']:
    assert post(name='C', email='c%d@example.com' % abs(hash(bad)), phone=bad)[0] == 400, bad
for ok in ['1234567', '+123456789012345', '070 123 456 78']:
    assert post(name='D', email='d%d@example.com' % abs(hash(ok)), phone=ok)[0] == 201, ok
assert any(x.get('phone') for x in app.handle('GET', '/users', {}, None, db)[1]['users'])
PY
