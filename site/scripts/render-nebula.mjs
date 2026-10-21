// Offline nebula renderer: our own procedural volume renderer (no AI media), run once, output committed under public/nebula.
// Renders, from the same field as the live volume (src/lib/galaxy/nebula-volume.ts: lobes, palette, ionisation fronts, dust
// lanes, the knot; recoded here with gradient noise on a rotated domain and a 512^3 bake plus analytic fine octaves):
//   1. approach layers: 5 premultiplied-alpha depth slabs of the nebula from the hero camera (sceneState(0)), far -> near,
//      2560x1600 (high) and 1280x800 (low). The far layer carries the baked starfield, the embedded young stars sit in
//      the slab that holds them. Over-compositing the five reproduces the tonemapped frame.
//   2. bubble: from the origin (Opus) with the cavity carved at cavityR(1, rMax) and the swept-up gas piled into a lit wall:
//      6 cubemap faces of the gas beyond the inner wall (opaque, stars baked in) and 6 faces of the inner wall shell (RGBA),
//      2048^2 (high) and 1024^2 (low).
//   manifest.json records the camera pose, the layer depth centroids, the cube conventions and the file sizes.
// Needs: a Chromium with a real GPU (WebGL2, float colour buffers; the GTX 970M path below works headless), playwright-core and
// sharp (both in node_modules; sharp encodes the WebP with a lossy alpha). GPU=0 renders the same frames on swiftshader, slowly.
//
//   CHROME=/path/to/chrome PLAYWRIGHT_CORE=/dir/with/node_modules node scripts/render-nebula.mjs [all|hero|cube|moments|preview]
//   GPU=0 to use swiftshader; QUALITY=draft|final (default final); OUT=dir (default public/nebula); Q=82 AQ=72 (webp colour and
//   alpha quality); HW=2048 CUBE_N=1024 (high-set sizes; the low set is half); QA_DIR=dir also writes the tonemapped composite there.
//   ROLL=90 renders the hero rolled 90 degrees about the view axis (a streak that stays vertical on screen is the renderer's).
// Deterministic: fixed seeds, Halton sub-pixel jitter, integer hashes.
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { extname, join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
process.chdir(root);
const mode = process.argv[2] || 'all';
const draft = (process.env.QUALITY || 'final') === 'draft' || mode === 'preview';
const OUT = resolve(process.env.OUT || join(root, 'public/nebula'));
mkdirSync(OUT, { recursive: true });
const Q = process.env.Q || '82';
const roll = ((+process.env.ROLL || 0) * Math.PI) / 180;

const { loadFeaturedRun } = await import(join(root, 'src/lib/run.ts'));
const { buildStory } = await import(join(root, 'src/lib/galaxy/story.ts'));
const { buildNursery } = await import(join(root, 'src/lib/galaxy/nursery.ts'));
const { cavityR, sceneState } = await import(join(root, 'src/lib/galaxy/path.ts'));
const gen = await import(join(root, 'src/lib/galaxy/generator.ts'));
const { PALETTE, mulberry32 } = await import(join(root, 'src/lib/galaxy/shared.ts'));

// ---- the scene numbers --------------------------------------------------------------------------------------------------------
const hero = sceneState(0);
const run = loadFeaturedRun();
const nur = buildNursery(buildStory(run), 1.6);
const rMax = nur.stars.length ? nur.extent + 0.7 : 6;
const RC = cavityR(1, rMax);
const bubble = { rc: RC, w: 3.6, rs0: 3.2, rs1: 8.6, bias: +process.env.BBIAS || 0.15, split: RC + 0.7, vh: Math.ceil((RC + 3.6 + 0.5) * 2) / 2 };
const HERO_BOUNDS = (process.env.BOUNDS ? process.env.BOUNDS.split(',').map(Number) : [11.6, 14.6, 17.4, 20.6]); // view depth, near -> far

// ---- stars --------------------------------------------------------------------------------------------------------------------
const SPEC = [[0.62, 0.74, 1], [0.78, 0.87, 1], [1, 1, 1], [1, 0.93, 0.78], [1, 0.8, 0.55], [1, 0.62, 0.4]];
const tint = (u) => {
  const f = Math.min(SPEC.length - 1.001, Math.max(0, (u ** 0.8) * (SPEC.length - 1)));
  const i = Math.floor(f);
  return SPEC[i].map((v, k) => v + (SPEC[i + 1][k] - v) * (f - i));
};
function backgroundStars(n, seed) {
  const rnd = mulberry32(seed);
  const out = [];
  for (let i = 0; i < n; i++) {
    const z = 2 * rnd() - 1;
    const a = 2 * Math.PI * rnd();
    const r = Math.sqrt(1 - z * z);
    const d = [r * Math.cos(a), z, r * Math.sin(a)];
    const m = rnd();
    const b = 0.045 + 0.55 * m ** 7 + (m > 0.992 ? 0.5 + rnd() * 0.7 : 0);
    const c = tint(rnd() ** 1.1 * 0.95);
    out.push({ d, rgb: c.map((v) => v * b * 1.6), sigma: 0.7 + 0.55 * Math.min(1, b), halo: b > 0.5 ? 0.07 : 0.02 });
  }
  return out;
}
function embeddedStars() {
  const out = [];
  const sp = gen.buildSpikeStars(24);
  const big = [...Array(sp.count).keys()].sort((a, b) => sp.data[b * 4] - sp.data[a * 4]).slice(0, 7);
  for (let i = 0; i < sp.count; i++) {
    const p = [sp.position[i * 3], sp.position[i * 3 + 1], sp.position[i * 3 + 2]];
    const c = [sp.color[i * 3], sp.color[i * 3 + 1], sp.color[i * 3 + 2]];
    const b = Math.max(...c);
    out.push({ p, rgb: c.map((v) => v * 2.0), sigma: 1.15, halo: 0.08, spike: big.includes(i) ? { len: 26 + b * 50, amp: 0.18, ang: 0.3 } : null });
  }
  const nb = gen.buildNebulaStars(900);
  for (let i = 0; i < nb.count; i++) {
    const p = [nb.position[i * 3], nb.position[i * 3 + 1], nb.position[i * 3 + 2]];
    const c = [nb.color[i * 3], nb.color[i * 3 + 1], nb.color[i * 3 + 2]];
    const b = Math.max(...c);
    out.push({ p, rgb: c.map((v) => v * 1.6), sigma: 0.75 + Math.min(0.5, b * 0.35), halo: b > 0.7 ? 0.06 : 0.02 });
  }
  return out;
}
// camera ray through an image fraction (fx, fy): the direction a spike star is put at, so each lands where it reads well
function heroDir(fx, fy) {
  const f = hero.target.map((v, i) => v - hero.cam[i]);
  const l = Math.hypot(...f); f.forEach((_, i) => (f[i] /= l));
  const r = [f[2], 0, -f[0]]; const rl = Math.hypot(...r); r.forEach((_, i) => (r[i] /= rl));
  const u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
  const ty = Math.tan((hero.fov * Math.PI) / 360);
  const nx = (fx * 2 - 1) * ty * 1.6, ny = (1 - fy * 2) * ty;
  const d = [0, 1, 2].map((k) => f[k] + r[k] * nx + u[k] * ny);
  const dl = Math.hypot(...d);
  return d.map((v) => v / dl);
}
const bgAll = backgroundStars(6300, 4242);
const heroStars = [
  ...bgAll,
  ...[[0.1, 0.24, 0.6], [0.88, 0.14, 0.35], [0.93, 0.66, 0.7]].map(([fx, fy, ang], i) => ({
    d: heroDir(fx, fy), rgb: tint(0.2 + i * 0.22).map((v) => v * 1.9), sigma: 1.3, halo: 0.08, spike: { len: 70 + i * 12, amp: 0.2, ang },
  })),
  ...embeddedStars(),
];
const cubeStars = [...bgAll];
{
  // a few spiked stars, kept off the face seams: two per face around +-0.45 of the face centre
  const faceN = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  const rnd = mulberry32(99);
  faceN.forEach((n, f) => {
    for (let k = 0; k < 2; k++) {
      const t1 = n[0] === 0 ? [1, 0, 0] : [0, 0, 1];
      const t2 = [n[1] * t1[2] - n[2] * t1[1], n[2] * t1[0] - n[0] * t1[2], n[0] * t1[1] - n[1] * t1[0]];
      const a = (rnd() * 2 - 1) * 0.5, b = (rnd() * 2 - 1) * 0.5;
      const d = [0, 1, 2].map((q) => n[q] + t1[q] * a + t2[q] * b);
      const l = Math.hypot(...d);
      cubeStars.push({ d: d.map((v) => v / l), rgb: tint(0.15 + rnd() * 0.5).map((v) => v * 1.9), sigma: 1.3, halo: 0.08, spike: { len: 80 + rnd() * 40, amp: 0.2, ang: 0.2 + rnd() * 0.8 } });
    }
  });
}

const cfg = {
  lobes: gen.LOBES, rim: gen.RIM, knotR: gen.KNOT_R, teal: PALETTE.opencode, amber: PALETTE.agy, vh: 9, bubble, heroStars, cubeStars, dither: process.env.DITHER !== undefined ? +process.env.DITHER : 0.5, alphaDither: process.env.ADITHER !== '0', comp: !!process.env.QA_DIR,
};

// ---- the server: serves the render page and receives the raw RGBA frames ------------------------------
const MIME = { '.html': 'text/html', '.js': 'text/javascript' };
const jobs = new Map();
const sizes = {};
const QA = process.env.QA_DIR ? resolve(process.env.QA_DIR) : null; // the tonemapped composite, for checking the layers against; never shipped
if (QA) mkdirSync(QA, { recursive: true });
function outPath(name) { return join(name.includes('-comp-') && QA ? QA : OUT, `${name}.${draft ? 'png' : 'webp'}`); }
// frames arrive as raw straight-alpha RGBA8. sharp (libwebp) encodes them: lossy colour (Q) and lossy alpha (AQ); the alpha
// channel is most of the bytes at lossless, and the soft gas does not need it exact. ffmpeg cannot set the alpha quality.
const sharp = createRequire(join(root, 'x.js'))('sharp');
const AQ = +process.env.AQ || 72;
function startEncode(name, w, h) {
  const chunks = [];
  const opaque = /-(cube|comp)-/.test(name);
  const done = new Promise((res) => { chunks.done = res; });
  return {
    chunks, done,
    async finish() {
      const raw = Buffer.concat(chunks);
      let img = sharp(raw, { raw: { width: w, height: h, channels: 4 } });
      if (opaque) img = img.removeAlpha();
      if (draft) await img.png().toFile(outPath(name));
      else await img.webp({ quality: +Q, alphaQuality: AQ, effort: 6, smartSubsample: true }).toFile(outPath(name));
    },
  };
}
const server = createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET') {
      const f = join(root, 'scripts/render-nebula', u.pathname === '/' ? 'index.html' : u.pathname.slice(1));
      if (!f.startsWith(join(root, 'scripts/render-nebula')) || !existsSync(f)) { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'content-type': MIME[extname(f)] || 'application/octet-stream' });
      createReadStream(f).pipe(res);
      return;
    }
    const name = u.searchParams.get('name');
    if (u.pathname === '/begin') {
      jobs.set(name, startEncode(name, +u.searchParams.get('w'), +u.searchParams.get('h')));
      res.writeHead(200).end('ok');
    } else if (u.pathname === '/chunk') {
      const bufs = [];
      for await (const c of req) bufs.push(c);
      const b = Buffer.concat(bufs);
      jobs.get(name).chunks.push(b);
      res.writeHead(200).end('ok');
    } else if (u.pathname === '/end') {
      await jobs.get(name).finish();
      sizes[name] = statSync(outPath(name)).size;
      jobs.delete(name);
      res.writeHead(200).end('ok');
    } else res.writeHead(404).end();
  } catch (e) {
    console.error(e);
    res.writeHead(500).end(String(e));
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

// ---- the browser ----------------------------------------------------------------------------------------------------------------
const { chromium } = createRequire(join(process.env.PLAYWRIGHT_CORE || root, 'x.js'))('playwright-core');
const gpu = process.env.GPU !== '0';
const browser = await chromium.launch({
  executablePath: process.env.CHROME || '/home/ha-lun/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome',
  args: gpu
    ? ['--headless=new', '--use-gl=angle', '--use-angle=gl-egl', '--ignore-gpu-blocklist', '--enable-gpu', '--no-sandbox']
    : ['--no-sandbox', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  env: gpu
    ? { ...process.env, __NV_PRIME_RENDER_OFFLOAD: '1', __GLX_VENDOR_LIBRARY_NAME: 'nvidia', __EGL_VENDOR_LIBRARY_FILENAMES: '/usr/share/glvnd/egl_vendor.d/10_nvidia.json' }
    : process.env,
});
const page = await browser.newPage();
page.on('console', (m) => console.log(m.text()));
page.on('pageerror', (e) => console.error('PAGE ERROR', e.message));
await page.goto(`http://127.0.0.1:${port}/`);
await page.waitForFunction(() => window.nebulaReady === true, null, { timeout: 30000 });
const gpuName = await page.evaluate((c) => window.nebula.init(c), cfg);
console.log('renderer:', gpuName);

const T0 = Date.now();
const manifest = {
  version: 1,
  generator: 'site/scripts/render-nebula.mjs',
  encoding: 'WebP, display-referred: sRGB-encoded straight alpha (decode to linear, multiply by alpha, blend premultiplied in linear). Layer colour was tonemapped (ACES, exposure 1) per pixel before splitting, so over-compositing the layers far to near equals the tonemapped frame.',
  approach: {}, bubble: {},
};
const heroJob = (extra) => ({
  name: 'approach', cam: hero.cam, target: hero.target, fov: hero.fov, roll, bounds: HERO_BOUNDS, gain: 0.38, expo: 1, detail: process.env.DETAIL !== undefined ? +process.env.DETAIL : 1.0, knot: process.env.KNOT !== undefined ? +process.env.KNOT : 1.3, rim: process.env.RIM !== undefined ? +process.env.RIM : 2.5, dust: process.env.DUST !== undefined ? +process.env.DUST : 2.2, ...extra,
});
let mom = null;
if (mode === 'all' || mode === 'moments' || mode === 'hero' || mode === 'cube' || mode === 'preview') {
  const mj = { ...heroJob({ kind: 'hero', W: 480, H: 300, frames: 3, steps: 192, bakeN: draft ? 256 : 512, tile: 240, tileH: 150 }) };
  mom = { hero: await page.evaluate((j) => window.nebula.moments(j), mj) };
  mom.bubble = await page.evaluate((j) => window.nebula.moments(j), { kind: 'bubble', W: 128, frames: 2, steps: 160, bakeN: draft ? 256 : 512 });
  console.log('moments', JSON.stringify(mom));
}
const heroW = +process.env.HW || (draft ? 640 : 2048);
const heroSizes = [[heroW, Math.round(heroW * 0.625)]];
const cubeN = +process.env.CUBE_N || (draft ? 256 : 768);
const quality = draft
  ? { hero: { frames: 6, steps: 192, bakeN: 256, tile: 320, tileH: 200 }, cube: { frames: 4, steps: 160, bakeN: 256, tile: 256, tileH: 128 } }
  : { hero: { frames: +process.env.HFRAMES || 64, steps: +process.env.HSTEPS || 512, bakeN: 512, tile: 256, tileH: 160 }, cube: { frames: +process.env.CFRAMES || 32, steps: +process.env.CSTEPS || 384, bakeN: 512, tile: 256, tileH: 128 } };

if (mode === 'all' || mode === 'hero' || mode === 'preview') {
  for (const [W, H] of heroSizes) {
    const r = await page.evaluate((j) => window.nebula.hero(j), heroJob({ W, H, emit: true, low: !draft, ...quality.hero }));
    console.log('hero stats', JSON.stringify(r));
  }
}
if (mode === 'all' || mode === 'cube' || mode === 'preview') {
  const faces = process.env.FACES ? process.env.FACES.split(',').map(Number) : [0, 1, 2, 3, 4, 5];
  for (const face of faces) {
    const r = await page.evaluate((j) => window.nebula.face(j), { name: 'bubble', face, N: cubeN, gain: +process.env.CGAIN || 0.1, expo: 1, low: !draft, detail: process.env.CDETAIL !== undefined ? +process.env.CDETAIL : 1, rim: process.env.CRIM !== undefined ? +process.env.CRIM : 4, ...quality.cube });
    console.log('face', JSON.stringify(r));
  }
}
console.log(`total ${((Date.now() - T0) / 60000).toFixed(1)} min`);

if (!draft && mode === 'all') {
  const heroM = mom.hero.slabs;
  manifest.approach = {
    camera: { position: hero.cam, target: hero.target, fov: hero.fov, aspect: 1.6, up: [0, 1, 0], note: 'vertical fov; hero pose = sceneState(0)' },
    sizes: { high: [heroW, heroW * 0.625], low: [heroW / 2, heroW * 0.3125] },
    layers: heroM.map((s, k) => ({
      index: k, role: ['far gas and starfield', 'mid lobe (far)', 'mid lobe (near)', 'near wisps', 'foreground dust and near gas'][k],
      file: { high: `approach-L${k}-${heroW}.webp`, low: `approach-L${k}-${heroW / 2}.webp` },
      depth: +s.centroid.toFixed(3), slab: [k === 0 ? null : HERO_BOUNDS[HERO_BOUNDS.length - k], k === heroM.length - 1 ? null : HERO_BOUNDS[HERO_BOUNDS.length - 1 - k]],
      planeHeight: +(2 * s.centroid * Math.tan((hero.fov * Math.PI) / 360)).toFixed(4),
    })),
    depthNote: 'depth = emission-weighted view-space distance along the camera forward axis (not ray length). A camera-facing plane at that depth with height 2*depth*tan(fov/2) and width height*aspect reproduces the layer exactly from the hero camera. Order far -> near, composite premultiplied over.',
  };
  manifest.bubble = {
    origin: [0, 0, 0],
    cavityRadius: RC, rMax, nurseryExtent: nur.extent,
    wall: { thickness: bubble.w, split: bubble.split },
    cube: { order: ['px', 'nx', 'py', 'ny', 'pz', 'nz'], sizes: { high: cubeN, low: cubeN / 2 }, file: { high: `bubble-cube-{face}-${cubeN}.webp`, low: `bubble-cube-{face}-${cubeN / 2}.webp` }, opaque: true, convention: 'built for THREE.CubeTexture / scene.background (three flips x): load [px,nx,py,ny,pz,nz] as-is.' },
    shell: { sizes: { high: cubeN, low: cubeN / 2 }, file: { high: `bubble-shell-{face}-${cubeN}.webp`, low: `bubble-shell-{face}-${cubeN / 2}.webp` }, rgba: true, radius: +mom.bubble.slabs[1].centroid.toFixed(3), farRadius: +mom.bubble.slabs[0].centroid.toFixed(3), note: 'the inner wall slab (r < split) as its own RGBA cube; over-composite on the opaque cube. radius = emission-weighted distance from the origin.' },
  };
  manifest.files = Object.fromEntries(Object.entries(sizes).filter(([k]) => !k.includes('-comp-')).sort().map(([k, v]) => [`${k}.webp`, v]));
  const isHigh = (k) => k.endsWith(`-${heroW}`) && k.startsWith('approach') || k.endsWith(`-${cubeN}`) && k.startsWith('bubble');
  const isComp = (k) => k.includes('-comp-');
  manifest.totals = {
    highBytes: Object.entries(sizes).filter(([k]) => !isComp(k) && isHigh(k)).reduce((a, [, v]) => a + v, 0),
    lowBytes: Object.entries(sizes).filter(([k]) => !isComp(k) && !isHigh(k)).reduce((a, [, v]) => a + v, 0),
  };
  manifest.render = { gpu: gpuName, minutes: +((Date.now() - T0) / 60000).toFixed(1), heroFrames: quality.hero.frames, heroSteps: quality.hero.steps, cubeFrames: quality.cube.frames, cubeSteps: quality.cube.steps };
  writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 1) + '\n');
  console.log('manifest written', JSON.stringify(manifest.totals));
}
await browser.close();
server.close();
