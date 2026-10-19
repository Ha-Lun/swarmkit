import assert from 'node:assert/strict';
import type { Lane } from '../../src/lib/galaxy/constellation.ts';
import { layoutNodes, linkProgress, nodeOn, spokeProgress } from '../../src/lib/galaxy/constellation.ts';

const ws: { slug: string; lane: Lane }[] = [
  ...['expr', 'cron', 'semver', 'diff'].map((slug) => ({ slug, lane: 'opencode' as Lane })),
  ...['csv', 'lru', 'template', 'wrap'].map((slug) => ({ slug, lane: 'agy' as Lane })),
];
for (const aspect of [1.6, 0.46]) {
  const n = layoutNodes(ws, aspect);
  assert.deepEqual(n.map((x) => x.slug), ws.map((w) => w.slug));
  for (let i = 0; i < n.length; i++) for (let j = i + 1; j < n.length; j++) {
    const d = Math.hypot(...n[i].pos.map((v, k) => v - n[j].pos[k]));
    assert.ok(d > 0.3, `nodes ${i},${j} overlap at aspect ${aspect}`);
  }
}
const wide = layoutNodes(ws, 1.6);
assert.ok(wide.filter((x) => x.lane === 'opencode').every((x) => x.pos[0] < 0));
assert.ok(wide.filter((x) => x.lane === 'agy').every((x) => x.pos[0] > 0));
assert.equal(spokeProgress(0, 0, 8), 0);
assert.equal(spokeProgress(1, 7, 8), 1);
assert.ok(spokeProgress(0.3, 0, 8) > spokeProgress(0.3, 7, 8));
assert.equal(nodeOn(1, 3, 8), 1);
assert.equal(nodeOn(0, 0, 8), 0);
assert.equal(linkProgress(0.5), 0);
assert.equal(linkProgress(1), 1);
