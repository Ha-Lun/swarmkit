// Mid-turn messages: Claude gets priority 'next' (steers the running turn); opencode/agy cannot take a
// second prompt mid-turn, so the user event shows `queued` until the adapter reads the message.
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ActivityEvent, ServerEvent } from '../src/shared/types';
import { SdkSessions } from '../server/sdk/sessions';
import type { QueryFn } from '../server/sdk/sessions';

const homeDir = mkdtempSync(path.join(homedir(), 'fleet-queued-test-'));
afterAll(() => rmSync(homeDir, { recursive: true, force: true }));

/** A lead whose first turn blocks until `release()`; every message it reads is recorded. */
function gatedLead() {
  let release!: () => void;
  const gate = new Promise<void>(r => (release = r));
  const read: SDKUserMessage[] = [];
  const fn: QueryFn = ({ prompt }) =>
    (async function* (): AsyncGenerator<SDKMessage> {
      yield { type: 'system', subtype: 'init', model: 'fake' } as unknown as SDKMessage;
      let turn = 0;
      for await (const m of prompt as AsyncIterable<SDKUserMessage>) {
        read.push(m);
        turn += 1;
        if (turn === 1) await gate;
        yield { type: 'result', subtype: 'success', usage: {} } as unknown as SDKMessage;
      }
    })();
  return { fn, read, release };
}

const userEvents = (events: ServerEvent[], text: string): ActivityEvent[] =>
  events.flatMap(e => (e.type === 'node.event' && e.event.kind === 'user' && e.event.summary === text ? [e.event] : []));

describe('mid-turn messages', () => {
  it('opencode: a message sent during a turn is queued until the next turn reads it', async () => {
    const events: ServerEvent[] = [];
    const lead = gatedLead();
    const sdk = new SdkSessions(e => events.push(e), lead.fn, { acp: () => lead.fn });
    const id = sdk.start({ prompt: 'first', cwd: homeDir, runtime: 'opencode' });
    await vi.waitFor(() => expect(lead.read).toHaveLength(1));

    sdk.send(id, 'side question');
    const [queued] = userEvents(events, 'side question');
    expect(queued?.queued).toBe(true);
    expect(sdk.get(id)?.nodes.find(n => n.id === 'root')?.events.find(e => e.id === queued?.id)?.queued).toBe(true);

    lead.release();
    await vi.waitFor(() => expect(lead.read).toHaveLength(2));
    const after = userEvents(events, 'side question');
    expect(after).toHaveLength(2);
    expect(after[1]?.id).toBe(queued?.id);
    expect(after[1]?.queued).toBeUndefined();
    expect(sdk.get(id)?.nodes.find(n => n.id === 'root')?.events.find(e => e.id === queued?.id)?.queued).toBeUndefined();
    sdk.stop(id);
  });

  it('claude: a mid-turn message carries priority next and is never shown as queued', async () => {
    const events: ServerEvent[] = [];
    const lead = gatedLead();
    const sdk = new SdkSessions(e => events.push(e), lead.fn);
    const id = sdk.start({ prompt: 'first', cwd: homeDir });
    await vi.waitFor(() => expect(lead.read).toHaveLength(1));
    expect(lead.read[0]?.priority).toBeUndefined();

    sdk.send(id, 'steer');
    expect(userEvents(events, 'steer')[0]?.queued).toBeUndefined();
    lead.release();
    await vi.waitFor(() => expect(lead.read).toHaveLength(2));
    expect(lead.read[1]?.priority).toBe('next');
    sdk.stop(id);
  });
});
