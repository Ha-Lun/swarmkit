// Plain node asserts: `node site/test/city/buildlog.test.ts` from the worktree root.
import assert from 'node:assert/strict';
import { summarizeBuildlog, summarizeWorkers } from '../../src/lib/buildlog.ts';

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

console.log('buildlog.test.ts: ok');
