// Build-time (Node) read of ../core/agents/*.md frontmatter.
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface Agent {
  name: string;
  tier: string;
  /** where the Claude Code build installs it: `core` (global) or a pack linked per project with `install.sh --pack` */
  pack: string;
  description: string;
}

function unquote(v: string): string {
  const s = v.trim();
  if (s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  if (s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
  return s;
}

function scalar(fm: string, key: string): string {
  const m = fm.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
  return m ? unquote(m[1]) : '';
}

function frontmatter(src: string): string {
  return src.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? '';
}

export function loadAgents(): Agent[] {
  const dir = resolve(process.cwd(), '../core/agents');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => {
      const fm = frontmatter(readFileSync(resolve(dir, f), 'utf8'));
      const name = scalar(fm, 'name') || f.replace(/\.md$/, '');
      const pack = scalar(fm, 'pack');
      if (!pack) throw new Error(`core/agents/${f}: no pack: in the frontmatter (scripts/build.py requires one)`);
      return {
        name,
        tier: scalar(fm, 'tier'),
        pack,
        description: scalar(fm, 'description'),
      };
    });
}

/** One line of role text for a label card or a compact list: the first sentence, cut at a word boundary. */
export function roleLine(a: Agent, max = 84): string {
  const first = a.description.split(/(?<=[.!?])\s/)[0].replace(/\.$/, '');
  if (first.length <= max) return first;
  return `${first.slice(0, max - 3).replace(/[\s,;:]+\S*$/, '')}...`;
}
