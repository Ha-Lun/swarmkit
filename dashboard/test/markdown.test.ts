import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Markdown, parseInline, parseMarkdown } from '../src/client/Markdown.tsx';

describe('parseMarkdown paragraphs', () => {
  it('joins consecutive lines and splits on blank lines', () => {
    const blocks = parseMarkdown('a\nb\n\nc');
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ t: 'p', c: [{ t: 'text', v: 'a\nb' }] });
    expect(blocks[1]).toEqual({ t: 'p', c: [{ t: 'text', v: 'c' }] });
  });
});

describe('parseMarkdown headings', () => {
  it('maps levels and caps ####+ at 3', () => {
    expect(parseMarkdown('# A')).toEqual([{ t: 'h', level: 1, c: [{ t: 'text', v: 'A' }] }]);
    expect(parseMarkdown('## B')).toEqual([{ t: 'h', level: 2, c: [{ t: 'text', v: 'B' }] }]);
    expect(parseMarkdown('### C')).toEqual([{ t: 'h', level: 3, c: [{ t: 'text', v: 'C' }] }]);
    expect(parseMarkdown('#### D')).toEqual([{ t: 'h', level: 3, c: [{ t: 'text', v: 'D' }] }]);
  });
});

describe('parseMarkdown fenced code', () => {
  it('captures language and body', () => {
    expect(parseMarkdown('```ts\nconst x = 1;\n```')).toEqual([{ t: 'code', lang: 'ts', v: 'const x = 1;' }]);
  });
  it('works without a language', () => {
    expect(parseMarkdown('```\nplain\n```')).toEqual([{ t: 'code', v: 'plain' }]);
  });
  it('runs an unclosed fence to end of text', () => {
    expect(parseMarkdown('```js\nunclosed')).toEqual([{ t: 'code', lang: 'js', v: 'unclosed' }]);
  });
});

describe('parseMarkdown lists', () => {
  it('parses bullets into a ul', () => {
    const blocks = parseMarkdown('- a\n* b\n+ c');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].t).toBe('ul');
    if (blocks[0].t === 'ul') expect(blocks[0].items).toHaveLength(3);
  });
  it('parses numbers into an ol with start', () => {
    const blocks = parseMarkdown('3. a\n4. b');
    expect(blocks).toEqual([
      { t: 'ol', items: [[{ t: 'text', v: 'a' }], [{ t: 'text', v: 'b' }]], start: 3 },
    ]);
  });
});

describe('parseMarkdown quote and hr', () => {
  it('parses quote lines recursively', () => {
    expect(parseMarkdown('> hello\n> world')).toEqual([
      { t: 'quote', c: [{ t: 'p', c: [{ t: 'text', v: 'hello\nworld' }] }] },
    ]);
  });
  it('parses hr markers', () => {
    for (const m of ['---', '***', '___']) {
      expect(parseMarkdown(m)).toEqual([{ t: 'hr' }]);
    }
  });
});

describe('parseInline', () => {
  it('keeps code spans literal', () => {
    expect(parseInline('`**x**`')).toEqual([{ t: 'code', v: '**x**' }]);
  });
  it('parses bold and em', () => {
    expect(parseInline('**b**')).toEqual([{ t: 'strong', c: [{ t: 'text', v: 'b' }] }]);
    expect(parseInline('__b__')).toEqual([{ t: 'strong', c: [{ t: 'text', v: 'b' }] }]);
    expect(parseInline('*e*')).toEqual([{ t: 'em', c: [{ t: 'text', v: 'e' }] }]);
    expect(parseInline('_e_')).toEqual([{ t: 'em', c: [{ t: 'text', v: 'e' }] }]);
  });
  it('does not treat snake_case as emphasis', () => {
    expect(parseInline('snake_case')).toEqual([{ t: 'text', v: 'snake_case' }]);
  });
  it('links https hrefs', () => {
    expect(parseInline('[x](https://a.com)')).toEqual([
      { t: 'link', href: 'https://a.com', c: [{ t: 'text', v: 'x' }] },
    ]);
  });
  it('leaves javascript: links as plain text', () => {
    expect(parseInline('[x](javascript:alert(1))')).toEqual([{ t: 'text', v: '[x](javascript:alert(1))' }]);
  });
  it('linkifies bare urls', () => {
    const nodes = parseInline('go to https://example.com/x now');
    expect(nodes).toEqual([
      { t: 'text', v: 'go to ' },
      { t: 'link', href: 'https://example.com/x', c: [{ t: 'text', v: 'https://example.com/x' }] },
      { t: 'text', v: ' now' },
    ]);
  });
  it('keeps raw html as text', () => {
    const nodes = parseInline('<script>alert(1)</script>');
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toEqual({ t: 'text', v: '<script>alert(1)</script>' });
  });
});

describe('Markdown render', () => {
  it('escapes html and marks links safe', () => {
    const html = renderToStaticMarkup(
      createElement(Markdown, { text: '# Hi\n\nSee [docs](https://example.com).\n\n<script>alert(1)</script>' }),
    );
    expect(html).not.toContain('<script');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('&lt;script&gt;');
  });
  it('renders raw pre for very large text', () => {
    const text = 'a'.repeat(100_001);
    const html = renderToStaticMarkup(createElement(Markdown, { text }));
    expect(html).toContain('md-raw');
    expect(html).toContain('<pre');
  });
});

describe('parseInline nesting', () => {
  it('parses em containing strong', () => {
    const nodes = parseInline('*foo **bar** baz*');
    expect(nodes).toHaveLength(1);
    expect(nodes[0].t).toBe('em');
    if (nodes[0].t === 'em') {
      const inner = nodes[0].c;
      expect(inner).toHaveLength(3);
      expect(inner[0]).toEqual({ t: 'text', v: 'foo ' });
      expect(inner[1]).toEqual({ t: 'strong', c: [{ t: 'text', v: 'bar' }] });
      expect(inner[2]).toEqual({ t: 'text', v: ' baz' });
    }
  });
  it('parses ***x*** with no stray asterisk', () => {
    const nodes = parseInline('***x***');
    expect(JSON.stringify(nodes)).not.toContain('*');
    const texts: string[] = [];
    const walk = (ns: typeof nodes): void => {
      for (const n of ns) {
        if (n.t === 'text' || n.t === 'code') texts.push(n.v);
        else if (n.t === 'link') walk(n.c);
        else walk(n.c);
      }
    };
    walk(nodes);
    expect(texts.join('')).toBe('x');
  });
});

describe('parseMarkdown deep quote', () => {
  it('caps quote recursion', () => {
    const blocks = parseMarkdown('> '.repeat(20) + 'x');
    let depth = 0;
    let cur: typeof blocks = blocks;
    while (cur.length === 1 && cur[0].t === 'quote') {
      depth++;
      cur = (cur[0] as { t: 'quote'; c: typeof blocks }).c;
      if (depth > 30) break;
    }
    expect(depth).toBeLessThanOrEqual(8);
    expect(JSON.stringify(cur)).toContain('x');
  });
});

describe('adversarial performance', () => {
  const cases: Array<[string, string]> = [
    ['brackets', '['.repeat(100_000)],
    ['link-starts', '[]('.repeat(30_000)],
    ['backticks', '`'.repeat(100_000)],
    ['underscore', '(_a'.repeat(30_000)],
    ['stars', '*a'.repeat(50_000)],
  ];
  for (const [name, input] of cases) {
    it(`parseInline ${name} finishes in < 200ms`, () => {
      const t0 = performance.now();
      parseInline(input);
      expect(performance.now() - t0).toBeLessThan(200);
    });
  }
  it('deep quotes finish in < 200ms', () => {
    const input = '>'.repeat(50_000) + ' x';
    const t0 = performance.now();
    parseMarkdown(input);
    expect(performance.now() - t0).toBeLessThan(200);
  });
  it('long list gap with CR finishes in < 200ms', () => {
    const input = '-' + ' '.repeat(50_000) + 'a\rb';
    const t0 = performance.now();
    parseMarkdown(input);
    expect(performance.now() - t0).toBeLessThan(200);
  });
});
