// Regenerates public/stills from the real scene: one 1440x900 WebP per beat at the beat's camera key u, plus the
// 1200x630 social image (og.jpg) from the lanes beat. Our own renderer, no AI media. Needs a served copy of the site
// (astro dev, or a static server over dist/), a Chromium with WebGL (software is fine), playwright-core and ffmpeg.
//
//   CHROME=/path/to/chrome PLAYWRIGHT_CORE=/dir/with/node_modules node scripts/stills.mjs [http://127.0.0.1:4321/]
//   ONLY=beat-bill,og node scripts/stills.mjs   (redo some)
//
// The u values are beatKeyUs(buildTimeline(run).beats) from src/lib/city/camera.ts; rerun this when the run, the
// camera or the look changes. The camera leaves room for the hero panel and captions, so the hero, bill and og
// shots are cropped (CROP, CSS px) to where the content is; all crops keep the output aspect.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const base = process.argv[2] || 'http://127.0.0.1:4321/';
const { loadFeaturedRun } = await import(join(root, 'src/lib/run.ts'));
const { buildTimeline } = await import(join(root, 'src/lib/city/timeline.ts'));
const { beatKeyUs } = await import(join(root, 'src/lib/city/camera.ts'));
process.chdir(root); // loadFeaturedRun reads public/data relative to the cwd
const run = loadFeaturedRun();
if (!run) throw new Error('no public/data/featured-run.json: nothing to render');
const keys = beatKeyUs(buildTimeline(run).beats);

const { chromium } = createRequire(join(process.env.PLAYWRIGHT_CORE || root, 'x.js'))('playwright-core');
const CROP = {
  'beat-hero': { x: 340, y: 170, width: 1100, height: 687.5 },
  'beat-bill': { x: 170, y: 100, width: 1100, height: 687.5 },
  og: { x: 0, y: 60, width: 1000, height: 525 },
};
const only = process.env.ONLY ? process.env.ONLY.split(',') : null;
const outDir = join(root, 'public/stills');
mkdirSync(outDir, { recursive: true });
const tmp = mkdtempSync(join(tmpdir(), 'stills-'));
const jobs = keys.map((k) => ({ name: `beat-${k.beat}`, u: k.u, w: 1440, h: 900 }));
const lanes = keys.find((k) => k.beat === 'lanes');
if (lanes) jobs.push({ name: 'og', u: lanes.u, w: 1200, h: 630 });

const browser = await chromium.launch({
  executablePath: process.env.CHROME || undefined,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
for (const [w, h] of [[1440, 900], [1200, 630]]) {
  const mine = jobs.filter((j) => j.w === w && (!only || only.includes(j.name)));
  if (!mine.length) continue;
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1.5 });
  await page.goto(`${base}?tier=high`, { waitUntil: 'commit' });
  await page.waitForTimeout(6000);
  // Scene only: no DOM overlays (all text stays DOM), no scrollbar.
  await page.addStyleTag({ content: 'html{scrollbar-width:none}.city-hero,.city-captions,.city-hud,.city-labels,header,nav{display:none!important}' });
  const max = await page.evaluate(() => document.querySelector('.city-stage').offsetHeight - innerHeight);
  for (const j of mine) {
    await page.evaluate((y) => scrollTo(0, y), j.u * max);
    await page.waitForTimeout(4000);
    const png = join(tmp, `${j.name}.png`);
    await page.screenshot({ path: png, ...(CROP[j.name] ? { clip: CROP[j.name] } : {}) });
    const args = j.name === 'og'
      ? ['-vf', 'scale=1200:630:flags=lanczos', '-q:v', '2', '-pix_fmt', 'yuvj420p', join(outDir, 'og.jpg')]
      : ['-vf', 'scale=1440:900:flags=lanczos', '-c:v', 'libwebp', '-quality', '85', '-compression_level', '6', join(outDir, `${j.name}.webp`)];
    const r = spawnSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', png, ...args], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error(`ffmpeg failed for ${j.name}`);
    console.log(j.name, 'u =', j.u.toFixed(4));
  }
  await page.close();
}
await browser.close();
rmSync(tmp, { recursive: true, force: true });
