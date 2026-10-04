import sys
import json
import shlex

READ_ONLY = [('git', 'diff'), ('git', 'log'), ('git', 'show'), ('git', 'status'),
             ('grep',), ('rg',), ('find',), ('cat',), ('ls',), ('head',), ('tail',), ('wc',)]

ALLOWED = {
    'code-proofreader': READ_ONLY,
    'security-auditor': READ_ONLY,
    'release-tester': [
        ('git', 'status'), ('git', 'diff'), ('ls',), ('cat',),
        ('npm',), ('npx',), ('pnpm',), ('yarn',), ('bun',),
        ('pytest',), ('python', '-m', 'pytest'), ('python3', '-m', 'pytest'),
        ('cargo', 'test'), ('cargo', 'check'), ('cargo', 'clippy'), ('cargo', 'build'),
        ('go', 'test'), ('go', 'vet'), ('go', 'build'),
        ('tsc',), ('eslint',), ('prettier', '--check'), ('ruff',), ('mypy',),
        ('make', 'test'), ('make', 'lint'), ('make', 'build'), ('make', 'check'),
    ],
}

# Flags that make an allowed read-only command write files or run other programs.
FORBIDDEN_ARGS = {
    'find': ('-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprint0', '-fprintf', '-fls'),
    'rg': ('--pre',),
    'git': ('--output', '--ext-diff'),
}


def segments(cmd):
    """Split a command into word lists on ; && || | & and newlines.

    Raises ValueError on command substitution, subshells or redirection to a file.
    """
    if '`' in cmd or '$(' in cmd:
        raise ValueError('command substitution')
    lex = shlex.shlex(cmd.replace('\n', ' ; '), posix=True, punctuation_chars=True)
    lex.whitespace_split = True
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
    if segs and segs[0][0] == 'cd' and len(segs[0]) == 2:
        segs = segs[1:]
    return segs


def allowed(words, allow):
    if not any(tuple(words[:len(a)]) == a for a in allow):
        return False
    bad = FORBIDDEN_ARGS.get(words[0], ())
    return not any(w.split('=')[0] in bad for w in words[1:])


def check_command(agent_name, cmd):
    allow = ALLOWED[agent_name]
    try:
        segs = segments(cmd)
    except ValueError as e:
        return f"Command not allowed for {agent_name} ({e}): {cmd}"
    for words in segs:
        if not allowed(words, allow):
            return f"Command not allowed for {agent_name}: {' '.join(words)}"
    return None


def main():
    if len(sys.argv) < 2:
        sys.exit(0)
    agent_name = sys.argv[1]

    try:
        data = json.load(sys.stdin)
    except json.JSONDecodeError:
        sys.exit(0)

    tool_name = data.get('tool_name') or data.get('tool', '')
    if not tool_name:
        sys.exit(0)

    params = data.get('tool_input') or data.get('params') or {}
    cmd = params.get('command') or params.get('cmd') or ''
    path = params.get('file_path') or params.get('path') or params.get('file') or ''

    if agent_name in ALLOWED:
        if tool_name == 'Bash':
            error = check_command(agent_name, cmd)
            if error:
                print(error, file=sys.stderr)
                sys.exit(2)

    elif agent_name == 'test-writer':
        if tool_name in ['Edit', 'Write']:
            if 'test' not in path.lower() and 'spec' not in path.lower():
                print(f"test-writer can only modify test files: {path}", file=sys.stderr)
                sys.exit(2)

    elif agent_name == 'git-specialist':
        if tool_name in ['Edit', 'Write']:
            if not path.endswith('.gitignore'):
                print(f"git-specialist can only modify .gitignore: {path}", file=sys.stderr)
                sys.exit(2)

    sys.exit(0)

if __name__ == '__main__':
    main()
