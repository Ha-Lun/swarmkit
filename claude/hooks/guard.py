"""PreToolUse guard for the restricted subagents (see core/agents/*.md `hooks:`).

Exit 0 allows the tool call, exit 2 blocks it. It is a speed bump, not a sandbox: a test runner can still
run any code in the project. It fails closed: an error while checking blocks the call for a guarded agent.
"""
import json
import os
import re
import shlex
import sys

READ_ONLY = [('git', 'diff'), ('git', 'log'), ('git', 'show'), ('git', 'status'),
             ('grep',), ('rg',), ('find',), ('cat',), ('ls',), ('head',), ('tail',), ('wc',)]

RUNNERS = [
    ('npm',), ('npx',), ('pnpm',), ('yarn',), ('bun',),
    ('pytest',), ('python', '-m', 'pytest'), ('python3', '-m', 'pytest'),
    ('python', '-m', 'unittest'), ('python3', '-m', 'unittest'),
    ('cargo', 'test'), ('cargo', 'check'), ('cargo', 'clippy'), ('cargo', 'build'),
    ('go', 'test'), ('go', 'vet'), ('go', 'build'),
    ('deno', 'test'), ('dotnet', 'test'), ('mvn', 'test'),
    ('tsc',), ('eslint',), ('prettier', '--check'), ('ruff',), ('mypy',),
    ('make', 'test'), ('make', 'lint'), ('make', 'build'), ('make', 'check'),
]

ALLOWED = {
    'code-proofreader': READ_ONLY,
    'security-auditor': READ_ONLY,
    'release-tester': [('git', 'status'), ('git', 'diff'), ('ls',), ('cat',)] + RUNNERS,
    'test-writer': READ_ONLY + RUNNERS,
}
PATH_RULES = ('test-writer', 'git-specialist')  # agents whose Edit/Write paths are checked
GUARDED = set(ALLOWED) | set(PATH_RULES)

# Flags that make an allowed command write files, run another program or fetch code. Matched by exact name
# (value after `=` ignored); bundled short flags (-lw) are expanded for the tools in EXPAND_SHORT.
FORBIDDEN_ARGS = {
    'find': ('-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprint0', '-fprintf', '-fls'),
    'rg': ('--pre',),
    'git': ('--output', '--ext-diff'),
    'ruff': ('--fix', '--fix-only', '--unsafe-fixes'),
    'eslint': ('--fix', '--fix-type', '-o', '--output-file', '--cache-location'),
    'prettier': ('--write', '-w', '--cache-location'),
    'pytest': ('--basetemp', '--junitxml', '--junit-xml', '--log-file', '-o', '--override-ini'),
    'tsc': ('--outFile', '--outDir', '--tsBuildInfoFile', '--declarationDir'),
    'cargo': ('--config', '-Z', '--target-dir'),
    'go': ('-exec', '-toolexec', '-vettool', '-overlay', '-o', '-coverprofile', '-cpuprofile', '-memprofile', '-trace'),
    'mypy': ('--python-executable', '--cache-dir', '--junit-xml'),
    'deno': ('--config', '--import-map'),
}
EXPAND_SHORT = {'eslint', 'prettier', 'ruff', 'pytest'}

# npm, pnpm, yarn and bun: only a bare install (no package named), `test`, or a script that exists in package.json.
# Anything else (exec, dlx, add, create, node, ...) fetches or runs code that is not the project's own.
PKG_RUNNERS = ('npm', 'pnpm', 'yarn', 'bun')
PKG_BLOCKED_FLAGS = ('--registry', '--script-shell', '--node-options', '--userconfig', '--globalconfig', '--location',
                     '--eval', '-e', '--print', '-g', '--global')
PKG_BUILTINS = {
    'exec', 'dlx', 'x', 'create', 'init', 'publish', 'add', 'link', 'remove', 'rm', 'uninstall', 'un', 'unlink',
    'update', 'upgrade', 'up', 'pkg', 'config', 'login', 'adduser', 'logout', 'token', 'owner', 'access', 'deprecate',
    'unpublish', 'dist-tag', 'cache', 'node', 'explore', 'rebuild', 'patch', 'env', 'eval', 'install-test', 'it', 'cit',
}
NPX_TOOLS = {'tsc', 'eslint', 'prettier', 'vitest', 'jest', 'mocha', 'playwright', 'vue-tsc', 'svelte-check'}
NPX_TOOL = re.compile(r'([a-z0-9._-]+)(?:@[\w.^~<>=*-]+)?')  # a version or tag, never `@npm:other-package`

# Paths a test-writer may edit: a test or spec directory, or a test file by name (*.test.*, *.spec.*,
# *_test.*, test_*, conftest.py), but never a manifest that a runner would execute.
TEST_PATH = re.compile(
    r'(^|/)(tests?|__tests__|specs?)/|(^|/)(test_[^/]*|conftest\.py)$|[._-](test|spec)\.[^/]*$', re.I)
MANIFESTS = {'package.json', 'makefile', 'justfile', 'pyproject.toml', 'setup.py', 'setup.cfg', 'tox.ini',
             'cargo.toml', 'go.mod', 'pom.xml', 'build.gradle', '.npmrc', '.yarnrc', '.yarnrc.yml', '.pnpmrc'}


def check_expansions(cmd):
    """Raise ValueError on shell syntax that changes the words after they were checked ($'exec', $x, {a,b})."""
    state, i = None, 0
    while i < len(cmd):
        c, nxt = cmd[i], cmd[i + 1:i + 2]
        if state == "'":
            state = None if c == "'" else state
        elif c == '\\':
            i += 1
        elif c == '$' and nxt and re.match(r'[{(A-Za-z_0-9@*#?!$-]' if state == '"' else r'[{(\'"A-Za-z_0-9@*#?!$-]', nxt):
            raise ValueError('shell expansion')
        elif state == '"':
            state = None if c == '"' else state
        elif c in '\'"':
            state = c
        elif c == '{':
            raise ValueError('brace expansion')
        i += 1


def segments(cmd):
    """Split a command into word lists on ; && || | & and newlines, plus the directory of a leading `cd`.

    Raises ValueError on command substitution, expansion, subshells or redirection to a file.
    """
    if '`' in cmd or '$(' in cmd:
        raise ValueError('command substitution')
    check_expansions(cmd)
    lex = shlex.shlex(cmd.replace('\n', ' ; '), posix=True, punctuation_chars=True)
    lex.whitespace_split = True
    lex.commenters = ''  # bash only starts a comment at the start of a word; shlex would drop `ls x#; rm y`
    tokens = list(lex)
    segs, cur, i = [], [], 0
    while i < len(tokens):
        t = tokens[i]
        if t and set(t) <= set('();<>|&'):
            if '(' in t or ')' in t:
                raise ValueError('subshell')
            if '>' in t or '<' in t:
                target = tokens[i + 1] if i + 1 < len(tokens) else ''
                if t.endswith('&') and target.isdigit():
                    if cur and cur[-1].isdigit():
                        cur.pop()  # the fd in 2>&1
                elif target != '/dev/null' and '>' in t:
                    raise ValueError('redirection to a file')
                i += 2
                continue
            segs.append(cur)
            cur = []
        else:
            cur.append(t)
        i += 1
    segs.append(cur)
    segs = [s for s in segs if s]
    cd = None
    if segs and segs[0][0] == 'cd' and len(segs[0]) == 2:
        cd, segs = segs[0][1], segs[1:]
    return segs, cd


def scripts(cwd):
    try:
        with open(os.path.join(cwd or '.', 'package.json')) as f:
            return set(json.load(f).get('scripts') or {})
    except (OSError, ValueError, AttributeError):
        return set()


def pkg_ok(words, cwd):
    cmd, args = words[0], words[1:]
    head = args[:args.index('--')] if '--' in args else args  # after `--` the words belong to the script
    if any(w.split('=')[0] in PKG_BLOCKED_FLAGS for w in head):
        return False
    if not head:
        return True
    sub, rest = head[0], [w for w in head[1:] if not w.startswith('-')]
    if sub.startswith('-'):
        return False  # a flag before the subcommand can hide it (--filter a add pkg)
    if sub in ('install', 'i', 'ci'):
        return not rest
    if sub in ('test', 't', 'tst'):
        return True
    if sub in ('run', 'run-script'):
        return bool(rest) and rest[0] in scripts(cwd)
    return sub not in PKG_BUILTINS and sub in scripts(cwd)


def npx_words(words):
    """[tool, *its args] for an allowed `npx tool ...`, else None. Flags before the tool can pull in another package."""
    args = words[1:]
    i = next((i for i, w in enumerate(args) if not w.startswith('-')), None)
    if i is None:
        return None
    for w in args[:i]:
        if w.split('=')[0] in PKG_BLOCKED_FLAGS + ('--package', '--call') or w[:2] in ('-p', '-c'):
            return None
    m = NPX_TOOL.fullmatch(args[i])
    return [m.group(1)] + args[i + 1:] if m and m.group(1) in NPX_TOOLS else None


def tool_ok(eff):
    name = 'pytest' if eff[0] in ('python', 'python3') and eff[1:3] == ['-m', 'pytest'] else eff[0]
    flags = {w.split('=')[0] for w in eff[1:]}
    if name in EXPAND_SHORT:
        flags |= {'-' + c for w in eff[1:] if re.fullmatch(r'-[A-Za-z]{2,}', w) for c in w[1:]}
    if flags & set(FORBIDDEN_ARGS.get(name, ())):
        return False
    if name == 'make':
        return len(eff) == 2  # a target, no -f / --eval / VAR=value
    if name == 'deno':
        return not any('://' in w for w in eff)
    if name == 'mypy':
        return not any(re.fullmatch(r'--[\w-]*-report', f) for f in flags)
    if name == 'ruff' and 'format' in eff[1:]:
        return bool({'--check', '--diff'} & flags)  # `ruff format` rewrites files unless it only checks
    return True


def allowed(words, allow, cwd):
    if not any(tuple(words[:len(a)]) == a for a in allow):
        return False
    if words[0] == 'npx':
        eff = npx_words(words)
    else:
        eff = words if words[0] not in PKG_RUNNERS or pkg_ok(words, cwd) else None
    return eff is not None and tool_ok(eff)


def check_command(agent_name, cmd, cwd=None):
    try:
        segs, cd = segments(cmd)
    except ValueError as e:
        return f"Command not allowed for {agent_name} ({e}): {cmd}"
    if cd:
        cwd = os.path.join(cwd or '.', cd)
    for words in segs:
        if not allowed(words, ALLOWED[agent_name], cwd):
            return f"Command not allowed for {agent_name}: {' '.join(words)}"
    return None


def project_root(cwd):
    d = cwd
    while d != os.path.dirname(d):
        if os.path.exists(os.path.join(d, '.git')):
            return d
        d = os.path.dirname(d)
    return cwd


def check_path(agent_name, path, cwd):
    if not cwd:
        return f"{agent_name}: the hook input has no cwd, so edits cannot be checked: {path}"
    cwd = os.path.realpath(cwd)
    rel = os.path.relpath(os.path.realpath(os.path.join(cwd, path)), project_root(cwd))
    if rel == '..' or rel.startswith('../'):
        return f"{agent_name} can only edit files inside the project: {path}"
    name = os.path.basename(rel)
    if agent_name == 'test-writer' and (not TEST_PATH.search(rel) or name.lower() in MANIFESTS):
        return f"test-writer can only modify test files: {path}"
    if agent_name == 'git-specialist' and name != '.gitignore':
        return f"git-specialist can only modify .gitignore: {path}"
    return None


def decide(agent_name, data):
    tool_name = data.get('tool_name') or data.get('tool', '')
    params = data.get('tool_input') or data.get('params') or {}
    cmd = params.get('command') or params.get('cmd') or ''
    path = params.get('file_path') or params.get('path') or params.get('file') or ''
    if tool_name == 'Bash' and agent_name in ALLOWED:
        return check_command(agent_name, cmd, data.get('cwd'))
    if tool_name in ('Edit', 'Write') and agent_name in PATH_RULES:
        return check_path(agent_name, path, data.get('cwd'))
    return None


def main():
    if len(sys.argv) < 2:
        sys.exit(0)
    agent_name = sys.argv[1]
    try:
        error = decide(agent_name, json.load(sys.stdin))
    except Exception as e:  # unexpected input or a bug: block a guarded agent rather than let the call through
        error = f"guard error for {agent_name}: {type(e).__name__}: {e}" if agent_name in GUARDED else None
    if error:
        print(error, file=sys.stderr)
        sys.exit(2)
    sys.exit(0)


if __name__ == '__main__':
    main()
