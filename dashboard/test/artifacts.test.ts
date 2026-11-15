import { describe, expect, it } from 'vitest';
import { matchWritten, resultKey, turnArtifacts } from '../src/client/artifacts.ts';
import type { ActivityEvent, PublishedArtifact, WrittenArtifact } from '../src/shared/types.ts';

const ev = (id: string, ts: number, kind: ActivityEvent['kind']): ActivityEvent => ({ id, ts, kind, summary: id });
const pub = (name: string, mtime: number): PublishedArtifact => ({ name, size: 1, mtime, url: `/a/${name}` });

describe('resultKey', () => {
  it('changes with each result event and is stable otherwise', () => {
    const a = [ev('u1', 1, 'user'), ev('t1', 2, 'text')];
    const b = [...a, ev('r1', 3, 'result')];
    const c = [...b, ev('t2', 4, 'text')];
    const d = [...b, ev('r2', 5, 'result')];
    expect(resultKey(undefined)).toBe('0:');
    expect(resultKey(a)).toBe('0:');
    expect(resultKey(b)).toBe('1:r1');
    expect(resultKey(c)).toBe(resultKey(b));
    expect(resultKey(d)).toBe('2:r2');
  });
});

describe('turnArtifacts', () => {
  const events = [
    ev('u1', 100, 'user'),
    ev('t1', 150, 'text'),
    ev('r1', 160, 'result'),
    ev('u2', 200, 'user'),
    ev('t2', 250, 'text'),
    ev('t3', 260, 'text'),
    ev('r2', 270, 'result'),
    ev('u3', 300, 'user'),
    ev('t4', 320, 'text'),
  ];

  it('puts each file under the last reply of the turn whose window holds its mtime', () => {
    const out = turnArtifacts(events, [pub('a.pdf', 155), pub('b.zip', 265), pub('c.csv', 90)]);
    expect(out.get('t1')?.map((f) => f.name)).toEqual(['a.pdf']);
    expect(out.get('t3')?.map((f) => f.name)).toEqual(['b.zip']);
    expect(out.has('t2')).toBe(false);
    expect([...out.keys()]).toEqual(['t1', 't3']);
  });

  it('counts a file written exactly at the turn start', () => {
    expect(turnArtifacts(events, [pub('a.pdf', 100)]).get('t1')).toHaveLength(1);
  });

  it('skips the running last turn until its result arrives', () => {
    expect(turnArtifacts(events, [pub('late.pdf', 330)]).size).toBe(0);
    const done = [...events, ev('r3', 340, 'result')];
    expect(turnArtifacts(done, [pub('late.pdf', 330)]).get('t4')).toHaveLength(1);
  });

  it('skips turns without an assistant reply and empty inputs', () => {
    expect(turnArtifacts([ev('u', 1, 'user'), ev('r', 2, 'result')], [pub('a', 1)]).size).toBe(0);
    expect(turnArtifacts(events, []).size).toBe(0);
    expect(turnArtifacts([], [pub('a', 1)]).size).toBe(0);
  });
});

describe('matchWritten', () => {
  const w = (path: string, rel: string): WrittenArtifact => ({ path, rel, size: 1, mtime: 1, url: `/w?path=${path}` });
  const written = [w('/repo/docs/a.md', 'docs/a.md'), w('/repo/b.md', 'b.md')];

  it('matches Write, Edit and NotebookEdit rows by absolute path', () => {
    expect(matchWritten('Write', '/repo/docs/a.md', written)?.rel).toBe('docs/a.md');
    expect(matchWritten('Edit', '/repo/b.md', written)?.rel).toBe('b.md');
    expect(matchWritten('NotebookEdit', '/repo/b.md', written)?.rel).toBe('b.md');
  });

  it('matches a path that ends with the relative path, on a segment boundary only', () => {
    expect(matchWritten('Write', '/other/root/docs/a.md', written)?.rel).toBe('docs/a.md');
    expect(matchWritten('Write', 'docs/a.md', written)?.rel).toBe('docs/a.md');
    expect(matchWritten('Write', '/repo/xb.md', written)).toBeUndefined();
  });

  it('ignores other tools, empty summaries and unknown files', () => {
    expect(matchWritten('Read', '/repo/b.md', written)).toBeUndefined();
    expect(matchWritten(undefined, '/repo/b.md', written)).toBeUndefined();
    expect(matchWritten('Write', '  ', written)).toBeUndefined();
    expect(matchWritten('Write', '/repo/c.md', written)).toBeUndefined();
  });
});
