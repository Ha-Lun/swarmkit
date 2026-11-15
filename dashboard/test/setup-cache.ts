// Every test file gets a scratch XDG_CACHE_HOME, so sessions started in tests never create
// artifact or image dirs in the real ~/.cache. Tests that need their own still override it.
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';

const dir = mkdtempSync(path.join(os.tmpdir(), 'swarmkit-test-cache-'));
process.env.XDG_CACHE_HOME = dir;
afterAll(() => rmSync(dir, { recursive: true, force: true }));
