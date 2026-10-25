import { describe, expect, it } from 'vitest';
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
      Markdown({ text: '# Hi\n\nSee [docs](https://example.com).\n\n<script>alert(1)</script>' }),
    );
    expect(html).not.toContain('<script');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('&lt;script&gt;');
  });
});
