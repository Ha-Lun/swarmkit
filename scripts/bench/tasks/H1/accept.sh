. "$TASK_DIR/../_lib.sh"
svc_tests
[ "$(svc_test_count)" -gt 5 ] || fail "no new tests"
grep -q '/files' svc/docs/API.md || fail "endpoint not documented"
cd svc && python3 - <<'PY' || fail "endpoint behaviour"
import os, sys, shutil
sys.path.insert(0, '.')
import app, store
db = store.connect(); store.migrate(db)
def get(name=None):
    q = {} if name is None else {'name': name}
    return app.handle('GET', '/files', q, None, db)
s, b = get('hello.txt'); assert s == 200 and b['name'] == 'hello.txt' and 'hello from exports' in b['content'], (s, b)
assert get()[0] == 400, get()
assert get('nope.txt')[0] == 404
secret = open('app.py').read()[:60]
host = open('/etc/hostname').read().strip() if os.path.exists('/etc/hostname') else 'zzz-no-host'
os.symlink(os.path.abspath('app.py'), 'exports/_link.txt')
try:
    for name in ['../app.py', '..\\app.py', '/etc/hostname', os.path.abspath('app.py'), 'exports/../app.py', 'a/../../app.py', '%2e%2e/app.py', '..%2fapp.py', 'hello.txt\x00.png', '_link.txt', './../store.py']:
        s, b = get(name)
        assert s in (400, 403, 404), (name, s)
        text = str(b)
        assert secret not in text and host not in text and 'def create_user' not in text, ('leaked', name)
finally:
    os.unlink('exports/_link.txt')
PY
