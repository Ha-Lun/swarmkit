// Plain node asserts: `node site/test/city/buildlog.test.ts` from the worktree root.
import assert from 'node:assert/strict';
import { summarizeWorkers } from '../../src/lib/buildlog.ts';

const rows: Array<Record<string, unknown>> = [
  { event: 'start', cli: 'opencode', slug: 'city-scan', model: 'm-one' },
  { event: 'finish', cli: 'opencode', slug: 'city-scan', model: 'm-one', ok: true, denied: 0, stopped_by: null },
  { event: 'finish', cli: 'agy', slug: 'city-drones', model: 'm-two', ok: false, denied: 2, stopped_by: 'human' },
  { cli: 'agy', slug: 'city-merge', ok: true, denied: 1, stopped_by: null },
  { event: 'start', cli: 'agy', slug: 'city-tiltshift' },
  {},
];

// Start rows never count. Finish rows plus rows with no event field do.
const s = summarizeWorkers(rows);
assert.equal(s.tasks, 4);
assert.deepEqual(s.byLane, { agy: 2, opencode: 1 });
assert.deepEqual(s.models, ['m-one', 'm-two']);
assert.equal(s.stopped, 1);
assert.equal(s.denied, 3);

// Missing fields degrade to empty, never to invented values.
const empty = summarizeWorkers([]);
assert.deepEqual(empty, { tasks: 0, byLane: {}, models: [], stopped: 0, denied: 0 });
const startsOnly = summarizeWorkers([{ event: 'start', cli: 'agy' }]);
assert.equal(startsOnly.tasks, 0);
assert.deepEqual(startsOnly.byLane, {});

console.log('buildlog.test.ts: ok');
