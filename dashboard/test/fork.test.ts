import { mkdtempSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ServerEvent } from '../src/shared/types.ts';
import { SdkSessions } from '../server/sdk/sessions.ts';
import type { QueryFn } from '../server/sdk/sessions.ts';

/** Real scratch dir under $HOME: resume() validates cwds like the start path does. */
const homeDir = mkdtempSync(path.join(homedir(), 'fleet-fork-test-'));
afterAll(() => rmSync(homeDir, { recursive: true, force: true }));
afterEach(() => {
  vi.useRealTimers();
});

/**
 * Fake CLI query whose init reports the session id from `initSid` (undefined = no
 * init message at all). A forked CLI picks a fresh id; a misbehaving one can report
 * the source or an owned id.
 */
function makeInitQuery(initSid: { value?: string }, seen: Record<string, unknown>[]): QueryFn {
  return (params) => {
    seen.push(params.options as Record<string, unknown>);
    return (async function* generator(): AsyncGenerator<SDKMessage, void> {
      if (initSid.value !== undefined) {
        yield { type: 'system', subtype: 'init', session_id: initSid.value, model: 'claude-opus-5-5' } as unknown as SDKMessage;
      }
      yield { type: 'result', subtype: 'success' } as unknown as SDKMessage;
    })() as unknown as AsyncIterable<SDKMessage>;
  };
}

describe('resume fork (terminal continue-as-a-copy)', () => {
  it('adopts the CLI\u2019s new session id and leaves the source unowned', async () => {
    const events: ServerEvent[] = [];
    const seen: Record<string, unknown>[] = [];
    const sdk = new SdkSessions(e => events.push(e), makeInitQuery({ value: 'forked-new-id' }, seen));

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

  it('never adopts the source id: the copy is killed, silenced and the fork fails', async () => {
    const events: ServerEvent[] = [];
    const seen: Record<string, unknown>[] = [];
    // The CLI answered init with the SOURCE id: it did not fork after all. The
    // trailing result message must never reach the (deleted) placeholder tree.
    const sdk = new SdkSessions(e => events.push(e), makeInitQuery({ value: 'fork-source-id' }, seen));
    await expect(
      sdk.resume('fork-source-id', { text: 'continue as a copy', fork: true }, { cwd: homeDir, title: 'Resumed session' }),
    ).rejects.toThrow(/source session id/);
    // Give the (aborted) consume loop a moment, then pin the event count: nothing
    // may be emitted for the deleted placeholder after the rejection.
    await new Promise(r => setTimeout(r, 30));
    const count = events.length;
    await new Promise(r => setTimeout(r, 30));
    expect(events.length).toBe(count);
    // Nothing was adopted and no session lingers: the source stays unowned.
    expect(sdk.owns('fork-source-id')).toBe(false);
    expect(sdk.list()).toEqual([]);
    // The aborted query was told to resume the source with forkSession.
    expect(seen[0]).toMatchObject({ resume: 'fork-source-id', forkSession: true });
  });

  it('fails closed when the CLI reports an id another session already owns', async () => {
    const events: ServerEvent[] = [];
    const seen: Record<string, unknown>[] = [];
    const initSid: { value?: string } = { value: undefined };
    const sdk = new SdkSessions(e => events.push(e), makeInitQuery(initSid, seen));
    const ownerId = sdk.start({ prompt: 'own the fleet', cwd: homeDir, agent: 'lead-dev-hybrid' });
    // Let the owned session's own query finish before counting its events.
    await new Promise(r => setTimeout(r, 30));

    // The forked CLI reports the page session's id: never adopt it.
    initSid.value = ownerId;
    await expect(
      sdk.resume('fork-source-id', { text: 'continue as a copy', fork: true }, { cwd: homeDir, title: 'Resumed session' }),
    ).rejects.toThrow(/already owns/);
    // The owned session was untouched; only it remains, and nothing is emitted
    // for the deleted placeholder afterwards.
    await new Promise(r => setTimeout(r, 30));
    expect(sdk.owns(ownerId)).toBe(true);
    expect(sdk.owns('fork-source-id')).toBe(false);
    expect(sdk.list().map(s => s.id)).toEqual([ownerId]);
    const count = events.length;
    await new Promise(r => setTimeout(r, 30));
    expect(events.length).toBe(count);
  });

  it('refuses a fork of a dashboard-owned session with 409', async () => {
    const events: ServerEvent[] = [];
    const seen: Record<string, unknown>[] = [];
    const sdk = new SdkSessions(e => events.push(e), makeInitQuery({ value: 'unused-id' }, seen));
    const id = sdk.start({ prompt: 'own the fleet', cwd: homeDir, agent: 'lead-dev-hybrid' });
    const queriesBefore = seen.length;
    await expect(
      sdk.resume(id, { text: 'try to fork a page session', fork: true }, { cwd: homeDir }),
    ).rejects.toMatchObject({ status: 409 });
    // The live session was never touched and no fork query was started.
    expect(sdk.owns(id)).toBe(true);
    expect(seen.length).toBe(queriesBefore);
  });

  it('refuses a fork that carries attachments with 400', async () => {
    const seen: Record<string, unknown>[] = [];
    const sdk = new SdkSessions(() => {}, makeInitQuery({ value: 'any-id' }, seen));
    await expect(
      sdk.resume(
        'fork-source-id',
        { text: 'continue as a copy', fork: true, files: [{ name: 'a.txt', mediaType: 'text/plain', data: 'eA==' }] },
        { cwd: homeDir, title: 'Resumed session' },
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('drops the placeholder session when the forked query ends without an init id', async () => {
    const seen: Record<string, unknown>[] = [];
    const sdk = new SdkSessions(() => {}, makeInitQuery({ value: undefined }, seen));
    await expect(
      sdk.resume('fork-source-id', { text: 'continue as a copy', fork: true }, { cwd: homeDir, title: 'Resumed session' }),
    ).rejects.toThrow(/new session id/);
    expect(sdk.list()).toEqual([]);
    expect(sdk.owns('fork-source-id')).toBe(false);
  });

  it('times out a fork whose CLI never reports an id, and cleans up', async () => {
    // Only the timeout clock is fake: setImmediate stays real so resume's own I/O progresses.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    // The query never yields anything: consume waits forever on the iterator.
    const hangingQuery: QueryFn = () =>
      (async function* generator(): AsyncGenerator<SDKMessage, void> {
        await new Promise<never>(() => {});
        yield { type: 'result' } as unknown as SDKMessage; // unreachable
      })() as unknown as AsyncIterable<SDKMessage>;
    const sdk = new SdkSessions(() => {}, hangingQuery);
    let settled = false;
    const pending = sdk.resume(
      'fork-source-id',
      { text: 'continue as a copy', fork: true },
      { cwd: homeDir, title: 'Resumed session' },
    ).catch(err => {
      settled = true;
      throw err;
    });
    const assertion = expect(pending).rejects.toMatchObject({ status: 504, message: /did not start in time/ });
    // resume reaches the 60 s race after its own real-I/O awaits (slow under load):
    // give the event loop a real turn, then advance the fake clock, until it settles.
    for (let i = 0; i < 2_000 && !settled; i++) {
      await new Promise(resolve => setImmediate(resolve));
      await vi.advanceTimersByTimeAsync(5_000);
    }
    await assertion;
    // The placeholder was torn down; the source stays unowned.
    expect(sdk.list()).toEqual([]);
    expect(sdk.owns('fork-source-id')).toBe(false);
  }, 20_000);
});
