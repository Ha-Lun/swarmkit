// Scene QA for the animation-first layout. Measures, per pinned scene at 1440x810, how much of the viewport the visible
// DOM text covers, and takes screenshots at several scroll positions plus the hover / keyboard label cards.
//
//   node scripts/qa-scenes.mjs [baseUrl] [outDir]
//
// Needs the `playwright-core` package (set PLAYWRIGHT_CORE to its path if it is not resolvable from here).
// Headless Chrome uses software GL, so frame rate is meaningless here; this checks layout, text budget and behaviour.
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');
const base = process.argv[2] ?? 'http://localhost:4324';
const out = process.argv[3] ?? '.integration-shots/qa';
mkdirSync(out, { recursive: true });

const W = 1440, H = 810;
const log = [];
const say = (s) => { console.log(s); log.push(s); };

// ---- in-page: text-area ratio ------------------------------------------------------------------------------------
const measure = () => {
  const vw = innerWidth, vh = innerHeight;
  const opacityOf = (el) => {
    let o = 1;
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.display === 'none' || cs.visibility === 'hidden' || n.inert) return 0;
      o *= parseFloat(cs.opacity);
    }
    return o;
  };
  const boxes = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const seen = new Set();
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n.parentElement;
    if (!n.nodeValue.trim() || !el || seen.has(el) || el.closest('script, style, noscript, .sr-only')) continue;
    seen.add(el);
    if (opacityOf(el) < 0.1) continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 2 || r.height <= 2) continue; // clipped sr-only text
    const x0 = Math.max(0, r.left), x1 = Math.min(vw, r.right), y0 = Math.max(0, r.top), y1 = Math.min(vh, r.bottom);
    if (x1 <= x0 || y1 <= y0) continue;
    boxes.push({ text: n.nodeValue.trim().slice(0, 38), x0, x1, y0, y1, card: !!el.closest('.cell-card') });
  }
  // an element inside another counted element's box is not counted twice
  boxes.sort((a, b) => (b.x1 - b.x0) * (b.y1 - b.y0) - (a.x1 - a.x0) * (a.y1 - a.y0));
  const kept = [];
  for (const b of boxes) {
    const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
    if (!kept.some((k) => cx >= k.x0 && cx <= k.x1 && cy >= k.y0 && cy <= k.y1)) kept.push(b);
  }
  const area = kept.reduce((s, b) => s + (b.x1 - b.x0) * (b.y1 - b.y0), 0);
  const centre = { x0: vw * 0.3, x1: vw * 0.7, y0: vh * 0.3, y1: vh * 0.7 };
  const inCentre = kept.filter((b) => !b.card && b.x0 < centre.x1 && b.x1 > centre.x0 && b.y0 < centre.y1 && b.y1 > centre.y0).map((b) => b.text);
  return { ratio: area / (vw * vh), n: kept.length, inCentre, items: kept.map((b) => b.text) };
};

const browser = await chromium.launch({
  executablePath: process.env.CHROME ?? '/usr/bin/google-chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});

async function open(url, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, ...opts });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  await page.goto(url, { waitUntil: 'load' });
  return { ctx, page, errors };
}

const sectionTop = (page, id) => page.evaluate((i) => document.getElementById(i).getBoundingClientRect().top + scrollY, id);
async function goto(page, id, f, settle = 2500) {
  // f = 0..1 through the pinned window (the sticky scene is pinned from the section top to top + runway - 1 viewport)
  const y = await page.evaluate(([i, frac]) => {
    const el = document.getElementById(i);
    const top = el.getBoundingClientRect().top + scrollY;
    return top + frac * Math.max(0, el.offsetHeight - innerHeight);
  }, [id, f]);
  await page.evaluate((v) => window.scrollTo(0, v), y);
  await page.waitForTimeout(settle);
}
const shot = (page, name) => page.screenshot({ path: `${out}/${name}.png` });
const pct = (r) => `${(r * 100).toFixed(1)}%`;

// ---- world mode ------------------------------------------------------------------------------------------------
const { ctx, page, errors } = await open(`${base}/?tier=medium&debug`);
await page.waitForFunction(() => document.documentElement.dataset.world === 'ready', null, { timeout: 30000 }).catch(() => say('WARN: intro did not finish'));
say(`tier=${await page.evaluate(() => document.documentElement.dataset.tier)} world=${await page.evaluate(() => document.documentElement.dataset.world)}`);

const scenes = [
  ['top', 'intro', [0]],
  ['hive', 'hive', [0.05, 0.3, 0.5, 0.7, 0.95]],
  ['cells', 'cells', [0.1, 0.5, 0.9]],
  ['proof', 'proof', [0.3, 0.8, 1]],
  ['install', 'finale', [0.1, 0.35, 0.55, 0.75, 1]],
];
const rows = [];
for (const [id, name, fracs] of scenes) {
  for (const f of fracs) {
    await goto(page, id, f);
    const m = await page.evaluate(measure);
    await shot(page, `${name}-${String(Math.round(f * 100)).padStart(3, '0')}`);
    rows.push({ scene: name, at: f, ratio: m.ratio, n: m.n, inCentre: m.inCentre });
    say(`${name.padEnd(7)} @${f.toFixed(2)}  text ${pct(m.ratio).padStart(6)}  elements ${String(m.n).padStart(2)}  centre-overlap: ${m.inCentre.length ? m.inCentre.join(' | ') : 'none'}`);
  }
}
const worst = {};
for (const r of rows) worst[r.scene] = Math.max(worst[r.scene] ?? 0, r.ratio);
say('worst per scene: ' + Object.entries(worst).map(([k, v]) => `${k} ${pct(v)}`).join(', '));

// hover label card: project a real agent cell to the screen and move the mouse there
await goto(page, 'cells', 0.5);
const target = await page.evaluate(() => {
  const w = window.__world;
  const { ctx: c } = w;
  const V = c.camera.position.constructor;
  const names = c.agents.map((a) => a.name);
  const out = [];
  for (const n of names) {
    const v = c.cellTop(n, new V());
    if (!v) continue;
    v.project(c.camera);
    out.push({ n, x: ((v.x + 1) / 2) * innerWidth, y: ((1 - v.y) / 2) * innerHeight, ok: v.z < 1 });
  }
  const pick = out.filter((o) => o.ok && o.x > 200 && o.x < innerWidth - 200 && o.y > 150 && o.y < innerHeight - 150);
  return pick.sort((a, b) => Math.hypot(a.x - innerWidth / 2, a.y - innerHeight / 2) - Math.hypot(b.x - innerWidth / 2, b.y - innerHeight / 2))[0] ?? null;
});
say(`hover target: ${JSON.stringify(target)}`);
if (target) {
  await page.mouse.move(target.x - 40, target.y - 40);
  await page.mouse.move(target.x, target.y + 6, { steps: 4 });
  await page.waitForTimeout(2500);
  const card = await page.evaluate(() => {
    const el = document.querySelector('.cell-card.is-on');
    return el ? { agent: el.dataset.card, text: el.textContent.replace(/\s+/g, ' ').trim(), rect: el.getBoundingClientRect().toJSON() } : null;
  });
  say(`hover card: ${JSON.stringify(card)}`);
  await shot(page, 'cells-hover-card');
  const m = await page.evaluate(measure);
  say(`cells with hover card: text ${pct(m.ratio)}`);
  await page.mouse.move(W - 4, 4);
  await page.waitForTimeout(1200);
}

// keyboard focus: tab into the agent list, arrow to the next
await page.evaluate(() => document.activeElement?.blur());
let hops = 0;
for (; hops < 40; hops++) {
  await page.keyboard.press('Tab');
  if (await page.evaluate(() => !!document.activeElement?.closest('[data-agent-list]'))) break;
}
await page.keyboard.press('ArrowRight');
await page.waitForTimeout(2500);
const kb = await page.evaluate(() => {
  const el = document.querySelector('.cell-card.is-on');
  return { focused: document.activeElement?.dataset?.agent ?? null, card: el?.dataset.card ?? null, keyClass: el?.classList.contains('is-key') ?? false };
});
say(`keyboard: tabs to reach the agent list ${hops + 1}; ${JSON.stringify(kb)}`);
await shot(page, 'cells-keyboard-card');

// tab order starting at the nav, with the hive scene pinned (dev-only toolbar entries are astro's, not the site's)
await goto(page, 'hive', 0.5, 1500);
await page.evaluate(() => document.querySelector('.nav-ref').focus());
const order = [];
for (let i = 0; i < 9; i++) {
  await page.keyboard.press('Tab');
  order.push(await page.evaluate(() => {
    const a = document.activeElement;
    if (!a || a === document.body) return 'body';
    if (a.tagName.toLowerCase() === 'astro-dev-toolbar') return 'astro-dev-toolbar (dev only)';
    const cs = getComputedStyle(a);
    const r = a.getBoundingClientRect();
    return `${a.tagName.toLowerCase()} ${a.dataset.start ? `start:${a.dataset.start}` : a.getAttribute('href') ?? a.textContent.trim().slice(0, 24)}  outline=${cs.outlineStyle}/${cs.outlineWidth}  at y=${Math.round(r.top)}`;
  }));
}
say('tab order from the nav with the hive pinned:\n  ' + order.join('\n  '));
await shot(page, 'hive-focus');

// task pick: a landing-screen button starts the story with that task
await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForTimeout(1500);
await page.locator('[data-start]').nth(2).click();
await page.waitForTimeout(16000);
await page.waitForTimeout(4500);
await shot(page, 'hive-pick-refactor');
say(`pick: journey ${await page.evaluate(() => document.querySelector('[data-caption-step]') ? [...document.querySelectorAll('[data-caption-step]')].filter((e) => getComputedStyle(e).opacity > 0.5).map((e) => e.textContent.trim()).join(' | ') : 'no step captions')}`);

// canvas and accent
say(`canvas count: ${await page.locator('canvas').count()}`);
say(`errors (world): ${errors.length ? '\n  ' + errors.join('\n  ') : 'none'}`);
await ctx.close();

// ---- static: reduced motion and ?tier=fallback ----------------------------------------------------------------------
for (const [label, url, opts] of [
  ['reduced-motion', `${base}/`, { reducedMotion: 'reduce' }],
  ['tier-fallback', `${base}/?tier=fallback`, {}],
]) {
  const s = await open(url, opts);
  await s.page.waitForTimeout(2500);
  const info = await s.page.evaluate(() => ({
    canvas: document.querySelectorAll('canvas').length,
    tier: document.documentElement.dataset.tier ?? null,
    reference: !!document.getElementById('reference'),
    referenceH: document.getElementById('reference')?.offsetHeight ?? 0,
    captions: [...document.querySelectorAll('[data-caption]')].map((e) => getComputedStyle(e).opacity).join(','),
    sticky: getComputedStyle(document.querySelector('.scene')).position,
    docH: document.documentElement.scrollHeight,
  }));
  say(`${label}: ${JSON.stringify(info)}  errors: ${s.errors.length ? s.errors.join(' | ') : 'none'}`);
  await s.page.screenshot({ path: `${out}/${label}-full.png`, fullPage: true });
  await s.ctx.close();
}

// ---- narrow viewport (390x844) in world mode ---------------------------------------------------------------------------
{
  const s = await open(`${base}/?tier=medium`, { viewport: { width: 390, height: 844 } });
  await s.page.waitForTimeout(6000);
  for (const [id, f] of [['hive', 0.5], ['cells', 0.5], ['proof', 0.8], ['install', 0.8]]) {
    await goto(s.page, id, f);
    await s.page.screenshot({ path: `${out}/mobile-${id}.png` });
  }
  say(`mobile errors: ${s.errors.length ? s.errors.join(' | ') : 'none'}`);
  await s.ctx.close();
}

writeFileSync(`${out}/qa-report.txt`, log.join('\n') + '\n');
await browser.close();
