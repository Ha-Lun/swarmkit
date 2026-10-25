// Tests for the slash command matching helper.
import { describe, expect, it } from 'vitest';
import { matchCommands } from '../src/client/SlashMenu.tsx';
import type { SlashCommandInfo } from '../src/shared/types.ts';

function cmd(name: string, description?: string): SlashCommandInfo {
  return description === undefined ? { name } : { name, description };
}

describe('matchCommands', () => {
  it('orders prefix before substring before description match', () => {
    const list = [
      cmd('alpha', 'review helpers here'),
      cmd('xreview', 'something else'),
      cmd('review', 'run a review'),
    ];
    const got = matchCommands(list, 'review').map((c) => c.name);
    expect(got).toEqual(['review', 'xreview', 'alpha']);
  });
  it('is case-insensitive', () => {
    const list = [cmd('Review'), cmd('COMPACT', 'compact things')];
    expect(matchCommands(list, 'review').map((c) => c.name)).toEqual(['Review']);
    expect(matchCommands(list, 'COMPACT').map((c) => c.name)).toEqual(['COMPACT']);
    expect(matchCommands(list, 'compact things').map((c) => c.name)).toEqual(['COMPACT']);
  });
  it('returns the first 50 in input order for an empty query', () => {
    const list = Array.from({ length: 60 }, (_, i) => cmd(`c${i}`));
    const got = matchCommands(list, '');
    expect(got.length).toBe(50);
    expect(got[0].name).toBe('c0');
    expect(got[49].name).toBe('c49');
  });
  it('caps at 50', () => {
    const list = Array.from({ length: 80 }, (_, i) => cmd(`test-${i}`));
    expect(matchCommands(list, 'test').length).toBe(50);
  });
});
