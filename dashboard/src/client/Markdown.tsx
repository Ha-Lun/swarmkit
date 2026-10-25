// Rich markdown for agent chat output, built on react-markdown:
// GFM tables/task lists, math via remark-math + KaTeX, syntax
// highlighting via rehype-highlight, mermaid diagrams. Raw HTML is
// never rendered (no rehype-raw); URLs go through a strict transform.
import { useEffect, useMemo, useRef, useState, isValidElement } from 'react';
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
  const [copied, setCopied] = useState(false);
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
        setCopied(true);
        if (timer.current !== null) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setCopied(false), 1500);
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

const components: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
  img: ({ src, alt }) => {
    const s = src ?? '';
    if (s.startsWith('data:image/') || (s.startsWith('/') && !s.startsWith('//'))) {
      return <img loading="lazy" src={s} alt={alt ?? ''} />;
    }
    return (
      <a href={s} target="_blank" rel="noopener noreferrer">
        🖼 {alt || 'image'}
      </a>
    );
  },
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children }) => <CodeBlock className={className}>{children}</CodeBlock>,
  table: ({ children }) => (
    <div className="md-table-wrap">
      <table>{children}</table>
    </div>
  ),
};

export function Markdown({ text, className }: { text: string; className?: string }): ReactElement {
  const normalized = useMemo(() => (text.length > RAW_LIMIT ? null : normalizeMath(text)), [text]);
  const tree = useMemo(() => {
    if (normalized === null) return null;
    return (
      <ReactMarkdown
        remarkPlugins={[remarkGfm, [remarkMath, { singleDollarTextMath: true }]]}
        rehypePlugins={[
          [rehypeKatex, { throwOnError: false, strict: 'ignore', output: 'htmlAndMathml' }],
          [rehypeHighlight, { detect: false, ignoreMissing: true }],
        ]}
        components={components}
        urlTransform={(url, key) => {
          if (key === 'src' && /^data:image\/(png|jpeg|gif|webp);base64,/i.test(url)) return url;
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
