// Tests for the Antigravity disk scan (skills + workflows to slash commands).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { listAgyCommands } from '../server/runtimes/agy-commands.ts';

const base = mkdtempSync(path.join(tmpdir(), 'agy-commands-test-'));
afterAll(() => rmSync(base, { recursive: true, force: true }));

function setup(): { home: string; cwd: string } {
  const home = mkdtempSync(path.join(base, 'home-'));
  const cwd = mkdtempSync(path.join(base, 'cwd-'));
  const G = path.join(home, '.gemini', 'config');
  // Global skill.
  mkdirSync(path.join(G, 'skills', 'global-skill'), { recursive: true });
  writeFileSync(
    path.join(G, 'skills', 'global-skill', 'SKILL.md'),
    '---\nname: global-skill\ndescription: Global skill\n---\nBody.\n',
  );
  // Plugin skill.
  mkdirSync(path.join(G, 'plugins', 'plug', 'skills', 'plug-skill'), { recursive: true });
  writeFileSync(
    path.join(G, 'plugins', 'plug', 'skills', 'plug-skill', 'SKILL.md'),
    '---\ndescription: Plugin skill\n---\nBody.\n',
  );
  // Global workflow.
  mkdirSync(path.join(G, 'global_workflows'), { recursive: true });
  writeFileSync(path.join(G, 'global_workflows', 'ship.md'), '---\ndescription: Ship it\n---\nBody.\n');
  // Disabled skill (must be absent).
  mkdirSync(path.join(G, 'skills', 'off-skill'), { recursive: true });
  writeFileSync(
    path.join(G, 'skills', 'off-skill', 'SKILL.md'),
    '---\nname: off-skill\ndisable-slash-command: true\n---\nBody.\n',
  );
  // Project skill overriding the global name (project description wins).
  mkdirSync(path.join(cwd, '.agents', 'skills', 'global-skill'), { recursive: true });
  writeFileSync(
    path.join(cwd, '.agents', 'skills', 'global-skill', 'SKILL.md'),
    '---\ndescription: Project override\n---\nBody.\n',
  );
  // Skill dir without SKILL.md (ignored).
  mkdirSync(path.join(G, 'skills', 'empty-dir'), { recursive: true });
  return { home, cwd };
}

describe('listAgyCommands', () => {
  it('reads skills and workflows, lets project override global, skips disabled and empty', async () => {
    const { home, cwd } = setup();
    const cmds = await listAgyCommands(cwd, home);
    expect(cmds).toEqual([
      { name: 'global-skill', description: 'Project override' },
      { name: 'plug-skill', description: 'Plugin skill' },
      { name: 'ship', description: 'Ship it' },
    ]);
  });

  it('returns [] when .gemini is missing', async () => {
    const cwd = mkdtempSync(path.join(base, 'cwd-missing-'));
    const home = mkdtempSync(path.join(base, 'home-missing-'));
    expect(await listAgyCommands(cwd, home)).toEqual([]);
  });
});
