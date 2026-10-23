import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { listAgents } from '../server/agents.ts';

// Live under $HOME so the project <cwd> validity check ("directory under $HOME") passes.
const home = mkdtempSync(path.join(homedir(), 'fleet-agents-'));
const agentsHome = path.join(home, 'user-agents');
const projectDir = path.join(home, 'proj', '.claude', 'agents');

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

/** Rebuilds the user agent files (AGENTS_HOME target) from a clean template dir. */
function seedUserAgents(): void {
  rmSync(agentsHome, { recursive: true, force: true });
  mkdirSync(agentsHome, { recursive: true });
  writeFileSync(
    path.join(agentsHome, 'a.md'),
    '---\nname: Alpha\ndescription: "Reviews dashboards"\n---\nBody line.\n',
  );
  writeFileSync(path.join(agentsHome, 'b.md'), 'No frontmatter here.\n');
  writeFileSync(path.join(agentsHome, 'c.txt'), 'name: ignored\n');
}

describe('listAgents', () => {
  afterEach(() => {
    delete process.env.AGENTS_HOME;
    rmSync(path.join(home, 'proj'), { recursive: true, force: true });
  });

  it('reads user agents from AGENTS_HOME with frontmatter and basename fallbacks', async () => {
    process.env.AGENTS_HOME = agentsHome;
    seedUserAgents();

    const agents = await listAgents();
    expect(agents).toEqual([
      { name: 'Alpha', description: 'Reviews dashboards', scope: 'user' },
      { name: 'b', scope: 'user' },
    ]);
  });

  it('lets project agents override user agents on the same name', async () => {
    process.env.AGENTS_HOME = agentsHome;
    seedUserAgents();
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      path.join(projectDir, 'override.md'),
      "---\nname: b\ndescription: 'project-level review'\n---\nProject body.\n",
    );

    const agents = await listAgents(path.join(home, 'proj'));
    expect(agents).toEqual([
      { name: 'Alpha', description: 'Reviews dashboards', scope: 'user' },
      { name: 'b', description: 'project-level review', scope: 'project' },
    ]);

    // Without cwd only user agents are listed.
    const userOnly = await listAgents();
    expect(userOnly.map(a => a.name)).toEqual(['Alpha', 'b']);
    expect(userOnly.every(a => a.scope === 'user')).toBe(true);
  });
});
