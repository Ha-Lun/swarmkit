import { describe, expect, it } from 'vitest';
import { answerFor, fallbackQuestionTexts, parseAskQuestions, planRejectMessage } from '../src/client/Permission';

const opt = (label: string, description = 'd') => ({ label, description });

function askInput(questions: unknown[]) {
  return { questions };
}

describe('parseAskQuestions', () => {
  it('parses 1-4 well-formed questions', () => {
    const out = parseAskQuestions(askInput([
      { question: 'Which layout?', header: 'Layout', multiSelect: false, options: [opt('A'), opt('B')] },
    ]));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ question: 'Which layout?', header: 'Layout', multiSelect: false });
    expect(out[0]!.options).toHaveLength(2);
  });

  it('returns [] for missing/non-array questions', () => {
    expect(parseAskQuestions(undefined)).toEqual([]);
    expect(parseAskQuestions(null)).toEqual([]);
    expect(parseAskQuestions({})).toEqual([]);
    expect(parseAskQuestions({ questions: 'nope' })).toEqual([]);
  });

  it('skips malformed entries (blank question, no options)', () => {
    const out = parseAskQuestions(askInput([
      { question: 'Good?', options: [opt('Yes')] },
      { question: '   ', options: [opt('Yes')] },
      { question: 'No options?' },
      { options: [opt('Yes')] },
    ]));
    expect(out.map(q => q.question)).toEqual(['Good?']);
  });

  it('caps at 4 parsed questions', () => {
    const raw = Array.from({ length: 6 }, (_, i) => ({ question: `Q${i}?`, options: [opt('Yes')] }));
    expect(parseAskQuestions(askInput(raw))).toHaveLength(4);
  });
});

describe('answerFor', () => {
  it('joins picked labels', () => {
    expect(answerFor({ picked: ['A', 'B'], otherOn: false, otherText: '' })).toBe('A, B');
  });

  it('appends non-blank Other text', () => {
    expect(answerFor({ picked: ['A'], otherOn: true, otherText: ' custom ' })).toBe('A, custom');
    expect(answerFor({ picked: [], otherOn: true, otherText: 'solo' })).toBe('solo');
  });

  it('Other checked with blank text is unanswered, even with picks (multi-select too)', () => {
    expect(answerFor({ picked: [], otherOn: true, otherText: '' })).toBe('');
    expect(answerFor({ picked: [], otherOn: true, otherText: '   ' })).toBe('');
    expect(answerFor({ picked: ['A', 'B'], otherOn: true, otherText: '  ' })).toBe('');
  });

  it('empty state is unanswered', () => {
    expect(answerFor({ picked: [], otherOn: false, otherText: '' })).toBe('');
  });
});

describe('fallbackQuestionTexts', () => {
  it('collects string question texts', () => {
    expect(fallbackQuestionTexts(askInput([
      { question: 'Q1?' },
      { question: 'Q2?' },
    ]))).toEqual(['Q1?', 'Q2?']);
  });

  it('skips non-objects and non-string/empty questions', () => {
    expect(fallbackQuestionTexts(askInput([null, 42, {}, { question: 7 }, { question: '' }, { question: 'Ok?' }]))).toEqual(['Ok?']);
    expect(fallbackQuestionTexts({})).toEqual([]);
    expect(fallbackQuestionTexts(undefined)).toEqual([]);
  });
});

describe('planRejectMessage', () => {
  it('wraps trimmed feedback for the model', () => {
    expect(planRejectMessage('  use a smaller scope \n')).toBe(
      'Keep planning. Feedback from the user: use a smaller scope',
    );
  });

  it('falls back to a plain rejection when feedback is blank', () => {
    expect(planRejectMessage('')).toBe('The user rejected the plan; keep planning.');
    expect(planRejectMessage('   \n ')).toBe('The user rejected the plan; keep planning.');
  });
});
