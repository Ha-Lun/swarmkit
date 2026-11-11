// Disk scan for Antigravity slash commands (`agy -p` has no list API).
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SlashCommandInfo } from '../../src/shared/types.ts';
import { cleanValue } from '../agents.ts';

/** Max bytes read from the head of each SKILL.md or workflow file. */
const HEAD_BYTES = 8192;

/** Head of a file, or undefined when missing, unreadable or not a file. */
async function readHead(file: string): Promise<string | undefined> {
  try {
    const fh = await fsp.open(file, 'r');
    try {
      const buf = Buffer.alloc(HEAD_BYTES);
      const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0); // a directory throws EISDIR here
      return buf.subarray(0, bytesRead).toString('utf8');
    } finally {
      await fh.close();
    }
  } catch {
    return undefined;
  }
}

/** Frontmatter name/description/disabled flag from the head of a markdown file. */
function frontmatter(content: string): { name?: string; description?: string; disabled?: boolean } {
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return {};
  let name: string | undefined;
  let description: string | undefined;
  let disabled = false;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.trim() === '---') break;
    const nameMatch = /^name:\s*(.+)$/.exec(line);
    if (nameMatch && name === undefined) {
      const v = cleanValue(nameMatch[1] ?? '');
      if (v) name = v;
      continue;
    }
    const descMatch = /^description:\s*(.+)$/.exec(line);
    if (descMatch && description === undefined) {
      let v = cleanValue(descMatch[1] ?? '');
      if (/^[>|][+-]?$/.test(v)) {
        // YAML block scalar: the indented lines below, joined into one line.
        const block: string[] = [];
        while (i + 1 < lines.length && /^(\s|$)/.test(lines[i + 1] ?? '')) {
          i += 1;
          block.push((lines[i] ?? '').trim());
        }
        v = block.filter(Boolean).join(' ');
      }
      if (v) description = v;
      continue;
    }
    const disableMatch = /^disable-slash-command:\s*(.+)$/.exec(line);
    if (disableMatch && cleanValue(disableMatch[1] ?? '').toLowerCase() === 'true') disabled = true;
  }
  return { ...(name ? { name } : {}), ...(description ? { description } : {}), ...(disabled ? { disabled: true } : {}) };
}

/** SKILL.md files directly under a skills parent dir (entry = skill directory name). */
async function skillsIn(parent: string): Promise<Array<{ dir: string; file: string }>> {
  let entries: string[];
  try {
    entries = await fsp.readdir(parent);
  } catch {
    return [];
  }
  return entries.sort().map(dir => ({ dir, file: path.join(parent, dir, 'SKILL.md') }));
}

/** G/plugins/<plugin>/skills/<skill>/SKILL.md entries. */
async function pluginSkillsIn(pluginsDir: string): Promise<Array<{ dir: string; file: string }>> {
  let plugins: string[];
  try {
    plugins = await fsp.readdir(pluginsDir);
  } catch {
    return [];
  }
  const out: Array<{ dir: string; file: string }> = [];
  for (const plugin of plugins.sort()) {
    for (const skill of await skillsIn(path.join(pluginsDir, plugin, 'skills'))) out.push(skill);
  }
  return out;
}

/** *.md files directly under a workflows dir. */
async function workflowsIn(dir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return [];
  }
  return entries
    .filter(e => e.toLowerCase().endsWith('.md'))
    .sort()
    .map(e => path.join(dir, e));
}

/** Adds one skill SKILL.md or workflow *.md; `fallback` names it when the frontmatter has no name. */
async function addEntry(byName: Map<string, SlashCommandInfo>, file: string, fallback: string): Promise<void> {
  const head = await readHead(file);
  if (head === undefined) return;
  const fm = frontmatter(head);
  if (fm.disabled) return;
  const name = fm.name || fallback;
  if (!name) return;
  byName.set(name, fm.description ? { name, description: fm.description } : { name });
}

const workflowName = (file: string): string => path.basename(file).replace(/\.md$/i, '');

/**
 * Slash commands from skill SKILL.md files and workflow markdown files.
 * Project (cwd) entries override global ones with the same name.
 */
export async function listAgyCommands(cwd: string, home: string = os.homedir()): Promise<SlashCommandInfo[]> {
  const byName = new Map<string, SlashCommandInfo>();
  const G = path.join(home, '.gemini', 'config');
  for (const skill of await skillsIn(path.join(G, 'skills'))) await addEntry(byName, skill.file, skill.dir);
  for (const skill of await pluginSkillsIn(path.join(G, 'plugins'))) await addEntry(byName, skill.file, skill.dir);
  for (const file of await workflowsIn(path.join(G, 'global_workflows'))) await addEntry(byName, file, workflowName(file));
  for (const file of await workflowsIn(path.join(G, 'workflows'))) await addEntry(byName, file, workflowName(file));
  for (const skill of await skillsIn(path.join(cwd, '.agents', 'skills'))) await addEntry(byName, skill.file, skill.dir);
  for (const file of await workflowsIn(path.join(cwd, '.agents', 'workflows'))) await addEntry(byName, file, workflowName(file));
  for (const file of await workflowsIn(path.join(cwd, '.agent', 'workflows'))) await addEntry(byName, file, workflowName(file));
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
