python3 - <<'PY'
p = 'scripts/build.py'
s = open(p).read()
s = s.replace("import shutil\n", "import shutil\nimport subprocess\nimport sys\n", 1)
s = s.replace("def main():\n    for d in", """def main():
    if '--check' in sys.argv:
        import tempfile
        tmp = tempfile.mkdtemp()
        subprocess.run(['git', 'worktree', 'add', '--detach', tmp], cwd=ROOT, check=True, capture_output=True)
        try:
            return check(tmp)
        finally:
            subprocess.run(['git', 'worktree', 'remove', '--force', tmp], cwd=ROOT, capture_output=True)
    for d in""", 1)
s = s.replace("if __name__ == '__main__':\n    main()", '''def check(tmp):
    # Build into a throwaway copy of the sources and compare with the working tree.
    for d in ('core', 'claude', 'opencode', 'antigravity', 'scripts'):
        shutil.rmtree(os.path.join(tmp, d), ignore_errors=True)
        shutil.copytree(os.path.join(ROOT, d), os.path.join(tmp, d))
    subprocess.run([sys.executable, os.path.join(tmp, 'scripts/build.py')], check=True, capture_output=True)
    stale = []
    for d in ('claude', 'opencode', 'antigravity'):
        a, b = os.path.join(ROOT, d), os.path.join(tmp, d)
        names = {os.path.relpath(os.path.join(r, f), b) for r, _, fs in os.walk(b) for f in fs}
        names |= {os.path.relpath(os.path.join(r, f), a) for r, _, fs in os.walk(a) for f in fs}
        for n in sorted(names):
            pa, pb = os.path.join(a, n), os.path.join(b, n)
            if not (os.path.exists(pa) and os.path.exists(pb) and open(pa, 'rb').read() == open(pb, 'rb').read()):
                stale.append(os.path.join(d, n))
    for s in stale:
        print('stale:', s)
    return 1 if stale else 0


if __name__ == '__main__':
    sys.exit(main())''')
open(p, 'w').write(s)
PY
