// Lists Claude Code subagent definitions (*.md with YAML frontmatter).
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { realpath } from 'node:fs/promises';
import type { AgentInfo } from '../src/shared/types.ts';

/** Absolute existing directory under $HOME (like the POST /api/sessions cwd check), or null. */
async function validCwd(cwd: string | undefined): Promise<string | null> {
  if (!cwd) return null;
  try {
    const real = await realpath(cwd);
    if (real === os.homedir()) return real;
    const home = await realpath(os.homedir());
    if (!real.startsWith(home + path.sep)) return null;
    const st = await fsp.stat(real);
    return st.isDirectory() ? real : null;
  } catch {
    return null;
  }
}

async function readAgentDir(dir: string, scope: AgentInfo['scope']): Promise<AgentInfo[]> {
  let entries: string[];
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return [];
  }
  const out: AgentInfo[] = [];
  for (const entry of entries.sort()) {
    if (!entry.toLowerCase().endsWith('.md')) continue;
    const file = path.join(dir, entry);
    try {
      // stat follows symlinks, so symlinked agent files are listed.
      const st = await fsp.stat(file);
      if (!st.isFile()) continue;
      const content = await fsp.readFile(file, 'utf8');
      out.push(parseAgentFile(content, entry, scope));
    } catch {
      // Unreadable file: skip it.
    }
  }
  return out;
}

function parseAgentFile(content: string, fileName: string, scope: AgentInfo['scope']): AgentInfo {
  let name: string | undefined;
  let description: string | undefined;
  const lines = content.split('\n');
  if (lines[0]?.trim() === '---') {
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i] ?? '';
      if (line.trim() === '---') break;
      const nameMatch = /^name:\s*(.+)$/.exec(line);
      if (nameMatch && name === undefined) name = cleanValue(nameMatch[1]);
      const descMatch = /^description:\s*(.+)$/.exec(line);
      if (descMatch && description === undefined) description = cleanValue(descMatch[1]);
    }
  }
  const basename = fileName.replace(/\.md$/i, '');
  return {
    name: name || basename,
    ...(description ? { description } : {}),
    scope,
  };
}

function cleanValue(raw: string): string {
  let value = raw.trim();
  if (value.length > 1 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    value = value.slice(1, -1);
  }
  return value.slice(0, 160);
}

/**
 * User agents from ~/.claude/agents (AGENTS_HOME overrides it, for tests) plus
 * project agents from <cwd>/.claude/agents when cwd is a valid directory under
 * $HOME. Project overrides user on the same name; result is sorted by name.
 */
export async function listAgents(cwd?: string): Promise<AgentInfo[]> {
  const userDir = process.env.AGENTS_HOME || path.join(os.homedir(), '.claude', 'agents');
  const byName = new Map<string, AgentInfo>();
  for (const agent of await readAgentDir(userDir, 'user')) byName.set(agent.name, agent);
  const projectRoot = await validCwd(cwd);
  if (projectRoot) {
    const projectDir = path.join(projectRoot, '.claude', 'agents');
    for (const agent of await readAgentDir(projectDir, 'project')) byName.set(agent.name, agent);
  }
  return [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
