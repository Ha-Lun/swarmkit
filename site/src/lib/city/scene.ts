// SwarmKit City scene: mounts the replay on a fixed canvas. Builds layout + timeline from the run, reads the palette
// from CSS custom properties, lights a matte golden-hour diorama, adds the five visual parts, drives one continuous
// camera path, and projects DOM labels onto the lots. It reads scroll progress (written by scroll.ts) and never
// touches scroll or copy itself: text is DOM, the page gets each frame's StageState through onState.
//
// Tiers: high = antialias, DPR <= 2, shadows 2048, EffectComposer with the tilt-shift passes; medium = plain render,
// DPR <= 1.5, shadows 1024; low = no animation loop (a single static frame at the current beat's pose, re-rendered
// when scrolling stops). Reduced motion starts on low. An fps probe on the first frames steps high -> medium -> low.
// The loop only runs while the stage is on screen.
import {
  Color, DirectionalLight, Fog, GridHelper, Group, HalfFloatType, HemisphereLight, InstancedMesh, Matrix4, Mesh, MeshLambertMaterial, NoToneMapping,
  PCFShadowMap, PerspectiveCamera, PlaneGeometry, Quaternion, Scene, SRGBColorSpace, Vector3, WebGLRenderer, WebGLRenderTarget,
} from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import type { BufferGeometry, LineBasicMaterial } from 'three';
import type { FeaturedRun } from '../run.ts';
import { createBlueprint } from './blueprint.ts';
import { createBuildings } from './buildings.ts';
import { beatPoseU, buildCameraKeys, CAMERA_FOV, createCameraPath, smoothDamp } from './camera.ts';
import { createDrones } from './drones.ts';
import { buildLayout, lotPoseAt } from './lots.ts';
import { createMerge } from './merge.ts';
import { createScan } from './scan.ts';
import { createTable, SLAB_DEPTH, SLAB_TOP } from './table.ts';
import { createTiltShift } from './tiltshift.ts';
import { buildTimeline } from './timeline.ts';
import { kitPartGeometries, loadKit } from './kit.ts';
import type { Kit } from './kit.ts';
import type { CityPalette, CityPart, LotLayout, StageState } from './types.ts';

export type CityTier = 'high' | 'medium' | 'low';

export interface MountCityOptions {
  canvas: HTMLCanvasElement;
  run: FeaturedRun;
  /** Written by scroll.ts; the scene only reads it. */
  progress: { u: number };
  /** Holds one pre-created `[data-slug]` element per lot; the scene writes transform and opacity only. */
  labelLayer: HTMLElement;
  /** Every rendered frame's state, for DOM counters and captions. */
  onState?: (state: StageState) => void;
  /** A forced tier (e.g. ?tier=high): the fps probe is skipped. */
  tier?: CityTier;
  reducedMotion?: boolean;
  /** Subscribe to "scrolling stopped" (scroll.ts); static frames re-render then. */
  onScrollEnd?: (cb: () => void) => () => void;
  /** The tier in use, whenever it is decided or changes. */
  onTier?: (tier: CityTier, reason: string) => void;
  /** WebGL failed after mount (context lost): the page should switch to its fallback. */
  onFail?: (reason: string) => void;
  /** Element whose visibility gates the loop (the stage section). Defaults to the canvas. */
  visibilityTarget?: Element;
}

export interface LabelPosition {
  slug: string;
  /** Pixels from the label layer's top-left. */
  x: number;
  y: number;
  visible: boolean;
}

export interface CityHandle {
  readonly tier: CityTier;
  /** Updated every rendered frame, one per lot in layout order. */
  labelPositions: LabelPosition[];
  dispose(): void;
}

const TOKENS: Record<keyof CityPalette, [string, string]> = {
  paper: ['--paper', '#f3ebd9'],
  ink: ['--blueprint-ink', '#0b1b33'],
  line: ['--blueprint-line', '#3d79c6'],
  lightWarm: ['--light-warm', '#ffc77a'],
  laneAgy: ['--lane-agy', '#e69f00'],
  laneOpencode: ['--lane-opencode', '#1aa7a1'],
  ok: ['--status-ok', '#4f9d2f'],
  fail: ['--status-fail', '#d6443b'],
};

function readToken(css: CSSStyleDeclaration, name: string, fallback: string): string {
  const v = css.getPropertyValue(name).trim();
  return v || fallback;
}

/** The City palette from :root custom properties, falling back to the token values when a property is empty. */
export function readPalette(): CityPalette {
  const css = getComputedStyle(document.documentElement);
  const out = {} as CityPalette;
  for (const key of Object.keys(TOKENS) as (keyof CityPalette)[]) out[key] = readToken(css, TOKENS[key][0], TOKENS[key][1]);
  return out;
}

/** Damping time of the scroll follow (s): critically damped, so scrubbing glides without overshoot. */
const DAMP_TIME = 0.15;
/** fps probe: warm-up frames skipped (shader compile), then at least this long and this many frames. */
const PROBE = { warmup: 10, ms: 800, minFrames: 20, stepDownBelow: 45, lowBelow: 30 };
// Lighting is in three's physical units: a Lambert surface returns albedo / pi times its irradiance, so sun * cos +
// sky ~ pi brings lit paper back to about its token value (no tone mapping, sRGB output). The sun is low (long soft
// shadows) and warm but mixed towards white, the sky fill cool but mixed towards white, so the light is warm and the
// paper stays paper: lit ground ~0.9 of the token, ground in shadow ~0.6, lane colours keep their saturation.
const SUN_INTENSITY = 3.1;
const HEMI_INTENSITY = 2.0;
/** How far the sun's colour moves from white towards --light-warm, and the sky's towards --light-cool. */
const SUN_WARMTH = 0.45;
const SKY_COOLNESS = 0.35;
/** The table: a shade under the paper token, so the unlit page background reads as the same paper beyond it. */
const TABLE_SHADE = 0.97;
/** Faint blueprint grid on the table: spacing in lot cells, opacity. */
const GRID_CELLS = 2;
const GRID_OPACITY = 0.1;
/**
 * How much the bill beat dims the scene (the city recedes and dims). Lights, background and fog dim by the same
 * factor, so lit paper and the paper backdrop keep their ratio and no tone step opens at the table's edge.
 */
const BILL_DIM = 0.45;
/** Bill progress past which the lot labels hide. */
const BILL_LABELS_OFF = 0.35;
/** Label anchor above the building top (m). */
const LABEL_LIFT = 0.6;
/**
 * Label de-collision with hysteresis. Each label box is grown by a gap (px) on every side before two boxes count as
 * overlapping; the gap differs by what the label is doing, so a pose on the edge cannot flip it every frame:
 * - a shown label hides only when its boxes overlap with LABEL_GAP_HIDE (negative = they must overlap by 2 px);
 * - a new label appears when it is clear with LABEL_GAP;
 * - a label hidden for overlap returns only after it has been clear with LABEL_GAP_SHOW for LABEL_CLEAR_S seconds.
 * A static frame (dt = 0) has no time to wait: it uses LABEL_GAP only, so the picture depends on the state alone.
 */
const LABEL_GAP = 3;
const LABEL_GAP_HIDE = -1;
const LABEL_GAP_SHOW = 5;
const LABEL_CLEAR_S = 0.3;

/**
 * A few kit trees along the city's outer edge: one InstancedMesh per tree type, static matrices set once. They
 * stand on a rectangle outside `layout.bounds` (which frames everything), so they never land on the plot or a lot.
 * Positions are seeded from the index, so the same layout always grows the same trees.
 */
const TREE_COUNT = 16;
const TREE_MARGIN = 2.4;
const TREE_NAMES = ['tree_round', 'tree_cone'];

function createTrees(layout: LotLayout, kit: Kit): CityPart | null {
  const geos = TREE_NAMES.map((n) => kitPartGeometries(kit, n).base);
  const counts = [0, 0];
  const kinds: number[] = [];
  for (let i = 0; i < TREE_COUNT; i++) {
    const kind = geos[1] ? i % 2 : 0;
    if (!geos[kind]) {
      kinds.push(-1);
      continue;
    }
    kinds.push(kind);
    counts[kind]++;
  }
  if (counts[0] + counts[1] === 0) {
    for (const g of geos) if (g) g.dispose();
    return null;
  }
  const root = new Group();
  root.name = 'trees';
  const owned: BufferGeometry[] = [];
  for (const g of geos) if (g) owned.push(g);
  const meshes: (InstancedMesh | null)[] = geos.map((g, kind) => {
    if (!g) return null;
    const mesh = new InstancedMesh(g, kit.material, counts[kind] > 0 ? counts[kind] : 1);
    mesh.name = `trees-${TREE_NAMES[kind]}`;
    mesh.count = counts[kind];
    mesh.frustumCulled = false;
    root.add(mesh);
    return mesh;
  });

  // Walk the outside rectangle's perimeter; the per-tree offset along it is index-seeded.
  const b = layout.bounds;
  const x0 = b.x - b.w / 2 - TREE_MARGIN;
  const x1 = b.x + b.w / 2 + TREE_MARGIN;
  const z0 = b.z - b.d / 2 - TREE_MARGIN;
  const z1 = b.z + b.d / 2 + TREE_MARGIN;
  const w = Math.max(0.001, x1 - x0);
  const d = Math.max(0.001, z1 - z0);
  const per = 2 * (w + d);
  const subs = [0, 0];
  const p = new Vector3();
  const sc = new Vector3(1, 1, 1);
  const q = new Quaternion();
  const m = new Matrix4();
  for (let i = 0; i < TREE_COUNT; i++) {
    const kind = kinds[i];
    if (kind < 0) continue;
    const mesh = meshes[kind];
    if (!mesh) continue;
    const f = (Math.imul(i + 1, 2654435761) >>> 0) / 4294967296;
    let t = (((i + f) / TREE_COUNT) * per) % per;
    if (t < 0) t += per;
    let x: number;
    let z: number;
    if (t < w) {
      x = x0 + t;
      z = z0;
    } else if (t < w + d) {
      x = x1;
      z = z0 + (t - w);
    } else if (t < 2 * w + d) {
      x = x1 - (t - w - d);
      z = z1;
    } else {
      x = x0;
      z = z1 - (t - 2 * w - d);
    }
    p.set(x, 0, z);
    mesh.setMatrixAt(subs[kind]++, m.compose(p, q, sc));
  }
  for (const mesh of meshes) {
    if (!mesh) continue;
    mesh.instanceMatrix.needsUpdate = true;
  }

  let disposed = false;
  return {
    object: root,
    update(_state: StageState, _dt: number): void {},
    dispose(): void {
      if (disposed) return;
      disposed = true;
      root.clear();
      for (const g of owned) g.dispose();
    },
  };
}

export async function mountCity(opts: MountCityOptions): Promise<CityHandle> {
  const { canvas, run, progress, labelLayer } = opts;
  const layout = buildLayout(run);
  const timeline = buildTimeline(run);
  const palette = readPalette();
  const lightCool = readToken(getComputedStyle(document.documentElement), '--light-cool', '#9cc3ee');
  // The Blender kit is progressive enhancement: a failed load keeps the placeholder look working unchanged.
  const kit: Kit | null = await loadKit().catch(() => null);

  const reduced = !!opts.reducedMotion;
  const cores = navigator.hardwareConcurrency || 4;
  const coarse = matchMedia('(pointer: coarse)').matches;
  let tier: CityTier = opts.tier ?? (reduced ? 'low' : cores >= 8 && !coarse ? 'high' : 'medium');
  let tierReason = opts.tier ? `forced ${opts.tier}` : reduced ? 'prefers-reduced-motion' : `${cores} cores${coarse ? ', coarse pointer' : ''}`;

  // --- Renderer, scene, camera, lights.
  const renderer = new WebGLRenderer({ canvas, antialias: tier === 'high', powerPreference: 'high-performance' });
  renderer.toneMapping = NoToneMapping; // the palette stays the palette
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFShadowMap;

  const scene = new Scene();
  // Drafting paper all the way out: the background is the paper token and the table fogs into it.
  const paper = new Color(palette.paper);
  const backdrop = paper.clone();
  scene.background = backdrop;
  const fog = new Fog(paper, 60, 200);
  scene.fog = fog;

  const b = layout.bounds;
  const R = 0.5 * Math.hypot(b.w, b.d);
  const centre = new Vector3(b.x, 0, b.z);

  const camera = new PerspectiveCamera(CAMERA_FOV, 16 / 9, 0.5, R * 20);

  // Warm low key from one side (long soft shadows), cool sky fill from the other. Matte: Lambert everywhere.
  const sun = new DirectionalLight(new Color(1, 1, 1).lerp(new Color(palette.lightWarm), SUN_WARMTH), SUN_INTENSITY);
  sun.position.set(b.x + R * 1.3, R * 0.75, b.z + R * 0.9);
  sun.target.position.copy(centre);
  sun.castShadow = true;
  const sc = sun.shadow.camera;
  sc.left = -R * 1.3; sc.right = R * 1.3; sc.top = R * 1.3; sc.bottom = -R * 1.3;
  sc.near = 0.5; sc.far = R * 4;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.03;
  sun.shadow.radius = 4;
  scene.add(sun, sun.target);
  const hemi = new HemisphereLight(new Color(1, 1, 1).lerp(new Color(lightCool), SKY_COOLNESS), paper, HEMI_INTENSITY);
  scene.add(hemi);

  // Drafting table. Plain look: a large paper plane just under the ground (fog fades its edge into the paper
  // background) with a faint blueprint grid. With the kit the table is a real slab (table.ts: tan top, wooden lip,
  // blueprint sheet) and this plane becomes the paper floor under it, below the slab's fascia, so the slab reads as
  // a table standing on the same paper as the backdrop and the tone never parts; the grid is left out.
  const tableGeo = new PlaneGeometry(R * 10, R * 10);
  const tableMat = new MeshLambertMaterial({ color: paper.clone().multiplyScalar(TABLE_SHADE) });
  const table = new Mesh(tableGeo, tableMat);
  table.rotation.x = -Math.PI / 2;
  table.position.set(b.x, kit ? SLAB_TOP - SLAB_DEPTH - 0.02 : -0.01, b.z);
  table.receiveShadow = true;
  scene.add(table);
  const gridSize = R * 6;
  const gridDiv = Math.max(4, Math.round(gridSize / (layout.cell * GRID_CELLS)));
  const grid = new GridHelper(gridSize, gridDiv, new Color(palette.line), new Color(palette.line));
  const gridMat = grid.material as LineBasicMaterial;
  gridMat.transparent = true;
  gridMat.opacity = GRID_OPACITY;
  gridMat.depthWrite = false;
  grid.position.set(b.x, -0.005, b.z);
  if (!kit) scene.add(grid);

  // --- The five parts. Shadows are a scene decision: every mesh in a part casts and receives.
  const parts: CityPart[] = [
    ...(kit ? [createTable(layout, palette, kit)] : []),
    createMerge(layout, palette),
    createBlueprint(layout, palette),
    createBuildings(layout, palette, kit),
    createDrones(layout, palette, kit),
    createScan(layout, palette),
  ];
  const trees = kit ? createTrees(layout, kit) : null;
  if (trees) parts.push(trees);
  for (const p of parts) {
    p.object.traverse((o) => {
      if ((o as Mesh).isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    scene.add(p.object);
  }

  // --- Post (high tier only): RenderPass -> tilt-shift (two passes) -> OutputPass.
  const tilt = createTiltShift();
  let composer: EffectComposer | null = null;
  function buildComposer() {
    if (composer) return;
    const target = new WebGLRenderTarget(1, 1, { type: HalfFloatType, samples: 4 });
    composer = new EffectComposer(renderer, target);
    composer.addPass(new RenderPass(scene, camera));
    tilt.install(composer);
    composer.addPass(new OutputPass());
  }
  function dropComposer() {
    if (!composer) return;
    tilt.setEnabled(false);
    composer.dispose();
    composer = null;
  }

  // --- Camera path (rebuilt when the aspect changes).
  let path = createCameraPath(buildCameraKeys(layout, timeline.beats, 16 / 9));
  const camPos = new Vector3();
  const camTgt = new Vector3();

  // --- Labels: pre-created DOM elements, one per lot, found by slug.
  const nWorkers = layout.lots.filter((l) => !l.extra).length;
  const labels = layout.lots.map((lot, i) => ({
    i,
    lot,
    el: labelLayer.querySelector<HTMLElement>(`[data-slug="${CSS.escape(lot.slug)}"]`),
    x: NaN,
    y: NaN,
    on: false,
    /** Hidden because it overlapped another label (waiting to be clear for LABEL_CLEAR_S). */
    held: false,
    /** Seconds this held label has been clear. */
    clear: 0,
  }));
  const labelPositions: LabelPosition[] = layout.lots.map((l) => ({ slug: l.slug, x: 0, y: 0, visible: false }));
  for (const l of labels) if (l.el) l.el.style.opacity = '0';
  const pose = { x: 0, y: 0, z: 0 };
  const ndc = new Vector3();
  let viewW = 1, viewH = 1;
  // De-collision: label sizes are measured on resize (and once fonts settle), never per frame; each frame places the
  // labels greedily in lot order and hides any whose box would overlap one already placed, with hysteresis (see
  // LABEL_GAP_*) so crowded poses do not blink. Allocation-free.
  const labelW = new Float32Array(labels.length);
  const labelH = new Float32Array(labels.length);
  const placed = new Float32Array(labels.length * 4);
  function measureLabels() {
    for (const l of labels) {
      labelW[l.i] = l.el ? l.el.offsetWidth : 0;
      labelH[l.i] = l.el ? l.el.offsetHeight : 0;
    }
  }
  void document.fonts?.ready.then(() => { if (!disposed) measureLabels(); });

  function placeLabels(state: StageState, dt: number) {
    let nPlaced = 0;
    for (const l of labels) {
      const k = l.i;
      let build: number, merge: number, shown: boolean;
      if (k < nWorkers) {
        const w = state.workers[k];
        build = w.build; merge = w.merge; shown = state.split >= 0.5;
      } else {
        const x = state.extras[k - nWorkers];
        build = x.build; merge = 0; shown = x.build > 0;
      }
      lotPoseAt(layout, k, merge, pose);
      ndc.set(pose.x, pose.y + l.lot.height * build + LABEL_LIFT, pose.z).project(camera);
      const onScreen = ndc.z < 1 && ndc.x > -1.05 && ndc.x < 1.05 && ndc.y > -1.05 && ndc.y < 1.05;
      // In the bill the city recedes and the labels would pile up: they leave with it.
      let vis = shown && onScreen && state.bill < BILL_LABELS_OFF;
      const px = Math.round((ndc.x * 0.5 + 0.5) * viewW * 4) / 4;
      const py = Math.round((-ndc.y * 0.5 + 0.5) * viewH * 4) / 4;
      if (vis) {
        // The label's box: anchored bottom-centre on the point (translate(-50%, -100%)); stored without any gap.
        const hw = labelW[k] / 2;
        const x0 = px - hw, x1 = px + hw, y0 = py - labelH[k], y1 = py;
        const gap = dt > 0 ? (l.on ? LABEL_GAP_HIDE : l.held ? LABEL_GAP_SHOW : LABEL_GAP) : LABEL_GAP;
        let hit = false;
        for (let j = 0; j < nPlaced; j++) {
          const o = j * 4;
          // Both boxes grow by `gap`, so the gap between them is 2 * gap.
          if (x0 - gap < placed[o + 2] + gap && x1 + gap > placed[o] - gap && y0 - gap < placed[o + 3] + gap && y1 + gap > placed[o + 1] - gap) { hit = true; break; }
        }
        if (!hit) {
          if (l.held && dt > 0) {
            l.clear += dt;
            if (l.clear < LABEL_CLEAR_S) vis = false;
          }
        } else {
          vis = false;
          l.clear = 0;
        }
        if (vis) {
          l.held = false;
          const o = nPlaced * 4;
          placed[o] = x0; placed[o + 1] = y0; placed[o + 2] = x1; placed[o + 3] = y1;
          nPlaced++;
        } else if (hit || l.held) {
          l.held = true;
        }
      } else {
        l.held = false;
        l.clear = 0;
      }
      const out = labelPositions[k];
      out.x = px; out.y = py; out.visible = vis;
      if (!l.el) continue;
      if (vis && (px !== l.x || py !== l.y)) {
        l.el.style.transform = `translate3d(${px}px, ${py}px, 0) translate(-50%, -100%)`;
        l.x = px; l.y = py;
      }
      if (vis !== l.on) {
        l.el.style.opacity = vis ? '1' : '0';
        l.on = vis;
      }
    }
  }

  // --- One frame at scroll progress u.
  function drawAt(u: number, dt: number) {
    const state = timeline.stateAt(u);
    for (const p of parts) p.update(state, dt);
    path.poseAt(u, camPos, camTgt);
    camera.position.copy(camPos);
    camera.lookAt(camTgt);
    camera.updateMatrixWorld();
    const dim = 1 - BILL_DIM * state.bill;
    sun.intensity = SUN_INTENSITY * dim;
    hemi.intensity = HEMI_INTENSITY * dim;
    backdrop.copy(paper).multiplyScalar(dim);
    fog.color.copy(backdrop);
    const dist = camPos.distanceTo(camTgt);
    fog.near = dist + R * 0.8;
    fog.far = fog.near + R * 3.5;
    if (composer && tier === 'high') composer.render(dt);
    else renderer.render(scene, camera);
    placeLabels(state, dt);
    opts.onState?.(state);
  }

  // --- Static frames (low tier, reduced motion): the current beat's pose, no loop.
  function drawStatic() {
    if (disposed) return;
    drawAt(beatPoseU(timeline.beats, progress.u), 0);
  }

  // --- Loop (high / medium), only while the stage is on screen.
  let raf = 0;
  let last = 0;
  let du = progress.u;
  const damp = { v: 0 };
  let visible = false;
  let disposed = false;
  let probe: ((dtMs: number) => void) | null = null;

  function frame(now: number) {
    raf = requestAnimationFrame(frame);
    const dtMs = last ? now - last : 0;
    last = now;
    const dt = Math.min(0.1, dtMs / 1000);
    du = smoothDamp(du, progress.u, damp, DAMP_TIME, dt);
    drawAt(du, dt);
    if (probe && dtMs > 0) probe(dtMs);
  }
  function start() {
    if (raf || disposed || tier === 'low') return;
    last = 0;
    du = progress.u; // resume where the page is, no glide from a stale value
    damp.v = 0;
    raf = requestAnimationFrame(frame);
  }
  function stop() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }

  function makeProbe(): (dtMs: number) => void {
    let seen = 0, frames = 0, elapsed = 0;
    return (dtMs) => {
      if (++seen <= PROBE.warmup) return;
      frames++;
      elapsed += dtMs;
      if (elapsed < PROBE.ms || frames < PROBE.minFrames) return;
      const fps = (frames * 1000) / elapsed;
      probe = null;
      if (fps < PROBE.lowBelow) setTier('low', `fps probe ${fps.toFixed(0)}`);
      else if (fps < PROBE.stepDownBelow && tier === 'high') {
        setTier('medium', `fps probe ${fps.toFixed(0)}`);
        probe = makeProbe(); // one more probe on the lower tier
      } else {
        tierReason += `, fps probe ${fps.toFixed(0)} ok`;
        opts.onTier?.(tier, tierReason);
      }
    };
  }

  // --- Size: the canvas box is fixed by CSS; the drawing buffer follows it.
  function pixelRatio() {
    return Math.min(window.devicePixelRatio || 1, tier === 'high' ? 2 : 1.5);
  }
  function resize() {
    const w = Math.max(1, canvas.clientWidth), h = Math.max(1, canvas.clientHeight);
    const pr = pixelRatio();
    viewW = w; viewH = h;
    renderer.setPixelRatio(pr);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    path = createCameraPath(buildCameraKeys(layout, timeline.beats, w / h));
    measureLabels();
    if (composer) {
      composer.setPixelRatio(pr);
      composer.setSize(w, h);
      tilt.setSize(Math.round(w * pr), Math.round(h * pr));
    }
    if (tier === 'low') drawStatic();
  }

  function applyTier() {
    const size = tier === 'high' ? 2048 : 1024;
    if (sun.shadow.mapSize.x !== size) {
      sun.shadow.mapSize.set(size, size);
      sun.shadow.map?.dispose();
      sun.shadow.map = null;
    }
    if (tier === 'high') {
      buildComposer();
      tilt.setEnabled(true);
    } else dropComposer();
    resize();
  }

  function setTier(next: CityTier, reason: string) {
    tier = next;
    tierReason = reason;
    applyTier();
    if (tier === 'low') {
      stop();
      drawStatic();
    } else if (visible) start();
    opts.onTier?.(tier, tierReason);
  }

  // --- Wiring.
  const ro = new ResizeObserver(() => resize());
  ro.observe(canvas);
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      visible = e.isIntersecting;
      if (visible) start();
      else stop();
    }
  });
  io.observe(opts.visibilityTarget ?? canvas);
  // Re-render in the next frame, not inside the scroll event itself.
  const unsubEnd = opts.onScrollEnd?.(() => { if (tier === 'low') requestAnimationFrame(drawStatic); });
  const onLost = (e: Event) => {
    e.preventDefault();
    stop();
    opts.onFail?.('webgl context lost');
  };
  canvas.addEventListener('webglcontextlost', onLost);

  applyTier();
  if (!opts.tier && tier !== 'low') probe = makeProbe();
  opts.onTier?.(tier, tierReason);

  return {
    get tier() { return tier; },
    labelPositions,
    dispose() {
      if (disposed) return;
      disposed = true;
      stop();
      ro.disconnect();
      io.disconnect();
      unsubEnd?.();
      canvas.removeEventListener('webglcontextlost', onLost);
      for (const p of parts) {
        scene.remove(p.object);
        p.dispose();
      }
      if (kit) kit.dispose();
      tilt.dispose();
      dropComposer();
      tableGeo.dispose();
      tableMat.dispose();
      grid.geometry.dispose();
      gridMat.dispose();
      sun.shadow.map?.dispose();
      renderer.dispose();
    },
  };
}
