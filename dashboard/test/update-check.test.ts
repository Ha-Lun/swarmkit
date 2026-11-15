import { describe, expect, it } from 'vitest';
import { initialState, reducer } from '../src/client/state';


function sendHello(state: typeof initialState, build?: string) {
  return reducer(state, { type: 'ev', ev: { type: 'hello', sessions: [], build } });
}

describe('redeploy check', () => {
  it('remembers the first build and flags a different one', () => {
    let s = sendHello(initialState, 'aaa');
    expect(s.build).toBe('aaa');
    expect(s.updated).toBeFalsy();
    s = sendHello(s, 'aaa'); // reconnect, same build
    expect(s.updated).toBeFalsy();
    s = sendHello(s, 'bbb'); // reconnect after a redeploy
    expect(s.updated).toBe(true);
    expect(s.build).toBe('aaa');
  });

  it('ignores hellos without a build (dev server, the initial list fetch)', () => {
    let s = sendHello(initialState);
    expect(s.build).toBeUndefined();
    s = sendHello(s, 'aaa');
    s = sendHello(s);
    expect(s.updated).toBeFalsy();
  });

  it('stays flagged once set', () => {
    let s = sendHello(sendHello(initialState, 'aaa'), 'bbb');
    s = sendHello(s, 'aaa');
    expect(s.updated).toBe(true);
  });
});
