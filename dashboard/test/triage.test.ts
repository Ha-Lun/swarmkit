import { describe, expect, it } from 'vitest';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { QueryFn } from '../server/sdk/sessions.ts';
import { triage, triageStartBody } from '../server/triage.ts';

function fakeTriageQuery(reply: string, opts?: { inResult?: boolean; isError?: boolean }): {
  queryFn: QueryFn;
  calls: Array<{ prompt: unknown; options: Options | undefined }>;
} {
  const calls: Array<{ prompt: unknown; options: Options | undefined }> = [];
  const queryFn: QueryFn = ({ prompt, options }) => {
    calls.push({ prompt, options });
    return (async function* (): AsyncGenerator<unknown, void> {
      yield { type: 'system', subtype: 'init', model: 'claude-sonnet-5-5' };
      if (opts?.inResult) {
        yield { type: 'result', subtype: opts.isError ? 'error' : 'success', is_error: opts.isError, result: reply };
      } else {
        yield {
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: reply }] },
        };
        yield { type: 'result', subtype: 'success' };
      }
    })() as unknown as AsyncIterable<SDKMessage>;
  };
  return { queryFn, calls };
}

describe('triage', () => {
  it('maps trivial, normal, and hard to the expected model and effort', async () => {
    const cases = [
      { level: 'trivial', model: 'sonnet', effort: 'medium', reason: 'version bump' },
      { level: 'normal', model: 'sonnet', effort: 'high', reason: 'clean disk space' },
      { level: 'hard', model: 'opus', effort: 'high', reason: 'auth redesign' },
    ] as const;

    for (const c of cases) {
      const { queryFn } = fakeTriageQuery(JSON.stringify({ level: c.level, reason: c.reason }));
      const res = await triage('do work', { queryFn });
      expect(res).toMatchObject({
        level: c.level,
        model: c.model,
        effort: c.effort,
        reason: c.reason,
        source: 'model',
      });
      expect(res.ms).toBeGreaterThanOrEqual(0);
    }
  });

  it('extracts JSON wrapped in prose/fences and reads result.result when present', async () => {
    const { queryFn } = fakeTriageQuery('```json\n{"level":"normal","reason":"two-file edit"}\n```', {
      inResult: true,
    });
    const res = await triage('update two files', { queryFn });
    expect(res).toMatchObject({
      level: 'normal',
      model: 'sonnet',
      effort: 'high',
      reason: 'two-file edit',
      source: 'model',
    });
  });

  it('falls back to opus/high on garbled replies, invalid levels, or query errors', async () => {
    for (const bad of ['not json at all', '{"level":"unknown","reason":"x"}', '{}']) {
      const { queryFn } = fakeTriageQuery(bad);
      const res = await triage('help', { queryFn });
      expect(res).toMatchObject({
        level: 'hard',
        model: 'opus',
        effort: 'high',
        reason: '',
        source: 'fallback',
      });
    }

    const throwing: QueryFn = () => {
      throw new Error('boom');
    };
    const errRes = await triage('help', { queryFn: throwing });
    expect(errRes).toMatchObject({
      level: 'hard',
      model: 'opus',
      effort: 'high',
      reason: '',
      source: 'fallback',
    });

    const { queryFn: errorResult } = fakeTriageQuery('{"level":"trivial","reason":"ok"}', {
      inResult: true,
      isError: true,
    });
    expect(await triage('help', { queryFn: errorResult })).toMatchObject({
      level: 'hard',
      model: 'opus',
      effort: 'high',
      reason: '',
      source: 'fallback',
    });
  });

  it('falls back after timeoutMs and aborts the query abortController when queryFn never yields', async () => {
    let seenOptions: Options | undefined;
    const hanging: QueryFn = ({ options }) => {
      seenOptions = options;
      return (async function* (): AsyncGenerator<unknown, void> {
        await new Promise<void>(() => {});
      })() as unknown as AsyncIterable<SDKMessage>;
    };

    const res = await triage('slow prompt', { queryFn: hanging, timeoutMs: 25 });
    expect(res).toMatchObject({
      level: 'hard',
      model: 'opus',
      effort: 'high',
      reason: '',
      source: 'fallback',
    });
    expect(seenOptions?.abortController?.signal.aborted).toBe(true);
  });

  it('falls back without calling queryFn when signal is pre-aborted', async () => {
    let called = false;
    const queryFn: QueryFn = () => {
      called = true;
      throw new Error('should not run');
    };
    const ac = new AbortController();
    ac.abort();

    const res = await triage('anything', { queryFn, signal: ac.signal });
    expect(called).toBe(false);
    expect(res).toMatchObject({
      level: 'hard',
      model: 'opus',
      effort: 'high',
      reason: '',
      source: 'fallback',
    });
  });

  it('skips queryFn for attachment-only prompts ("(image)" and "(file)")', async () => {
    let called = false;
    const queryFn: QueryFn = () => {
      called = true;
      throw new Error('should not run');
    };

    for (const sentinel of ['(image)', '(file)']) {
      const res = await triage(sentinel, { queryFn, hasAttachments: true });
      expect(called).toBe(false);
      expect(res).toMatchObject({
        level: 'hard',
        model: 'opus',
        effort: 'high',
        reason: 'attachments only',
        source: 'fallback',
      });
    }
  });

  it('sanitises reason: strips control chars, trims, clips to 80 chars, and defaults missing to empty', async () => {
    const longReason = `  \x00hello\n\t\x7f ${'a'.repeat(200)}  `;
    const { queryFn } = fakeTriageQuery(JSON.stringify({ level: 'trivial', reason: longReason }));
    const res = await triage('bump version', { queryFn });
    expect(res.reason).toBe(`hello ${'a'.repeat(74)}`);
    expect(res.reason).toHaveLength(80);
    expect(/[\x00-\x1f\x7f]/.test(res.reason)).toBe(false);

    const { queryFn: noReasonQuery } = fakeTriageQuery(JSON.stringify({ level: 'normal' }));
    const resNoReason = await triage('do stuff', { queryFn: noReasonQuery });
    expect(resNoReason.reason).toBe('');
  });

  it('isolates the triage query options and builds the expected prompt', async () => {
    const { queryFn, calls } = fakeTriageQuery('{"level":"trivial","reason":"ok"}');
    const longUserText = `${'x'.repeat(4500)} tail-beyond-4000`;
    await triage(longUserText, { queryFn, hasAttachments: true });

    expect(calls).toHaveLength(1);
    const { prompt, options } = calls[0]!;
    expect(options).toMatchObject({
      model: 'claude-sonnet-5-5',
      effort: 'low',
      persistSession: false,
      tools: [],
      settingSources: [],
      mcpServers: {},
      strictMcpConfig: true,
      maxTurns: 1,
    });
    expect(options?.abortController).toBeInstanceOf(AbortController);
    await expect(
      options!.canUseTool!('Bash', {}, { signal: new AbortController().signal, toolUseID: 't1', requestId: 'req-t1' }),
    ).resolves.toEqual({ behavior: 'deny', message: 'triage' });

    expect(typeof prompt).toBe('string');
    const promptStr = prompt as string;
    expect(promptStr).toContain('The request has attachments. Request: ');
    expect(promptStr).toContain(JSON.stringify('x'.repeat(4000)));
    expect(promptStr).not.toContain('tail-beyond-4000');

    const { queryFn: noAttFn, calls: noAttCalls } = fakeTriageQuery('{"level":"trivial","reason":"ok"}');
    await triage('hello "world"', { queryFn: noAttFn });
    const noAttPrompt = noAttCalls[0]!.prompt as string;
    expect(noAttPrompt).not.toContain('The request has attachments.');
    expect(noAttPrompt).toContain(`Request: ${JSON.stringify('hello "world"')}`);
  });
});

describe('triageStartBody', () => {
  it('triages claude start bodies without a model and overrides any client effort', async () => {
    const { queryFn, calls } = fakeTriageQuery('{"level":"trivial","reason":"one-line fix"}');
    const out = await triageStartBody(
      {
        prompt: 'fix typo in README',
        cwd: '/tmp',
        effort: 'low',
        images: [{ mediaType: 'image/png', data: 'abc' }],
      },
      { queryFn },
    );

    expect(calls).toHaveLength(1);
    expect((calls[0]!.prompt as string)).toContain('The request has attachments.');
    expect((out as { model?: string }).model).toBe('sonnet');
    expect(out.effort).toBe('medium');
    expect(out.triage).toEqual({
      level: 'trivial',
      reason: 'one-line fix',
      source: 'model',
    });
  });

  it('leaves claude start bodies with an explicit model unchanged without calling queryFn', async () => {
    let called = false;
    const queryFn: QueryFn = () => {
      called = true;
      throw new Error('should not run');
    };
    const body = { prompt: 'fix bug', model: 'sonnet', effort: 'low' as const };
    const out = await triageStartBody(body, { queryFn });
    expect(called).toBe(false);
    expect(out).toEqual(body);
    expect(out.triage).toBeUndefined();
  });

  it('leaves opencode and agy start bodies unchanged without calling queryFn', async () => {
    let called = false;
    const queryFn: QueryFn = () => {
      called = true;
      throw new Error('should not run');
    };

    for (const runtime of ['opencode', 'agy'] as const) {
      const body = { runtime, prompt: 'do work' };
      const out = await triageStartBody(body, { queryFn });
      expect(called).toBe(false);
      expect(out).toEqual(body);
      expect(out.triage).toBeUndefined();
    }
  });
});
