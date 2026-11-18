// Per-project secrets: private storage, validation, project scoping, env injection and redaction.
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { SdkSessions } from '../server/sdk/sessions.ts';
import type { QueryFn } from '../server/sdk/sessions.ts';
import {
  allSecretEntries, deleteSecret, listSecrets, projectRoot, putSecret, redactAll, redactDeep, redactSecrets, redactServerEvent,
  resetSecretStateForTests, secretEnv, secretsDirPath, secretsFilePath,
} from '../server/secrets.ts';
import type { SecretEntry } from '../server/secrets.ts';
import type { ActivityEvent, ServerEvent, SessionSummary } from '../src/shared/types.ts';

const mode = (p: string): number => lstatSync(p).mode & 0o777;

let config: string;
let work: string;
let prevXdg: string | undefined;

beforeEach(() => {
  config = mkdtempSync(path.join(tmpdir(), 'fleet-secrets-config-'));
  // Projects must live inside $HOME (like session cwds), so the work dir does too.
  work = realpathSync(mkdtempSync(path.join(homedir(), 'fleet-secrets-work-')));
  prevXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = config;
  resetSecretStateForTests();
});

afterEach(() => {
  if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = prevXdg;
  rmSync(config, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

describe('storage', () => {
  it('writes a private dir and file, no temp files left', () => {
    putSecret(work, 'API_KEY', 'sk-test-123456');
    expect(secretsFilePath()).toBe(path.join(config, 'swarmkit', 'secrets.json'));
    expect(mode(secretsDirPath())).toBe(0o700);
    expect(mode(secretsFilePath())).toBe(0o600);
    expect(readdirSync(secretsDirPath())).toEqual(['secrets.json']);
    const stored = JSON.parse(readFileSync(secretsFilePath(), 'utf8'));
    expect(stored[work].API_KEY.value).toBe('sk-test-123456');
    expect(typeof stored[work].API_KEY.updatedAt).toBe('number');
  });

  it('writes 0600 even under a permissive umask', () => {
    const old = process.umask(0);
    try {
      putSecret(work, 'API_KEY', 'sk-test-123456');
    } finally {
      process.umask(old);
    }
    expect(mode(secretsFilePath())).toBe(0o600);
  });

  it('fixes a wrong file mode on read and a wrong dir mode on write', () => {
    putSecret(work, 'API_KEY', 'sk-test-123456');
    chmodSync(secretsFilePath(), 0o644);
    chmodSync(secretsDirPath(), 0o755);
    expect(listSecrets(work).names.map(n => n.name)).toEqual(['API_KEY']);
    expect(mode(secretsFilePath())).toBe(0o600);
    putSecret(work, 'OTHER_KEY', 'another-value');
    expect(mode(secretsDirPath())).toBe(0o700);
  });

  it('refuses a symlinked secrets file and a symlinked dir', () => {
    mkdirSync(path.join(config, 'swarmkit'), { mode: 0o700 });
    const target = path.join(work, 'target.json');
    writeFileSync(target, '{}');
    symlinkSync(target, secretsFilePath());
    expect(() => listSecrets(work)).toThrow();
    expect(() => putSecret(work, 'API_KEY', 'sk-test-123456')).toThrow();
    expect(readFileSync(target, 'utf8')).toBe('{}');

    rmSync(path.join(config, 'swarmkit'), { recursive: true });
    const real = path.join(work, 'realdir');
    mkdirSync(real);
    symlinkSync(real, path.join(config, 'swarmkit'));
    expect(() => putSecret(work, 'API_KEY', 'sk-test-123456')).toThrow(/plain directory/);
    expect(readdirSync(real)).toEqual([]);
  });

  it('keeps a corrupt file instead of overwriting it', () => {
    mkdirSync(path.join(config, 'swarmkit'), { mode: 0o700 });
    writeFileSync(secretsFilePath(), '{not json', { mode: 0o600 });
    expect(() => putSecret(work, 'API_KEY', 'sk-test-123456')).toThrow();
    expect(readFileSync(secretsFilePath(), 'utf8')).toBe('{not json');
    expect(secretEnv(work)).toEqual({}); // sessions still start
  });

  it('replaces, deletes and treats a missing delete as fine', () => {
    putSecret(work, 'API_KEY', 'first-value');
    putSecret(work, 'API_KEY', 'second-value');
    expect(secretEnv(work)).toEqual({ API_KEY: 'second-value', SWARMKIT_SECRET_NAMES: 'API_KEY' });
    deleteSecret(work, 'API_KEY');
    deleteSecret(work, 'API_KEY');
    expect(listSecrets(work).names).toEqual([]);
    expect(JSON.parse(readFileSync(secretsFilePath(), 'utf8'))).toEqual({});
  });
});

describe('validation', () => {
  it.each(['api_key', '1KEY', 'A-B', '', 'A'.repeat(65), 'KEY NAME', 'KÉY'])('rejects the name %j', name => {
    expect(() => putSecret(work, name, 'value-123456')).toThrow(/name/);
  });

  it.each(['PATH', 'HOME', 'PWD', 'SHELL', 'USER', 'ENV', 'BASH_ENV', 'IFS', 'TMPDIR', 'NODE_OPTIONS', 'NODE_PATH', 'PYTHONPATH', 'PYTHONSTARTUP',
    'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'SWARMKIT_ARTIFACTS_DIR', 'CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'FLEET_TOKEN', 'XDG_CONFIG_HOME',
    'OPENCODE_CONFIG', 'AGY_X', 'GIT_DIR',
    'NODE_EXTRA_CA_CERTS', 'NPM_CONFIG_REGISTRY', 'PYTHONHOME', 'PERL5OPT', 'RUBYOPT', 'BASH_FUNC_X', 'GLIBC_TUNABLES', 'MALLOC_CHECK_',
    'OPENSSL_CONF', 'SSL_CERT_FILE', 'SSH_ASKPASS', 'LC_ALL', 'JAVA_TOOL_OPTIONS', 'JDK_JAVA_OPTIONS', 'GCONV_PATH',
    'SHELLOPTS', 'PS1', 'PS2', 'PS3', 'PS4', 'PROMPT_COMMAND', 'CDPATH', 'GLOBIGNORE', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
    'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE', 'EDITOR', 'VISUAL', 'PAGER', 'MANPAGER', 'LESSOPEN', 'LESSCLOSE', 'BROWSER', 'GNUPGHOME',
    'LOCPATH', 'NLSPATH', 'HOSTALIASES', 'TERM', 'LANG', 'LANGUAGE', 'TZ'])('rejects the reserved name %s', name => {
    expect(() => putSecret(work, name, 'value-123456')).toThrow(/reserved/);
  });

  it('explains a reserved name and suggests another', () => {
    expect(() => putSecret(work, 'HTTP_PROXY', 'value-123456')).toThrow(/changes how programs run.*MY_PROXY_URL/);
  });

  it('caps the secrets per project, the bytes per project and the store size', () => {
    for (let i = 0; i < 64; i++) putSecret(work, `KEY_${i}`, `value-number-${i}`);
    expect(() => putSecret(work, 'ONE_MORE', 'value-123456')).toThrow('too many secrets');
    putSecret(work, 'KEY_0', 'replaced-value'); // replacing is not adding
    expect(listSecrets(work).names).toHaveLength(64);

    const big = path.join(work, 'big');
    mkdirSync(big);
    for (let i = 0; i < 16; i++) putSecret(big, `BIG_${i}`, 'x'.repeat(8 * 1024 - 1) + String(i % 10));
    expect(() => putSecret(big, 'BIG_16', 'y'.repeat(8 * 1024))).toThrow(/too large/);
    expect(() => putSecret(big, 'BIG_0', 'y'.repeat(8 * 1024))).not.toThrow(); // replacing within the cap is fine

    // Many projects at the per-project cap fill the 1 MB store.
    let full: unknown;
    for (let p = 0; p < 12 && !full; p++) {
      const dir = path.join(work, `fill-${p}`);
      mkdirSync(dir);
      try {
        for (let i = 0; i < 16; i++) putSecret(dir, `FILL_${i}`, `${String.fromCharCode(97 + p)}${i}`.padEnd(8 * 1024, 'z'));
      } catch (err) {
        full = err;
      }
    }
    expect((full as Error).message).toBe('secret store full');
    expect(statSync(secretsFilePath()).size).toBeLessThanOrEqual(1024 * 1024);
  });

  it('accepts a 64 character name', () => {
    putSecret(work, 'A'.repeat(64), 'value-123456');
    expect(listSecrets(work).names).toHaveLength(1);
  });

  it('limits the value: non-string, empty, NUL, over 8 KB', () => {
    expect(() => putSecret(work, 'API_KEY', 5)).toThrow(/value/);
    expect(() => putSecret(work, 'API_KEY', '')).toThrow(/value/);
    expect(() => putSecret(work, 'API_KEY', 'ab\0cdef')).toThrow(/NUL/);
    expect(() => putSecret(work, 'API_KEY', 'x'.repeat(8 * 1024 + 1))).toThrow(/too large/);
    expect(() => putSecret(work, 'API_KEY', 'é'.repeat(4097))).toThrow(/too large/); // bytes, not chars
    putSecret(work, 'API_KEY', 'x'.repeat(8 * 1024));
  });

  it('errors never echo the value', () => {
    const value = 'super-secret-value-xyz';
    for (const call of [() => putSecret(work, 'path', value), () => putSecret(work, 'PATH', value), () => putSecret('relative', 'API_KEY', value)]) {
      try {
        call();
        expect.unreachable();
      } catch (err) {
        expect((err as Error).message).not.toContain(value);
      }
    }
  });

  it('requires an absolute, existing directory for cwd', () => {
    expect(() => listSecrets('relative/dir')).toThrow(/absolute/);
    expect(() => listSecrets(undefined)).toThrow(/absolute/);
    expect(() => listSecrets(path.join(work, 'missing'))).toThrow(/existing directory/);
    const file = path.join(work, 'file.txt');
    writeFileSync(file, 'x');
    expect(() => listSecrets(file)).toThrow(/existing directory/);
  });
});

describe('project scoping', () => {
  it('maps a subdirectory of a git repo to the git root', () => {
    const repo = path.join(work, 'repo');
    mkdirSync(path.join(repo, '.git'), { recursive: true });
    mkdirSync(path.join(repo, 'packages', 'app'), { recursive: true });
    expect(projectRoot(path.join(repo, 'packages', 'app'))).toBe(repo);
    putSecret(path.join(repo, 'packages', 'app'), 'API_KEY', 'sk-test-123456');
    expect(listSecrets(repo).names.map(n => n.name)).toEqual(['API_KEY']);
    expect(secretEnv(path.join(repo, 'packages'))).toEqual({ API_KEY: 'sk-test-123456', SWARMKIT_SECRET_NAMES: 'API_KEY' });
  });

  it('treats a worktree (.git file) as its own project', () => {
    const wt = path.join(work, 'wt');
    mkdirSync(wt);
    writeFileSync(path.join(wt, '.git'), 'gitdir: /elsewhere');
    expect(projectRoot(wt)).toBe(wt);
  });

  it('uses the folder itself outside a repo and keeps projects apart', () => {
    const a = path.join(work, 'a');
    const b = path.join(work, 'b');
    mkdirSync(a);
    mkdirSync(b);
    putSecret(a, 'API_KEY', 'only-in-a-123');
    expect(listSecrets(a).project).toBe(a);
    expect(listSecrets(b).names).toEqual([]);
    expect(secretEnv(b)).toEqual({});
  });

  it('resolves a symlinked cwd to the real path', () => {
    const real = path.join(work, 'real');
    mkdirSync(real);
    const link = path.join(work, 'link');
    symlinkSync(real, link);
    putSecret(link, 'API_KEY', 'via-link-123');
    expect(listSecrets(real)).toEqual({ project: real, names: [expect.objectContaining({ name: 'API_KEY' })] });
    expect(secretEnv(link)).toEqual({ API_KEY: 'via-link-123', SWARMKIT_SECRET_NAMES: 'API_KEY' });
  });

  it('rejects a cwd outside $HOME', () => {
    const outside = realpathSync(mkdtempSync(path.join(tmpdir(), 'fleet-secrets-outside-')));
    try {
      expect(() => projectRoot(outside)).toThrow(/inside your home directory/);
      expect(() => putSecret(outside, 'API_KEY', 'sk-test-123456')).toThrow(/home directory/);
      expect(() => listSecrets(outside)).toThrow(/home directory/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('does not let a .git at $HOME widen the scope', () => {
    const prevHome = process.env.HOME;
    const fakeHome = path.join(work, 'fakehome');
    const sub = path.join(fakeHome, 'projects', 'app');
    mkdirSync(path.join(fakeHome, '.git'), { recursive: true });
    mkdirSync(sub, { recursive: true });
    process.env.HOME = fakeHome;
    try {
      expect(projectRoot(sub)).toBe(sub);
      expect(projectRoot(path.join(fakeHome, 'projects'))).toBe(path.join(fakeHome, 'projects'));
      expect(projectRoot(fakeHome)).toBe(fakeHome);
      // A repo below $HOME still scopes to its own toplevel.
      mkdirSync(path.join(sub, '.git'));
      mkdirSync(path.join(sub, 'src'));
      expect(projectRoot(path.join(sub, 'src'))).toBe(sub);
      putSecret(path.join(fakeHome, 'projects'), 'API_KEY', 'only-in-projects');
      expect(secretEnv(sub)).toEqual({});
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
    }
  });

  it('GET never returns values', () => {
    putSecret(work, 'API_KEY', 'sk-test-123456');
    putSecret(work, 'DB_URL', 'postgres://u:p@h/db');
    const listed = listSecrets(work);
    expect(listed.names.map(n => n.name)).toEqual(['API_KEY', 'DB_URL']);
    const json = JSON.stringify(listed);
    expect(json).not.toContain('sk-test-123456');
    expect(json).not.toContain('postgres');
    expect(Object.keys(listed.names[0]!).sort()).toEqual(['name', 'updatedAt']);
  });
});

describe('redaction', () => {
  const entries = (...pairs: [string, string][]): SecretEntry[] => pairs.map(([name, value]) => ({ name, value }));

  it('replaces values with [secret:NAME]', () => {
    expect(redactSecrets('curl -H "Bearer sk-test-123456" x', entries(['API_KEY', 'sk-test-123456']))).toBe('curl -H "Bearer [secret:API_KEY]" x');
    expect(redactSecrets('twice sk-test-123456 sk-test-123456', entries(['API_KEY', 'sk-test-123456']))).toBe('twice [secret:API_KEY] [secret:API_KEY]');
  });

  it('prefers the longest of overlapping values and never rescans a placeholder', () => {
    const e = entries(['SHORT', 'abcdef'], ['LONG', 'abcdefghij'], ['TRICKY', 'secret']);
    expect(redactSecrets('abcdefghij and abcdef', e)).toBe('[secret:LONG] and [secret:SHORT]');
    // A value that is part of the placeholder text must not corrupt earlier replacements.
    expect(redactSecrets('abcdef secret', e)).toBe('[secret:SHORT] [secret:TRICKY]');
  });

  it('skips values shorter than 6 characters and handles regex characters', () => {
    expect(redactSecrets('pin 12345 here', entries(['PIN', '12345']))).toBe('pin 12345 here');
    expect(redactSecrets('a.b*c+(d) ok', entries(['ODD', 'a.b*c+(d)']))).toBe('[secret:ODD] ok');
    expect(redactSecrets('axb*c+(d)', entries(['ODD', 'a.b*c+(d)']))).toBe('axb*c+(d)');
  });

  it('skips values with fewer than 4 distinct characters', () => {
    expect(redactSecrets('x aaaaaaaaaa y', entries(['FLAT', 'aaaaaaaaaa']))).toBe('x aaaaaaaaaa y');
    expect(redactSecrets('x 0101010101 y', entries(['BIN', '0101010101']))).toBe('x 0101010101 y');
    expect(redactSecrets('x abcdabcdab y', entries(['OK', 'abcdabcdab']))).toBe('x [secret:OK] y');
  });

  it('also catches the JSON-escaped form of a value', () => {
    const value = 'line1\nquote"end';
    const text = JSON.stringify({ command: `echo ${value}` });
    expect(redactSecrets(text, entries(['ODD', value]))).toBe('{"command":"echo [secret:ODD]"}');
  });

  it('walks nested objects and arrays, copying only what changed', () => {
    const e = entries(['TOKEN', 'tok-abcdef-123']);
    const untouched = { a: [1, 'plain'], b: { c: null } };
    const input = { ...untouched, d: [{ text: 'got tok-abcdef-123!' }], e: { f: { g: 'tok-abcdef-123' } } };
    const out = redactDeep(input, e);
    expect(out).toEqual({ ...untouched, d: [{ text: 'got [secret:TOKEN]!' }], e: { f: { g: '[secret:TOKEN]' } } });
    expect(out.a).toBe(input.a);
    expect(input.d[0]!.text).toBe('got tok-abcdef-123!'); // input untouched
    expect(redactDeep(untouched, e)).toBe(untouched);
    expect(redactDeep(input, [])).toBe(input);
  });

  it('redacts object keys too, rebuilding only the object whose key changed', () => {
    const e = entries(['TOKEN', 'tok-abcdef-123']);
    const clean = { a: 1 };
    const input = { clean, ['key-tok-abcdef-123']: 'v', other: 'w', nested: [{ ['tok-abcdef-123']: { deep: 1 } }] };
    const out = redactDeep(input, e);
    expect(out).toEqual({ clean, 'key-[secret:TOKEN]': 'v', other: 'w', nested: [{ '[secret:TOKEN]': { deep: 1 } }] });
    expect(out.clean).toBe(clean);
    expect(Object.keys(input)).toContain('key-tok-abcdef-123'); // input untouched
    const proto = JSON.parse('{"__proto__":"tok-abcdef-123"}');
    const redacted = redactDeep(proto, e) as Record<string, unknown>;
    expect(Object.getPrototypeOf(redacted)).toBe(Object.prototype);
    expect(Object.keys(redacted)).toEqual(['__proto__']);
  });

  describe('events', () => {
    const projectA = path.join(homedir(), 'proj-a');
    const projectB = path.join(homedir(), 'proj-b');
    const valueA = 'value-for-project-a';
    const valueB = 'value-for-project-b';
    const summary = (id: string, cwd: string, title: string): SessionSummary => ({
      id, source: 'page', project: path.basename(cwd), cwd, title, status: 'running', startedAt: 1, updatedAt: 1, costUsd: 0, nodeCount: 1, pendingPermissions: 0, resumable: false,
    }) as SessionSummary;
    const activity = (text: string): ActivityEvent => ({ kind: 'text', text, ts: 1 }) as unknown as ActivityEvent;
    const twoProjects = (): void => {
      mkdirSync(path.join(work, 'a'));
      mkdirSync(path.join(work, 'b'));
      putSecret(path.join(work, 'a'), 'KEY_A', valueA);
      putSecret(path.join(work, 'b'), 'KEY_B', valueB);
    };

    it('scrubs every project\'s values from titles in session.upsert and hello', () => {
      twoProjects();
      const a = summary('s-a', projectA, `deploy with ${valueA} and ${valueB}`);
      const b = summary('s-b', projectB, `deploy with ${valueA}`);
      const up = redactServerEvent({ type: 'session.upsert', session: a }) as { session: SessionSummary };
      expect(up.session.title).toBe('deploy with [secret:KEY_A] and [secret:KEY_B]');
      expect((redactServerEvent({ type: 'session.upsert', session: b }) as { session: SessionSummary }).session.title).toBe('deploy with [secret:KEY_A]');
      const hello = redactServerEvent({ type: 'hello', sessions: [a, b] }) as { sessions: SessionSummary[] };
      expect(hello.sessions.map(s => s.title)).toEqual(['deploy with [secret:KEY_A] and [secret:KEY_B]', 'deploy with [secret:KEY_A]']);
    });

    it('scrubs nested node, permission and activity events regardless of the session or project', () => {
      twoProjects();
      const ev = { type: 'node.event', sessionId: 's-x', nodeId: 'root', event: { kind: 'tool', input: { command: `echo ${valueA}`, list: [valueB] } } } as unknown as ServerEvent;
      const out = JSON.stringify(redactServerEvent(ev));
      expect(out).not.toContain(valueA);
      expect(out).not.toContain(valueB);
      expect(out).toContain('[secret:KEY_A]');
      expect(out).toContain('[secret:KEY_B]');
      const perm = { type: 'permission.request', request: { id: 'p', sessionId: 's-y', nodeId: 'root', tool: 'Bash', input: { command: `x ${valueA}` } } } as unknown as ServerEvent;
      expect(JSON.stringify(redactServerEvent(perm))).not.toContain(valueA);
      const node = { type: 'node.upsert', node: { id: 'root', sessionId: 's-z', label: valueB } } as unknown as ServerEvent;
      expect(JSON.stringify(redactServerEvent(node))).not.toContain(valueB);
      const text = { type: 'node.event', sessionId: 's-a', nodeId: 'root', event: activity(valueA) } as ServerEvent;
      expect(JSON.stringify(redactServerEvent(text))).toContain('[secret:KEY_A]');
    });

    it('scrubs workers.update and other values with the union matcher', () => {
      twoProjects();
      const workers = { type: 'workers.update', workers: [{ slug: 'w1', title: `uses ${valueA}`, task: { note: valueB } }] } as unknown as ServerEvent;
      const out = JSON.stringify(redactServerEvent(workers));
      expect(out).not.toContain(valueA);
      expect(out).not.toContain(valueB);
      expect(redactAll({ lines: [`log ${valueB}`] })).toEqual({ lines: ['log [secret:KEY_B]'] });
    });

    it('leaves events without a secret alone (same object)', () => {
      twoProjects();
      const removed: ServerEvent = { type: 'session.removed', sessionId: 's-a' };
      expect(redactServerEvent(removed)).toBe(removed);
    });

    it('keeps redacting a deleted or rotated value once it was injected', () => {
      const project = path.join(work, 'inj');
      mkdirSync(project);
      putSecret(project, 'API_KEY', 'first-secret-value');
      putSecret(project, 'GONE_KEY', 'second-secret-value');
      secretEnv(project); // a session starts with both
      putSecret(project, 'API_KEY', 'rotated-secret-value'); // rotated
      deleteSecret(project, 'GONE_KEY'); // deleted
      const ev = { type: 'node.event', sessionId: 's', nodeId: 'root', event: activity('first-secret-value second-secret-value rotated-secret-value') } as ServerEvent;
      const out = JSON.stringify(redactServerEvent(ev));
      expect(out).not.toMatch(/first-secret-value|second-secret-value|rotated-secret-value/);
      expect(out).toContain('[secret:API_KEY]');
      expect(out).toContain('[secret:GONE_KEY]');
    });

    it('does not redact a value that was stored but never injected once it is deleted', () => {
      const project = path.join(work, 'never');
      mkdirSync(project);
      putSecret(project, 'API_KEY', 'never-used-secret');
      expect(redactAll('never-used-secret')).toBe('[secret:API_KEY]');
      deleteSecret(project, 'API_KEY');
      expect(redactAll('never-used-secret')).toBe('never-used-secret');
    });

    it('falls back to the last good store when the file becomes unreadable', () => {
      twoProjects();
      expect(redactAll(`x ${valueA}`)).toBe('x [secret:KEY_A]');
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        writeFileSync(secretsFilePath(), '{not json', { mode: 0o600 });
        expect(redactAll(`x ${valueA} ${valueB}`)).toBe('x [secret:KEY_A] [secret:KEY_B]');
        expect(allSecretEntries().map(e => e.name).sort()).toEqual(['KEY_A', 'KEY_B']);
        rmSync(secretsFilePath());
        expect(redactAll(`x ${valueA}`)).toBe(`x ${valueA}`); // a missing file is an empty store, not a failure
        expect(err).toHaveBeenCalledTimes(1); // logged once, not per event
      } finally {
        err.mockRestore();
      }
    });

    it('dedupes values across projects and lists the longest first', () => {
      mkdirSync(path.join(work, 'a'));
      mkdirSync(path.join(work, 'b'));
      putSecret(path.join(work, 'a'), 'SAME', 'shared-value-123');
      putSecret(path.join(work, 'b'), 'OTHER', 'shared-value-123');
      putSecret(path.join(work, 'b'), 'LONGER', 'shared-value-123-and-more');
      const all = allSecretEntries();
      expect(all.filter(e => e.value === 'shared-value-123')).toHaveLength(1);
      expect(all[0]!.name).toBe('LONGER');
      expect(allSecretEntries()).toBe(all); // stable until something changes
    });
  });
});

describe('injection', () => {
  const homeDir = mkdtempSync(path.join(homedir(), 'fleet-secrets-sessions-'));
  afterAll(() => rmSync(homeDir, { recursive: true, force: true }));

  function recording(seen: Record<string, unknown>[]): QueryFn {
    return (params => {
      seen.push(params.options as Record<string, unknown>);
      return (async function* generator(): AsyncGenerator<any, void> {
        yield { type: 'system', subtype: 'init', model: 'claude-opus-5-5' };
        yield { type: 'result', subtype: 'success' };
      })() as unknown as AsyncIterable<SDKMessage>;
    }) as QueryFn;
  }

  it('merges project secrets and their names into the Claude env, with no systemPrompt option', async () => {
    const project = path.join(homeDir, 'p1');
    mkdirSync(project);
    putSecret(project, 'DB_URL', 'postgres://x');
    putSecret(project, 'API_KEY', 'sk-test-123456');
    const seen: Record<string, unknown>[] = [];
    const sdk = new SdkSessions(() => {}, recording(seen));
    sdk.start({ prompt: 'hello', cwd: project });
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    const env = seen[0]!.env as Record<string, string>;
    expect(env.API_KEY).toBe('sk-test-123456');
    expect(env.DB_URL).toBe('postgres://x');
    expect(env.SWARMKIT_SECRET_NAMES).toBe('API_KEY,DB_URL');
    expect(env.PATH).toBe(process.env.PATH); // process.env stays
    expect(seen[0]).not.toHaveProperty('systemPrompt');
  });

  it('passes the secrets and their names to the OpenCode and agy runtimes', async () => {
    const project = path.join(homeDir, 'p3');
    mkdirSync(project);
    putSecret(project, 'DB_URL', 'postgres://x');
    putSecret(project, 'API_KEY', 'sk-test-123456');
    const acpEnv: Record<string, string | undefined>[] = [];
    const agyEnv: Record<string, string | undefined>[] = [];
    const none = recording([]);
    const sdk = new SdkSessions(() => {}, recording([]), {
      acp: o => { acpEnv.push(o.env as Record<string, string | undefined>); return none; },
      agy: o => { agyEnv.push(o.env as Record<string, string | undefined>); return none; },
    });
    sdk.start({ prompt: 'hello', cwd: project, runtime: 'opencode' });
    sdk.start({ prompt: 'hello', cwd: project, runtime: 'agy' });
    await vi.waitFor(() => expect(acpEnv.length + agyEnv.length).toBe(2));
    for (const env of [acpEnv[0]!, agyEnv[0]!]) {
      expect(env.API_KEY).toBe('sk-test-123456');
      expect(env.DB_URL).toBe('postgres://x');
      expect(env.SWARMKIT_SECRET_NAMES).toBe('API_KEY,DB_URL');
    }
  });

  it('sets no names env for a project without secrets, in any runtime, but still passes the env', async () => {
    const project = path.join(homeDir, 'p2');
    mkdirSync(project);
    const seen: Record<string, unknown>[] = [];
    const acpEnv: Record<string, string | undefined>[] = [];
    const agyEnv: Record<string, string | undefined>[] = [];
    const none = recording([]);
    const sdk = new SdkSessions(() => {}, recording(seen), {
      acp: o => { acpEnv.push(o.env as Record<string, string | undefined>); return none; },
      agy: o => { agyEnv.push(o.env as Record<string, string | undefined>); return none; },
    });
    sdk.start({ prompt: 'hello', cwd: project });
    sdk.start({ prompt: 'hello', cwd: project, runtime: 'opencode' });
    sdk.start({ prompt: 'hello', cwd: project, runtime: 'agy' });
    await vi.waitFor(() => expect(seen.length + acpEnv.length + agyEnv.length).toBe(3));
    expect(seen[0]).not.toHaveProperty('systemPrompt');
    const env = seen[0]!.env as Record<string, string>;
    expect(env.PATH).toBe(process.env.PATH);
    expect(env.SWARMKIT_SECRET_NAMES).toBeUndefined();
    expect(acpEnv[0]!.SWARMKIT_SECRET_NAMES).toBeUndefined();
    expect(agyEnv[0]!.SWARMKIT_SECRET_NAMES).toBeUndefined();
  });

  it('keeps one project’s secrets out of another project’s session', async () => {
    const a = path.join(homeDir, 'pa');
    const b = path.join(homeDir, 'pb');
    mkdirSync(a);
    mkdirSync(b);
    putSecret(a, 'ONLY_A', 'value-only-a');
    const seen: Record<string, unknown>[] = [];
    const sdk = new SdkSessions(() => {}, recording(seen));
    sdk.start({ prompt: 'hello', cwd: b });
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect((seen[0]!.env as Record<string, string>).ONLY_A).toBeUndefined();
  });

  it('the store file is the only place a value lives', () => {
    putSecret(work, 'API_KEY', 'sk-test-123456');
    expect(existsSync(secretsFilePath())).toBe(true);
    expect(JSON.stringify(listSecrets(work))).not.toContain('sk-test');
  });
});
