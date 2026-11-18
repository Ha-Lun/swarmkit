// Every test file gets a scratch XDG_CACHE_HOME, so sessions started in tests never create
// artifact or image dirs in the real ~/.cache. Tests that need their own still override it.
// Likewise a scratch XDG_CONFIG_HOME, so sessions never read the developer's real secrets,
// token, stars or push stores under ~/.config/swarmkit.
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';

const dir = mkdtempSync(path.join(os.tmpdir(), 'swarmkit-test-cache-'));
const configDir = mkdtempSync(path.join(os.tmpdir(), 'swarmkit-test-config-'));
process.env.XDG_CACHE_HOME = dir;
process.env.XDG_CONFIG_HOME = configDir;
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(configDir, { recursive: true, force: true });
});
