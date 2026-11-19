import { mkdtempSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ServerEvent } from '../src/shared/types.ts';
import { SdkSessions } from '../server/sdk/sessions.ts';
import type { QueryFn } from '../server/sdk/sessions.ts';

/** Real scratch dir under $HOME: resume() validates cwds like the start path does. */
const homeDir = mkdtempSync(path.join(homedir(), 'fleet-fork-test-'));
afterAll(() => rmSync(homeDir, { recursive: true, force: true }));

/** Fake CLI query: the fork resumes the source and reports a fresh session id in init. */
function makeForkQuery(newId: string, seen: Record<string, unknown>[]): QueryFn {
  return (params) => {
    seen.push(params.options as Record<string, unknown>);
    return (async function* generator(): AsyncGenerator<SDKMessage, void> {
      yield { type: 'system', subtype: 'init', session_id: newId, model: 'claude-opus-5-5' } as unknown as SDKMessage;
      yield { type: 'result', subtype: 'success' } as unknown as SDKMessage;
    })() as unknown as AsyncIterable<SDKMessage>;
  };
}

describe('resume fork (terminal continue-as-a-copy)', () => {
  it('adopts the CLI\u2019s new session id and leaves the source unowned', async () => {
    const events: ServerEvent[] = [];
    const seen: Record<string, unknown>[] = [];
    const sdk = new SdkSessions(e => events.push(e), makeForkQuery('forked-new-id', seen));

    const returned = await sdk.resume(
      'fork-source-id',
      { text: 'continue this as a copy', fork: true },
      { cwd: homeDir, title: 'Resumed session' },
    );
    expect(returned).toBe('forked-new-id'); // the id the transcript really continues under
    expect(sdk.owns('forked-new-id')).toBe(true);
    expect(sdk.owns('fork-source-id')).toBe(false);
    // The query resumed the source with forkSession, not the placeholder id.
    expect(seen[0]).toMatchObject({ resume: 'fork-source-id', forkSession: true });
    expect(seen[0]!.sessionId).toBeUndefined();
    // Nothing was broadcast under the placeholder/source id before the adoption.
    const upsertIds = events
      .filter(e => e.type === 'session.upsert')
      .map(e => (e as { session: { id: string } }).session.id);
    expect(upsertIds).toContain('forked-new-id');
    expect(upsertIds).not.toContain('fork-source-id');
  });

  it('a plain resume keeps the same session id (contract unchanged)', async () => {
    const seen: Record<string, unknown>[] = [];
    const sdk = new SdkSessions(() => {}, makeForkQuery('any-id', seen));
    const id = await sdk.resume('plain-terminal-id', { text: 'continue' }, { cwd: homeDir, title: 'Resumed session' });
    expect(id).toBe('plain-terminal-id');
    expect(sdk.owns('plain-terminal-id')).toBe(true);
    expect(seen[0]!.resume).toBe('plain-terminal-id');
    expect(seen[0]!.forkSession).toBeUndefined();
  });
});
