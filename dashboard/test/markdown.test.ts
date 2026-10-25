import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Markdown, normalizeMath } from '../src/client/Markdown.tsx';

function html(text: string, className?: string): string {
  return renderToStaticMarkup(createElement(Markdown, { text, className }));
}

describe('GFM extensions', () => {
  it('renders tables inside .md-table-wrap', () => {
    const out = html('| a | b |\n| --- | --- |\n| 1 | 2 |\n');
    expect(out).toContain('md-table-wrap');
    expect(out).toContain('<table');
    expect(out).toContain('<th');
    expect(out).toContain('<td');
  });
  it('renders task-list checkboxes', () => {
    const out = html('- [x] done\n- [ ] todo\n');
    expect(out).toContain('type="checkbox"');
    expect(out).toContain('done');
    expect(out).toContain('todo');
  });
  it('renders strikethrough as <del>', () => {
    expect(html('~~gone~~')).toContain('<del>gone</del>');
  });
  it('autolinks bare urls', () => {
    const out = html('see https://example.com/x now');
    expect(out).toContain('href="https://example.com/x"');
    expect(out).toContain('target="_blank"');
  });
  it('renders footnotes', () => {
    const out = html('Here[^1]\n\n[^1]: the note\n');
    expect(out).toContain('footnote');
    expect(out).toContain('the note');
  });
});

describe('math', () => {
  it('renders inline $x^2$ with katex', () => {
    const out = html('Einstein: $x^2$ end');
    expect(out).toContain('katex');
  });
  it('renders display $$\\int$$ with katex', () => {
    const out = html('$$\\int_0^1 x\\,dx$$');
    expect(out).toContain('katex');
  });
  it('leaves "$5 and $10" as plain text', () => {
    const out = html('$5 and $10');
    expect(out).not.toContain('katex');
    expect(out).toContain('$5');
    expect(out).toContain('$10');
  });
});

describe('normalizeMath', () => {
  it('converts \\(\\) to dollars', () => {
    expect(normalizeMath('\\(a\\)')).toBe('$a$');
  });
  it('converts \\[\\] to display math on its own lines', () => {
    const out = normalizeMath('\\[b\\]');
    expect(out).toContain('$$');
    expect(out).toContain('b');
    expect(out).not.toContain('\\[');
    // Renders as display math through the pipeline.
    expect(html('\\[b\\]')).toContain('katex');
    expect(html('\\(a\\)')).toContain('katex');
  });
  it('leaves code spans untouched', () => {
    expect(normalizeMath('`\\(a\\)`')).toBe('`\\(a\\)`');
    expect(normalizeMath('`\\[b\\]`')).toBe('`\\[b\\]`');
    expect(normalizeMath('`$5 and $10`')).toBe('`$5 and $10`');
  });
  it('leaves fenced code blocks untouched', () => {
    const input = 'before \\(x\\)\n```\n\\(a\\) and \\[b\\]\n```\nafter \\(y\\)';
    const out = normalizeMath(input);
    expect(out).toContain('\\(a\\) and \\[b\\]');
    expect(out).toContain('$x$');
    expect(out).toContain('$y$');
  });
  it('handles 1e5 repeated backslashes/brackets in < 200 ms', () => {
    for (const input of ['\\'.repeat(100_000), '['.repeat(100_000), ']'.repeat(100_000), '\\('.repeat(50_000)]) {
      const t0 = performance.now();
      normalizeMath(input);
      expect(performance.now() - t0).toBeLessThan(200);
    }
  });
});

describe('code blocks', () => {
  it('highlights ```ts with hljs classes, a lang label and a Copy button', () => {
    const out = html('```ts\nconst x: number = 1;\n```\n');
    expect(out).toContain('hljs');
    expect(out).toContain('ts');
    expect(out).toContain('Copy');
    expect(out).toContain('<button');
  });
  it('renders ```mermaid as a Mermaid placeholder with code visible', () => {
    const out = html('```mermaid\ngraph TD; A-->B;\n```\n');
    expect(out).toContain('md-mermaid');
    expect(out).toContain('graph TD');
  });
});

describe('safety', () => {
  it('drops javascript: hrefs', () => {
    const out = html('[x](javascript:alert(1))');
    expect(out).not.toContain('javascript:');
  });
  it('escapes raw html', () => {
    const out = html('<script>alert(1)</script>');
    expect(out).not.toContain('<script');
    expect(out).toContain('&lt;script');
  });
  it('renders remote images as links, not <img>', () => {
    const out = html('![alt](https://example.com/i.png)');
    expect(out).not.toContain('<img');
    expect(out).toContain('https://example.com/i.png');
    expect(out).toContain('🖼');
  });
  it('renders data:image/png;base64 images as <img>', () => {
    const out = html('![alt](data:image/png;base64,iVBORw0KGgo=)');
    expect(out).toContain('<img');
    expect(out).toContain('data:image/png;base64,iVBORw0KGgo=');
  });
});

describe('stored images', () => {
  it('renders stored session image paths as <img>', () => {
    for (const src of [
      '/api/sessions/abc123/images/1.png',
      '/api/sessions/abc-DEF_01/images/12.jpg',
      '/api/sessions/s1/images/1234.gif',
      '/api/sessions/s1/images/3.webp',
    ]) {
      const out = html(`![alt](${src})`);
      expect(out).toContain('<img');
      expect(out).toContain(`src="${src}"`);
    }
  });
  it('renders other same-origin paths as 🖼 links', () => {
    for (const src of [
      '/api/sessions/s1/images/1.txt',
      '/api/sessions/s1/images/1.jpeg',
      '/api/sessions/s1/images/12345.png',
      '/api/sessions//images/1.png',
      '/api/sessions/s1/files/1.png',
      '/other/path.png',
      '/api/sessions/s1/images/1.png/evil',
    ]) {
      const out = html(`![alt](${src})`);
      expect(out).not.toContain('<img');
      expect(out).toContain('🖼');
      expect(out).toContain(src);
    }
  });
  it('renders remote and protocol-relative URLs as 🖼 links', () => {
    for (const src of ['https://example.com/i.png', '//example.com/i.png']) {
      const out = html(`![alt](${src})`);
      expect(out).not.toContain('<img');
      expect(out).toContain('🖼');
    }
  });
});

describe('large input', () => {
  it('renders text over 100k chars as an md-raw pre', () => {
    const out = html('a'.repeat(100_001));
    expect(out).toContain('md-raw');
    expect(out).toContain('<pre');
  });
});

describe('katex limits', () => {
  it('renders \\rule{1e5em}{1e5em} without throwing (maxSize caps it)', () => {
    let out = '';
    expect(() => {
      out = html('$\\rule{1e5em}{1e5em}$');
    }).not.toThrow();
    expect(out).toContain('katex');
    expect(() => {
      out = html('$$\\rule{1e5em}{1e5em}$$');
    }).not.toThrow();
    expect(out).toContain('katex');
  });
});

describe('safe images via shared helper', () => {
  it('renders data:image/jpeg and webp as <img>, rejects svg data URLs', () => {
    expect(html('![alt](data:image/jpeg;base64,/9j/4AAQ=)')).toContain('<img');
    expect(html('![alt](data:image/webp;base64,UklGRg==)')).toContain('<img');
    const svg = html('![alt](data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=)');
    expect(svg).not.toContain('<img');
    expect(svg).toContain('🖼');
  });
});
