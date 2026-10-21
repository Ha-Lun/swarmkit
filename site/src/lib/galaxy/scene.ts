// The galaxy flight scene: one camera, driven by scroll progress through sceneState(p). Vanilla three.js.
// High/medium render through bloom on a black clear (the final pass adds #05060a after tone mapping); low renders
// direct. All copy and labels are DOM; this file only reports where Opus and the young stars land on screen.
// Beats 01-05 are a star nursery (nursery.ts) inside the galaxy: knots of gas glow in the bubble Opus carved, threads of light
// ignite them into protostars, each grows in its own cocoon; a close-up on the star with a fixer, then the merge into Opus.
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
import { createNebulaVolume, MAX_KNOTS } from './nebula-volume.ts';
import type { Tier } from './shared.ts';
import type { Lane } from '../run.ts';
import type { StoryWorker } from './story.ts';
import {
  buildDust, buildGalaxy, buildHaze, buildNebulaStars, buildNewArm, buildSky,
} from './generator.ts';
import type { PointCloud } from './generator.ts';
import {
  burstFlash, cavityR, nebulaDip, cometAt, clamp01, closeAmt, closeC, closeView, coreFlare, L, lateU, legacyP, lerp, M, formK, mergeCam, mergeM, shockAlpha, shockK, sunSwell, systemLeft, pullK, SPLIT,
  sceneState, shipK, ss, systemView,
} from './path.ts';
import type { SceneState, V3 } from './path.ts';
import { buildNursery, cocoonK, cronPhase, flashPhase, igniteK, infallPos, knotK, testPulseK, threadK, verifyU, VIEW_DIR } from './nursery.ts';
import {
  bodyFrag, bodyVert, cometVert, fxFrag, fxVert, lineFrag, lineVert, spriteFrag, spriteVert, tailFrag, tailVert,
} from './shaders.ts';

const CLEAR = '#05060a';
const TIER = {
  // neb: young stars in the nebula (the gas is the ray-marched volume, nebula-volume.ts)
  high: { stars: 110000, arm: 5000, haze: 44, dust: 280, sky: [5200, 2600, 1100], pr: 1.75, bloom: true, neb: 520 },
  medium: { stars: 55000, arm: 3200, haze: 36, dust: 200, sky: [2600, 1300, 600], pr: 1.25, bloom: true, neb: 340 },
  low: { stars: 15000, arm: 2200, haze: 22, dust: 120, sky: [900, 500, 250], pr: 1, bloom: false, neb: 200 },
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
    uCoreDim: { value: 1 }, uMax: { value: pointMax }, uDof: { value: 0 }, uFocusD: { value: 2 },
  };
  const volMask = { value: new Vector4(-0.6, 0, 0.5, 0.95) }; // NDC ellipse that keeps the nebula dim behind the copy column (set in resize)
  const copyMask = { value: new Vector4(-0.6, 0, 0.5, 0.95) }; // NDC ellipse of the close-up headline column (set in resize)
  const sprite = (blending: Blending, mode: number, o: { size?: number; rotate?: number; px?: number; big?: number; gain?: number }): ShaderMaterial => {
    const m = new ShaderMaterial({
      uniforms: {
        ...shared,
        ...(o.gain !== undefined ? { uGain: { value: o.gain } } : {}),
        uSize: { value: o.size ?? 0.05 }, uRotate: { value: o.rotate ?? 0 }, uPx: { value: o.px ?? 0 },
        uBig: { value: o.big ?? 0 }, uMode: { value: mode }, uForm: { value: 1 }, uSpark: { value: 0 }, uClearR: { value: 0 },
        uNear: { value: 0 }, uCopyMask: copyMask, uCopyAmt: { value: 0 },
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
  // The nebula gas: ray-marched volume (reduced-res target, composited before the planets), see nebula-volume.ts.
  const nebVol = createNebulaVolume(opts.tier, renderer);
  scene.add(nebVol.object3d);
  // Galaxy: stars, haze (additive), dust (alpha)
  const starMat = sprite(AdditiveBlending, 0, { size: opts.tier === 'low' ? 0.07 : 0.05, rotate: 1 });
  starMat.uniforms.uSpark.value = 1;
  const starPts = points(cloudGeometry(buildGalaxy(tcfg.stars)), starMat, 2);
  const hazeMat = sprite(AdditiveBlending, 1, { size: 1, rotate: 1, big: 1, gain: 0.8 });
  const hazePts = points(cloudGeometry(buildHaze(tcfg.haze)), hazeMat, 1);
  const dustMat = sprite(NormalBlending, 2, { size: 1, rotate: 1, big: 1, gain: 1 });
  const dustPts = points(cloudGeometry(buildDust(tcfg.dust)), dustMat, 3);

  // Young stars embedded in the nebula (crisp points; the gas itself is the volume). Own gain, no differential rotation,
  // near-faded by view distance so the camera can fly through them.
  const nebStarMat = sprite(AdditiveBlending, 0, { size: opts.tier === 'low' ? 0.07 : 0.05, rotate: 0, gain: 0 });
  nebStarMat.uniforms.uCoreDim = { value: 1 };
  nebStarMat.uniforms.uNear = { value: 0.8 };
  const nebStarPts = points(cloudGeometry(buildNebulaStars(tcfg.neb)), nebStarMat, 2);

  // The arm the merge adds (hidden until the merge brings it in).
  const armMat = sprite(AdditiveBlending, 0, { size: opts.tier === 'low' ? 0.07 : 0.05, rotate: 1, gain: 1.0 });
  armMat.uniforms.uSpark.value = 1;
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

  // ---- the star nursery: Opus (the sun), the young stars, light threads, the fixer --------------------------------------
  const nWork = opts.workers.length;
  const fixers: { w: number; slug: string; lane: Lane }[] = [];
  opts.workers.forEach((w, i) => { if (w.failed && w.fixer) fixers.push({ w: i, slug: w.fixer.slug, lane: w.fixer.lane }); });
  const nFix = fixers.length;
  const nodeCount = nWork + 1 + nFix; // frame nodes: 0 the sun, 1..n workers (story order), then fixers
  const SUN_R = 0.11;
  const STAR_R = 0.05;
  const FIX_R = 0.024;
  const FX_R = 10;
  const SUN = 0;
  const FIX0 = 1 + nWork;
  const nBody = 1 + nWork + nFix;
  const uP = Array.from({ length: nBody }, () => new Vector4());
  const uS = Array.from({ length: nBody }, () => new Vector4());
  const uA = Array.from({ length: nBody }, () => new Vector4());
  const bodyGeo = track(new BufferGeometry());
  {
    const bPos = new Float32Array(nBody * 4 * 3);
    const bCol = new Float32Array(nBody * 4 * 3);
    const bData = new Float32Array(nBody * 4 * 4);
    const bIdx = new Uint32Array(nBody * 6);
    const warm: Rgb = [1.0, 0.7, 0.36];
    for (let b = 0; b < nBody; b++) {
      const kind = b === SUN ? 0 : b < FIX0 ? 1 : 2;
      let col: Rgb = warm;
      if (kind === 1) col = NODE_COL[opts.workers[b - 1].lane];
      else if (kind === 2) col = NODE_COL[fixers[b - FIX0].lane];
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
    uniforms: { uP: { value: uP }, uS: { value: uS }, uA: { value: uA }, uScale: shared.uScale, uPR: shared.uPR, uFlare: { value: 0 }, uSpin: { value: 0 }, uTime: shared.uTime },
    vertexShader: bodyVert(nBody), fragmentShader: bodyFrag(), glslVersion: GLSL3,
    blending: AdditiveBlending, depthWrite: false, depthTest: false, transparent: true,
  }));
  const bodies = new Mesh(bodyGeo, bodyMat);
  bodies.frustumCulled = false;
  bodies.renderOrder = 7;
  scene.add(bodies);

  // the sun's soft lens glow: one big warm sprite (no cross, no spikes), own gain, never core-dimmed
  const haloGeo = track(new BufferGeometry());
  haloGeo.setAttribute('position', new BufferAttribute(new Float32Array(3), 3));
  const haloCol = new Float32Array([1.0, 0.62, 0.3]);
  const haloColAttr = new BufferAttribute(haloCol, 3);
  haloGeo.setAttribute('aColor', haloColAttr);
  haloGeo.setAttribute('aData', new BufferAttribute(new Float32Array([1, 0.3, 0.3, 0]), 4));
  const haloMat = sprite(AdditiveBlending, 1, { size: 2.8, big: 1, gain: 0 });
  haloMat.uniforms.uCoreDim = { value: 1 };
  points(haloGeo, haloMat, 4);
  // the supernova's hot point core: a steep radial falloff (mode 3), white-violet, only alive across the burst
  const bcoreGeo = track(new BufferGeometry());
  bcoreGeo.setAttribute('position', new BufferAttribute(new Float32Array(3), 3));
  bcoreGeo.setAttribute('aColor', new BufferAttribute(new Float32Array([1, 0.9, 1]), 3));
  bcoreGeo.setAttribute('aData', new BufferAttribute(new Float32Array([1, 0.3, 0.3, 0]), 4));
  const bcoreMat = sprite(AdditiveBlending, 3, { size: 2, big: 1, gain: 0 });
  bcoreMat.uniforms.uCoreDim = { value: 1 };
  const bcorePts = points(bcoreGeo, bcoreMat, 5);

  // ribbons: one light thread per young star, plus the fixer's short tail
  const lineRes = { value: new Vector2(1, 1) }; // shared device-px screen size for the ribbon lines
  interface Ribbon { mesh: Mesh; pos: Float32Array; next: Float32Array; geo: BufferGeometry; prog: number[]; al: number[]; pul: number[]; mat: ShaderMaterial }
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
    const pul = new Array(Math.max(1, nLines)).fill(0) as number[];
    const mat = track(new ShaderMaterial({
      uniforms: { uRes: lineRes, uWidth: { value: width }, uPR: shared.uPR, uProg: { value: prog }, uAl: { value: al }, uPul: { value: pul }, uFocus: { value: new Vector3() }, uDof: shared.uDof, uCopyMask: copyMask, uCopyAmt: { value: 0 } },
      vertexShader: lineVert(Math.max(1, nLines)), fragmentShader: lineFrag, glslVersion: GLSL3,
      blending: AdditiveBlending, depthWrite: false, depthTest: false, transparent: true, side: 2,
    }));
    const mesh = new Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 6;
    scene.add(mesh);
    return { mesh, pos, next, geo, prog, al, pul, mat };
  }
  const THSEG = 64;
  const FSEG = 16;
  const threads = makeRibbon(nWork, THSEG, 0, 1.5, (li) => NODE_COL[opts.workers[Math.min(li, nWork - 1)].lane]);
  const tail = makeRibbon(Math.max(1, nFix), FSEG, 1, 1.1, () => NODE_COL.agy);
  tail.mesh.visible = nFix > 0;
  // the feeding stream: a curved additive ribbon from the fixer into the close-up star (kind 2, flow phase in uProg)
  const FEEDSEG = 28;
  const feed = makeRibbon(1, FEEDSEG, 2, 1.7, () => NODE_COL[fixers[0]?.lane ?? 'agy']);
  feed.mesh.visible = false;

  // Opus's approval pulse (a soft expanding ring facing the camera) and the supernova shock ring (galaxy plane)
  const fxMat = track(new ShaderMaterial({
    uniforms: { uPulseR: { value: 0 }, uPulseA: { value: 0 }, uShockR: { value: 0 }, uShockA: { value: 0 } },
    vertexShader: fxVert, fragmentShader: fxFrag, glslVersion: GLSL3,
    blending: AdditiveBlending, depthWrite: false, depthTest: false, transparent: true,
  }));
  const fx = new Mesh(track(new PlaneGeometry(FX_R * 2, FX_R * 2)), fxMat);
  fx.rotation.x = -Math.PI / 2;
  fx.frustumCulled = false;
  fx.renderOrder = 5;
  scene.add(fx);

  let nur = buildNursery({ workers: opts.workers }, 1.6);
  let closeIdx = -1; // star index (launch order) of the close-up
  let rMax = 6; // framing radius: the nursery's extent plus its cocoons
  const starSlot: number[] = []; // star (launch order) -> index in opts.workers
  const starAxis: V3[] = []; // bipolar axis (disc normal) of every young star, a varied tilt about the view direction
  const starKnot: Vector4[] = Array.from({ length: Math.min(nWork, MAX_KNOTS) }, () => new Vector4());
  const starKnotC: Vector4[] = Array.from({ length: Math.min(nWork, MAX_KNOTS) }, () => new Vector4());
  const starKnotA: Vector4[] = Array.from({ length: Math.min(nWork, MAX_KNOTS) }, () => new Vector4());
  const GOLD = 2.399963;
  function bakeSystem(): void {
    nur = buildNursery({ workers: opts.workers }, camera.aspect);
    closeIdx = nur.closeUp === null ? -1 : nur.stars.findIndex((s) => s.slug === nur.closeUp);
    rMax = nur.stars.length ? nur.extent + 0.7 : 6;
    // the basis across the view direction (same construction as nursery.ts)
    const vd = VIEW_DIR;
    const l1 = Math.hypot(vd[2], vd[0]) || 1;
    const e1: V3 = [-vd[2] / l1, 0, vd[0] / l1];
    const e2: V3 = [vd[1] * e1[2] - vd[2] * e1[1], vd[2] * e1[0] - vd[0] * e1[2], vd[0] * e1[1] - vd[1] * e1[0]];
    nur.stars.forEach((s, i) => {
      starSlot[i] = opts.workers.findIndex((w) => w.slug === s.slug);
      const a = 0.9 + i * GOLD * 0.8;
      const tilt = 0.5 * Math.sin(i * 2.1 + 0.4); // out of the view plane, either way: never along the line of sight
      const v: V3 = [0, 1, 2].map((k) => Math.cos(a) * e1[k] + Math.sin(a) * e2[k] + tilt * vd[k]) as V3;
      const l = Math.hypot(v[0], v[1], v[2]) || 1;
      starAxis[i] = [v[0] / l, v[1] / l, v[2] / l];
      fillThread(starSlot[i], s.pos);
    });
    threads.geo.attributes.position.needsUpdate = true;
    threads.geo.attributes.aNext.needsUpdate = true;
  }
  const threadPrev: V3 = [0, 0, 0];
  const feedPrev: V3 = [0, 0, 0];
  const threadAt = (C: V3, P: V3, tt: number, o: V3): void => {
    const k0 = 0.04 + 0.96 * tt; // starts a hair off Opus, ends on the star
    const m1 = 1 - k0;
    for (let c = 0; c < 3; c++) o[c] = 2 * m1 * k0 * C[c] + k0 * k0 * P[c];
  };
  /** The thread: a gentle arc from just off Opus to the star at P, bowed sideways like a filament of gas (slot li = story order). */
  function fillThread(li: number, P: V3): void {
    const vd = VIEW_DIR;
    const r = Math.hypot(P[0], P[1], P[2]) || 1;
    const dir: V3 = [P[0] / r, P[1] / r, P[2] / r];
    const bowD: V3 = [dir[1] * vd[2] - dir[2] * vd[1], dir[2] * vd[0] - dir[0] * vd[2], dir[0] * vd[1] - dir[1] * vd[0]];
    const bl = Math.hypot(bowD[0], bowD[1], bowD[2]) || 1;
    const bow = 0.16 * r * (li % 2 === 0 ? 1 : -1);
    const C: V3 = [P[0] * 0.5 + (bowD[0] / bl) * bow, P[1] * 0.5 + (bowD[1] / bl) * bow, P[2] * 0.5 + (bowD[2] / bl) * bow];
    const p0: V3 = [0, 0, 0];
    const p1: V3 = [0, 0, 0];
    for (let sg = 0; sg <= THSEG; sg++) {
      threadAt(C, P, sg / THSEG, p0);
      threadAt(C, P, Math.min(1, (sg + 1) / THSEG), p1);
      if (sg === THSEG) for (let c = 0; c < 3; c++) p1[c] = p0[c] + (p0[c] - threadPrev[c]);
      for (let sd = 0; sd < 2; sd++) {
        const v2 = (li * (THSEG + 1) + sg) * 2 + sd;
        threads.pos.set(p0, v2 * 3);
        threads.next.set(p1, v2 * 3);
      }
      threadPrev[0] = p0[0]; threadPrev[1] = p0[1]; threadPrev[2] = p0[2];
    }
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
  let threadsMerged = false;
  const nodeWorld: V3[] = Array.from({ length: nodeCount }, () => [0, 0, 0] as V3);
  const nodeRad: number[] = new Array(nodeCount).fill(0); // world radius used for the pill offset
  const nodeOnArr: number[] = new Array(nodeCount).fill(0);
  const tailPts: V3[] = Array.from({ length: FSEG + 1 }, () => [0, 0, 0] as V3);
  let cssW = 1;
  let cssH = 1;

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
    const idleOn = reduced ? 0 : 1; // ambient idle motion (owner-allowed): time-based, layered on the scroll; 0 under reduced motion
    const tt = 4.2 * clamp01((progress - SPLIT) / (1 - SPLIT)); // scroll-driven rotation clock for the stars' surfaces (the idle motion is uTime in the shaders)
    shared.uTime.value = t;
    shared.uSpin.value = st.spin + 0.5 * m;
    const band = ss(0.27, 0.36, pp) * (1 - ss(0.53, 0.6, pp)); // the dive's bright stretch: thin the bulge so the tunnel reads
    // the galaxy sits far behind and dim from the dive's end through the merge; it comes back up as the camera pulls out
    const lg = ss(0.3, 0.72, m);
    const calmDive = ss(0.1, 0.28, pp) * (1 - ss(0.5, 0.58, pp));
    const calmPlan = ss(0.4, 0.56, pp) * (1 - lg);
    const calm = (1 - 0.6 * calmDive) * (1 - 0.84 * calmPlan) * (1 - 0.5 * ss(0.5, 0.58, pp) * (1 - lg));
    // the spiral galaxy exists only after the supernova (the page opens on the nebula): hidden until the burst, then each star flies out of the core (uForm)
    const fK = formK(m);
    const galVis = fK > 0.001;
    for (const gm of [starMat, hazeMat, dustMat, armMat]) gm.uniforms.uForm.value = fK;
    const fin = ss(0.45, 1.0, m); // the finished galaxy: lifts out of the system-beat dimming (gain chains tuned for the dive) back to the hero look
    const mixTo = (v: number, to: number): number => v + (to - v) * fin;
    starPts.visible = galVis;
    hazePts.visible = galVis;
    dustPts.visible = galVis;
    shared.uGain.value = 1.4 * mixTo(st.galaxyGain, 0.5) * calm * (1 + 1.5 * lg);
    shared.uCoreDim.value = mixTo((st.coreGain + (0.8 - st.coreGain) * lg) * (1 - 0.7 * pullOut) * (1 - 0.5 * calmPlan), 0.6);
    hazeMat.uniforms.uGain.value = 0.8 * mixTo(st.galaxyGain * (1 - 0.8 * ss(0.5, 0.62, pp)) * (1 + 2.4 * lg) * (1 - 0.6 * pullOut), 1.0) * (1 - 0.8 * band) * calm * (1 - 0.6 * calmPlan);
    hazeMat.uniforms.uSize.value = 1 + 0.7 * ss(0.5, 1, m); // the far camera shrinks the soft sprites: keep the disc light as wide on screen as in the near hero view
    hazeMat.uniforms.uGain.value *= ss(0.2, 0.8, fK); // the soft disc light arrives with the stars, not stacked on the core
    dustMat.uniforms.uGain.value = (1 + 0.4 * ss(0.5, 0.6, pp)) * (1 - 0.95 * ss(0.14, 0.3, pp) * (1 - lg)) * (1 - 0.85 * calmPlan);
    dustMat.uniforms.uGain.value *= 1 - 0.55 * clamp01((1.0 - camera.aspect) / 0.35) * ss(0.45, 1, m); // phones: the far camera makes each dust sprite a big black smear
    // late beats: clean black around the sun so the system reads against it; the full field returns as the merge camera pulls out
    const clearR = Math.max((2.6 + 3 * (1 - ss(0.56, 0.62, pp))) * ss(0.5, 0.55, pp), 2.6 * ss(0, 0.05, u)) * (1 - ss(M.burst[0], M.burst[1], m)); // also clean around the sun at the core beat
    starMat.uniforms.uClearR.value = clearR;
    hazeMat.uniforms.uClearR.value = clearR;
    dustMat.uniforms.uClearR.value = clearR;
    // the nebula: full through the hero, comet and dive; the knot contracts to a point and brightens, the flash, then the gas thins to a faint
    // remnant behind the system and goes out as the merge brings the galaxy up
    const nebBlow = ss(M.burst[0], M.burst[1], m); // the supernova's shock ring sweeps the remnant away within the burst
    const nebRem = (1 - 0.62 * ss(0.5, 0.66, pp)) * (1 - nebBlow);
    nebStarPts.visible = nebRem > 0.002;
    const nebPortrait = clamp01((1.0 - camera.aspect) / 0.35); // phones: fewer stars and less gas per screen area, so lift both
    nebStarMat.uniforms.uGain.value = 1.0 * nebRem * (1 - 0.3 * band) * (1 + 0.7 * nebPortrait);
    nebStarMat.uniforms.uClearR.value = clearR;

    // ---- young stars: knots (plan), threads + ignition (fan), cocoon build, verify, merge (nursery.ts does the layout) ----
    const n = nWork;
    const stars = nur.stars;
    const starPos: V3[] = stars.map((s) => [s.pos[0], s.pos[1], s.pos[2]] as V3);
    const kk: number[] = new Array(stars.length).fill(0); // knot glow-in (plan)
    const thK: number[] = new Array(stars.length).fill(0); // thread travel (fan)
    const igK: number[] = new Array(stars.length).fill(0); // ignition
    const cbK: number[] = new Array(stars.length).fill(0); // cocoon build
    const mk: number[] = new Array(stars.length).fill(0); // merge fall
    const pulseP = st.pulse > 0 && st.pulse < 1 ? st.pulse : 0;
    const pulseFront = pulseP * (rMax + 1.0);
    stars.forEach((s, pi) => {
      kk[pi] = knotK(pp, s.rank, n);
      thK[pi] = threadK(u, s.rank, n);
      igK[pi] = igniteK(u, s.rank, n);
      cbK[pi] = cocoonK(u, s.buildIndex, n);
      if (m > 0) {
        mk[pi] = pullK(m, mergeRank[starSlot[pi]], n);
        starPos[pi] = infallPos(s.pos, mk[pi]); // a gentle inward spiral: gravity pulls the cluster into Opus
      }
    });
    const cronPos: V3 = closeIdx >= 0 ? starPos[closeIdx] : [0, 0, 0];
    const cA = closeIdx >= 0 ? closeAmt(u) : 0;
    const cronR = closeIdx >= 0 ? STAR_R * (0.8 + 0.2 * igK[closeIdx] + 0.35 * cbK[closeIdx]) : STAR_R; // the close-up star's body radius (frames the close-up)
    shared.uDof.value = cA; // fake depth of field in the close-up: far stars and threads soften with distance from the focus star
    // the knots are density pockets of the same nebula gas: positions + glow (the pulse from Opus brightens them as it passes), tint + ignition, axis + cocoon
    stars.forEach((s, pi) => {
      if (pi >= starKnot.length) return;
      const r = Math.hypot(s.pos[0], s.pos[1], s.pos[2]);
      const hit = pulseP > 0 ? Math.exp(-(((pulseFront - r) / 0.9) ** 2)) : 0;
      const gone = 1 - ss(0, 0.25, mk[pi]);
      const c = NODE_COL[s.lane];
      // the close-up star: its cocoon glow steps back so the star reads (not a blob), and the cocoon flushes red with each sputter
      const isC = pi === closeIdx;
      const kRed = isC && u >= L.dwell[0] ? cronPhase(s.verify.redFlashes, closeC(u)).red : 0;
      const kDim = isC ? 1 - 0.7 * cA : 1;
      starKnot[pi].set(starPos[pi][0], starPos[pi][1], starPos[pi][2], kk[pi] * (1 + 1.1 * hit) * gone * kDim);
      starKnotC[pi].set(c[0] + (1.0 - c[0]) * kRed, c[1] * (1 - 0.85 * kRed), c[2] * (1 - 0.9 * kRed), igK[pi] * gone * (isC ? 1 - 0.45 * cA : 1));
      starKnotA[pi].set(starAxis[pi][0], starAxis[pi][1], starAxis[pi][2], cbK[pi]);
    });

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
      const cl = closeView(cronPos, aspect, cronR);
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
    // camera life: stronger pointer parallax in the system beats, plus a tiny slow Lissajous sway (smaller in the close-up so framing holds)
    const sysP = wSys * (1 - m);
    const sway = idleOn * (0.2 + 0.8 * wSys) * (1 - 0.92 * cA) * (1 - m);
    camera.position.set(
      cx + ptr.sx * 0.5 * par * (1 + 0.9 * sysP) + Math.sin(t * 0.21) * 0.16 * sway,
      cy + ptr.sy * 0.3 * par * (1 + 0.9 * sysP) + Math.sin(t * 0.17 + 1.3) * 0.1 * sway,
      cz + Math.sin(t * 0.13 + 2.1) * 0.12 * sway,
    );
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
    // nebula volume: full through hero, comet and dive (the knot collapses at the ignition flash), then the dimmed remnant around the
    // star's cavity; the shock ring widens the cavity past the sky and the gas is gone by the end of the burst. Low renders direct, so lift it.
    nebVol.render(renderer, camera, {
      time: t,
      gain: 0.38 * nebRem * nebulaDip(pp) * (1 - 0.3 * band) * (1 - 0.35 * nebPortrait) * (opts.tier === 'low' ? 1.5 : 1),
      knots: { n: Math.min(nWork, MAX_KNOTS), p: starKnot, c: starKnotC, a: starKnotA, gain: 0.7 * (1 - nebBlow) * (1 + 0.5 * nebPortrait) },
      cavR: Math.max(cavityR(pp, rMax), camera.position.length() * 1.45 * ss(0.512, 0.545, pp) * (1 - ss(0.6, 0.66, pp)), shockK(m) * (rMax + 1.2) * 2.4),
      collapse: ss(0.4, 0.512, pp),
      knot: 1 - ss(0.515, 0.545, pp),
      copyAmt: ss(0.45, 0.55, pp),
      wall: ss(0.56, 0.75, pp), // Opus lights the bubble walls: a gentle ramp over the plan beat
      copyMask: volMask.value,
      still: reduced,
    });
    shared.uFocusD.value = Math.max(0.5, (cronPos[0] - camera.position.x) * fwd.x + (cronPos[1] - camera.position.y) * fwd.y + (cronPos[2] - camera.position.z) * fwd.z);
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
    const portraitK = clamp01((1.2 - aspect) / 0.74); // phones: the far final camera is width-limited
    const sparse = (opts.tier === 'low' ? 1 : 0.15) * portraitK; // portrait + few stars (phones): the far camera is width-limited, so stars grow and brighten
    shared.uGain.value *= Math.min(1.15 + 0.7 * portraitK, 1 + 0.35 * pullOut * (1 + sparse)) * (1 + 0.28 * flare) * (0.35 + 0.65 * ss(0.12, 0.55, fK)); // while the debris is still packed near the core it stacks additively: hold it down until it spreads; the pull-out brightening is capped: the far core stays a core, not a blob
    const wideSize = Math.min(1.4 + 1.3 * portraitK, (1 + 1.1 * pullOut) * (1 + 0.55 * pullOut * sparse + 0.9 * pullOut * portraitK)); // stars are fixed-size in world units: keep them readable from the far camera, boost capped
    starMat.uniforms.uSize.value *= wideSize;
    armMat.uniforms.uSize.value = starMat.uniforms.uSize.value;
    armMat.uniforms.uGain.value = shared.uGain.value * 0.45; // the new arm sits below the original field: never an over-bright crescent
    armPts.visible = galVis;

    // ---- the nursery layer ----
    const px = shared.uScale.value / shared.uPR.value; // css px per world unit at depth 1
    const sunA = ss(0.5, 0.56, pp) * (1 - 0.55 * pullOut) * (1 - 0.7 * cA) * systemLeft(m) * (1 - ss(M.burst[0] - 0.006, M.burst[0] + 0.008, m)); // the star body is gone at the burst (the hot point core takes over); gone by the end of the burst: the merged galaxy owns the origin
    const pulseGlow = Math.sin(Math.PI * pulseP) ** 2;
    uP[SUN].set(0, 0, 0, SUN_R * (1 + 0.3 * flare + 0.1 * pulseGlow + 1.6 * sunSwell(m)));
    uS[SUN].set(sunA * (1 + 2.6 * cA), 0, 0, 0); // behind the close-up copy the far sun is lifted back to a blazing star (the dimming above only guards the pill and the bloom)
    bodyMat.uniforms.uSpin.value = tt;
    bodyMat.uniforms.uFlare.value = flare * 0.9 + st.flash * 0.5 + pulseGlow * 0.12;
    nodeWorld[0] = [0, 0, 0];
    nodeRad[0] = SUN_R;
    nodeOnArr[0] = sunA * (1 - cA);

    const cC = closeC(u);
    const cph = closeIdx >= 0 ? cronPhase(nur.stars[closeIdx].verify.redFlashes, cC) : { red: 0, green: 0, feed: 0 };
    stars.forEach((s, pi) => {
      const wi = starSlot[pi];
      const w = opts.workers[wi];
      // verify: a test pulse runs out along the thread; when it lands the star runs its verify (passing: a steady calm burn,
      // failing: a red sputter, then it re-ignites). The close-up star sputters and is fed during the dwell instead.
      let okV = 0;
      let redV = 0;
      let failV = 0;
      let bright = 1;
      if (pi === closeIdx) {
        if (u >= L.dwell[0]) {
          const ph = cronPhase(s.verify.redFlashes, cC);
          okV = ph.green;
          redV = ph.red;
          failV = ss(0, 0.03, cC) * (1 - ss(0.6, 0.72, cC));
          const flick = 0.5 + 0.5 * Math.sin(cC * Math.PI * 2 * s.verify.redFlashes * 14);
          bright = (1 - 0.6 * redV * flick) * (1 + 0.3 * ph.feed);
        }
      } else if (u > L.scan[0]) {
        const uL = verifyU(u, s.rank, n);
        const fp = flashPhase(s.verify, uL);
        okV = fp.green;
        redV = fp.red;
        if (s.verify.redFlashes > 0) {
          failV = ss(0, 0.04, uL) * (1 - ss(0.62, 0.78, uL));
          const flick = 0.5 + 0.5 * Math.sin(clamp01(uL / 0.7) * Math.PI * 2 * s.verify.redFlashes * 6);
          bright = (1 - 0.6 * redV * flick) * (1 + 0.35 * Math.sin(Math.PI * okV)); // sputters, then re-ignites
        }
      }
      // close-up: stars inside the headline column step back so the copy reads (the focus star stays)
      let copyDim = 0;
      if (cA > 0 && pi !== closeIdx) {
        tmpV.set(starPos[pi][0], starPos[pi][1], starPos[pi][2]).project(camera);
        const nx = (tmpV.x - copyMask.value.x) / copyMask.value.z;
        const ny = (tmpV.y - copyMask.value.y) / copyMask.value.w;
        copyDim = 0.9 * cA * (1 - ss(0.75, 1.25, Math.hypot(nx, ny)));
      }
      const live = ss(0, 0.06, igK[pi]) * (1 - ss(0.9, 1, mk[pi])) * (1 - copyDim);
      const R = STAR_R * (0.8 + 0.2 * igK[pi] + 0.35 * cbK[pi]) * (pi === closeIdx ? 1 + 0.4 * cA : 1); // the close-up star grows so its disc and jets read
      // jet axis and disc tilt on screen: the axis projected onto the camera basis
      const ax = starAxis[pi];
      const sx = ax[0] * right.x + ax[1] * right.y + ax[2] * right.z;
      const sy = ax[0] * upV.x + ax[1] * upV.y + ax[2] * upV.z;
      const sz = ax[0] * back.x + ax[1] * back.y + ax[2] * back.z;
      uP[1 + wi].set(starPos[pi][0], starPos[pi][1], starPos[pi][2], R);
      uS[1 + wi].set(live * bright * (pi === closeIdx || camera.aspect >= 1.2 ? 1 : 1 - 0.8 * cA), okV, redV, pi === closeIdx ? cA : 0);
      uA[1 + wi].set(Math.atan2(sy, sx), Math.abs(sz), igK[pi], cbK[pi]);
      // the thread: a bright head travels out from Opus, then it settles to a faint filament
      const landed = thK[pi] >= 1;
      const pv = testPulseK(u, s.rank, n);
      threads.pul[wi] = pv > 0 && pv < 1 ? pv : 0; // the test pulse from Opus
      if (m > 0 && mk[pi] < 1) fillThread(wi, starPos[pi]); // the thread follows its star as it falls in
      threadsMerged = threadsMerged || (m > 0 && mk[pi] < 1);
      threads.prog[wi] = thK[pi];
      threads.al[wi] = (landed ? 0.2 + 0.8 * (1 - ss(0, 1, igK[pi])) : ss(0, 0.04, thK[pi])) * (1 - ss(0.1, 0.9, mk[pi])) * systemLeft(m);
      // the DOM pill sits under its knot; it names the planned worker from the plan beat on
      nodeWorld[wi + 1] = starPos[pi];
      nodeRad[wi + 1] = 0.4 + 0.1 * cbK[pi];
      nodeOnArr[wi + 1] = ss(0.7, 1, kk[pi]) * (1 - ss(0, 0.2, mk[pi])) * (1 - cA * (pi === closeIdx ? 0 : 1));
      const fo = frameOut.nodes[wi + 1];
      fo.ok = okV;
      fo.bad = failV;
      fo.rev = w.reviewed ? ss(0.5, 0.95, okV) : 0;
    });
    if (m > 0) {
      threads.geo.attributes.position.needsUpdate = true;
      threads.geo.attributes.aNext.needsUpdate = true;
    } else if (threadsMerged) {
      stars.forEach((s2, pi2) => fillThread(starSlot[pi2], s2.pos)); // rewound out of the merge: back to the baked threads
      threads.geo.attributes.position.needsUpdate = true;
      threads.geo.attributes.aNext.needsUpdate = true;
      threadsMerged = false;
    }
    threads.mesh.visible = n > 0 && u > 0;
    threads.mat.uniforms.uCopyAmt.value = cA;
    threads.mat.uniforms.uFocus.value.set(cronPos[0], cronPos[1], cronPos[2]);
    hazeMat.uniforms.uGain.value *= 1 + 2.6 * portraitK * pullOut;
    hazeMat.uniforms.uSize.value *= 1 + 0.45 * portraitK * pullOut; // the haze carries the disc on phones
    const bf = burstFlash(m);
    haloMat.uniforms.uGain.value = 0.17 * sunA * (1 + 1.6 * cA) * (1 + 2.5 * sunSwell(m)) + 1.1 * st.flash + 0.08 * bf; // + the ignition flash and the (now gentle) supernova wash
    haloMat.uniforms.uSize.value = 2.8 * (1 + 0.5 * bf + 0.8 * sunSwell(m));
    const b0 = M.burst[0];
    const bCore = ss(b0 - 0.004, b0 + 0.012, m) * (1 - ss(b0 + 0.014, b0 + 0.075, m)); // the hot point: a sharp rise, a quick fall
    bcorePts.visible = bCore > 0.002;
    bcoreMat.uniforms.uGain.value = 2.0 * bCore;
    bcoreMat.uniforms.uSize.value = 2.6 * (0.45 + 1.2 * ss(b0, b0 + 0.06, m));
    haloCol[0] = 1 - 0.2 * bf;
    haloCol[1] = 0.62 + 0.1 * bf;
    haloCol[2] = 0.3 + 0.7 * bf;
    haloColAttr.needsUpdate = true;
    fxMat.uniforms.uShockR.value = shockK(m) * (rMax + 1.2);
    fxMat.uniforms.uShockA.value = shockAlpha(m);
    fxMat.uniforms.uPulseR.value = pulseFront;
    fxMat.uniforms.uPulseA.value = pulseP > 0 ? Math.sin(Math.PI * pulseP) ** 0.8 * 0.9 : 0;
    // the pulse is a sphere's front seen from the camera (a ring facing it); the shock ring lies in the galaxy plane
    if (m > 0) fx.rotation.set(-Math.PI / 2, 0, 0);
    else fx.quaternion.copy(camera.quaternion);

    // the fixer: a small amber star that arrives from the bubble wall, settles beside the close-up star (in its disc plane) and
    // FEEDS it: a stream of gas from the fixer into the star, until the star holds a steady burn. The fixer then stays nearby, dimmer.
    let feedOn = 0;
    fixers.forEach((fx2, kf) => {
      const ni = 1 + n + kf;
      const isClose = closeIdx >= 0 && fx2.w === starSlot[closeIdx];
      let a = 0;
      if (isClose) {
        const kS = shipK(u);
        const e = 1 - (1 - kS) ** 2.2;
        // a world-fixed frame from the close-up camera: so the fixer's route does not wobble with the camera's fly-in
        const cvw = closeView(starPos[closeIdx], camera.aspect, cronR);
        const fz: V3 = [cvw.target[0] - cvw.cam[0], cvw.target[1] - cvw.cam[1], cvw.target[2] - cvw.cam[2]];
        const fl = Math.hypot(fz[0], fz[1], fz[2]) || 1;
        const rl = Math.hypot(fz[2], fz[0]) || 1;
        const rW: V3 = [-fz[2] / rl, 0, fz[0] / rl]; // world right of the close-up camera
        const uW: V3 = [(rW[1] * fz[2] - rW[2] * fz[1]) / fl, (rW[2] * fz[0] - rW[0] * fz[2]) / fl, (rW[0] * fz[1] - rW[1] * fz[0]) / fl];
        const ax = starAxis[closeIdx];
        const ax_r = ax[0] * rW[0] + ax[1] * rW[1] + ax[2] * rW[2];
        const ax_u = ax[0] * uW[0] + ax[1] * uW[1] + ax[2] * uW[2];
        // beside the star, across its jets (in the disc plane as seen), on the right of the frame
        let ox = -ax_u;
        let oy = ax_r;
        const ol = Math.hypot(ox, oy) || 1;
        if (ox < 0) { ox = -ox; oy = -oy; }
        const cAn = cA;
        const dockD = 7 * cronR * (1 + 0.4 * cAn);
        const D: V3 = [0, 1, 2].map((c) => starPos[closeIdx][c] + (rW[c] * ox / ol + uW[c] * oy / ol) * dockD * (1 - mk[closeIdx])) as V3;
        const S: V3 = [0, 1, 2].map((c) => D[c] + rW[c] * 3.0 + uW[c] * 0.9 - (fz[c] / fl) * 0.8) as V3;
        const C: V3 = [0, 1, 2].map((c) => (S[c] + D[c]) / 2 + uW[c] * 0.9) as V3;
        const bez = (ee: number, o: V3): void => {
          const mm = 1 - ee;
          for (let c = 0; c < 3; c++) o[c] = mm * mm * S[c] + 2 * mm * ee * C[c] + ee * ee * D[c];
        };
        const headP: V3 = [0, 0, 0];
        bez(e, headP);
        a = ss(0, 0.05, kS) * (u >= L.ship[0] ? 1 : 0) * (1 - 0.45 * ss(0.9, 0.955, u)) * (1 - ss(0.6, 1, mk[closeIdx]));
        uP[FIX0 + kf].set(headP[0], headP[1], headP[2], FIX_R * (1 + 0.5 * cph.feed));
        uS[FIX0 + kf].set(a * (1 + 0.5 * cph.feed), 0, 0, 0);
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
        // the feeding stream: an arc from the fixer to just inside the star's disc, with clumps flowing toward the star
        feedOn = cph.feed * (u >= L.ship[0] ? 1 : 0) * (1 - ss(0.6, 1, mk[closeIdx]));
        if (feedOn > 0.002) {
          const T: V3 = [0, 1, 2].map((c) => starPos[closeIdx][c] + (D[c] - starPos[closeIdx][c]) * (1.5 * cronR * (1 + 0.4 * cAn) / (dockD * (1 - mk[closeIdx]) + 1e-6))) as V3;
          const dl = Math.hypot(D[0] - T[0], D[1] - T[1], D[2] - T[2]);
          const FC: V3 = [0, 1, 2].map((c) => (D[c] + T[c]) / 2 + uW[c] * dl * 0.38 + (fz[c] / fl) * -dl * 0.1) as V3;
          const fAt = (tt: number, o: V3): void => {
            const mm = 1 - tt;
            for (let c = 0; c < 3; c++) o[c] = mm * mm * D[c] + 2 * mm * tt * FC[c] + tt * tt * T[c];
          };
          const f0: V3 = [0, 0, 0];
          const f1: V3 = [0, 0, 0];
          for (let sg = 0; sg <= FEEDSEG; sg++) {
            fAt(sg / FEEDSEG, f0);
            fAt(Math.min(1, (sg + 1) / FEEDSEG), f1);
            if (sg === FEEDSEG) for (let c = 0; c < 3; c++) f1[c] = f0[c] + (f0[c] - feedPrev[c]);
            for (let sd = 0; sd < 2; sd++) {
              const v2 = (sg) * 2 + sd;
              feed.pos.set(f0, v2 * 3);
              feed.next.set(f1, v2 * 3);
            }
            feedPrev[0] = f0[0]; feedPrev[1] = f0[1]; feedPrev[2] = f0[2];
          }
          feed.geo.attributes.position.needsUpdate = true;
          feed.geo.attributes.aNext.needsUpdate = true;
        }
        feed.al[0] = feedOn * 0.85;
        feed.prog[0] = cC * 9 + t * 0.35; // flow phase: scrolls with the page, plus a slow idle drift (0 under reduced motion)
        nodeWorld[ni] = headP;
        nodeOnArr[ni] = ss(0.01, 0.06, kS) * (u >= L.ship[0] ? 1 : 0) * (1 - ss(0.6, 1, mk[closeIdx]));
      } else {
        uS[FIX0 + kf].set(0, 0, 0, 0);
        tail.al[kf] = 0;
        nodeWorld[ni] = cronPos;
        nodeOnArr[ni] = 0;
      }
      nodeRad[ni] = FIX_R;
    });
    feed.mesh.visible = feedOn > 0.002;
    tail.mesh.visible = nFix > 0 && u >= L.ship[0];

    if (composer) renderer.toneMappingExposure = st.exposure * (1 + 0.3 * burstFlash(m));
    // planets and rings stay crisp: the bloom steps back while the system is on screen
    const sysAmt = sunA * (1 - pullOut);
    if (bloom) bloom.strength = 0.45 * st.bloom * (1 - 0.35 * ss(0.5, 0.62, pp) * (1 - lg)) * (opts.tier === 'medium' ? 0.9 : 1) * (1 - 0.55 * sysAmt) * (1 - 0.6 * cA) * (1 + 0.12 * flare) * (1 + 1.0 * burstFlash(m));

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
      if (closeIdx >= 0 && i === starSlot[closeIdx] + 1) cronScreen = [fo.x, fo.y];
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
    // keep the nebula dim behind the copy: the left column on wide screens, the top band on portrait
    if (camera.aspect >= 1.2) volMask.value.set(-0.6, 0, 0.5, 0.95);
    else volMask.value.set(0, 0.55, 1.5, 0.5);
    const dbs = renderer.getDrawingBufferSize(new Vector2());
    nebVol.resize(dbs.x, dbs.y);
    // the close-up headline column: wider than the nebula mask so planets and ribbons near the copy step back too
    if (camera.aspect >= 1.2) copyMask.value.set(-0.55, 0.1, 0.8, 1.05);
    else copyMask.value.set(0, 0.6, 1.6, 0.6);
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
      nebVol.dispose();
      for (const p of passes) p.dispose?.();
      composer?.dispose();
      for (const d of disposables) d.dispose();
      scene.clear();
      renderer.dispose();
    },
  };
}
