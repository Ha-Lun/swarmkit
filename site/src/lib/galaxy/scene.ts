// The galaxy flight scene: one camera, driven by scroll progress through sceneState(p). Vanilla three.js.
// High/medium render through bloom on a black clear (same black-level fix as the swarm scene: the final pass adds
// #05060a after tone mapping); low renders direct. All copy and labels are DOM; this file only reports where the
// constellation nodes land on screen.
import {
  ACESFilmicToneMapping, AdditiveBlending, BufferAttribute, BufferGeometry, Color, GLSL3, Group, Mesh,
  NoBlending, NormalBlending, NoToneMapping, PerspectiveCamera, PlaneGeometry, Points, Scene, ShaderMaterial,
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
import { layoutNodes, linkProgress, nodeOn, spokeProgress } from './constellation.ts';
import type { Lane } from './constellation.ts';
import { buildDust, buildGalaxy, buildHaze, buildSky, buildStreaks } from './generator.ts';
import type { PointCloud } from './generator.ts';
import {
  bubbleAmt, cometAt, clamp01, destTheta, fixerAt, fixWindow, growAmt, L, lateCam, lateU, launchK, legacyP, lerp, sceneState,
  ss, starAt, starDest, sweepAngle, sweepRange, sweepTime,
} from './path.ts';
import type { SceneState, V3 } from './path.ts';
import {
  accFrag, accVert, cometVert, nodeFrag, nodeVert, orbFrag, orbVert, ribbonFrag, ribbonVert, ringFrag, ringVert, scanFrag, scanVert,
  spriteFrag, spriteVert, streakFrag, streakVert, tailFrag, tailVert, trailFrag,
} from './shaders.ts';

const CLEAR = '#05060a';
const TIER = {
  high: { stars: 110000, haze: 44, dust: 280, sky: [5200, 2600, 1100], streaks: 3200, acc: 150, pr: 1.75, bloom: true },
  medium: { stars: 55000, haze: 36, dust: 200, sky: [2600, 1300, 600], streaks: 2000, acc: 100, pr: 1.25, bloom: true },
  low: { stars: 15000, haze: 22, dust: 120, sky: [900, 500, 250], streaks: 1000, acc: 60, pr: 1, bloom: false },
} as const;

export interface NodeInfo {
  slug: string;
  lane: Lane;
  launchIndex: number;
  buildIndex: number;
  failed: boolean;
  fixer: { slug: string; lane: Lane } | null;
  reviewed: boolean;
}
export interface GalaxyFrame {
  /** legacy progress for beats 0-2 (0..1 over the first SPLIT of the page) */
  p: number;
  /** late progress for beats 3-5 */
  u: number;
  state: SceneState;
  /**
   * CSS px relative to the canvas: x, y, in-front flag, node brightness 0..1, bubble radius in px, status 0..1
   * (ok green, bad red, rev = reviewed tick). Index 0 is the Opus core, 1..n the workers (launch order), then fixers.
   */
  nodes: { x: number; y: number; front: boolean; on: number; rad: number; ok: number; bad: number; rev: number }[];
  pulseOn: number;
}
export interface GalaxyOptions {
  tier: Tier;
  workers: NodeInfo[];
  reducedMotion: boolean;
  onFrame?: (f: GalaxyFrame) => void;
}
export interface GalaxyScene {
  setProgress(p: number): void;
  /** raw scroll velocity in px/s (ScrollTrigger getVelocity); smoothed inside */
  setScrollVelocity(v: number): void;
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
        uBig: { value: o.big ?? 0 }, uMode: { value: mode },
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

  // ---- streaks ----------------------------------------------------------------------------------------------
  const sk = buildStreaks(tcfg.streaks);
  const skGeo = track(new BufferGeometry());
  skGeo.setAttribute('position', new BufferAttribute(sk.position, 3));
  skGeo.setAttribute('aCorner', new BufferAttribute(sk.corner, 2));
  skGeo.setAttribute('aData', new BufferAttribute(sk.data, 3));
  skGeo.setIndex(new BufferAttribute(sk.index, 1));
  const streakMat = track(new ShaderMaterial({
    uniforms: {
      uRes: { value: new Vector2(1, 1) }, uFwd: { value: new Vector3(0, 0, -1) }, uRight: { value: new Vector3(1, 0, 0) },
      uUp: { value: new Vector3(0, 1, 0) }, uCam: { value: new Vector3() }, uTravel: { value: 0 }, uDepth: { value: 26 },
      uStretch: { value: 0 }, uVis: { value: 0 }, uWidth: { value: 1.4 }, uPR: shared.uPR,
    },
    vertexShader: streakVert, fragmentShader: streakFrag, glslVersion: GLSL3,
    blending: AdditiveBlending, depthWrite: false, depthTest: false, transparent: true, side: 2,
  }));
  const streaks = new Mesh(skGeo, streakMat);
  streaks.frustumCulled = false;
  streaks.renderOrder = 4;
  scene.add(streaks);

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
  const tail = new Mesh(tGeo, tailMat);
  tail.frustumCulled = false;
  tail.renderOrder = 5;
  scene.add(tail);

  // ---- constellation (static world positions around the core) -----------------------------------------------
  const nWork = opts.workers.length;
  const group = new Group();
  scene.add(group);
  const fixers: { w: number; slug: string; lane: Lane }[] = [];
  opts.workers.forEach((w, i) => { if (w.failed && w.fixer) fixers.push({ w: i, slug: w.fixer.slug, lane: w.fixer.lane }); });
  const nFix = fixers.length;
  const nodeCount = nWork + 1 + nFix;
  const nodeGeo = track(new BufferGeometry());
  const nodePos = new Float32Array(nodeCount * 3);
  const nodeCol = new Float32Array(nodeCount * 3);
  const nodeData = new Float32Array(nodeCount * 4);
  const opus = PALETTE.opus as Rgb;
  nodeCol.set([opus[0] * 1.2, opus[1] * 1.2, opus[2] * 1.2], 0);
  nodeData.set([0.5, 0, 0, 0], 0);
  opts.workers.forEach((w, i) => {
    const c = NODE_COL[w.lane];
    nodeCol.set([c[0], c[1], c[2]], (i + 1) * 3);
    nodeData.set([0.34, i + 1, i * 1.7, 0], (i + 1) * 4);
  });
  fixers.forEach((f, k) => {
    const c = NODE_COL[f.lane];
    nodeCol.set([c[0], c[1], c[2]], (nWork + 1 + k) * 3);
    nodeData.set([0.3, nWork + 1 + k, 4.1 + k, 0], (nWork + 1 + k) * 4);
  });
  nodeGeo.setAttribute('position', new BufferAttribute(nodePos, 3));
  nodeGeo.setAttribute('aColor', new BufferAttribute(nodeCol, 3));
  nodeGeo.setAttribute('aData', new BufferAttribute(nodeData, 4));
  const pulseU = { uPulseR: { value: 0 }, uPulseOn: { value: 0 } };
  const nodeMat = track(new ShaderMaterial({
    uniforms: { uOn: { value: new Array(nodeCount).fill(0) }, uComp: { value: 0 }, uRef: { value: 4.4 }, uScale: shared.uScale, uTime: shared.uTime, uMax: shared.uMax, ...pulseU },
    vertexShader: nodeVert.replace('uOn[9]', `uOn[${nodeCount}]`), fragmentShader: nodeFrag, glslVersion: GLSL3,
    blending: AdditiveBlending, depthWrite: false, depthTest: false, transparent: true,
  }));
  const nodes = new Points(nodeGeo, nodeMat);
  nodes.frustumCulled = false;
  nodes.renderOrder = 7;
  group.add(nodes);

  // ribbons: spokes (Opus -> node i), then lane links (node -> next node of the same lane)
  const SEG = 30;
  const links: [number, number][] = [];
  for (let i = 0; i < nWork; i++) {
    for (let j = i + 1; j < nWork; j++) if (opts.workers[j].lane === opts.workers[i].lane) { links.push([i, j]); break; }
  }
  const nLines = nWork + links.length;
  const vCount = nLines * (SEG + 1) * 2;
  const rPos = new Float32Array(vCount * 3);
  const rNext = new Float32Array(vCount * 3);
  const rCol = new Float32Array(vCount * 3);
  const rData = new Float32Array(vCount * 4);
  const rIdx = new Uint32Array(nLines * SEG * 6);
  const rGeo = track(new BufferGeometry());
  rGeo.setAttribute('position', new BufferAttribute(rPos, 3));
  rGeo.setAttribute('aNext', new BufferAttribute(rNext, 3));
  rGeo.setAttribute('aColor', new BufferAttribute(rCol, 3));
  rGeo.setAttribute('aData', new BufferAttribute(rData, 4));
  rGeo.setIndex(new BufferAttribute(rIdx, 1));
  const rMat = track(new ShaderMaterial({
    uniforms: {
      uRes: streakMat.uniforms.uRes, uWidth: { value: 2.2 }, uPR: shared.uPR, uTime: shared.uTime,
      uProg: { value: new Array(nLines).fill(0) }, ...pulseU,
    },
    vertexShader: ribbonVert.replace('uProg[24]', `uProg[${Math.max(1, nLines)}]`), fragmentShader: ribbonFrag, glslVersion: GLSL3,
    blending: AdditiveBlending, depthWrite: false, depthTest: false, transparent: true, side: 2,
  }));
  const ribbons = new Mesh(rGeo, rMat);
  ribbons.frustumCulled = false;
  ribbons.renderOrder = 6;
  group.add(ribbons);

  const ringGeo = track(new PlaneGeometry(16, 16));
  const ringMat = track(new ShaderMaterial({
    uniforms: { uR: { value: 0 }, uAlpha: { value: 0 } },
    vertexShader: ringVert, fragmentShader: ringFrag, glslVersion: GLSL3,
    blending: AdditiveBlending, depthWrite: false, depthTest: false, transparent: true,
  }));
  const ring = new Mesh(ringGeo, ringMat);
  ring.frustumCulled = false;
  ring.renderOrder = 8;
  ring.visible = false;
  group.add(ring);

  // ---- late beats: worktree bubbles + planets (one sprite each), accretion dust, launch trails, scan sweep -------------
  const ORB_R = 1.1; // sprite radius in world units; the bubble is half of it
  const uA = Array.from({ length: Math.max(1, nWork) }, () => new Vector4());
  const uB = Array.from({ length: Math.max(1, nWork) }, () => new Vector4());
  const uC = Array.from({ length: Math.max(1, nWork) }, () => new Vector3());
  const orbGeo = track(new BufferGeometry());
  const orbPos = new Float32Array(nWork * 3);
  const orbCol = new Float32Array(nWork * 3);
  const orbData = new Float32Array(nWork * 4);
  opts.workers.forEach((w, i) => { orbCol.set(NODE_COL[w.lane], i * 3); orbData.set([i, ORB_R, 0, 0], i * 4); });
  orbGeo.setAttribute('position', new BufferAttribute(orbPos, 3));
  orbGeo.setAttribute('aColor', new BufferAttribute(orbCol, 3));
  orbGeo.setAttribute('aData', new BufferAttribute(orbData, 4));
  const orbMat = track(new ShaderMaterial({
    uniforms: { uScale: shared.uScale, uMax: shared.uMax, uComp: nodeMat.uniforms.uComp, uRef: { value: 11 }, uTime: shared.uTime, uA: { value: uA }, uB: { value: uB } },
    vertexShader: orbVert.replace('uA[8]', `uA[${Math.max(1, nWork)}]`).replace('uB[8]', `uB[${Math.max(1, nWork)}]`), fragmentShader: orbFrag, glslVersion: GLSL3,
    blending: AdditiveBlending, depthWrite: false, depthTest: false, transparent: true,
  }));
  const orbs = new Points(orbGeo, orbMat);
  orbs.frustumCulled = false;
  orbs.renderOrder = 6;
  orbs.visible = false;
  group.add(orbs);

  const per = tcfg.acc;
  const accN = nWork * per;
  const accGeo = track(new BufferGeometry());
  const accPos = new Float32Array(accN * 3);
  const accCol = new Float32Array(accN * 3);
  const accData = new Float32Array(accN * 4);
  {
    let seed = 7;
    const rnd = (): number => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    for (let i = 0; i < accN; i++) {
      const w = Math.floor(i / per);
      const z = rnd() * 2 - 1;
      const a = rnd() * Math.PI * 2;
      const rr = Math.sqrt(1 - z * z);
      accPos.set([rr * Math.cos(a), z, rr * Math.sin(a)], i * 3);
      accCol.set(NODE_COL[opts.workers[w].lane], i * 3);
      accData.set([w, rnd(), rnd(), rnd()], i * 4);
    }
  }
  accGeo.setAttribute('position', new BufferAttribute(accPos, 3));
  accGeo.setAttribute('aColor', new BufferAttribute(accCol, 3));
  accGeo.setAttribute('aData', new BufferAttribute(accData, 4));
  const accMat = track(new ShaderMaterial({
    uniforms: { uTime: shared.uTime, uPR: shared.uPR, uC: { value: uC }, uA: { value: uA } },
    vertexShader: accVert.replace('uC[8]', `uC[${Math.max(1, nWork)}]`).replace('uA[8]', `uA[${Math.max(1, nWork)}]`), fragmentShader: accFrag, glslVersion: GLSL3,
    blending: AdditiveBlending, depthWrite: false, depthTest: false, transparent: true,
  }));
  const acc = new Points(accGeo, accMat);
  acc.frustumCulled = false;
  acc.renderOrder = 6;
  acc.visible = false;
  group.add(acc);

  // trails: one ribbon per worker launch and per fixer flight, rewritten from the star paths each frame
  const TSEGS = 22;
  const nTrails = nWork + nFix;
  const tV = nTrails * (TSEGS + 1) * 2;
  const trPos = new Float32Array(tV * 3);
  const trNext = new Float32Array(tV * 3);
  const trCol = new Float32Array(tV * 3);
  const trData = new Float32Array(tV * 4);
  const trIdx = new Uint32Array(nTrails * TSEGS * 6);
  for (let li = 0; li < nTrails; li++) {
    const col = NODE_COL[li < nWork ? opts.workers[li].lane : fixers[li - nWork].lane];
    for (let sg = 0; sg <= TSEGS; sg++) for (let sd = 0; sd < 2; sd++) {
      const v = (li * (TSEGS + 1) + sg) * 2 + sd;
      trCol.set(col, v * 3);
      trData.set([sg / TSEGS, sd ? 1 : -1, li, 1], v * 4);
    }
    for (let sg = 0; sg < TSEGS; sg++) {
      const a = (li * (TSEGS + 1) + sg) * 2;
      trIdx.set([a, a + 1, a + 2, a + 1, a + 3, a + 2], (li * TSEGS + sg) * 6);
    }
  }
  const trGeo = track(new BufferGeometry());
  trGeo.setAttribute('position', new BufferAttribute(trPos, 3));
  trGeo.setAttribute('aNext', new BufferAttribute(trNext, 3));
  trGeo.setAttribute('aColor', new BufferAttribute(trCol, 3));
  trGeo.setAttribute('aData', new BufferAttribute(trData, 4));
  trGeo.setIndex(new BufferAttribute(trIdx, 1));
  const trProg = new Array(Math.max(1, nTrails)).fill(0) as number[];
  const trailMat = track(new ShaderMaterial({
    uniforms: { uRes: streakMat.uniforms.uRes, uWidth: { value: 3 }, uPR: shared.uPR, uProg: { value: trProg } },
    vertexShader: ribbonVert.replace('uProg[24]', `uProg[${Math.max(1, nTrails)}]`), fragmentShader: trailFrag, glslVersion: GLSL3,
    blending: AdditiveBlending, depthWrite: false, depthTest: false, transparent: true, side: 2,
  }));
  const trails = new Mesh(trGeo, trailMat);
  trails.frustumCulled = false;
  trails.renderOrder = 6;
  trails.visible = false;
  group.add(trails);

  const SCAN_R = 8;
  const scanMat = track(new ShaderMaterial({
    uniforms: { uAng: { value: 0 }, uVis: { value: 0 }, uR: { value: SCAN_R } },
    vertexShader: scanVert, fragmentShader: scanFrag, glslVersion: GLSL3,
    blending: AdditiveBlending, depthWrite: false, depthTest: false, transparent: true,
  }));
  const scan = new Mesh(track(new PlaneGeometry(SCAN_R * 2, SCAN_R * 2)), scanMat);
  scan.rotation.x = -Math.PI / 2;
  scan.frustumCulled = false;
  scan.renderOrder = 5;
  scan.visible = false;
  group.add(scan);

  let layout = layoutNodes(opts.workers, 1.6);
  const dest: V3[] = opts.workers.map(() => [0, 0, 0]);
  const destAng: number[] = [];
  let sweepA0 = 0;
  let sweepA1 = 1;
  function bakeConstellation(): void {
    layout = layoutNodes(opts.workers, camera.aspect);
    opts.workers.forEach((w, i) => { dest[i] = starDest(w.launchIndex, nWork, camera.aspect); {
      const th = destTheta(w.launchIndex, nWork);
      let a = Math.atan2(dest[i][2], dest[i][0]);
      while (a < th - Math.PI) a += Math.PI * 2;
      while (a > th + Math.PI) a -= Math.PI * 2;
      destAng[i] = a;
    } });
    [sweepA0, sweepA1] = sweepRange(destAng);
    fixers.forEach((fx, k) => { const d = dest[fx.w]; fixDest[k] = camera.aspect >= 1.2 ? [d[0] - 0.2, d[1] + 1.5, d[2] - 0.5] : [d[0] + 1.5, d[1] + 0.3, d[2] + 0.4]; });
    nodePos.set([0, 0, 0], 0);
    layout.forEach((n, i) => nodePos.set(n.pos, (i + 1) * 3));
    nodeGeo.attributes.position.needsUpdate = true;
    const ends: { a: [number, number, number]; b: [number, number, number]; col: Rgb; w: number; bow: number }[] = [];
    layout.forEach((n) => ends.push({ a: [0, 0, 0], b: n.pos, col: NODE_COL[n.lane], w: 1, bow: 0.12 }));
    links.forEach(([i, j]) => ends.push({ a: layout[i].pos, b: layout[j].pos, col: NODE_COL[layout[i].lane], w: 0.5, bow: 0.18 }));
    let vi = 0;
    let ii = 0;
    ends.forEach((e, li) => {
      const dx = e.b[0] - e.a[0];
      const dy = e.b[1] - e.a[1];
      const dz = e.b[2] - e.a[2];
      const len = Math.hypot(dx, dy, dz) || 1;
      // bow perpendicular to the line in the xy plane
      const nx = -dy / len;
      const ny = dx / len;
      const at = (t: number): [number, number, number] => {
        const s = Math.sin(Math.PI * t) * e.bow * len * (li % 2 ? 1 : -1);
        return [e.a[0] + dx * t + nx * s, e.a[1] + dy * t + ny * s, e.a[2] + dz * t];
      };
      const base = vi;
      for (let s = 0; s <= SEG; s++) {
        const t = s / SEG;
        const p = at(t);
        const q = at(Math.min(1, t + 1 / SEG));
        const q2 = s === SEG ? at(1 - 1 / SEG) : q;
        for (let side = -1; side <= 1; side += 2) {
          rPos.set(p, vi * 3);
          rNext.set(s === SEG ? [p[0] + (p[0] - q2[0]), p[1] + (p[1] - q2[1]), p[2] + (p[2] - q2[2])] : q, vi * 3);
          rCol.set(e.col, vi * 3);
          rData.set([t, side, li, e.w], vi * 4);
          vi++;
        }
      }
      for (let s = 0; s < SEG; s++) {
        const a = base + s * 2;
        rIdx.set([a, a + 1, a + 2, a + 1, a + 3, a + 2], ii);
        ii += 6;
      }
    });
    rGeo.attributes.position.needsUpdate = true;
    rGeo.attributes.aNext.needsUpdate = true;
    rGeo.attributes.aColor.needsUpdate = true;
    rGeo.attributes.aData.needsUpdate = true;
    rGeo.index!.needsUpdate = true;
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
      bloom = new UnrealBloomPass(new Vector2(256, 256), 0.55, 0.45, 0.6);
      const output = new OutputPass();
      const dither = new ShaderPass({
        uniforms: { tDiffuse: { value: null } },
        vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
        fragmentShader: 'uniform sampler2D tDiffuse; varying vec2 vUv; void main() { vec4 c = texture2D(tDiffuse, vUv); float n = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453); vec3 bg = vec3(5.0, 6.0, 10.0) / 255.0; vec3 rgb = c.rgb + bg * (1.0 - clamp(max(c.r, max(c.g, c.b)) * 4.0, 0.0, 1.0)); vec3 hi = max(rgb - 0.62, 0.0); rgb = min(rgb, vec3(0.62)) + 0.22 * (1.0 - exp(-hi / 0.22)); gl_FragColor = vec4(rgb + (n - 0.5) * 1.5 / 255.0, 1.0); }',
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
  void NoBlending;

  // ---- loop -------------------------------------------------------------------------------------------------
  let target = 0;
  let progress = 0;
  let vel = 0;
  let scrollVel = 0;
  let scrollVelAt = 0;
  let raf = 0;
  let disposed = false;
  let active = true;
  let lastMs = performance.now();
  const t0 = lastMs;
  const ptr = { x: 0, y: 0, sx: 0, sy: 0 };
  const tmpV = new Vector3();
  const fwd = new Vector3();
  const frameOut: GalaxyFrame = { p: 0, u: 0, state: sceneState(0), nodes: [], pulseOn: 0 };
  for (let i = 0; i < nodeCount; i++) frameOut.nodes.push({ x: 0, y: 0, front: false, on: 0, rad: 0, ok: 0, bad: 0, rev: 0 });
  const right = new Vector3();
  const upV = new Vector3();
  const back = new Vector3();
  const sp: V3 = [0, 0, 0];
  const sq: V3 = [0, 0, 0];
  let lastLate = false;
  let refOrb = 11;
  let refStar = 4.4;
  const retestRank: number[] = [];
  { let r = 0; opts.workers.forEach((w, i) => { retestRank[i] = w.failed && !w.fixer ? r++ : 0; }); }
  const ptsTmp = new Float32Array((TSEGS + 1) * 3);
  const fixDest: V3[] = fixers.map(() => [0, 0, 0]);
  let cssW = 1;
  let cssH = 1;

  function writeTrail(li: number): void {
    for (let sg = 0; sg <= TSEGS; sg++) {
      const o = sg < TSEGS ? (sg + 1) * 3 : sg * 3;
      for (let sd = 0; sd < 2; sd++) {
        const v = (li * (TSEGS + 1) + sg) * 2 + sd;
        for (let c = 0; c < 3; c++) {
          const here = ptsTmp[sg * 3 + c];
          trPos[v * 3 + c] = here;
          trNext[v * 3 + c] = sg < TSEGS ? ptsTmp[o + c] : here + (here - ptsTmp[(sg - 1) * 3 + c]);
        }
      }
    }
  }

  function renderFrame(nowMs: number): void {
    const dtRaw = Math.max(0, (nowMs - lastMs) / 1000);
    lastMs = nowMs;
    const dt = Math.min(0.1, dtRaw);
    const prev = progress;
    progress = reduced ? target : progress + (target - progress) * (1 - Math.exp(-Math.min(dtRaw, 1) * 6));
    const inst = dtRaw > 0 ? Math.abs(progress - prev) / Math.max(dtRaw, 1e-3) : 0;
    // scroll velocity: ScrollTrigger's px/s (zero if stale) combined with the eased-progress rate, then smoothed
    const sv = nowMs - scrollVelAt < Math.max(140, dtRaw * 2500) ? Math.min(1, Math.abs(scrollVel) / (cssH * 3.2)) : 0;
    vel += (Math.max(sv, Math.min(1, inst * 14)) - vel) * (1 - Math.exp(-dt * 6));
    const u = lateU(progress);
    const pp = legacyP(progress);
    const st = sceneState(pp);
    const t = reduced ? 0 : (nowMs - t0) / 1000;
    shared.uTime.value = t;
    shared.uSpin.value = st.spin;
    const band = ss(0.27, 0.36, pp) * (1 - ss(0.53, 0.6, pp)); // the dive's bright stretch: thin the bulge so the tunnel reads
    const lg = ss(0, 0.22, u); // the galaxy comes back up behind the late beats
    shared.uGain.value = 1.4 * st.galaxyGain * (1 + 1.5 * lg);
    shared.uCoreDim.value = st.coreGain + (0.8 - st.coreGain) * lg;
    hazeMat.uniforms.uGain.value = 0.8 * st.galaxyGain * (1 - 0.8 * ss(0.5, 0.62, pp)) * (1 + 2.4 * lg) * (1 - 0.8 * band);
    dustMat.uniforms.uGain.value = (1 + 0.4 * ss(0.5, 0.6, pp)) * (1 - 0.85 * ss(0.3, 0.38, pp) * (1 - ss(0.56, 0.64, pp)));

    // camera: aspect pull-back so portrait phones still see the whole galaxy, then pointer parallax
    const aspect = camera.aspect;
    const fAsp = aspect < 1.1 ? 1 + (1.1 / aspect - 1) * 0.55 : 1;
    const f = (fAsp + (1 + (fAsp - 1) * 0.6 - fAsp) * ss(0.2, 0.5, pp)) * (1 + 0.2 * (1 - ss(0.04, 0.2, pp)));
    ptr.sx += (ptr.x - ptr.sx) * Math.min(1, dt * 3);
    ptr.sy += (ptr.y - ptr.sy) * Math.min(1, dt * 3);
    const par = reduced ? 0 : 1 - st.diveEnv;
    // desktop: the constellation sits right of centre so the copy column keeps the left
    const shiftX = aspect > 1.2 ? -0.5 * ss(0.52, 0.62, pp) : 0;
    // portrait: the constellation drops below the copy block at the top
    const shiftY = aspect <= 1.2 ? 0.62 * ss(0.52, 0.62, pp) : 0;
    const tg: [number, number, number] = [st.target[0] + shiftX, st.target[1] + shiftY, st.target[2]];
    let cx = tg[0] + (st.cam[0] + shiftX - tg[0]) * f;
    let cy = tg[1] + (st.cam[1] + shiftY - tg[1]) * f;
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
    let fov = st.fov;
    if (u > 0) {
      const lc = lateCam(u, aspect);
      const w = ss(0, 0.22, u);
      cx = lerp(cx, lc.cam[0], w);
      cy = lerp(cy, lc.cam[1], w);
      cz = lerp(cz, lc.cam[2], w);
      tg[0] = lerp(tg[0], lc.target[0], w);
      tg[1] = lerp(tg[1], lc.target[1], w);
      tg[2] = lerp(tg[2], lc.target[2], w);
      fov = lerp(fov, lc.fov, w);
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
    starMat.uniforms.uSize.value = (opts.tier === 'low' ? 0.07 : 0.05) * (1 + 0.3 * hw) * (1 - 0.6 * band);

    // dive tunnel: stars stream past with the scroll (uTravel), stretched by a base amount plus the scroll velocity
    streakMat.uniforms.uFwd.value.copy(fwd);
    streakMat.uniforms.uRight.value.copy(right);
    streakMat.uniforms.uUp.value.copy(upV);
    streakMat.uniforms.uCam.value.copy(camera.position);
    streakMat.uniforms.uTravel.value = pp * 12;
    streakMat.uniforms.uVis.value = st.diveEnv * (reduced ? 0 : 1);
    streakMat.uniforms.uStretch.value = st.diveEnv * (2.0 + 7 * vel);

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
    tail.visible = comet.visible;

    // core flash as the comet lands: a brief gain bump on the bulge
    shared.uGain.value *= 1 + 0.9 * st.flash;

    // constellation
    const on = nodeMat.uniforms.uOn.value as number[];
    on[0] = ss(0.5, 0.6, pp);
    for (let i = 0; i < nWork; i++) on[i + 1] = nodeOn(st.draw, i, nWork) * (st.draw > 0 ? 1 : 0);
    const prog = rMat.uniforms.uProg.value as number[];
    for (let i = 0; i < nWork; i++) prog[i] = spokeProgress(st.draw, i, nWork);
    for (let i = 0; i < links.length; i++) prog[nWork + i] = linkProgress(st.draw);
    const pulseR = st.pulse * 5.2;
    pulseU.uPulseR.value = pulseR;
    pulseU.uPulseOn.value = st.pulse > 0 && st.pulse < 1 ? 1 : 0;
    ring.visible = st.pulse > 0 && st.pulse < 1;
    ringMat.uniforms.uR.value = pulseR;
    ringMat.uniforms.uAlpha.value = Math.sin(Math.PI * Math.min(1, st.pulse)) ** 0.7;
    ring.lookAt(camera.position);
    ring.scale.setScalar(1);

    // ---- late beats 3-5 ----
    const lateOnNow = u > 0;
    nodeMat.uniforms.uComp.value = lg;
    const narrow = clamp01((1.2 - aspect) / 0.74);
    refOrb = 11 * (1 + narrow);
    refStar = 4.4 * (1 + 0.8 * narrow);
    orbMat.uniforms.uRef.value = refOrb;
    nodeMat.uniforms.uRef.value = refStar;
    for (let i = 0; i < nWork; i++) {
      const w = opts.workers[i];
      const slot = layout[i].pos as V3;
      const k = lateOnNow ? launchK(u, w.launchIndex, nWork) : 0;
      const grow = growAmt(u, w.buildIndex, nWork);
      starAt(sp, slot, dest[i], w.launchIndex, k);
      nodePos[(i + 1) * 3] = sp[0];
      nodePos[(i + 1) * 3 + 1] = sp[1];
      nodePos[(i + 1) * 3 + 2] = sp[2];
      orbPos[i * 3] = sp[0];
      orbPos[i * 3 + 1] = sp[1];
      orbPos[i * 3 + 2] = sp[2];
      uC[i].set(sp[0], sp[1], sp[2]);
      if (lateOnNow) on[i + 1] = (1 + 0.7 * Math.sin(Math.PI * k) ** 2) * (1 - 0.5 * grow);
      prog[i] *= 1 - k;
      // verify
      const vt = sweepTime(destAng[i], sweepA0, sweepA1);
      const kk = w.failed ? fixers.findIndex((fx) => fx.w === i) : -1;
      let okA = 0;
      let badA = 0;
      let ph = 0;
      let kind = 0;
      let revT = vt + 0.035;
      if (kk < 0 && !w.failed) {
        ph = clamp01((u - vt) / 0.05);
        okA = ss(vt, vt + 0.03, u);
      } else {
        // failed: red at its sweep slot. With a fixer it turns green when the fixer lands; without one its re-test
        // (a later passing verify in the data) lands right after the sweep.
        const fb = kk >= 0 ? fixWindow(kk, nFix)[1] : L.sweep[1] + 0.014 + 0.008 * retestRank[i];
        badA = ss(vt, vt + 0.02, u) * (1 - ss(fb, fb + 0.03, u));
        okA = ss(fb, fb + 0.03, u);
        ph = u < fb ? clamp01((u - vt) / 0.05) : clamp01((u - fb) / 0.05);
        kind = u < fb ? 1 : 0;
        revT = fb + 0.035;
      }
      uA[i].set(bubbleAmt(u, w.launchIndex, nWork), grow, okA, badA);
      uB[i].set(ph, kind, 0, 0);
      const fo = frameOut.nodes[i + 1];
      fo.ok = okA;
      fo.bad = badA;
      fo.rev = w.reviewed ? ss(revT, revT + 0.02, u) : 0;
      // launch trail
      const tl = trProg;
      tl[i] = lateOnNow && k > 0.001 ? 1 - ss(0.88, 1, k) : 0;
      if (tl[i] > 0) {
        const t0k = Math.max(0, k - 0.5);
        for (let sg = 0; sg <= TSEGS; sg++) {
          starAt(sq, slot, dest[i], w.launchIndex, lerp(t0k, k, sg / TSEGS));
          ptsTmp.set(sq, sg * 3);
        }
        writeTrail(i);
      }
    }
    for (let kk = 0; kk < nFix; kk++) {
      const fx = fixers[kk];
      const [fa, fb] = fixWindow(kk, nFix);
      const kf = ss(fa, fb, u);
      const d = fixDest[kk];
      fixerAt(sp, d, kf, kk);
      const ni = nWork + 1 + kk;
      nodePos[ni * 3] = sp[0];
      nodePos[ni * 3 + 1] = sp[1];
      nodePos[ni * 3 + 2] = sp[2];
      on[ni] = ss(fa - 0.005, fa + 0.01, u) * (1 + 0.5 * Math.sin(Math.PI * kf) ** 2);
      trProg[nWork + kk] = kf > 0.001 ? 1 - ss(0.86, 1, kf) : 0;
      if (trProg[nWork + kk] > 0) {
        for (let sg = 0; sg <= TSEGS; sg++) {
          fixerAt(sq, d, lerp(Math.max(0, kf - 0.5), kf, sg / TSEGS), kk);
          ptsTmp.set(sq, sg * 3);
        }
        writeTrail(nWork + kk);
      }
      void fx;
    }
    for (let i = 0; i < links.length; i++) prog[nWork + i] *= 1 - ss(0.03, 0.1, u);
    if (lateOnNow || lastLate) {
      nodeGeo.attributes.position.needsUpdate = true;
      orbGeo.attributes.position.needsUpdate = true;
      trGeo.attributes.position.needsUpdate = true;
      trGeo.attributes.aNext.needsUpdate = true;
    }
    lastLate = lateOnNow;
    orbs.visible = u > L.bubble[0] - 0.01;
    acc.visible = orbs.visible;
    trails.visible = u > 0.01;
    const scanVis = ss(L.sweep[0] - 0.025, L.sweep[0], u) * (1 - ss(L.sweep[1], L.sweep[1] + 0.03, u));
    scan.visible = nWork > 0 && scanVis > 0.002;
    scanMat.uniforms.uVis.value = scanVis;
    scanMat.uniforms.uAng.value = sweepAngle(u, sweepA0, sweepA1);

    if (composer) renderer.toneMappingExposure = st.exposure;
    if (bloom) bloom.strength = 0.55 * st.bloom * (opts.tier === 'medium' ? 0.9 : 1);

    // project nodes
    camera.updateMatrixWorld();
    for (let i = 0; i < nodeCount; i++) {
      tmpV.set(nodePos[i * 3], nodePos[i * 3 + 1], nodePos[i * 3 + 2]);
      const depth = Math.max(0.1, (tmpV.x - camera.position.x) * fwd.x + (tmpV.y - camera.position.y) * fwd.y + (tmpV.z - camera.position.z) * fwd.z);
      tmpV.project(camera);
      const fo = frameOut.nodes[i];
      const bubA = i >= 1 && i <= nWork ? uA[i - 1].x : 0;
      fo.rad = (bubA > 0.02 ? 0.5 * ORB_R : 0.1) * shared.uScale.value / lerp(depth, bubA > 0.02 ? refOrb : refStar, lg) / shared.uPR.value;
      fo.x = (tmpV.x * 0.5 + 0.5) * cssW;
      fo.y = (-tmpV.y * 0.5 + 0.5) * cssH;
      fo.front = tmpV.z > -1 && tmpV.z < 1;
      fo.on = on[i];
    }
    frameOut.p = pp;
    frameOut.u = u;
    frameOut.state = st;
    frameOut.pulseOn = pulseU.uPulseOn.value;

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

  function resize(): void {
    if (disposed) return;
    cssW = Math.max(1, canvas.clientWidth || 1);
    cssH = Math.max(1, canvas.clientHeight || 1);
    const pr = Math.min(window.devicePixelRatio || 1, tcfg.pr);
    renderer.setPixelRatio(pr);
    renderer.setSize(cssW, cssH, false);
    composer?.setPixelRatio(pr);
    composer?.setSize(cssW, cssH);
    camera.aspect = cssW / cssH;
    camera.updateProjectionMatrix();
    shared.uPR.value = pr;
    shared.uMax.value = pointMax;
    streakMat.uniforms.uRes.value.set(cssW * pr, cssH * pr);
    tailMat.uniforms.uRes.value.set(cssW * pr, cssH * pr);
    bakeConstellation();
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
    setScrollVelocity(v: number): void {
      scrollVel = v;
      scrollVelAt = performance.now();
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
