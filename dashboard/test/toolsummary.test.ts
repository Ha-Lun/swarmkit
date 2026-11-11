import { describe, expect, it } from 'vitest';
import { toolSummary } from '../src/client/toolSummary.ts';

describe('toolSummary', () => {
  it('pluralises each group and keeps the group order', () => {
    expect(
      toolSummary([
        { key: 'bash', count: 3 },
        { key: 'read', count: 2 },
        { key: 'edit', count: 1 },
      ]),
    ).toBe('ran 3 commands, read 2 files, edited 1 file');
  });
  it('uses singular nouns for one and irregular plurals for many', () => {
    expect(toolSummary([{ key: 'search', count: 1 }, { key: 'web', count: 2 }])).toBe(
      'ran 1 search, made 2 web requests',
    );
    expect(toolSummary([{ key: 'search', count: 4 }])).toBe('ran 4 searches');
  });
  it('falls back when there are no counted groups', () => {
    expect(toolSummary([])).toBe('used tools');
    expect(toolSummary([{ key: 'other', count: 0 }])).toBe('used tools');
  });
});
