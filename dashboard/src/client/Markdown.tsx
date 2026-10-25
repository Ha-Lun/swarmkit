// Safe markdown subset for agent chat output. Builds React elements only:
// raw HTML in the input stays literal text (React escapes strings).
import { Fragment } from 'react';
import type { ReactElement, ReactNode } from 'react';

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'code'; v: string }
  | { t: 'strong'; c: Inline[] }
  | { t: 'em'; c: Inline[] }
  | { t: 'link'; href: string; c: Inline[] };
export type Block =
  | { t: 'p'; c: Inline[] }
  | { t: 'h'; level: 1 | 2 | 3; c: Inline[] }
  | { t: 'code'; lang?: string; v: string }
  | { t: 'ul' | 'ol'; items: Inline[][]; start?: number }
  | { t: 'quote'; c: Block[] }
  | { t: 'hr' };

function isSafeHref(href: string): boolean {
  try {
    const u = new URL(href.trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

const WORD = /[A-Za-z0-9]/;

function underscoreClose(s: string, from: number): number {
  for (let k = from; k < s.length; k++) {
    if (s[k] === '_' && !WORD.test(s[k + 1] ?? '')) return k;
  }
  return -1;
}

export function parseInline(s: string): Inline[] {
  const out: Inline[] = [];
  let buf = '';
  const flush = (): void => {
    if (buf) {
      out.push({ t: 'text', v: buf });
      buf = '';
    }
  };
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '`') {
      let n = 1;
      while (s[i + n] === '`') n++;
      const fence = '`'.repeat(n);
      const j = s.indexOf(fence, i + n);
      if (j >= 0) {
        flush();
        out.push({ t: 'code', v: s.slice(i + n, j) });
        i = j + n;
        continue;
      }
      buf += ch;
      i++;
      continue;
    }
    if (ch === '[') {
      const c = s.indexOf(']', i + 1);
      if (c >= 0 && s[c + 1] === '(') {
        let d = c + 2;
        let depth = 1;
        while (d < s.length && depth > 0) {
          if (s[d] === '(') depth++;
          else if (s[d] === ')') depth--;
          d++;
        }
        if (depth === 0) {
          const raw = s.slice(i, d);
          const href = s.slice(c + 2, d - 1);
          if (isSafeHref(href)) {
            flush();
            out.push({ t: 'link', href: href.trim(), c: parseInline(s.slice(i + 1, c)) });
          } else {
            buf += raw;
          }
          i = d;
          continue;
        }
      }
      buf += ch;
      i++;
      continue;
    }
    const dbl = s[i + 1] === ch ? ch + ch : '';
    if (dbl === '**' || (dbl === '__' && !WORD.test(i > 0 ? s[i - 1] : ' '))) {
      const j = s.indexOf(dbl, i + 2);
      if (j > i + 2) {
        flush();
        out.push({ t: 'strong', c: parseInline(s.slice(i + 2, j)) });
        i = j + 2;
        continue;
      }
      buf += ch;
      i++;
      continue;
    }
    if (ch === '*' || (ch === '_' && !WORD.test(i > 0 ? s[i - 1] : ' '))) {
      if (s[i + 1] === ch) {
        buf += ch;
        i++;
        continue;
      }
      const j = ch === '*' ? s.indexOf('*', i + 1) : underscoreClose(s, i + 1);
      if (j > i + 1) {
        flush();
        out.push({ t: 'em', c: parseInline(s.slice(i + 1, j)) });
        i = j + 1;
        continue;
      }
      buf += ch;
      i++;
      continue;
    }
    if (s.startsWith('http://', i) || s.startsWith('https://', i)) {
      const m = /^https?:\/\/[^\s<>\[\]]+/.exec(s.slice(i));
      if (m) {
        let url = m[0].replace(/[.,;:!?'"]+$/, '');
        while (url.endsWith(')') && url.split('(').length < url.split(')').length) {
          url = url.slice(0, -1);
        }
        if (url && isSafeHref(url)) {
          flush();
          out.push({ t: 'link', href: url, c: [{ t: 'text', v: url }] });
          i += url.length;
          continue;
        }
      }
    }
    buf += ch;
    i++;
  }
  flush();
  return out;
}

const HR = /^(-{3,}|\*{3,}|_{3,})$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const UL = /^[-*+]\s+(.*)$/;
const OL = /^(\d+)[.)]\s+(.*)$/;

function blockStart(t: string): boolean {
  return t.startsWith('```') || HR.test(t) || HEADING.test(t) || t.startsWith('>') || UL.test(t) || OL.test(t);
}

export function parseMarkdown(text: string): Block[] {
  const lines = text.split(/\r?\n/);
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const t = lines[i].trim();
    if (!t) {
      i++;
      continue;
    }
    if (t.startsWith('```')) {
      const lang = t.slice(3).trim().split(/\s+/)[0] || undefined;
      i++;
      const buf: string[] = [];
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        buf.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++;
      const v = buf.join('\n');
      blocks.push(lang ? { t: 'code', lang, v } : { t: 'code', v });
      continue;
    }
    if (HR.test(t)) {
      blocks.push({ t: 'hr' });
      i++;
      continue;
    }
    const h = HEADING.exec(t);
    if (h) {
      blocks.push({ t: 'h', level: Math.min(h[1].length, 3) as 1 | 2 | 3, c: parseInline(h[2]) });
      i++;
      continue;
    }
    if (t.startsWith('>')) {
      const inner: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        inner.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      blocks.push({ t: 'quote', c: parseMarkdown(inner.join('\n')) });
      continue;
    }
    const um = UL.exec(t);
    if (um) {
      const items: Inline[][] = [];
      while (i < lines.length) {
        const m = UL.exec(lines[i].trim());
        if (!m) break;
        items.push(parseInline(m[1]));
        i++;
      }
      blocks.push({ t: 'ul', items });
      continue;
    }
    const om = OL.exec(t);
    if (om) {
      const start = parseInt(om[1], 10);
      const items: Inline[][] = [];
      while (i < lines.length) {
        const m = OL.exec(lines[i].trim());
        if (!m) break;
        items.push(parseInline(m[2]));
        i++;
      }
      blocks.push({ t: 'ol', items, start });
      continue;
    }
    const buf: string[] = [];
    while (i < lines.length && lines[i].trim() && !blockStart(lines[i].trim())) {
      buf.push(lines[i]);
      i++;
    }
    blocks.push({ t: 'p', c: parseInline(buf.join('\n')) });
  }
  return blocks;
}

function renderInline(nodes: Inline[], key: string): ReactElement[] {
  return nodes.flatMap((n, idx): ReactElement[] => {
    const k = `${key}-${idx}`;
    if (n.t === 'text') {
      return n.v.split('\n').flatMap((p, j): ReactElement[] => {
        const parts: ReactElement[] = [];
        if (j > 0) parts.push(<br key={`${k}-br-${j}`} />);
        parts.push(<Fragment key={`${k}-t-${j}`}>{p}</Fragment>);
        return parts;
      });
    }
    if (n.t === 'code') return [<code key={k}>{n.v}</code>];
    if (n.t === 'strong') return [<strong key={k}>{renderInline(n.c, k)}</strong>];
    if (n.t === 'em') return [<em key={k}>{renderInline(n.c, k)}</em>];
    return [
      <a key={k} href={n.href} target="_blank" rel="noopener noreferrer">
        {renderInline(n.c, k)}
      </a>,
    ];
  });
}

function renderBlock(b: Block, key: number): ReactNode {
  switch (b.t) {
    case 'p':
      return <p key={key}>{renderInline(b.c, `b${key}`)}</p>;
    case 'h': {
      const Tag = b.level === 1 ? 'h3' : b.level === 2 ? 'h4' : 'h5';
      return <Tag key={key}>{renderInline(b.c, `b${key}`)}</Tag>;
    }
    case 'code':
      return (
        <pre key={key}>
          {b.lang && <span className="md-lang">{b.lang}</span>}
          <code data-lang={b.lang}>{b.v}</code>
        </pre>
      );
    case 'ul':
      return (
        <ul key={key}>
          {b.items.map((it, j) => (
            <li key={j}>{renderInline(it, `b${key}-${j}`)}</li>
          ))}
        </ul>
      );
    case 'ol':
      return (
        <ol key={key} start={b.start}>
          {b.items.map((it, j) => (
            <li key={j}>{renderInline(it, `b${key}-${j}`)}</li>
          ))}
        </ol>
      );
    case 'quote':
      return <blockquote key={key}>{b.c.map((c, j) => renderBlock(c, j))}</blockquote>;
    case 'hr':
      return <hr key={key} />;
  }
}

export function Markdown({ text, className }: { text: string; className?: string }): ReactElement {
  const blocks = parseMarkdown(text);
  return (
    <div className={'md' + (className ? ' ' + className : '')}>
      {blocks.map((b, idx) => renderBlock(b, idx))}
    </div>
  );
}
