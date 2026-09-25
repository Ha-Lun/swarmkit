// Build-time facts derived from the repo root. The single source for every
// number and list shown on the site.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { frontmatter, loadAgents, scalar } from './agents';

const root = resolve(process.cwd(), '..');

export const repoUrl = 'https://github.com/ha-lun/swarmkit';

export interface Flag { flag: string; description: string }
export interface Command { name: string; description: string }
export interface Platform { name: string; flag: string; summary: string }

function skills(): string[] {
  const dir = resolve(root, 'core/skills');
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(resolve(dir, d.name, 'SKILL.md')))
    .map((d) => d.name)
    .sort();
}

function mcpServers(): string[] {
  const json = JSON.parse(readFileSync(resolve(root, 'core/mcp.json'), 'utf8'));
  return Object.keys(json.mcpServers).sort();
}

function commands(): Command[] {
  const dir = resolve(root, 'opencode/command');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => ({
      name: `/${f.replace(/\.md$/, '')}`,
      description: scalar(frontmatter(readFileSync(resolve(dir, f), 'utf8')), 'description'),
    }));
}

// Flags are documented in the header comment of install.sh: `#   --flag   Description`.
function installFlags(): Flag[] {
  const src = readFileSync(resolve(root, 'install.sh'), 'utf8');
  return [...src.matchAll(/^#\s{2,}(--[a-z0-9-]+)\s+(.+)$/gm)].map((m) => ({ flag: m[1], description: m[2].trim() }));
}

// Platform summaries paraphrase the "One source, three CLIs" table in README.md.
const platforms: Platform[] = [
  { name: 'Claude Code', flag: '--claude', summary: 'Specialists install as subagents. Tool limits are enforced by tool lists and guard hooks.' },
  { name: 'OpenCode', flag: '--opencode', summary: 'Specialists install as agents. Tool limits are enforced by permission blocks.' },
  { name: 'Antigravity', flag: '--agy', summary: 'Specialists ship as skills in the swarmkit plugin. Antigravity has no custom subagents, so limits are stated in each skill.' },
];

const agents = loadAgents();

export const facts = {
  agents,
  skills: skills(),
  mcpServers: mcpServers(),
  commands: commands(),
  flags: installFlags(),
  platforms,
};
