// Build-time facts derived from the repo root. The single source for every
// number and list shown on the site.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { frontmatter, loadAgents, scalar } from './agents';

const root = resolve(process.cwd(), '..');

export const repoUrl = 'https://github.com/ha-lun/swarmkit';

export interface Flag { flag: string; args: string; description: string }
export interface Pack { name: string; count: number }
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

// Flags are documented in the header comment of install.sh: `#   --flag [<arg>] [arg]  Description`, continued on the
// following comment lines (indented further).
function installFlags(): Flag[] {
  const flags: Flag[] = [];
  for (const line of readFileSync(resolve(root, 'install.sh'), 'utf8').split('\n')) {
    const m = line.match(/^#\s{2,}(--[a-z0-9-]+)((?:\s+(?:<[^>]+>|\[[^\]]+\]))*)\s+(\S.*)$/);
    if (m) flags.push({ flag: m[1], args: m[2].trim(), description: m[3].trim() });
    else if (flags.length && !line.startsWith('#')) break; // the header comment ends at the first other line
    else if (flags.length && /^#\s{10,}\S/.test(line)) flags[flags.length - 1].description += ` ${line.replace(/^#\s+/, '').trim()}`;
  }
  return flags;
}

// The Claude Code packs (install.sh --pack): every agent whose `pack:` is not core, counted per pack.
function packs(): Pack[] {
  const count = new Map<string, number>();
  for (const a of agents) if (a.pack !== 'core') count.set(a.pack, (count.get(a.pack) ?? 0) + 1);
  return [...count].map(([name, n]) => ({ name, count: n })).sort((a, b) => a.name.localeCompare(b.name));
}

// Platform summaries paraphrase the "One source, three CLIs" table in README.md.
const platforms: Platform[] = [
  { name: 'Claude Code', flag: '--claude', summary: 'Core agents install as subagents; domain specialists come as per-project packs. Tool lists are enforced; the guard hooks are a speed bump, not a sandbox.' },
  { name: 'OpenCode', flag: '--opencode', summary: 'Specialists install as agents. Tool limits are enforced by permission blocks.' },
  { name: 'Antigravity', flag: '--agy', summary: 'Specialists ship as agents in the swarmkit plugin (invoke_subagent). Antigravity cannot enforce tool limits, so each agent states its own.' },
];

const agents = loadAgents();

export const facts = {
  agents,
  skills: skills(),
  mcpServers: mcpServers(),
  commands: commands(),
  flags: installFlags(),
  packs: packs(),
  coreAgents: agents.filter((a) => a.pack === 'core').length,
  platforms,
};
