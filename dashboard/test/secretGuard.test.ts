// Tests for the paste guard that keeps credentials out of chat messages.
import { describe, expect, it } from 'vitest';
import { looksLikeSecret } from '../src/client/secretGuard.ts';

const kind = (s: string) => looksLikeSecret(s)?.kind ?? null;

describe('looksLikeSecret: detects', () => {
  it('Anthropic keys', () => {
    expect(kind('sk-ant-api03-abcdefghijklmnopqrstuvwxyz')).toBe('Anthropic API key');
  });
  it('OpenAI-style sk- keys with mixed characters', () => {
    expect(kind('use sk-proj-Ab3dEfGh1jKlMnOp4rStUvWx please')).toBe('API key');
  });
  it('GitHub tokens', () => {
    expect(kind(`ghp_${'a1B2'.repeat(9)}`)).toBe('GitHub token');
    expect(kind(`github_pat_${'A1b2C3d4E5'.repeat(3)}`)).toBe('GitHub token');
  });
  it('AWS access key ids', () => {
    expect(kind('AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE')).toBe('AWS access key');
  });
  it('Slack tokens', () => {
    expect(kind('xoxb-123456789012-abcdefghijkl')).toBe('Slack token');
    expect(kind('xoxp-123456789012-abcdefghijkl')).toBe('Slack token');
  });
  it('private key blocks, whole block as the token', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nabc\n-----END RSA PRIVATE KEY-----';
    const m = looksLikeSecret(`here:\n${pem}\nthanks`);
    expect(m?.kind).toBe('private key');
    expect(m?.token).toBe(pem);
    expect(kind('-----BEGIN PRIVATE KEY-----\nMIIEvQ')).toBe('private key');
    expect(kind('-----BEGIN OPENSSH PRIVATE KEY-----\nb3Blbn')).toBe('private key');
  });
  it('JWTs', () => {
    expect(kind('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r')).toBe('JWT');
  });
  it('Google API keys', () => {
    expect(kind(`AIza${'Sy-_0123456789abcdefghijklmnopqrstu'}`)).toBe('Google API key');
  });
  it('Stripe keys', () => {
    expect(kind(`sk_live_${'4eC39HqLyjWDarjtT1zdp7dc'}`)).toBe('Stripe key');
    expect(kind(`rk_test_${'4eC39HqLyjWDarjtT1zdp7dc'}`)).toBe('Stripe key');
  });
  it('returns the matched token for prefill', () => {
    expect(looksLikeSecret('key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz, ok?')?.token).toBe(
      'sk-ant-api03-abcdefghijklmnopqrstuvwxyz',
    );
  });
});

describe('looksLikeSecret: leaves normal text alone', () => {
  it.each([
    'Please fix the failing tests in src/client/Composer.tsx and keep the diff small.',
    'We should avoid risk-assessment-framework-documentation-sprawl in the docs.',
    'ask-for-help-with-the-migration-before-friday',
    'sk-learn-style-names-are-lowercase-slugs',
    'const key = process.env.OPENAI_API_KEY; if (!key) throw new Error("missing key");',
    'git checkout 3f786850e387550fdab836ed7e6dc881de23001b',
    'id: 550e8400-e29b-41d4-a716-446655440000',
    'headers: { Authorization: `Bearer ${token}` }',
    'The prefix sk-ant- identifies Anthropic keys, and ghp_ marks GitHub ones.',
    'AKIA is the prefix; AKIAshort is not a key; xoxb- alone is not either.',
    'sk_test_xxx and sk_live_YOUR_KEY are placeholders',
    '-----BEGIN CERTIFICATE-----\nMIIC\n-----END CERTIFICATE-----',
    'eyJ is how base64 JSON starts',
    '',
  ])('%s', (text) => {
    expect(looksLikeSecret(text)).toBeNull();
  });
});
