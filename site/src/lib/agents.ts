// Build-time (Node) read of ../core/agents/*.md frontmatter joined with the band map.
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { bandOf, type Band } from '../content/tiers';

export interface Agent {
  name: string;
  role: string;
  tier: string;
  band: Band;
}

function scalar(fm: string, key: string): string {
  const m = fm.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
  return m ? m[1].trim().replace(/^['"]|['"]$/g, '') : '';
}

export function loadAgents(): Agent[] {
  const dir = resolve(process.cwd(), '../core/agents');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => {
      const src = readFileSync(resolve(dir, f), 'utf8');
      const fm = src.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? '';
      const name = scalar(fm, 'name') || f.replace(/\.md$/, '');
      return { name, role: scalar(fm, 'role'), tier: scalar(fm, 'tier'), band: bandOf(name) };
    });
}
