// Tests for the speech-to-text dictation pure helpers (transcript appending + final chunk extraction).
import { describe, expect, it } from 'vitest';
import { appendTranscript, finalChunks } from '../src/client/Dictation.tsx';

describe('appendTranscript', () => {
  it('returns trimmed chunk when text is empty', () => {
    expect(appendTranscript('', 'hello world')).toBe('hello world');
    expect(appendTranscript('', '  hello world  ')).toBe('hello world');
  });

  it('inserts a single space when text does not end with whitespace', () => {
    expect(appendTranscript('hello', 'world')).toBe('hello world');
    expect(appendTranscript('hello', '  world  ')).toBe('hello world');
  });

  it('does not insert an extra space when text ends with a space, tab, or newline', () => {
    expect(appendTranscript('hello ', 'world')).toBe('hello world');
    expect(appendTranscript('hello\n', 'world')).toBe('hello\nworld');
    expect(appendTranscript('hello\t', 'world')).toBe('hello\tworld');
    expect(appendTranscript('   ', 'world')).toBe('   world');
  });

  it('returns text unchanged when chunk is empty or whitespace-only', () => {
    expect(appendTranscript('', '')).toBe('');
    expect(appendTranscript('hello', '')).toBe('hello');
    expect(appendTranscript('hello', '   \t\n  ')).toBe('hello');
    expect(appendTranscript('hello ', '  ')).toBe('hello ');
  });
});

describe('finalChunks', () => {
  it('extracts only finalized entries starting from resultIndex', () => {
    const results = [
      { isFinal: true, 0: { transcript: 'old' } },
      { isFinal: false, 0: { transcript: 'interim' } },
      { isFinal: true, 0: { transcript: 'fresh' } },
      { isFinal: false, 0: { transcript: 'trailing' } },
    ];
    const emitted = new Set<number>();

    expect(finalChunks(results, 1, emitted)).toEqual(['fresh']);
    expect(emitted.has(0)).toBe(false);
    expect(emitted.has(1)).toBe(false);
    expect(emitted.has(2)).toBe(true);
    expect(emitted.has(3)).toBe(false);
  });

  it('de-duplicates already-emitted final indices across calls with the same emitted set', () => {
    const emitted = new Set<number>();
    const firstBatch = [
      { isFinal: true, 0: { transcript: 'one' } },
      { isFinal: false, 0: { transcript: 'tw' } },
    ];

    expect(finalChunks(firstBatch, 0, emitted)).toEqual(['one']);

    // Android Chrome re-delivers index 0 with resultIndex 0 when index 1 finalizes.
    const secondBatch = [
      { isFinal: true, 0: { transcript: 'one' } },
      { isFinal: true, 0: { transcript: 'two' } },
      { isFinal: true, 0: { transcript: 'three' } },
    ];

    expect(finalChunks(secondBatch, 0, emitted)).toEqual(['two', 'three']);
    expect(finalChunks(secondBatch, 0, emitted)).toEqual([]);
  });

  it('handles empty results and out-of-range resultIndex', () => {
    const emitted = new Set<number>();
    expect(finalChunks([], 0, emitted)).toEqual([]);
    expect(finalChunks([{ isFinal: true, 0: { transcript: 'a' } }], 5, emitted)).toEqual([]);
  });
});
