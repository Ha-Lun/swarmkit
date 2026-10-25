// Safe markdown subset for agent chat output. Builds React elements only:
// raw HTML in the input stays literal text (React escapes strings).
import { Fragment, useMemo } from 'react';
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

function findStarClose(s: string, from: number): number {
  for (let k = from; k < s.length; k++) {
    if (s[k] !== '*') continue;
    if (s[k + 1] === '*' || (k > 0 && s[k - 1] === '*')) continue;
    return k;
  }
  return -1;
}

function findUndClose(s: string, from: number): number {
  for (let k = from; k < s.length; k++) {
    if (s[k] !== '_') continue;
    if (s[k + 1] === '_' || (k > 0 && s[k - 1] === '_')) continue;
    if (WORD.test(s[k + 1] ?? '')) continue;
    return k;
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
  let noCloseBracket = false;
  const noCloseParen = s.indexOf(')') === -1;
  let failTripleStar = false;
  let failTripleUnd = false;
  let failStrongStar = false;
  let failStrongUnd = false;
  let failStar = false;
  let failUnd = false;
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
      buf += fence;
      i += n;
      continue;
    }
    if (ch === '[') {
      if (noCloseBracket) {
        buf += ch;
        i++;
        continue;
      }
      const c = s.indexOf(']', i + 1);
      if (c === -1) {
        noCloseBracket = true;
        buf += ch;
        i++;
        continue;
      }
      if (s[c + 1] !== '(') {
        buf += ch;
        i++;
        continue;
      }
      if (noCloseParen) {
        buf += ch;
        i++;
        continue;
      }
      let end = -1;
      let depth = 1;
      for (let d = c + 2; d < s.length; d++) {
        if (d - (c + 2) > 2048) break;
        const chd = s[d];
        if (chd === '(') {
          depth++;
        } else if (chd === ')') {
          depth--;
          if (depth === 0) {
            end = d;
            break;
          }
        } else if (chd === ' ' || chd === '\t' || chd === '\n' || chd === '\r') {
          break;
        }
      }
      if (end !== -1) {
        const href = s.slice(c + 2, end);
        if (isSafeHref(href)) {
          flush();
          out.push({ t: 'link', href: href.trim(), c: parseInline(s.slice(i + 1, c)) });
        } else {
          buf += s.slice(i, end + 1);
        }
        i = end + 1;
        continue;
      }
      buf += ch;
      i++;
      continue;
    }
    if (s.startsWith('***', i)) {
      if (!failTripleStar) {
        const j = s.indexOf('***', i + 3);
        if (j > i + 3) {
          flush();
          out.push({ t: 'strong', c: [{ t: 'em', c: parseInline(s.slice(i + 3, j)) }] });
          i = j + 3;
          continue;
        }
        failTripleStar = true;
      }
      buf += ch;
      i++;
      continue;
    }
    if (s.startsWith('___', i) && !WORD.test(i > 0 ? s[i - 1] : ' ')) {
      if (!failTripleUnd) {
        const j = s.indexOf('___', i + 3);
        if (j > i + 3) {
          flush();
          out.push({ t: 'strong', c: [{ t: 'em', c: parseInline(s.slice(i + 3, j)) }] });
          i = j + 3;
          continue;
        }
        failTripleUnd = true;
      }
      buf += ch;
      i++;
      continue;
    }
    const dbl = s[i + 1] === ch ? ch + ch : '';
    if (dbl === '**' || (dbl === '__' && !WORD.test(i > 0 ? s[i - 1] : ' '))) {
      if (dbl === '**') {
        if (!failStrongStar) {
          const j = s.indexOf(dbl, i + 2);
          if (j > i + 2) {
            flush();
            out.push({ t: 'strong', c: parseInline(s.slice(i + 2, j)) });
            i = j + 2;
            continue;
          }
          failStrongStar = true;
        }
        buf += ch;
        i++;
        continue;
      }
      if (!failStrongUnd) {
        const j = s.indexOf(dbl, i + 2);
        if (j > i + 2) {
          flush();
          out.push({ t: 'strong', c: parseInline(s.slice(i + 2, j)) });
          i = j + 2;
          continue;
        }
        failStrongUnd = true;
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
      if (ch === '*') {
        if (failStar) {
          buf += ch;
          i++;
          continue;
        }
        const j = findStarClose(s, i + 1);
        if (j > i + 1) {
          flush();
          out.push({ t: 'em', c: parseInline(s.slice(i + 1, j)) });
          i = j + 1;
          continue;
        }
        failStar = true;
        buf += ch;
        i++;
        continue;
      }
      if (failUnd) {
        buf += ch;
        i++;
        continue;
      }
      const j = findUndClose(s, i + 1);
      if (j > i + 1) {
        flush();
        out.push({ t: 'em', c: parseInline(s.slice(i + 1, j)) });
        i = j + 1;
        continue;
      }
      failUnd = true;
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
const HEADING = /^(#{1,6})[ \t]+([\s\S]*)$/;
const UL = /^[-*+][ \t]+([\s\S]*)$/;
const OL = /^(\d+)[.)][ \t]+([\s\S]*)$/;

const MAX_QUOTE_DEPTH = 8;

function blockStart(t: string): boolean {
  return t.startsWith('```') || HR.test(t) || HEADING.test(t) || t.startsWith('>') || UL.test(t) || OL.test(t);
}

function blockStartNoQuote(t: string): boolean {
  return t.startsWith('```') || HR.test(t) || HEADING.test(t) || UL.test(t) || OL.test(t);
}

function parseBlocks(lines: string[], depth: number): Block[] {
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
      if (depth >= MAX_QUOTE_DEPTH) {
        const buf: string[] = [];
        while (i < lines.length && lines[i].trim() && !blockStartNoQuote(lines[i].trim())) {
          buf.push(lines[i]);
          i++;
        }
        if (buf.length) {
          blocks.push({ t: 'p', c: parseInline(buf.join('\n')) });
        } else {
          blocks.push({ t: 'p', c: parseInline(t) });
          i++;
        }
        continue;
      }
      const inner: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        inner.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      blocks.push({ t: 'quote', c: parseBlocks(inner, depth + 1) });
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

export function parseMarkdown(text: string): Block[] {
  return parseBlocks(text.split(/\r?\n/), 0);
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
  const blocks = useMemo(() => (text.length > 100_000 ? [] : parseMarkdown(text)), [text]);
  if (text.length > 100_000) {
    return <pre className="md md-raw">{text}</pre>;
  }
  return (
    <div className={'md' + (className ? ' ' + className : '')}>
      {blocks.map((b, idx) => renderBlock(b, idx))}
    </div>
  );
}
