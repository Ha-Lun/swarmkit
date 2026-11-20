// Per-project secrets: private storage, validation, project scoping, env injection and redaction.
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
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
    const stored = JSON.parse(readFileSync(secretsFilePath(), 'utf8'));
    expect(Object.keys(stored)).toEqual(['__retired__']);
    expect(stored.__retired__.map((r: { value: string; name: string }) => [r.value, r.name])).toEqual([['first-value', 'API_KEY'], ['second-value', 'API_KEY']]);
  });

  describe('retired values', () => {
    const retiredOf = (): { value: string; name: string; retiredAt: number }[] =>
      JSON.parse(readFileSync(secretsFilePath(), 'utf8')).__retired__ ?? [];

    it('keeps redacting a deleted or replaced value after a restart, but never lists or injects it', () => {
      putSecret(work, 'API_KEY', 'first-secret-value');
      putSecret(work, 'GONE_KEY', 'second-secret-value');
      putSecret(work, 'API_KEY', 'rotated-secret-value');
      deleteSecret(work, 'GONE_KEY');
      resetSecretStateForTests(); // restart: no injected values, no cached store
      expect(redactAll('first-secret-value second-secret-value rotated-secret-value'))
        .toBe('[secret:API_KEY] [secret:GONE_KEY] [secret:API_KEY]');
      expect(JSON.stringify(listSecrets(work))).not.toMatch(/secret-value/);
      expect(secretEnv(work)).toEqual({ API_KEY: 'rotated-secret-value', SWARMKIT_SECRET_NAMES: 'API_KEY' });
      expect(mode(secretsFilePath())).toBe(0o600);
    });

    it('does not retire a value that is rewritten unchanged, nor one too weak to redact', () => {
      putSecret(work, 'API_KEY', 'same-secret-value');
      putSecret(work, 'API_KEY', 'same-secret-value');
      putSecret(work, 'WEAK_KEY', 'aaaaaa');
      deleteSecret(work, 'WEAK_KEY');
      expect(existsSync(secretsFilePath()) && retiredOf()).toEqual([]);
    });

    it('reads a file without the retired section, and a malformed one, and ignores older readers’ shape', () => {
      mkdirSync(secretsDirPath(), { mode: 0o700 });
      writeFileSync(secretsFilePath(), JSON.stringify({
        [work]: { API_KEY: { value: 'legacy-secret-value', updatedAt: 1 } },
        __retired__: [{ value: 'old-secret-value', name: 'lower', retiredAt: 'x' }, { value: 5 }, null, { value: '' }],
      }), { mode: 0o600 });
      expect(listSecrets(work).names.map(n => n.name)).toEqual(['API_KEY']);
      expect(redactAll('legacy-secret-value old-secret-value')).toBe('[secret:API_KEY] [secret:REDACTED]');
      putSecret(work, 'OTHER_KEY', 'other-secret-value'); // saving keeps the retired entry
      expect(retiredOf().map(r => r.value)).toEqual(['old-secret-value']);
    });

    it('caps the retired list at 256 entries, oldest dropped first', () => {
      for (let i = 0; i < 300; i++) putSecret(work, 'API_KEY', `value-generation-${i}`);
      const list = retiredOf();
      expect(list).toHaveLength(256);
      expect(list[0]!.value).toBe('value-generation-43');
      expect(list.at(-1)!.value).toBe('value-generation-298');
      resetSecretStateForTests();
      expect(redactAll('value-generation-42 value-generation-43')).toBe('value-generation-42 [secret:API_KEY]');
    });

    it('caps the retired list at 1 MB and keeps it out of the live secrets budget', () => {
      for (let i = 0; i < 200; i++) putSecret(work, 'API_KEY', `${String(i).padStart(4, '0')}`.padEnd(8 * 1024, 'r'));
      const size = statSync(secretsFilePath()).size;
      expect(size).toBeLessThanOrEqual(1024 * 1024 + 8 * 1024 + 1024);
      const list = retiredOf();
      expect(list.length).toBeLessThan(256);
      expect(list.at(-1)!.value.startsWith('0198')).toBe(true);
      expect(list[0]!.value.startsWith('0000')).toBe(false);
      // A full 1 MB of retired values does not stop a live secret from being stored.
      const other = path.join(work, 'other');
      mkdirSync(other);
      expect(() => putSecret(other, 'NEW_KEY', 'a-brand-new-value')).not.toThrow();
    });

    it('bounds the in-memory injected set, least recently injected first', () => {
      const project = path.join(work, 'many');
      mkdirSync(project);
      const stable = path.join(work, 'stable');
      mkdirSync(stable);
      putSecret(stable, 'STABLE_KEY', 'stable-secret-value');
      secretEnv(stable);
      deleteSecret(stable, 'STABLE_KEY'); // retired as well, so it must survive for another reason: touched below
      for (let i = 0; i < 600; i++) {
        putSecret(project, 'API_KEY', `inject-generation-${i}`);
        secretEnv(project);
      }
      // 599 earlier values are retired (cap 256) or injected (cap 512); the injected map never exceeds 512.
      const entries = allSecretEntries().filter(e => e.value.startsWith('inject-generation-'));
      expect(entries.length).toBeLessThanOrEqual(512);
      expect(entries.some(e => e.value === 'inject-generation-599')).toBe(true);
    });
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

    it('keeps redacting a value that was stored but never injected once it is deleted (retired)', () => {
      const project = path.join(work, 'never');
      mkdirSync(project);
      putSecret(project, 'API_KEY', 'never-used-secret');
      expect(redactAll('never-used-secret')).toBe('[secret:API_KEY]');
      deleteSecret(project, 'API_KEY');
      expect(redactAll('never-used-secret')).toBe('[secret:API_KEY]');
    });

    it('redacts a large value set across a session-detail-sized object in reasonable time', () => {
      const project = path.join(work, 'bench');
      mkdirSync(project);
      const values: string[] = [];
      for (let i = 0; i < 128; i++) {
        let v = '';
        while (v.length < 8 * 1024) v += randomBytes(6 * 1024).toString('base64').replace(/[+/=]/g, c => '-_.'[ '+/='.indexOf(c) ]);
        values.push(v.slice(0, 8 * 1024));
      }
      // 128 x 8 KB in total: the first 64 live in the store, the other 64 were replaced and are retired.
      values.forEach((v, i) => {
        const dir = path.join(project, `p${Math.floor(i / 16)}`);
        mkdirSync(dir, { recursive: true });
        putSecret(dir, `KEY_${i % 16}`, v);
        if (i >= 64) putSecret(dir, `KEY_${i % 16}`, `replacement-${i}-value`);
      });
      const detail = {
        id: 's', title: 'a session',
        events: Array.from({ length: 400 }, (_, i) => ({
          type: 'text', text: `${randomBytes(200).toString('base64')} line ${i} `.repeat(2),
          input: JSON.stringify({ cmd: `echo ${i}`, note: 'x'.repeat(100) }),
        })),
      };
      (detail.events[3] as { text: string }).text += ` leaked ${values[7]} and ${values[100]} end`;
      (detail.events[300] as { input: string }).input = JSON.stringify({ cmd: `curl -H "Authorization: ${values[42]!.slice(0, 40)}"`, tail: values[42] });
      expect(JSON.stringify(detail).length).toBeGreaterThan(150 * 1024);
      redactAll(detail); // warm: builds the matcher once, like the first event after a store change
      const start = performance.now();
      const out = redactAll(detail);
      const ms = performance.now() - start;
      console.info(`redactAll benchmark: ${ms.toFixed(1)} ms for ${JSON.stringify(detail).length} bytes against 128 x 8 KB values`);
      expect(ms).toBeLessThan(500);
      const text = JSON.stringify(out);
      expect(text).not.toContain(values[7]!);
      expect(text).not.toContain(values[100]!);
      expect(text).not.toContain(values[42]!);
      expect(text).toContain('[secret:KEY_7]');
      expect(text).toContain('[secret:KEY_4]'); // values[100] is retired
    });

    it('falls back to the last good store when the file becomes unreadable', () => {
      twoProjects();
      vi.useFakeTimers();
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        expect(redactAll(`x ${valueA}`)).toBe('x [secret:KEY_A]');
        writeFileSync(secretsFilePath(), '{not json', { mode: 0o600 });
        vi.advanceTimersByTime(1000);
        expect(redactAll(`x ${valueA} ${valueB}`)).toBe('x [secret:KEY_A] [secret:KEY_B]');
        expect(allSecretEntries().map(e => e.name).sort()).toEqual(['KEY_A', 'KEY_B']);
        expect(err).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(1000);
        expect(redactAll(`x ${valueA} ${valueB}`)).toBe('x [secret:KEY_A] [secret:KEY_B]'); // still failing: still the last good copy
        rmSync(secretsFilePath());
        vi.advanceTimersByTime(1000);
        expect(redactAll(`x ${valueA}`)).toBe(`x ${valueA}`); // a missing file is an empty store, not a failure
        expect(err).toHaveBeenCalledTimes(1); // logged once, not per event
      } finally {
        err.mockRestore();
        vi.useRealTimers();
      }
    });

    it('redacts a value from putSecret at once, and reuses the store between events', () => {
      vi.useFakeTimers();
      try {
        mkdirSync(path.join(work, 'a'));
        putSecret(path.join(work, 'a'), 'KEY_A', valueA);
        expect(redactAll(`x ${valueA}`)).toBe('x [secret:KEY_A]');
        const all = allSecretEntries();
        expect(allSecretEntries()).toBe(all); // within the recheck window the same store, so the same matcher
        putSecret(path.join(work, 'a'), 'KEY_NEW', 'brand-new-value-1');
        expect(redactAll('y brand-new-value-1')).toBe('y [secret:KEY_NEW]'); // no time advance
      } finally {
        vi.useRealTimers();
      }
    });

    it('sees an external write or delete of the file only after the recheck interval', () => {
      vi.useFakeTimers();
      try {
        twoProjects();
        expect(redactAll(`x ${valueA}`)).toBe('x [secret:KEY_A]'); // warm
        writeFileSync(secretsFilePath(), JSON.stringify({ ext: { KEY_EXT: { value: 'external-edit-value-9', updatedAt: 1 } } }), { mode: 0o600 });
        expect(redactAll('y external-edit-value-9')).toBe('y external-edit-value-9'); // still the cached store
        vi.advanceTimersByTime(1000);
        expect(redactAll(`y external-edit-value-9 ${valueA}`)).toBe(`y [secret:KEY_EXT] ${valueA}`);
        rmSync(secretsFilePath());
        expect(redactAll('y external-edit-value-9')).toBe('y [secret:KEY_EXT]'); // cached until the interval passes
        vi.advanceTimersByTime(1000);
        expect(redactAll('y external-edit-value-9')).toBe('y external-edit-value-9');
        // an empty (missing-file) result is never cached, so a re-created file is seen at once
        writeFileSync(secretsFilePath(), JSON.stringify({ back: { KEY_BACK: { value: 'recreated-value-77', updatedAt: 2 } } }), { mode: 0o600 });
        expect(redactAll('z recreated-value-77')).toBe('z [secret:KEY_BACK]'); // no time advance
      } finally {
        vi.useRealTimers();
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
