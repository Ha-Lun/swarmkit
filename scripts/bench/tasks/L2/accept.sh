. "$TASK_DIR/../_lib.sh"
svc_tests
[ "$(svc_test_count)" -ge 8 ] || fail "too few new tests"
grep -q 'import' svc/docs/API.md || fail "endpoint not documented"
cd svc && python3 - <<'PY' || fail "behaviour"
import sys
sys.path.insert(0, '.')
import app, store
db = store.connect(); store.migrate(db)
H = app.handle
imp = lambda users: H('POST', '/users/import', {}, users, db)
count = lambda: db.execute('SELECT COUNT(*) FROM users').fetchone()[0]
u = lambda i, e=None: {'name': 'N%d' % i, 'email': e or 'u%d@example.com' % i}
s, b = imp({'users': [u(1), u(2), u(3)]}); assert s == 201 and [x['email'] for x in b['users']] == ['u1@example.com', 'u2@example.com', 'u3@example.com'] and count() == 3, (s, b)
s, b = imp({'users': [u(4), u(5), {'name': 'bad', 'email': 'nope'}]}); assert s == 400 and b['errors'][0]['index'] == 2 and count() == 3, (s, b)
s, b = imp({'users': [u(6), u(7, 'Dup@example.com'), u(8, 'dup@EXAMPLE.com')]}); assert s == 409 and b['errors'][0]['index'] == 2 and count() == 3, (s, b)
s, b = imp({'users': [u(9), u(10, 'U1@example.com')]}); assert s == 409 and b['errors'][0]['index'] == 1 and count() == 3, ('clash with existing', s, b)
s, b = imp({'users': [u(i) for i in range(100, 201)]}); assert s == 413 and count() == 3, (s, count())
s, b = imp({'users': [u(i) for i in range(100, 200)]}); assert s == 201 and count() == 103, (s, count())
for bad in ({'users': []}, {}, {'users': 'x'}, {'users': ['x']}, {'users': [None]}, None, [1]):
    s, b = imp(bad); assert s == 400, (bad, s, b)
assert count() == 103
assert H('POST', '/users', {}, {'name': 'Z', 'email': 'z@example.com'}, db)[0] == 201
PY
