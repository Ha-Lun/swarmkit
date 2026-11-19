import { describe, expect, it } from 'vitest';
import { initialState, reducer, type AppState } from '../src/client/state';
import type { AgentNodeHead, SessionDetail } from '../src/shared/types';

describe('node.upsert merge', () => {
  it('clears lastTool when the head arrives without it (JSON drops undefined)', () => {
    const detail = { summary: { id: 's1' }, nodes: [{ id: 'n1', sessionId: 's1', lastTool: 'edit a.ts', events: [] }] };
    const state: AppState = { ...initialState, details: { s1: detail as unknown as SessionDetail } };
    const head = JSON.parse(JSON.stringify({ id: 'n1', sessionId: 's1', lastTool: undefined })) as AgentNodeHead;
    const next = reducer(state, { type: 'ev', ev: { type: 'node.upsert', node: head } });
    expect(next.details.s1.nodes[0].lastTool).toBeUndefined();
  });
});
