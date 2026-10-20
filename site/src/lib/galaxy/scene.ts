// The galaxy flight scene: one camera, driven by scroll progress through sceneState(p). Vanilla three.js.
// High/medium render through bloom on a black clear (the final pass adds #05060a after tone mapping); low renders
// direct. All copy and labels are DOM; this file only reports where the sun and the planets land on screen.
// Beats 01-05 are a solar system (system.ts) inside the galaxy: hairline orbits, small crisp planets, a close-up on the
// planet with a fixer, and the merge spiral into the sun.
import {
  ACESFilmicToneMapping, AdditiveBlending, BufferAttribute, BufferGeometry, Color, GLSL3, Mesh,
  NormalBlending, NoToneMapping, PerspectiveCamera, PlaneGeometry, Points, Scene, ShaderMaterial,
  SRGBColorSpace, Vector2, Vector3, Vector4, WebGLRenderer,
} from 'three';
import type { Blending } from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { PALETTE } from './shared.ts';
import type { Tier } from './shared.ts';
import type { Lane } from '../run.ts';
import type { StoryWorker } from './story.ts';
import { buildDust, buildGalaxy, buildHaze, buildNewArm, buildSky } from './generator.ts';
import type { PointCloud } from './generator.ts';
import {
  armGrow, cometAt, clamp01, closeAmt, closeC, closeView, coreFlare, L, lateU, legacyP, lerp, mergeCam, mergeM, orbitT, pullK,
  sceneState, shipK, ss, systemView, win,
} from './path.ts';
import type { SceneState, V3 } from './path.ts';
import { buildSystem, flashPhase, launchPos, planetPos, spiralIn, stagger } from './system.ts';
import {
  bodyFrag, bodyVert, cometVert, fxFrag, fxVert, lineFrag, lineVert, spriteFrag, spriteVert, tailFrag, tailVert,
} from './shaders.ts';

const CLEAR = '#05060a';
const TIER = {
  high: { stars: 110000, arm: 5000, haze: 44, dust: 280, sky: [5200, 2600, 1100], pr: 1.75, bloom: true },
  medium: { stars: 55000, arm: 3200, haze: 36, dust: 200, sky: [2600, 1300, 600], pr: 1.25, bloom: true },
  low: { stars: 15000, arm: 2200, haze: 22, dust: 120, sky: [900, 500, 250], pr: 1, bloom: false },
} as const;

export type NodeInfo = StoryWorker;
export interface GalaxyFrame {
  /** legacy progress for beats 0-2 (0..1 over the first SPLIT of the page) */
  p: number;
  /** late progress for beats 3-5 */
  u: number;
  /** merge progress for beat 6 */
  m: number;
  /** camera blend toward the close-up planet, 0..1 */
  closeAmt: number;
  state: SceneState;
  /**
   * CSS px relative to the canvas: x, y, in-front flag, brightness 0..1, body radius in px, status 0..1
   * (ok green, bad = failed-verify state red, rev = reviewed tick). Index 0 is the sun (Opus), 1..n the workers in story
   * order, then the fixers.
   */
  nodes: { x: number; y: number; front: boolean; on: number; rad: number; ok: number; bad: number; rev: number }[];
}
export interface GalaxyOptions {
  tier: Tier;
  workers: NodeInfo[];
  reducedMotion: boolean;
  onFrame?: (f: GalaxyFrame) => void;
}
export interface GalaxyScene {
  setProgress(p: number): void;
  setPointer(x: number, y: number): void;
  setActive(on: boolean): void;
  resize(): void;
  dispose(): void;
}

type Rgb = [number, number, number];
const NODE_COL: Record<Lane, Rgb> = { opencode: PALETTE.opencode as Rgb, agy: PALETTE.agy as Rgb };

function cloudGeometry(c: PointCloud): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(c.position, 3));
  g.setAttribute('aColor', new BufferAttribute(c.color, 3));
  g.setAttribute('aData', new BufferAttribute(c.data, 4));
  return g;
}

/** Throws if WebGL2 is unavailable (the caller then shows the fallback). */
export function createGalaxy(canvas: HTMLCanvasElement, opts: GalaxyOptions): GalaxyScene {
  const tcfg = TIER[opts.tier];
  const reduced = opts.reducedMotion;
  const renderer = new WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance' });
  if (!renderer.capabilities.isWebGL2) {
    renderer.dispose();
    throw new Error('galaxy: WebGL2 unavailable');
  }
  const bloomTier = tcfg.bloom;
  renderer.setClearColor(new Color(CLEAR), 1);
  renderer.toneMapping = bloomTier ? ACESFilmicToneMapping : NoToneMapping;
  renderer.toneMappingExposure = 1;
  renderer.outputColorSpace = SRGBColorSpace;
  const pointMax = Math.min(512, (renderer.getContext().getParameter(renderer.getContext().ALIASED_POINT_SIZE_RANGE) as Float32Array)[1] || 64);

  const scene = new Scene();
  const camera = new PerspectiveCamera(50, 1, 0.05, 600);
  const disposables: { dispose(): void }[] = [];
  const track = <T extends { dispose(): void }>(o: T): T => { disposables.push(o); return o; };

  // ---- shared uniforms -------------------------------------------------------------------------------------
  const shared = {
    uTime: { value: 0 }, uSpin: { value: 0 }, uScale: { value: 800 }, uPR: { value: 1 }, uGain: { value: 1.4 },
    uCoreDim: { value: 1 }, uMax: { value: pointMax },
  };
  const sprite = (blending: Blending, mode: number, o: { size?: number; rotate?: number; px?: number; big?: number; gain?: number }): ShaderMaterial => {
    const m = new ShaderMaterial({
      uniforms: {
        ...shared,
        ...(o.gain !== undefined ? { uGain: { value: o.gain } } : {}),
        uSize: { value: o.size ?? 0.05 }, uRotate: { value: o.rotate ?? 0 }, uPx: { value: o.px ?? 0 },
        uBig: { value: o.big ?? 0 }, uMode: { value: mode }, uGrow: { value: 2 }, uClearR: { value: 0 },
      },
      vertexShader: spriteVert, fragmentShader: spriteFrag, glslVersion: GLSL3,
      blending, depthWrite: false, depthTest: false, transparent: true,
    });
    return track(m);
  };
  const points = (geo: BufferGeometry, mat: ShaderMaterial, order: number): Points => {
    track(geo);
    const p = new Points(geo, mat);
    p.frustumCulled = false;
    p.renderOrder = order;
    scene.add(p);
    return p;
  };

  // Deep field in three parallax shells (fixed pixel sizes).
  const skyMats: ShaderMaterial[] = [];
  tcfg.sky.forEach((n, i) => {
    const r = [[240, 300], [120, 170], [48, 80]][i];
    const m = sprite(AdditiveBlending, 0, { px: [1.1, 1.5, 2.0][i], gain: [0.7, 0.85, 1][i] });
    skyMats.push(m);
    points(cloudGeometry(buildSky(n, r[0], r[1], 100 + i)), m, 0);
  });
  // Galaxy: stars, haze (additive), dust (alpha)
  const starMat = sprite(AdditiveBlending, 0, { size: opts.tier === 'low' ? 0.07 : 0.05, rotate: 1 });
  points(cloudGeometry(buildGalaxy(tcfg.stars)), starMat, 2);
  const hazeMat = sprite(AdditiveBlending, 1, { size: 1, rotate: 1, big: 1, gain: 0.8 });
  points(cloudGeometry(buildHaze(tcfg.haze)), hazeMat, 1);
  const dustMat = sprite(NormalBlending, 2, { size: 1, rotate: 1, big: 1, gain: 1 });
  points(cloudGeometry(buildDust(tcfg.dust)), dustMat, 3);

  // The arm the merge adds (grows outward from the core, driven by uGrow).
  const armMat = sprite(AdditiveBlending, 0, { size: opts.tier === 'low' ? 0.07 : 0.05, rotate: 1, gain: 1.0 });
  const armPts = points(cloudGeometry(buildNewArm(tcfg.arm)), armMat, 2);
  armPts.visible = false;

  // ---- comet ------------------------------------------------------------------------------------------------
  // head: one soft glowing sprite
  const cGeo = track(new BufferGeometry());
  cGeo.setAttribute('position', new BufferAttribute(new Float32Array(3), 3));
  cGeo.setAttribute('aT', new BufferAttribute(new Float32Array(1), 1));
  cGeo.setAttribute('aRand', new BufferAttribute(new Float32Array(3), 3));
  const cometMat = track(new ShaderMaterial({
    uniforms: {
      uHead: { value: new Vector3() }, uDir: { value: new Vector3(1, 0, 0) }, uLen: { value: 8 }, uVis: { value: 0 },
      uScale: shared.uScale, uMax: shared.uMax, uTime: shared.uTime, uFlash: { value: 0 },
    },
    vertexShader: cometVert, fragmentShader: spriteFrag.replace('uniform float uMode;', 'const float uMode = 0.0;'), glslVersion: GLSL3,
    blending: AdditiveBlending, depthWrite: false, depthTest: false, transparent: true,
  }));
  const comet = new Points(cGeo, cometMat);
  comet.frustumCulled = false;
  comet.renderOrder = 5;
  scene.add(comet);
  // tail: one continuous tapered ribbon, additive falloff, width in screen space
  const TSEG = 48;
  const tGeo = track(new BufferGeometry());
  const tT = new Float32Array((TSEG + 1) * 2 * 2);
  for (let s = 0; s <= TSEG; s++) for (let k = 0; k < 2; k++) tT.set([s / TSEG, k ? 1 : -1], (s * 2 + k) * 2);
  const tIdx = new Uint16Array(TSEG * 6);
  for (let s = 0; s < TSEG; s++) tIdx.set([s * 2, s * 2 + 1, s * 2 + 2, s * 2 + 1, s * 2 + 3, s * 2 + 2], s * 6);
  tGeo.setAttribute('position', new BufferAttribute(new Float32Array((TSEG + 1) * 2 * 3), 3));
  tGeo.setAttribute('aT', new BufferAttribute(tT, 2));
  tGeo.setIndex(new BufferAttribute(tIdx, 1));
  const tailMat = track(new ShaderMaterial({
    uniforms: { uHead: cometMat.uniforms.uHead, uDir: cometMat.uniforms.uDir, uLen: cometMat.uniforms.uLen, uVis: cometMat.uniforms.uVis, uRes: { value: new Vector2(1, 1) }, uScale: shared.uScale, uPR: shared.uPR },
    vertexShader: tailVert, fragmentShader: tailFrag, glslVersion: GLSL3,
    blending: AdditiveBlending, depthWrite: false, depthTest: false, transparent: true, side: 2,
  }));
  const comet2 = new Mesh(tGeo, tailMat);
  comet2.frustumCulled = false;
  comet2.renderOrder = 5;
  scene.add(comet2);

  // ---- the solar system: sun, planets, hairline orbits, the fixer ------------------------------------------------------
  const nWork = opts.workers.length;
  const fixers: { w: number; slug: string; lane: Lane }[] = [];
  opts.workers.forEach((w, i) => { if (w.failed && w.fixer) fixers.push({ w: i, slug: w.fixer.slug, lane: w.fixer.lane }); });
  const nFix = fixers.length;
  const nodeCount = nWork + 1 + nFix; // frame nodes: 0 the sun, 1..n workers (story order), then fixers
  const SUN_R = 0.11;
  const PLANET_R = 0.095;
  const SLOT_R = 0.05;
  const FIX_R = 0.024;
  const FX_R = 7.4;
  const SUN = 0;
  const FIX0 = 1 + nWork;
  const SLOT0 = 1 + nWork + nFix;
  const nBody = 1 + 2 * nWork + nFix;
  const uP = Array.from({ length: nBody }, () => new Vector4());
  const uS = Array.from({ length: nBody }, () => new Vector4());
  const bodyGeo = track(new BufferGeometry());
  {
    const bPos = new Float32Array(nBody * 4 * 3);
    const bCol = new Float32Array(nBody * 4 * 3);
    const bData = new Float32Array(nBody * 4 * 4);
    const bIdx = new Uint32Array(nBody * 6);
    const warm: Rgb = [1.0, 0.7, 0.36];
    for (let b = 0; b < nBody; b++) {
      const kind = b === SUN ? 0 : b < FIX0 ? 1 : b < SLOT0 ? 2 : 3;
      let col: Rgb = warm;
      if (kind === 1) col = NODE_COL[opts.workers[b - 1].lane];
      else if (kind === 2) col = NODE_COL[fixers[b - FIX0].lane];
      else if (kind === 3) col = NODE_COL[opts.workers[b - SLOT0].lane];
      for (let c = 0; c < 4; c++) {
        const v = b * 4 + c;
        bCol.set(col, v * 3);
        bData.set([b, kind, c % 2 ? 1 : -1, c < 2 ? -1 : 1], v * 4);
      }
      bIdx.set([b * 4, b * 4 + 1, b * 4 + 2, b * 4 + 1, b * 4 + 3, b * 4 + 2], b * 6);
    }
    bodyGeo.setAttribute('position', new BufferAttribute(bPos, 3));
    bodyGeo.setAttribute('aColor', new BufferAttribute(bCol, 3));
    bodyGeo.setAttribute('aData', new BufferAttribute(bData, 4));
    bodyGeo.setIndex(new BufferAttribute(bIdx, 1));
  }
  const bodyMat = track(new ShaderMaterial({
    uniforms: { uP: { value: uP }, uS: { value: uS }, uScale: shared.uScale, uPR: shared.uPR, uFlare: { value: 0 }, uSpin: { value: 0 } },
    vertexShader: bodyVert(nBody), fragmentShader: bodyFrag(opts.tier === 'low' ? 3 : opts.tier === 'medium' ? 4 : 5), glslVersion: GLSL3,
    blending: AdditiveBlending, depthWrite: false, depthTest: false, transparent: true,
  }));
  const bodies = new Mesh(bodyGeo, bodyMat);
  bodies.frustumCulled = false;
  bodies.renderOrder = 7;
  scene.add(bodies);

  // ribbons: one orbit hairline per planet, plus the fixer's short tail
  const lineRes = { value: new Vector2(1, 1) }; // shared device-px screen size for the ribbon lines
  interface Ribbon { mesh: Mesh; pos: Float32Array; next: Float32Array; geo: BufferGeometry; prog: number[]; al: number[] }
  function makeRibbon(nLines: number, segs: number, kind: number, width: number, color: (li: number) => Rgb): Ribbon {
    const vCount = nLines * (segs + 1) * 2;
    const pos = new Float32Array(vCount * 3);
    const next = new Float32Array(vCount * 3);
    const col = new Float32Array(vCount * 3);
    const data = new Float32Array(vCount * 4);
    const idx = new Uint32Array(nLines * segs * 6);
    for (let li = 0; li < nLines; li++) {
      for (let sg = 0; sg <= segs; sg++) for (let sd = 0; sd < 2; sd++) {
        const v = (li * (segs + 1) + sg) * 2 + sd;
        col.set(color(li), v * 3);
        data.set([sg / segs, sd ? 1 : -1, li, kind], v * 4);
      }
      for (let sg = 0; sg < segs; sg++) {
        const a = (li * (segs + 1) + sg) * 2;
        idx.set([a, a + 1, a + 2, a + 1, a + 3, a + 2], (li * segs + sg) * 6);
      }
    }
    const geo = track(new BufferGeometry());
    geo.setAttribute('position', new BufferAttribute(pos, 3));
    geo.setAttribute('aNext', new BufferAttribute(next, 3));
    geo.setAttribute('aColor', new BufferAttribute(col, 3));
    geo.setAttribute('aData', new BufferAttribute(data, 4));
    geo.setIndex(new BufferAttribute(idx, 1));
    const prog = new Array(Math.max(1, nLines)).fill(0) as number[];
    const al = new Array(Math.max(1, nLines)).fill(0) as number[];
    const mat = track(new ShaderMaterial({
      uniforms: { uRes: lineRes, uWidth: { value: width }, uPR: shared.uPR, uProg: { value: prog }, uAl: { value: al } },
      vertexShader: lineVert(Math.max(1, nLines)), fragmentShader: lineFrag, glslVersion: GLSL3,
      blending: AdditiveBlending, depthWrite: false, depthTest: false, transparent: true, side: 2,
    }));
    const mesh = new Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 6;
    scene.add(mesh);
    return { mesh, pos, next, geo, prog, al };
  }
  const SEGO = 128;
  const FSEG = 16;
  const laneTint = (l: Lane): Rgb => { const c = NODE_COL[l]; return [c[0] * 0.45 + 0.4, c[1] * 0.45 + 0.4, c[2] * 0.45 + 0.45]; };
  let sys = buildSystem({ workers: opts.workers }, 1.6);
  const orbits = makeRibbon(nWork, SEGO, 0, 0.8, (li) => laneTint(opts.workers[Math.min(li, nWork - 1)].lane));
  const tail = makeRibbon(Math.max(1, nFix), FSEG, 1, 1.1, () => NODE_COL.agy);
  tail.mesh.visible = nFix > 0;

  // flat effects in the orbital plane: the approval pulse and the scan arc
  const fxMat = track(new ShaderMaterial({
    uniforms: { uPulseR: { value: 0 }, uPulseA: { value: 0 }, uAng: { value: 0 }, uScanVis: { value: 0 }, uR: { value: 6 } },
    vertexShader: fxVert, fragmentShader: fxFrag, glslVersion: GLSL3,
    blending: AdditiveBlending, depthWrite: false, depthTest: false, transparent: true,
  }));
  const fx = new Mesh(track(new PlaneGeometry(FX_R * 2, FX_R * 2)), fxMat);
  fx.rotation.x = -Math.PI / 2;
  fx.frustumCulled = false;
  fx.renderOrder = 5;
  scene.add(fx);

  let closeIdx = -1; // planet index of the close-up
  let rMax = 6;
  function bakeSystem(): void {
    sys = buildSystem({ workers: opts.workers }, camera.aspect);
    closeIdx = sys.closeUp === null ? -1 : sys.planets.findIndex((p) => p.slug === sys.closeUp);
    rMax = sys.planets.length ? Math.max(...sys.planets.map((p) => p.orbit)) : 6;
    sys.planets.forEach((p, li) => {
      for (let sg = 0; sg <= SEGO; sg++) {
        const a0 = (sg / SEGO) * Math.PI * 2;
        const a1 = ((sg + 1) / SEGO) * Math.PI * 2;
        for (let sd = 0; sd < 2; sd++) {
          const v = (li * (SEGO + 1) + sg) * 2 + sd;
          orbits.pos.set([Math.cos(a0) * p.orbit, 0, Math.sin(a0) * p.orbit], v * 3);
          orbits.next.set([Math.cos(a1) * p.orbit, 0, Math.sin(a1) * p.orbit], v * 3);
        }
      }
    });
    orbits.geo.attributes.position.needsUpdate = true;
    orbits.geo.attributes.aNext.needsUpdate = true;
    fxMat.uniforms.uR.value = rMax + 0.6;
  }

  // ---- post -------------------------------------------------------------------------------------------------
  let composer: EffectComposer | null = null;
  let bloom: UnrealBloomPass | null = null;
  const passes: { dispose?: () => void }[] = [];
  if (bloomTier) {
    try {
      renderer.setClearColor(new Color(0, 0, 0), 1);
      composer = new EffectComposer(renderer);
      const renderPass = new RenderPass(scene, camera);
      bloom = new UnrealBloomPass(new Vector2(256, 256), 0.45, 0.3, 0.65);
      const output = new OutputPass();
      const dither = new ShaderPass({
        uniforms: { tDiffuse: { value: null } },
        vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
        fragmentShader: 'uniform sampler2D tDiffuse; varying vec2 vUv; void main() { vec4 c = texture2D(tDiffuse, vUv); vec3 bg = vec3(5.0, 6.0, 10.0) / 255.0; vec3 rgb = c.rgb + bg * (1.0 - clamp(max(c.r, max(c.g, c.b)) * 4.0, 0.0, 1.0)); vec3 hi = max(rgb - 0.62, 0.0); rgb = min(rgb, vec3(0.62)) + 0.22 * (1.0 - exp(-hi / 0.22)); gl_FragColor = vec4(rgb, 1.0); }',
      });
      composer.addPass(renderPass);
      composer.addPass(bloom);
      composer.addPass(output);
      composer.addPass(dither);
      passes.push(renderPass, bloom, output, dither);
    } catch {
      composer = null;
      bloom = null;
      renderer.setClearColor(new Color(CLEAR), 1);
      renderer.toneMapping = NoToneMapping;
    }
  }

  // ---- loop -------------------------------------------------------------------------------------------------
  let target = 0;
  let progress = 0;
  let raf = 0;
  let disposed = false;
  let active = true;
  let lastMs = performance.now();
  const t0 = lastMs;
  const ptr = { x: 0, y: 0, sx: 0, sy: 0 };
  const tmpV = new Vector3();
  const fwd = new Vector3();
  const frameOut: GalaxyFrame = { p: 0, u: 0, m: 0, closeAmt: 0, state: sceneState(0), nodes: [] };
  for (let i = 0; i < nodeCount; i++) frameOut.nodes.push({ x: 0, y: 0, front: false, on: 0, rad: 0, ok: 0, bad: 0, rev: 0 });
  const right = new Vector3();
  const upV = new Vector3();
  const back = new Vector3();
  // merge order: the data's merge index (a fixed branch merges as its fixer), unmerged workers last in launch order
  const mergeRank: number[] = [];
  opts.workers
    .map((w, i) => ({ i, key: (w.mergeIndex ?? 1000) + w.launchIndex * 1e-3 }))
    .sort((a, b) => a.key - b.key)
    .forEach((e, r) => { mergeRank[e.i] = r; });
  const nodeWorld: V3[] = Array.from({ length: nodeCount }, () => [0, 0, 0] as V3);
  const nodeRad: number[] = new Array(nodeCount).fill(0); // world radius used for the pill offset
  const nodeOnArr: number[] = new Array(nodeCount).fill(0);
  const tailPts: V3[] = Array.from({ length: FSEG + 1 }, () => [0, 0, 0] as V3);
  let cssW = 1;
  let cssH = 1;
  const ringTilt = (idx: number): number => -0.42 + 0.18 * Math.sin(idx * 2.7); // matches bodyFrag

  function renderFrame(nowMs: number): void {
    const dtRaw = Math.max(0, (nowMs - lastMs) / 1000);
    lastMs = nowMs;
    const dt = Math.min(0.1, dtRaw);
    progress = reduced ? target : progress + (target - progress) * (1 - Math.exp(-Math.min(dtRaw, 1) * 6));
    const u = lateU(progress);
    const pp = legacyP(progress);
    const m = mergeM(progress);
    const flare = coreFlare(m, nWork);
    const pullOut = ss(0.42, 0.98, m);
    const st = sceneState(pp);
    const t = reduced ? 0 : (nowMs - t0) / 1000;
    const tt = orbitT(progress); // orbital clock: scroll-driven
    shared.uTime.value = t;
    shared.uSpin.value = st.spin + 0.5 * m;
    const band = ss(0.27, 0.36, pp) * (1 - ss(0.53, 0.6, pp)); // the dive's bright stretch: thin the bulge so the tunnel reads
    // the galaxy sits far behind and dim from the dive's end through the merge; it comes back up as the camera pulls out
    const lg = ss(0.3, 0.72, m);
    const calmDive = ss(0.1, 0.28, pp) * (1 - ss(0.5, 0.58, pp));
    const calmPlan = ss(0.4, 0.56, pp) * (1 - lg);
    const calm = (1 - 0.6 * calmDive) * (1 - 0.93 * calmPlan) * (1 - 0.5 * ss(0.5, 0.58, pp) * (1 - lg));
    shared.uGain.value = 1.4 * st.galaxyGain * calm * (1 + 1.5 * lg);
    shared.uCoreDim.value = (st.coreGain + (0.8 - st.coreGain) * lg) * (1 - 0.7 * pullOut) * (1 - 0.5 * calmPlan);
    hazeMat.uniforms.uGain.value = 0.8 * st.galaxyGain * (1 - 0.8 * ss(0.5, 0.62, pp)) * (1 + 2.4 * lg) * (1 - 0.8 * band) * (1 - 0.6 * pullOut) * calm * (1 - 0.6 * calmPlan);
    dustMat.uniforms.uGain.value = (1 + 0.4 * ss(0.5, 0.6, pp)) * (1 - 0.95 * ss(0.14, 0.3, pp) * (1 - lg)) * (1 - 0.85 * calmPlan);
    // late beats: clean black around the sun so the system reads against it; the full field returns as the merge camera pulls out
    const clearR = Math.max((5 + 4 * (1 - ss(0.56, 0.62, pp))) * ss(0.5, 0.55, pp), 5 * ss(0, 0.05, u)) * (1 - ss(0.4, 0.9, m)); // also clean around the sun at the core beat
    starMat.uniforms.uClearR.value = clearR;
    hazeMat.uniforms.uClearR.value = clearR;
    dustMat.uniforms.uClearR.value = clearR;

    // ---- planets: position, launch, build, verify, merge (system.ts does the layout) ----
    const n = nWork;
    const planets = sys.planets;
    const bodyPos: V3[] = planets.map((p) => planetPos(p, tt));
    const kk: number[] = new Array(planets.length).fill(0);
    const mk: number[] = new Array(planets.length).fill(0);
    const fanW = win(L.fan, u);
    const buildW = win(L.build, u);
    planets.forEach((p, pi) => {
      kk[pi] = u > 0 ? stagger(fanW, p.launchIndex, n, 0.6) : 0;
      if (kk[pi] > 0) bodyPos[pi] = launchPos(p, kk[pi], tt);
      if (m > 0) {
        const wi = opts.workers.findIndex((w) => w.slug === p.slug);
        mk[pi] = pullK(m, mergeRank[wi], n);
        if (mk[pi] > 0) bodyPos[pi] = spiralIn(p, mk[pi], tt);
      }
    });
    const cronPos: V3 = closeIdx >= 0 ? planetPos(planets[closeIdx], tt) : [0, 0, 0];
    const cA = closeIdx >= 0 ? closeAmt(u) : 0;

    // ---- camera ----
    const aspect = camera.aspect;
    const fAsp = aspect < 1.1 ? 1 + (1.1 / aspect - 1) * 0.55 : 1;
    const f = (fAsp + (1 + (fAsp - 1) * 0.6 - fAsp) * ss(0.2, 0.5, pp)) * (1 + 0.2 * (1 - ss(0.04, 0.2, pp)));
    ptr.sx += (ptr.x - ptr.sx) * Math.min(1, dt * 3);
    ptr.sy += (ptr.y - ptr.sy) * Math.min(1, dt * 3);
    const par = (reduced ? 0 : 1 - st.diveEnv) * (1 - cA);
    const tg: [number, number, number] = [st.target[0], st.target[1], st.target[2]];
    let cx = tg[0] + (st.cam[0] - tg[0]) * f;
    let cy = tg[1] + (st.cam[1] - tg[1]) * f;
    let cz = tg[2] + (st.cam[2] - tg[2]) * f;
    // portrait hero: closer and more face-on so the galaxy fills the width under the copy
    const pw = clamp01((1.0 - aspect) / 0.35);
    const hw = pw * (1 - ss(0.04, 0.22, pp));
    if (hw > 0) {
      cx = lerp(cx, 0, hw);
      cy = lerp(cy, 16, hw);
      cz = lerp(cz, 10.5, hw);
      tg[1] = lerp(tg[1], 1.2, hw);
    }
    const fov = st.fov;
    // the dive lands in the sun's system; the camera then draws back to the overview
    const ov = systemView(aspect, rMax);
    const wSys = ss(0.54, 0.76, pp);
    if (wSys > 0) {
      cx = lerp(cx, ov.cam[0], wSys);
      cy = lerp(cy, ov.cam[1], wSys);
      cz = lerp(cz, ov.cam[2], wSys);
      tg[0] = lerp(tg[0], ov.target[0], wSys);
      tg[1] = lerp(tg[1], ov.target[1], wSys);
      tg[2] = lerp(tg[2], ov.target[2], wSys);
    }
    if (cA > 0) {
      const cl = closeView(cronPos, aspect);
      cx = lerp(cx, cl.cam[0], cA);
      cy = lerp(cy, cl.cam[1], cA);
      cz = lerp(cz, cl.cam[2], cA);
      tg[0] = lerp(tg[0], cl.target[0], cA);
      tg[1] = lerp(tg[1], cl.target[1], cA);
      tg[2] = lerp(tg[2], cl.target[2], cA);
    }
    if (m > 0) {
      const mc = mergeCam(m, aspect, rMax);
      [cx, cy, cz] = mc.cam;
      [tg[0], tg[1], tg[2]] = mc.target;
    }
    camera.position.set(cx + ptr.sx * 0.5 * par, cy + ptr.sy * 0.3 * par, cz);
    camera.up.set(Math.sin(st.roll), Math.cos(st.roll), 0);
    camera.lookAt(tg[0], tg[1], tg[2]);
    if (Math.abs(camera.fov - fov) > 1e-3) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
    shared.uScale.value = renderer.domElement.height / (2 * Math.tan((camera.fov * Math.PI) / 360));
    camera.updateMatrixWorld();
    camera.matrixWorld.extractBasis(right, upV, back);
    fwd.copy(back).negate();
    starMat.uniforms.uSize.value = (opts.tier === 'low' ? 0.07 : 0.05) * (1 + 0.3 * hw) * (1 - 0.6 * band) * (1 - 0.45 * calmPlan);

    // comet
    const cu = st.cometU;
    const head = cometAt(cu);
    const ahead = cometAt(Math.min(1, cu + 0.02));
    const behind = cometAt(Math.max(0, cu - 0.02));
    tmpV.set(ahead[0] - behind[0], ahead[1] - behind[1], ahead[2] - behind[2]).normalize();
    cometMat.uniforms.uHead.value.set(head[0], head[1], head[2]);
    cometMat.uniforms.uDir.value.copy(tmpV);
    cometMat.uniforms.uLen.value = 5 + 11 * (1 - ss(0.3, 0.52, pp));
    cometMat.uniforms.uVis.value = st.cometVis;
    cometMat.uniforms.uFlash.value = st.flash;
    comet.visible = st.cometVis > 0.002;
    comet2.visible = comet.visible;

    // core flash as the comet lands: a brief gain bump on the bulge
    shared.uGain.value *= 1 + 0.9 * st.flash;
    // merge: the whole galaxy comes back up as the camera pulls out; the bulge swells with each arrival (saturating, never blown out)
    const sparse = (opts.tier === 'low' ? 1 : 0.15) * clamp01((1.2 - aspect) / 0.74); // portrait + few stars (phones): the far camera is width-limited, so stars grow and brighten
    shared.uGain.value *= Math.min(1.15, 1 + 0.35 * pullOut * (1 + sparse)) * (1 + 0.28 * flare); // the pull-out brightening is capped: the far core stays a core, not a blob
    const wideSize = Math.min(1.4, (1 + 1.1 * pullOut) * (1 + 0.55 * pullOut * sparse)); // stars are fixed-size in world units: keep them readable from the far camera, boost capped
    starMat.uniforms.uSize.value *= wideSize;
    armMat.uniforms.uSize.value = starMat.uniforms.uSize.value;
    armMat.uniforms.uGain.value = shared.uGain.value * 0.45; // the new arm sits below the original field: never an over-bright crescent
    armMat.uniforms.uGrow.value = -0.15 + 1.27 * armGrow(m);
    armPts.visible = m > 0.3;

    // ---- the system layer ----
    const px = shared.uScale.value / shared.uPR.value; // css px per world unit at depth 1
    const sunA = ss(0.5, 0.56, pp) * (1 - 0.55 * pullOut) * (1 - 0.7 * cA) * (1 - ss(0.6, 0.9, m)); // gone entirely by merge 0.9: the merged galaxy owns the origin
    const pulseP = st.pulse > 0 && st.pulse < 1 ? st.pulse : 0;
    const pulseGlow = Math.sin(Math.PI * pulseP) ** 2;
    uP[SUN].set(0, 0, 0, SUN_R * (1 + 0.3 * flare + 0.1 * pulseGlow));
    uS[SUN].set(sunA, 0, 0, 0);
    bodyMat.uniforms.uSpin.value = tt;
    bodyMat.uniforms.uFlare.value = flare * 0.9 + st.flash * 0.5 + pulseGlow * 0.12;
    nodeWorld[0] = [0, 0, 0];
    nodeRad[0] = SUN_R;
    nodeOnArr[0] = sunA * (1 - cA);

    const scanS = win(L.scan, u);
    const scanLen = L.scan[1] - L.scan[0];
    const TH0 = -Math.PI / 2;
    const cC = closeC(u);
    const orbAl = orbits.al;
    const orbProg = orbits.prog;
    planets.forEach((p, pi) => {
      const wi = opts.workers.findIndex((w) => w.slug === p.slug);
      const w = opts.workers[wi];
      const draw = clamp01((st.draw - (p.launchIndex / Math.max(1, n)) * 0.4) / 0.6);
      const k = kk[pi];
      const mkI = mk[pi];
      const g = stagger(buildW, p.buildIndex, n, 0.5);
      // verify: the arc passes -> each planet runs its flashPhase; the close-up planet runs it during the dwell
      let okV = 0;
      let redV = 0;
      let failV = 0;
      if (u > L.scan[0] || u >= L.dwell[0]) {
        if (pi === closeIdx) {
          const fp = flashPhase(p.verify, cC);
          okV = fp.green;
          redV = fp.red;
          failV = ss(0, 0.03, cC) * (1 - ss(0.66, 0.74, cC));
        } else {
          const aNow = Math.atan2(bodyPos[pi][2], bodyPos[pi][0]);
          const rel = (((aNow - TH0) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2) / (Math.PI * 2);
          const uL = clamp01(((scanS - rel) * scanLen) / L.tick);
          const fp = flashPhase(p.verify, uL);
          okV = fp.green;
          redV = fp.red;
          failV = p.verify.redFlashes > 0 ? ss(0, 0.04, uL) * (1 - ss(0.62, 0.78, uL)) : 0;
        }
      }
      const live = ss(0, 0.05, k) * (1 - ss(0.9, 1, mkI));
      const ringAmt = g * (1 - ss(0.02, 0.2, mkI));
      const R = PLANET_R * (1 + 0.3 * g);
      uP[1 + pi].set(bodyPos[pi][0], bodyPos[pi][1], bodyPos[pi][2], R);
      uS[1 + pi].set(live * (pi === closeIdx || camera.aspect >= 1.2 ? 1 : 1 - 0.8 * cA), ringAmt, okV, redV);
      // plan slot: a dim dot on the orbit until the planet lands on it
      const slotA = ss(0.8, 1, draw) * 0.7 * (1 - ss(0.5, 0.95, k));
      const sp = planetPos(p, tt);
      uP[SLOT0 + pi].set(sp[0], sp[1], sp[2], SLOT_R);
      uS[SLOT0 + pi].set(slotA, 0, 0, 0);
      orbProg[pi] = draw;
      orbAl[pi] = 1.2 * ss(0, 0.12, draw) * (1 - ss(0.05, 0.9, mkI)) * (1 - 0.6 * ss(0.4, 0.85, m));
      // the DOM pill: on the slot until launch, hidden while it flies out, then on the planet
      const mask = clamp01(1 - ss(0, 0.08, k) + ss(0.5, 0.9, k));
      const at = k < 0.3 ? sp : bodyPos[pi];
      nodeWorld[wi + 1] = at;
      nodeRad[wi + 1] = R * (1 + 0.5 * ringAmt);
      nodeOnArr[wi + 1] = ss(0.8, 1, draw) * mask * (1 - cA * (pi === closeIdx ? 0 : 1));
      const fo = frameOut.nodes[wi + 1];
      fo.ok = okV;
      fo.bad = failV;
      fo.rev = w.reviewed ? ss(0.5, 0.95, okV) : 0;
    });
    orbits.mesh.visible = n > 0 && st.draw > 0;
    // the sun's approval pulse and the verify scan arc
    fxMat.uniforms.uPulseR.value = pulseP * (rMax + 0.8);
    fxMat.uniforms.uPulseA.value = pulseP > 0 ? Math.sin(Math.PI * pulseP) ** 0.8 * 0.9 : 0;
    fxMat.uniforms.uAng.value = TH0 + scanS * Math.PI * 2;
    fxMat.uniforms.uScanVis.value = n > 0 ? ss(L.scan[0] - 0.01, L.scan[0] + 0.005, u) * (1 - ss(L.scan[1] - 0.004, L.scan[1] + 0.012, u)) : 0;

    // the fixer: a small amber spark from outside the system that docks on the close-up planet's ring
    fixers.forEach((fx2, kf) => {
      const ni = 1 + n + kf;
      const isClose = closeIdx >= 0 && fx2.w === opts.workers.findIndex((w) => w.slug === planets[closeIdx].slug);
      let a = 0;
      let screenAway = 0;
      if (isClose) {
        const kS = shipK(u);
        const e = 1 - (1 - kS) ** 2.2;
        const ang = Math.atan2(cronPos[2], cronPos[0]);
        const S: V3 = [Math.cos(ang + 0.9) * (rMax + 3.5), 1.6, Math.sin(ang + 0.9) * (rMax + 3.5)];
        const Rc = uP[1 + closeIdx].w;
        const tilt = ringTilt(closeIdx);
        const dk = 2.5 * uS[1 + closeIdx].y * Rc;
        const D: V3 = [0, 1, 2].map((c) => cronPos[c] + (right.getComponent(c) * Math.cos(tilt) + upV.getComponent(c) * Math.sin(tilt)) * dk) as V3;
        const px2 = (D[2] - S[2]);
        const pz2 = -(D[0] - S[0]);
        const pl = Math.hypot(px2, pz2) || 1;
        const C: V3 = [(S[0] + D[0]) / 2 + (px2 / pl) * 1.3, (S[1] + D[1]) / 2 + 1.1, (S[2] + D[2]) / 2 + (pz2 / pl) * 1.3];
        const bez = (ee: number, o: V3): void => {
          const mm = 1 - ee;
          for (let c = 0; c < 3; c++) o[c] = mm * mm * S[c] + 2 * mm * ee * C[c] + ee * ee * D[c];
        };
        const headP: V3 = [0, 0, 0];
        bez(e, headP);
        a = ss(0, 0.05, kS) * (1 - ss(0.925, 0.955, u)) * (u >= L.ship[0] ? 1 : 0) * (1 - ss(0.3, 0.9, m) );
        uP[FIX0 + kf].set(headP[0], headP[1], headP[2], FIX_R);
        uS[FIX0 + kf].set(a, 0, 0, 0);
        // tail: the last stretch of the flight
        for (let s = 0; s <= FSEG; s++) bez(Math.max(0, e - 0.2 * (1 - s / FSEG)), tailPts[s]);
        for (let s = 0; s <= FSEG; s++) for (let sd = 0; sd < 2; sd++) {
          const v = (kf * (FSEG + 1) + s) * 2 + sd;
          const q = tailPts[s];
          const q2 = s < FSEG ? tailPts[s + 1] : [q[0] + (q[0] - tailPts[s - 1][0]), q[1] + (q[1] - tailPts[s - 1][1]), q[2] + (q[2] - tailPts[s - 1][2])];
          tail.pos.set(q, v * 3);
          tail.next.set(q2, v * 3);
        }
        tail.geo.attributes.position.needsUpdate = true;
        tail.geo.attributes.aNext.needsUpdate = true;
        tail.prog[kf] = 1;
        tail.al[kf] = a * 0.9 * (1 - ss(0.8, 1, kS));
        nodeWorld[ni] = headP;
        screenAway = 1;
        nodeOnArr[ni] = ss(0.01, 0.06, kS) * (1 - ss(0.88, 0.97, kS)) * (u >= L.ship[0] ? 1 : 0);
      } else {
        uS[FIX0 + kf].set(0, 0, 0, 0);
        tail.al[kf] = 0;
        nodeWorld[ni] = cronPos;
        nodeOnArr[ni] = 0;
      }
      nodeRad[ni] = FIX_R;
      void screenAway;
    });
    tail.mesh.visible = nFix > 0 && u >= L.ship[0];

    if (composer) renderer.toneMappingExposure = st.exposure;
    // planets and rings stay crisp: the bloom steps back while the system is on screen
    const sysAmt = sunA * (1 - pullOut);
    if (bloom) bloom.strength = 0.45 * st.bloom * (1 - 0.35 * ss(0.5, 0.62, pp) * (1 - lg)) * (opts.tier === 'medium' ? 0.9 : 1) * (1 - 0.55 * sysAmt) * (1 - 0.6 * cA) * (1 + 0.12 * flare);

    // project nodes
    camera.updateMatrixWorld();
    let cronScreen: [number, number] | null = null;
    for (let i = 0; i < nodeCount; i++) {
      const wp = nodeWorld[i];
      tmpV.set(wp[0], wp[1], wp[2]);
      const depth = Math.max(0.1, (tmpV.x - camera.position.x) * fwd.x + (tmpV.y - camera.position.y) * fwd.y + (tmpV.z - camera.position.z) * fwd.z);
      tmpV.project(camera);
      const fo = frameOut.nodes[i];
      fo.rad = Math.max(3, nodeRad[i] * px / depth);
      fo.x = (tmpV.x * 0.5 + 0.5) * cssW;
      fo.y = (-tmpV.y * 0.5 + 0.5) * cssH;
      fo.front = tmpV.z > -1 && tmpV.z < 1;
      fo.on = nodeOnArr[i];
      if (closeIdx >= 0 && i === opts.workers.findIndex((w) => w.slug === planets[closeIdx].slug) + 1) cronScreen = [fo.x, fo.y];
    }
    // the fixer's pill hovers on the far side of the ship from the close-up planet, never over it
    fixers.forEach((_fx, kf) => {
      const fo = frameOut.nodes[1 + n + kf];
      if (!cronScreen || fo.on <= 0.01) return;
      const dx = fo.x - cronScreen[0];
      const dy = fo.y - cronScreen[1];
      const l = Math.hypot(dx, dy) || 1;
      const away = 28 + 0.3 * Math.min(120, l);
      fo.x += (dx / l) * away;
      fo.y += (dy / l) * away * 0.6;
    });
    frameOut.p = pp;
    frameOut.u = u;
    frameOut.m = m;
    frameOut.closeAmt = cA;
    frameOut.state = st;

    if (composer) {
      try {
        composer.render(dt);
      } catch {
        composer = null;
        renderer.setClearColor(new Color(CLEAR), 1);
        renderer.toneMapping = NoToneMapping;
        renderer.render(scene, camera);
      }
    } else renderer.render(scene, camera);
    opts.onFrame?.(frameOut);
  }

  function frame(nowMs: number): void {
    if (disposed) return;
    raf = requestAnimationFrame(frame);
    if (document.hidden || !active) {
      lastMs = nowMs;
      return;
    }
    renderFrame(nowMs);
  }

  let sizeKey = '';
  function resize(): void {
    if (disposed) return;
    cssW = Math.max(1, canvas.clientWidth || 1);
    cssH = Math.max(1, canvas.clientHeight || 1);
    const pr = Math.min(window.devicePixelRatio || 1, tcfg.pr);
    // mobile URL-bar show/hide fires 'resize' without changing the (lvh) canvas: skip, resetting the buffer would flicker
    const key = `${cssW}x${cssH}@${pr}`;
    if (key === sizeKey) return;
    sizeKey = key;
    renderer.setPixelRatio(pr);
    renderer.setSize(cssW, cssH, false);
    composer?.setPixelRatio(pr);
    composer?.setSize(cssW, cssH);
    camera.aspect = cssW / cssH;
    camera.updateProjectionMatrix();
    shared.uPR.value = pr;
    shared.uMax.value = pointMax;
    lineRes.value.set(cssW * pr, cssH * pr);
    tailMat.uniforms.uRes.value.set(cssW * pr, cssH * pr);
    bakeSystem();
    if (reduced || !active) renderFrame(performance.now());
  }
  const onResize = (): void => resize();
  window.addEventListener('resize', onResize);
  resize();
  if (!reduced) raf = requestAnimationFrame(frame);

  return {
    setProgress(p: number): void {
      target = clamp01(p);
      if (reduced) renderFrame(performance.now());
    },
    setPointer(x: number, y: number): void {
      ptr.x = x;
      ptr.y = y;
    },
    setActive(on: boolean): void {
      active = on;
      lastMs = performance.now();
    },
    resize,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      for (const p of passes) p.dispose?.();
      composer?.dispose();
      for (const d of disposables) d.dispose();
      scene.clear();
      renderer.dispose();
    },
  };
}
