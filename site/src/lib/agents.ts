// Build-time (Node) read of ../core/agents/*.md frontmatter joined with the band map.
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { bandOf, type Band } from '../content/tiers';

export interface Agent {
  name: string;
  role: string;
  tier: string;
  band: Band;
  description: string;
  capabilities: string[];
}

function unquote(v: string): string {
  const s = v.trim();
  if (s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  if (s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
  return s;
}

export function scalar(fm: string, key: string): string {
  const m = fm.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
  return m ? unquote(m[1]) : '';
}

// Handles `key: [a, b]`, `key: []` and block lists (`key:` then `- item` lines).
function list(fm: string, key: string): string[] {
  const inline = fm.match(new RegExp(`^${key}:\\s*\\[(.*)\\]\\s*$`, 'm'));
  if (inline) return inline[1].split(',').map(unquote).filter(Boolean);
  const block = fm.match(new RegExp(`^${key}:\\s*\\r?\\n((?:[ \\t]*- .*(?:\\r?\\n|$))+)`, 'm'));
  return block ? block[1].split(/\r?\n/).filter(Boolean).map((l) => unquote(l.replace(/^[ \t]*- /, ''))) : [];
}

export function frontmatter(src: string): string {
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
      return {
        name,
        role: scalar(fm, 'role'),
        tier: scalar(fm, 'tier'),
        band: bandOf(name),
        description: scalar(fm, 'description'),
        capabilities: list(fm, 'capabilities'),
      };
    });
}

/** One line of role text for a label card or a compact list: the first sentence, cut at a word boundary. */
export function roleLine(a: Agent, max = 84): string {
  const first = a.description.split(/(?<=[.!?])\s/)[0].replace(/\.$/, '');
  if (first.length <= max) return first;
  return `${first.slice(0, max - 3).replace(/[\s,;:]+\S*$/, '')}...`;
}
