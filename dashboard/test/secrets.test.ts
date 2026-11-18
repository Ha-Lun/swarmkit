// Per-project secrets: private storage, validation, project scoping, env injection and redaction.
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { SdkSessions } from '../server/sdk/sessions.ts';
import type { QueryFn } from '../server/sdk/sessions.ts';
import {
  deleteSecret, invalidateSecretCaches, listSecrets, projectRoot, putSecret, redactDeep, redactSecrets, redactServerEvent,
  secretEnv, secretEntriesForCwd, secretsDirPath, secretsFilePath, secretsPromptLine,
} from '../server/secrets.ts';
import type { SecretEntry, SecretResolver } from '../server/secrets.ts';
import type { ActivityEvent, ServerEvent, SessionSummary } from '../src/shared/types.ts';

const mode = (p: string): number => lstatSync(p).mode & 0o777;

let config: string;
let work: string;
let prevXdg: string | undefined;

beforeEach(() => {
  config = mkdtempSync(path.join(tmpdir(), 'fleet-secrets-config-'));
  work = realpathSync(mkdtempSync(path.join(tmpdir(), 'fleet-secrets-work-')));
  prevXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = config;
  invalidateSecretCaches();
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
    expect(secretEnv(work)).toEqual({ API_KEY: 'second-value' });
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
    'OPENCODE_CONFIG', 'AGY_X', 'GIT_DIR'])('rejects the reserved name %s', name => {
    expect(() => putSecret(work, name, 'value-123456')).toThrow(/reserved/);
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
    expect(secretEnv(path.join(repo, 'packages'))).toEqual({ API_KEY: 'sk-test-123456' });
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
    expect(secretEnv(link)).toEqual({ API_KEY: 'via-link-123' });
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

  describe('events', () => {
    const projectA = '/proj/a';
    const projectB = '/proj/b';
    const valueA = 'value-for-project-a';
    const resolver: SecretResolver = {
      forCwd: cwd => (cwd === projectA ? entries(['KEY_A', valueA]) : []),
      forSession: id => (id === 's-a' ? entries(['KEY_A', valueA]) : []),
    };
    const summary = (id: string, cwd: string, title: string): SessionSummary => ({
      id, source: 'page', project: path.basename(cwd), cwd, title, status: 'running', startedAt: 1, updatedAt: 1, costUsd: 0, nodeCount: 1, pendingPermissions: 0, resumable: false,
    }) as SessionSummary;
    const activity = (text: string): ActivityEvent => ({ kind: 'text', text, ts: 1 }) as unknown as ActivityEvent;

    it('scrubs titles in session.upsert and hello, per project', () => {
      const a = summary('s-a', projectA, `deploy with ${valueA}`);
      const b = summary('s-b', projectB, `deploy with ${valueA}`);
      const up = redactServerEvent({ type: 'session.upsert', session: a }, resolver) as { session: SessionSummary };
      expect(up.session.title).toBe('deploy with [secret:KEY_A]');
      expect((redactServerEvent({ type: 'session.upsert', session: b }, resolver) as { session: SessionSummary }).session.title).toBe(`deploy with ${valueA}`);
      const hello = redactServerEvent({ type: 'hello', sessions: [a, b] }, resolver) as { sessions: SessionSummary[] };
      expect(hello.sessions.map(s => s.title)).toEqual(['deploy with [secret:KEY_A]', `deploy with ${valueA}`]);
    });

    it('scrubs nested node, permission and activity events of the owning session only', () => {
      const ev = { type: 'node.event', sessionId: 's-a', nodeId: 'root', event: { kind: 'tool', input: { command: `echo ${valueA}`, list: [valueA] } } } as unknown as ServerEvent;
      expect(JSON.stringify(redactServerEvent(ev, resolver))).not.toContain(valueA);
      expect(JSON.stringify(redactServerEvent(ev, resolver))).toContain('[secret:KEY_A]');
      const other = { ...ev, sessionId: 's-b' } as ServerEvent;
      expect(redactServerEvent(other, resolver)).toBe(other);
      const perm = { type: 'permission.request', request: { id: 'p', sessionId: 's-a', nodeId: 'root', tool: 'Bash', input: { command: `x ${valueA}` } } } as unknown as ServerEvent;
      expect(JSON.stringify(redactServerEvent(perm, resolver))).not.toContain(valueA);
      const node = { type: 'node.upsert', node: { id: 'root', sessionId: 's-a', label: valueA } } as unknown as ServerEvent;
      expect(JSON.stringify(redactServerEvent(node, resolver))).not.toContain(valueA);
      const text = { type: 'node.event', sessionId: 's-a', nodeId: 'root', event: activity(valueA) } as ServerEvent;
      expect(JSON.stringify(redactServerEvent(text, resolver))).toContain('[secret:KEY_A]');
    });

    it('leaves events of other types alone', () => {
      const removed: ServerEvent = { type: 'session.removed', sessionId: 's-a' };
      expect(redactServerEvent(removed, resolver)).toBe(removed);
    });
  });

  it('the cached per-cwd lists follow a PUT and a DELETE at once', () => {
    expect(secretEntriesForCwd(work)).toEqual([]);
    putSecret(work, 'API_KEY', 'sk-test-123456');
    expect(secretEntriesForCwd(work)).toEqual([{ name: 'API_KEY', value: 'sk-test-123456' }]);
    deleteSecret(work, 'API_KEY');
    expect(secretEntriesForCwd(work)).toEqual([]);
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

  it('merges project secrets into the Claude env and names them in the system prompt', async () => {
    const project = path.join(homeDir, 'p1');
    mkdirSync(project);
    putSecret(project, 'API_KEY', 'sk-test-123456');
    putSecret(project, 'DB_URL', 'postgres://x');
    const seen: Record<string, unknown>[] = [];
    const sdk = new SdkSessions(() => {}, recording(seen));
    sdk.start({ prompt: 'hello', cwd: project });
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    const env = seen[0]!.env as Record<string, string>;
    expect(env.API_KEY).toBe('sk-test-123456');
    expect(env.DB_URL).toBe('postgres://x');
    expect(env.PATH).toBe(process.env.PATH); // process.env stays
    const prompt = seen[0]!.systemPrompt as { type: string; preset: string; append: string };
    expect(prompt.type).toBe('preset');
    expect(prompt.append).toContain('API_KEY, DB_URL');
    expect(prompt.append).not.toContain('sk-test-123456');
    expect(prompt.append).not.toContain('postgres');
  });

  it('adds nothing to the prompt for a project without secrets, but still passes the env', async () => {
    const project = path.join(homeDir, 'p2');
    mkdirSync(project);
    expect(secretsPromptLine(project)).toBeUndefined();
    const seen: Record<string, unknown>[] = [];
    const sdk = new SdkSessions(() => {}, recording(seen));
    sdk.start({ prompt: 'hello', cwd: project });
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]!.systemPrompt).toBeUndefined();
    expect((seen[0]!.env as Record<string, string>).PATH).toBe(process.env.PATH);
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
