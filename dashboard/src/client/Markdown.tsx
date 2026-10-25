// Rich markdown for agent chat output, built on react-markdown:
// GFM tables/task lists, math via remark-math + KaTeX, syntax
// highlighting via rehype-highlight, mermaid diagrams. Raw HTML is
// never rendered (no rehype-raw); URLs go through a strict transform.
import { memo, useEffect, useMemo, useRef, useState, isValidElement } from 'react';
import type { ReactElement, ReactNode } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import rehypeHighlight from 'rehype-highlight';
import 'katex/dist/katex.min.css';
import './markdown.css';
import { Mermaid } from './Mermaid';
import { isSafeImageUrl } from './chat';

const RAW_LIMIT = 100_000;

/**
 * Convert \(…\) to $…$ and \[…\] to display $$…$$ (delimiters on
 * their own lines), and protect currency-style amounts ($5) from
 * single-dollar math, leaving fenced code blocks and inline code
 * spans untouched. Single linear pass — no nested scans.
 */
export function normalizeMath(input: string): string {
  const out: string[] = [];
  const n = input.length;
  let i = 0;
  let inFence = false;
  let inInline = false;
  while (i < n) {
    if (!inInline && input.startsWith('```', i)) {
      inFence = !inFence;
      out.push('```');
      i += 3;
      continue;
    }
    const ch = input[i];
    if (!inFence && ch === '`') {
      let j = i + 1;
      while (j < n && input[j] === '`') j++;
      out.push(input.slice(i, j));
      inInline = !inInline;
      i = j;
      continue;
    }
    if (inFence || inInline) {
      out.push(ch);
      i += 1;
      continue;
    }
    if (ch === '$') {
      const prev = i > 0 ? input[i - 1] : '';
      const nx = i + 1 < n ? input[i + 1] : '';
      const isDigit = nx >= '0' && nx <= '9';
      // A line that is only $$…$$ is display math: give it block delimiters
      // (remark-math otherwise treats one-line $$ as inline).
      if (nx === '$' && (i === 0 || prev === '\n')) {
        const eolAt = input.indexOf('\n', i);
        const end = eolAt === -1 ? n : eolAt;
        const line = input.slice(i, end).trimEnd();
        if (line.length > 4 && line.endsWith('$$') && line.indexOf('$$', 2) === line.length - 2) {
          out.push('$$\n', line.slice(2, -2), '\n$$');
          i += line.length;
          continue;
        }
      }
      // Keep $$ delimiters intact; escape $5-style amounts so
      // single-dollar math does not swallow prices.
      if (isDigit && prev !== '$') {
        out.push('\\$');
        i += 1;
        continue;
      }
      out.push(ch);
      i += 1;
      continue;
    }
    if (ch === '\\' && i + 1 < n) {
      const nx = input[i + 1];
      if (nx === '\\') {
        out.push('\\\\');
        i += 2;
        continue;
      }
      if (nx === '(' || nx === ')') {
        out.push('$');
        i += 2;
        continue;
      }
      if (nx === '[') {
        out.push('$$\n');
        i += 2;
        continue;
      }
      if (nx === ']') {
        out.push('\n$$');
        i += 2;
        continue;
      }
    }
    out.push(ch);
    i += 1;
  }
  return out.join('');
}

/** Recover raw text from (possibly highlight-wrapped) code children. */
function textOf(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return '';
}

function CodeBlock({ className, children }: { className?: string; children?: ReactNode }): ReactElement {
  const raw = textOf(children).replace(/\n$/, '');
  const match = /language-([\w+-]+)/.exec(className ?? '');
  const lang = match?.[1];
  // Copied state is keyed by content: re-renders with identical text keep
  // the "Copied" label, while newly streamed content resets it.
  const [copiedFor, setCopiedFor] = useState<string | null>(null);
  const copied = copiedFor !== null && copiedFor === raw;
  const timer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );
  if (lang === 'mermaid') {
    return <Mermaid code={raw} />;
  }
  if (!lang && !raw.includes('\n')) {
    return <code className={className}>{children}</code>;
  }
  const onCopy = (): void => {
    const clip = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
    if (!clip) return;
    clip.writeText(raw).then(
      () => {
        setCopiedFor(raw);
        if (timer.current !== null) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setCopiedFor(null), 1500);
      },
      () => undefined,
    );
  };
  return (
    <div className="md-codeblock">
      <div className="md-codeblock-head">
        <span className="md-lang">{lang ?? 'code'}</span>
        <button type="button" className="md-copy" onClick={onCopy}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre>
        <code className={className}>{children}</code>
      </pre>
    </div>
  );
}

/** Only safe image URLs render inline; every other src becomes a 🖼 link. */
const components: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
  img: ({ src, alt }) => {
    const s = src ?? '';
    if (isSafeImageUrl(s)) {
      return <img loading="lazy" src={s} alt={alt ?? ''} />;
    }
    return (
      <a href={s} target="_blank" rel="noopener noreferrer">
        🖼 {alt || 'image'}
      </a>
    );
  },
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children }) => {
    // Key the block by its content so identical text keeps the copied state
    // across parent re-renders, while changed content remounts and resets it.
    const key = textOf(children);
    return <CodeBlock key={key} className={className}>{children}</CodeBlock>;
  },
  table: ({ children }) => (
    <div className="md-table-wrap">
      <table>{children}</table>
    </div>
  ),
};

function MarkdownInner({ text, className }: { text: string; className?: string }): ReactElement {
  const normalized = useMemo(() => (text.length > RAW_LIMIT ? null : normalizeMath(text)), [text]);
  const tree = useMemo(() => {
    if (normalized === null) return null;
    return (
      <ReactMarkdown
        remarkPlugins={[remarkGfm, [remarkMath, { singleDollarTextMath: true }]]}
        rehypePlugins={[
          [rehypeKatex, { throwOnError: false, strict: 'ignore', output: 'htmlAndMathml', maxSize: 20, maxExpand: 1000 }],
          [rehypeHighlight, { detect: false, ignoreMissing: true }],
        ]}
        components={components}
        urlTransform={(url, key) => {
          if (key === 'src' && isSafeImageUrl(url)) return url;
          return defaultUrlTransform(url);
        }}
      >
        {normalized}
      </ReactMarkdown>
    );
  }, [normalized]);
  if (normalized === null) {
    return <pre className="md md-raw">{text}</pre>;
  }
  return <div className={'md' + (className ? ' ' + className : '')}>{tree}</div>;
}

export const Markdown = memo(MarkdownInner);
