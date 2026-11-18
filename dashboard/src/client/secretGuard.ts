// Paste guard: spots credentials in a message before it is sent to the agent, so the user can
// store them as a project secret instead. Runs on send only, so a handful of linear regexes is fine.

export interface SecretMatch {
  /** Human label, e.g. "Anthropic API key". */
  kind: string;
  /** The matched text, used to prefill the Secrets form. Never logged or stored by the guard. */
  token: string;
}

// A key may not continue an identifier: "risk-assessment-…" must not read as an "sk-" key.
const NOT_WORD = '(?<![A-Za-z0-9_-])';

interface Rule {
  kind: string;
  re: RegExp;
  /** Extra check on the match; keeps hyphenated words from passing as generic keys. */
  accept?: (token: string) => boolean;
}

const RULES: Rule[] = [
  {
    kind: 'private key',
    re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----(?:[\s\S]*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----|[\s\S]*)/,
  },
  { kind: 'Anthropic API key', re: new RegExp(`${NOT_WORD}sk-ant-[A-Za-z0-9_-]{16,}`) },
  { kind: 'Stripe key', re: new RegExp(`${NOT_WORD}(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}`) },
  {
    kind: 'API key',
    re: new RegExp(`${NOT_WORD}sk-[A-Za-z0-9_-]{20,}`),
    // Real keys mix cases or digits; "sk-some-long-lowercase-slug" is just a word.
    accept: (t) => /[0-9A-Z]/.test(t.slice(3)),
  },
  { kind: 'GitHub token', re: new RegExp(`${NOT_WORD}(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})`) },
  { kind: 'AWS access key', re: new RegExp(`${NOT_WORD}(?:AKIA|ASIA)[0-9A-Z]{16}(?![0-9A-Za-z])`) },
  { kind: 'Slack token', re: new RegExp(`${NOT_WORD}xox[abprs]-[A-Za-z0-9-]{10,}`) },
  { kind: 'JWT', re: new RegExp(`${NOT_WORD}eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}`) },
  { kind: 'Google API key', re: new RegExp(`${NOT_WORD}AIza[0-9A-Za-z_-]{35}`) },
];

/** The first credential-shaped token in `text`, or null. */
export function looksLikeSecret(text: string): SecretMatch | null {
  for (const rule of RULES) {
    const m = rule.re.exec(text);
    if (m && (!rule.accept || rule.accept(m[0]))) return { kind: rule.kind, token: m[0] };
  }
  return null;
}
