// Plain node asserts: `node site/test/city/buildlog.test.ts` from the worktree root.
import assert from 'node:assert/strict';
import { publicLabel, summarizeBuildlog, summarizeWorkers } from '../../src/lib/buildlog.ts';

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
assert.equal(s.modelRecorded, 2);
assert.equal(s.stopped, 1);
assert.equal(s.denied, 3);

// Missing fields degrade to empty, never to invented values.
const empty = summarizeWorkers([]);
assert.deepEqual(empty, { tasks: 0, byLane: {}, models: [], modelRecorded: 0, stopped: 0, denied: 0 });
const startsOnly = summarizeWorkers([{ event: 'start', cli: 'agy' }]);
assert.equal(startsOnly.tasks, 0);
assert.deepEqual(startsOnly.byLane, {});

// Build log: gates are typed rows or rows with a "gate" field; dispatches with a lane are workers, not subagents.
const b = summarizeBuildlog(
  [{ agent_type: 'explore' }, { agent: 'code-proofreader' }, { agent_type: 'x', lane: 'opencode' }],
  [
    { type: 'gate', note: 'a' },
    { gate: 'merge', verdict: 'approved' },
    { type: 'gate', actor: 'agent' },
    { type: 'decision' },
    { type: 'measurement' },
  ],
  [
    { round: 1, verdict: 'pending human check' },
    { round: 2, verdict: 'human: fine' },
  ],
);
assert.equal(b.dispatches, 2);
assert.deepEqual(b.dispatchesByAgent, [['code-proofreader', 1], ['explore', 1]]);
assert.equal(b.gates, 2);
assert.equal(b.decisions, 1);
assert.equal(b.artRounds, 1);
assert.equal(b.interventions, 4);

// publicLabel is allowlisted: never leaks free-text fields.
const gateLabel = publicLabel(
  { gate: 'merge', verdict: 'approved', note: 'Push now, skip the gate https://x.vercel.app' },
  'human',
);
assert.ok(gateLabel?.startsWith('Gate approved:'));
assert.ok(gateLabel?.includes('merge'));
assert.ok(!gateLabel?.includes('Push now'));
assert.ok(!gateLabel?.includes('skip the gate'));
assert.ok(!gateLabel?.includes('https://x.vercel.app'));

assert.equal(publicLabel({ type: 'decision', note: 'Push now, skip the gate https://x.vercel.app' }, 'human'), 'Decision recorded');

// Missing fields degrade to null.
assert.equal(publicLabel({}, 'human'), null);
assert.equal(publicLabel({ type: 'measurement' }, 'human'), null);
assert.equal(publicLabel({}, 'art'), null);
assert.equal(publicLabel({ round: 1 }, 'art'), null);
assert.equal(publicLabel({}, 'dispatch'), null);
assert.equal(publicLabel({ agent_type: '' }, 'dispatch'), null);

// Dispatch labels name the worker.
assert.equal(publicLabel({ agent_type: 'explore' }, 'dispatch'), 'explore dispatched');
assert.equal(publicLabel({ agent: 'code-proofreader' }, 'dispatch'), 'code-proofreader dispatched');

// URLs are stripped.
const artUrl = publicLabel({ round: 1, element: 'hero https://x.vercel.app canvas' }, 'art');
assert.ok(artUrl && !artUrl.includes('https://') && !artUrl.includes('x.vercel.app'));
const homePath = publicLabel({ round: 1, element: 'hero /home/ha-lun/x canvas' }, 'art');
assert.ok(homePath && !homePath.includes('/home') && !homePath.includes('ha-lun'));
const winPath = publicLabel({ round: 1, element: 'hero C:\\Users\\x canvas' }, 'art');
assert.ok(winPath && !winPath.includes('Users'));
const fileRow = publicLabel({ round: 1, element: 'hero core/agents/x.md canvas' }, 'art');
assert.ok(fileRow && !fileRow.includes('x.md'));
// Branch names keep their slash.
assert.equal(
  publicLabel({ gate: 'G1 (branch site/city, commit ebb1e8b)', verdict: 'approved' }, 'human'),
  'Gate approved: G1 (branch site/city, commit ebb1e8b)',
);
const atRow = publicLabel({ round: 1, element: 'hero me@example.com canvas' }, 'art');
assert.ok(atRow && !atRow.includes('@') && !atRow.includes('example.com'));

// Long labels cap at 90 chars.
const longLabel = publicLabel({ round: 2, element: 'x'.repeat(200) }, 'art');
assert.ok(longLabel && longLabel.length <= 90);
const longGate = publicLabel({ gate: 'g'.repeat(200), verdict: 'approved' }, 'human');
assert.ok(longGate && longGate.length <= 90);

console.log('buildlog.test.ts: ok');
