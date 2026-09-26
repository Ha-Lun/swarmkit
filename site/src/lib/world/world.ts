// The one WebGL world: renderer, scene, locked lights, honeycomb, packets, hex-dissolve targets, post, swarm.
// It reads the shared scroll state and the locked look; it never re-tunes either, and never listens to scroll.
// The camera reads a critically damped copy of the scroll progress (about 0.15 s), so wheel and trackpad steps never reach it raw.
import {
  Color, Fog, HalfFloatType, PerspectiveCamera, Scene, Vector2, Vector3, WebGLRenderer, WebGLRenderTarget,
} from 'three';
import type { Agent } from '../agents';
import type { ScrollState } from '../scroll';
import { createCameraPath, SEGMENTS } from './camera-path';
import { sceneAlpha } from './scene-dom';
import { accentCandidates, look, readPalette } from './config';
import { cellTopOf, createHoneycomb, layoutLattice, type Honeycomb } from './honeycomb';
import { motion, SWARM_CAM } from './motion-config';
import { createPost, type Post } from './post';
import { createStudio, type Studio } from './studio';
import { createFlow, type Flow } from './routes';
import { createRingFx } from './rings';
import { createSwarm, type Swarm } from './swarm-particles';
import { createHexDissolve, hexPixelSize, type HexDissolve } from './transitions';
import type { ActiveTier, Chapter, RoutingNames, View, WorldCtx } from './types';
import { createIntro, type IntroChapter } from './chapters/intro';
import { createHive } from './chapters/hive';
import { createCells } from './chapters/cells';
import { createProof } from './chapters/proof';
import { createFinale } from './chapters/finale';

export interface WorldOptions {
  canvas: HTMLCanvasElement;
  agents: Agent[];
  routing: RoutingNames;
  state: Readonly<ScrollState>;
  tier: ActiveTier;
  scroll: { lock(): void; unlock(): void };
}

export interface World {
  readonly ctx: WorldCtx;
  readonly intro: IntroChapter;
  readonly tier: ActiveTier;
  /** compile shaders and draw one frame so the first visible frame does not hitch */
  warmup(): void;
  tick(nowMs: number): void;
  setTier(tier: ActiveTier): void;
  /** called with the raw frame delta (ms) after every rendered frame */
  onFrame: ((dtMs: number) => void) | null;
  dispose(): void;
}

const MAX_DPR: Record<ActiveTier, number> = { high: 2, medium: 1.5 };

function readAccent(): string {
  // The accent belongs to the comet (head, tail, sparks, its rings) only; this is the one place it is read.
  const css = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  return css || accentCandidates.find((c) => c.name === 'violet')!.hex;
}

export function createWorld(opts: WorldOptions): World {
  const { canvas, agents, routing, state, scroll } = opts;
  let tier = opts.tier;
  const palette = readPalette();

  const renderer = new WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setClearColor(palette.ink);
  const scene = new Scene();
  scene.background = new Color(palette.ink); // (render targets need the linear value, not just the clear colour)
  scene.fog = new Fog(palette.ink, 20, 120);
  const camera = new PerspectiveCamera(40, 1, 0.1, 400);

  const lattice = layoutLattice(agents); // identical for every tier: cell indices stay valid across a rebuild
  const cellByName = new Map<string, number>();
  lattice.cells.forEach((c, i) => c.agent && cellByName.set(c.agent.name, i));

  let comb: Honeycomb = createHoneycomb(agents, tier, renderer);
  scene.add(comb.object);
  // moving studio lights for the stone (lights only: nothing here draws a glow)
  let studio: Studio = createStudio(scene, tier, palette);
  const path = createCameraPath(lattice);

  const accent = readAccent();
  const flows: Flow[] = Array.from({ length: 4 }, () => createFlow(accent));
  flows.forEach((f) => scene.add(f.packet.group));
  // the comet's crisp scan ring and arrival ripples sit just above the panel tops
  const rings = createRingFx(lattice.radius + look.cell.relief + 0.045, accent);
  scene.add(rings.mesh);

  // ---- view + panel highlight ----
  const view: View = {
    growth: 1, dim: 0, dissolve: 0, canvasOpacity: 1, latticeVisible: true, swarmFade: 0, swarmAttract: 0,
    focus: new Vector3(), focusWeight: 0, focusDrop: 0, overview: 0, camFloor: 0,
  };
  const hiTarget = new Map<number, number>();
  const hiCur = new Map<number, number>();

  const ctx: WorldCtx = {
    agents, routing, scene, camera, renderer, state, view, lattice, flows, rings, scroll,
    get comb() { return comb; },
    time: 0,
    dt: 0,
    cellIndex: (name) => cellByName.get(name) ?? -1,
    cellTop(name, out) {
      const i = cellByName.get(name);
      if (i === undefined) return null;
      return cellTopOf(lattice.cells[i], out);
    },
    hilite(name, amount) {
      const i = cellByName.get(name);
      if (i !== undefined) hiTarget.set(i, Math.max(hiTarget.get(i) ?? 0, amount));
    },
  };

  // ---- chapters ----
  const intro = createIntro(ctx);
  const chapters: Chapter[] = [intro, createHive(ctx), createCells(ctx), createProof(ctx), createFinale(ctx)];
  if (chapters.length !== SEGMENTS.length) throw new Error('world: chapter modules must match camera segments');
  let active = -1;
  chapters.forEach((c, i) => c.fade(i === 0 ? 1 : 0)); // scenes start hidden (and inert) until their handover

  // ---- optional pieces ----
  let post: Post | null = null;
  const dissolve: HexDissolve = createHexDissolve();
  let rtA: WebGLRenderTarget | null = null;
  let rtB: WebGLRenderTarget | null = null;
  let swarm: Swarm | null = null;
  let swarmBuilding = false;
  const swarmScene = new Scene();
  const swarmCam = new PerspectiveCamera(SWARM_CAM.fov, 1, 0.1, 100);
  swarmCam.position.set(0, 0, SWARM_CAM.z);
  const pcfg = { ...look.particles }; // per-frame copy: attract and opacity come from chapterProgress, look stays untouched

  function ensureTargets() {
    if (rtA) return;
    const samples = tier === 'high' ? 4 : 2;
    rtA = new WebGLRenderTarget(1, 1, { type: HalfFloatType, samples });
    rtB = new WebGLRenderTarget(1, 1, { type: HalfFloatType, samples });
    resize(true);
  }
  function freeTargets() {
    rtA?.dispose(); rtB?.dispose();
    rtA = rtB = null;
  }
  // The command is look.particles.textWidth wide; on a narrow (portrait) screen it is narrowed to fit the view.
  let swarmTextW = look.particles.textWidth;
  const swarmTextWidth = () => {
    const viewH = 2 * SWARM_CAM.z * Math.tan((SWARM_CAM.fov * Math.PI) / 360);
    return Math.min(look.particles.textWidth, viewH * (window.innerWidth / window.innerHeight) * 0.88);
  };
  async function ensureSwarm() {
    if (swarm || swarmBuilding) return;
    swarmBuilding = true;
    try {
      await document.fonts?.load('400 160px "JetBrains Mono"'); // the target text is rasterised with it
      if (disposed) return;
      swarmTextW = swarmTextWidth();
      swarm = createSwarm(renderer, tier, { ...look.particles, textWidth: swarmTextW }, palette);
      swarmScene.add(swarm.points);
      resize(true);
    } finally {
      swarmBuilding = false;
    }
  }

  function buildTier() {
    scene.remove(comb.object);
    comb.dispose();
    comb = createHoneycomb(agents, tier, renderer);
    scene.add(comb.object);
    studio.dispose();
    studio = createStudio(scene, tier, palette);
    hiCur.clear();
    post?.dispose();
    post = tier === 'high' ? createPost(renderer, scene, camera, look.post) : null;
    freeTargets();
    if (swarm) {
      swarmScene.remove(swarm.points);
      swarm.dispose();
      swarm = null;
    }
    resize(true);
  }

  const v2 = new Vector2();
  let lw = 0, lh = 0;
  function resize(force = false) {
    const w = window.innerWidth, h = window.innerHeight;
    // mobile URL-bar collapse changes innerHeight by a few dozen px on scroll: not worth reallocating every target
    if (!force && w === lw && Math.abs(h - lh) < 120) return;
    lw = w; lh = h;
    const pr = Math.min(window.devicePixelRatio || 1, MAX_DPR[tier]);
    renderer.setPixelRatio(pr);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    swarmCam.aspect = w / h;
    swarmCam.setViewOffset(w, h, 0, motion.finale.textLift * h, w, h); // + y moves the scene up
    swarmCam.updateProjectionMatrix();
    rtA?.setSize(w * pr, h * pr);
    rtB?.setSize(w * pr, h * pr);
    post?.setSize(w, h, pr);
    const bh = renderer.getDrawingBufferSize(v2).y;
    flows.forEach((f) => f.packet.setViewportHeight(bh));
    swarm?.setViewportHeight(bh);
    if (swarm) {
      const tw = swarmTextWidth();
      if (Math.abs(tw - swarmTextW) > 0.5) { swarmTextW = tw; swarm.retarget(tw); }
    }
  }
  resize(true);
  const onResize = () => resize();
  window.addEventListener('resize', onResize);

  // ---- per-frame ----
  const pos = new Vector3(), target = new Vector3(), focusSm = new Vector3();
  const posB = new Vector3(), targetB = new Vector3(), aim = new Vector3();
  let focusW = 0, dropSm = 0, overviewSm = 0;
  // critically damped progress (smoothTime ~0.15 s): the camera never sees a raw wheel step
  const SMOOTH_TIME = 0.15;
  let gSm = state.globalProgress, gVel = 0;
  function dampProgress(dt: number) {
    const w = 2 / SMOOTH_TIME, e = Math.exp(-w * dt);
    const change = gSm - state.globalProgress;
    const temp = (gVel + w * change) * dt;
    gVel = (gVel - w * temp) * e;
    gSm = state.globalProgress + (change + temp) * e;
    if (Math.abs(gSm - state.globalProgress) < 1e-6 && Math.abs(gVel) < 1e-6) { gSm = state.globalProgress; gVel = 0; }
  }
  let canvasOpacity = 1;

  function pose(g: number) {
    path.sample(g, pos, target);
    if (overviewSm > 0.001) {
      path.sample(SEGMENTS[1].t1, posB, targetB); // end of the hive chapter: the whole globe and its moon in frame
      pos.lerp(posB, overviewSm);
      target.lerp(targetB, overviewSm);
    }
    if (focusW > 0.001) {
      aim.copy(focusSm);
      aim.y -= dropSm * pos.distanceTo(focusSm);
      target.lerp(aim, focusW);
    }
    camera.position.copy(pos);
    camera.lookAt(target);
    // the key sweeps round the globe as the camera orbits (studio.ts), with a soft kicker from behind
    studio.update(camera, { timeSec: time });
    // fog follows camera distance so the recede reads as dimming, not clipping
    const d = pos.length();
    (scene.fog as Fog).near = d * 0.6;
    (scene.fog as Fog).far = d * 3 + 40;
  }

  function stepHilite(dt: number) {
    const k = 1 - Math.exp(-motion.hilite.ratePerSec * dt);
    for (const i of new Set([...hiTarget.keys(), ...hiCur.keys()])) {
      const t = hiTarget.get(i) ?? 0;
      let c = hiCur.get(i) ?? 0;
      const prev = c;
      c += (t - c) * k;
      if (t === 0 && c < 0.002) c = 0;
      if (c === prev) continue;
      comb.setCellState(i, c, c); // tone brightening and lift; never self-lit
      if (c === 0) hiCur.delete(i); else hiCur.set(i, c);
    }
    hiTarget.clear();
  }

  let last = 0, time = 0, disposed = false;
  const world: World = {
    ctx, intro,
    get tier() { return tier; },
    onFrame: null,
    warmup() {
      comb.update(0, 0);
      renderer.compile(scene, camera);
    },
    setTier(next) {
      if (next === tier) return;
      tier = next;
      buildTier();
    },
    tick(nowMs) {
      if (disposed) return;
      if (document.hidden) { last = 0; return; } // paused while the tab is hidden
      const raw = last ? nowMs - last : 16.7;
      last = nowMs;
      const dt = Math.min(raw / 1000, 0.1);
      time += dt;
      ctx.time = time;
      ctx.dt = dt;

      const ch = state.chapter;
      if (ch !== active) {
        if (active >= 0) chapters[active].exit();
        active = ch;
        chapters.forEach((c, i) => Math.abs(i - ch) > 1 && c.fade(0)); // a jump across chapters leaves no half-faded scene behind
        chapters[ch].enter();
      }
      // stateless per-frame outputs: chapters overwrite what they care about
      view.growth = 1; view.dim = 0; view.dissolve = 0; view.canvasOpacity = 1; view.latticeVisible = true;
      view.swarmFade = 0; view.swarmAttract = 0; view.focusWeight = 0; view.focusDrop = 0; view.overview = 0;
      chapters[ch].update(state.chapterProgress);
      // fixed scenes only change opacity: this one fades in over the first 25vh of its runway and out over the last 25vh, so the
      // neighbours are always fully faded (and inert) while it is on screen
      chapters[ch].fade(sceneAlpha(ch, state.chapterProgress));
      if (ch + 1 < chapters.length) chapters[ch + 1].fade(0);
      if (ch > 0) chapters[ch - 1].fade(0);
      dampProgress(dt);

      // lazy pieces, built ahead of the chapter that needs them
      if (!swarm && !swarmBuilding && ch >= 2) void ensureSwarm();
      if (ch === 3 || (ch === 2 && state.chapterProgress > 0.6)) ensureTargets();
      else if (ch === 4 || ch <= 1) freeTargets();

      const kf = 1 - Math.exp(-motion.camera.focusRatePerSec * dt);
      focusSm.lerp(view.focus, focusSm.lengthSq() === 0 ? 1 : kf);
      focusW += (view.focusWeight - focusW) * kf;
      dropSm += (view.focusDrop - dropSm) * kf;
      overviewSm += (view.overview - overviewSm) * kf;
      stepHilite(dt);
      render(dt);

      if (Math.abs(view.canvasOpacity - canvasOpacity) > 0.002) {
        canvasOpacity = view.canvasOpacity;
        canvas.style.opacity = String(canvasOpacity);
      }
      world.onFrame?.(raw);
    },
    dispose() {
      disposed = true;
      window.removeEventListener('resize', onResize);
      chapters.forEach((c) => c.dispose?.());
      flows.forEach((f) => f.dispose());
      rings.dispose();
      dissolve.dispose();
      freeTargets();
      post?.dispose();
      swarm?.dispose();
      comb.dispose();
      studio.dispose();
      scene.clear();
      swarmScene.clear();
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };

  function render(dt: number) {
    const g = Math.max(gSm, view.camFloor);
    comb.update(view.growth, view.dim);
    comb.object.visible = view.latticeVisible;
    pose(g);

    if (view.dissolve > 0.001 && view.dissolve < 0.999 && rtA && rtB) {
      // outgoing state: the end of the cells view, undimmed. incoming: the live view.
      const cellsEnd = SEGMENTS[2].t1;
      pose(cellsEnd);
      comb.update(view.growth, 0);
      renderer.setRenderTarget(rtA);
      renderer.render(scene, camera);
      pose(g);
      comb.update(view.growth, view.dim);
      renderer.setRenderTarget(rtB);
      renderer.render(scene, camera);
      // distance to the visible cells: when the look-at is the globe centre, the surface is one radius nearer
      const dCell = Math.max(2, camera.position.distanceTo(target) - (target.length() < lattice.radius * 0.5 ? lattice.radius : 0));
      const hexPx = hexPixelSize(camera.fov, rtA.height, lattice.cellRadius, dCell);
      dissolve.render(renderer, rtA.texture, rtB.texture, view.dissolve, hexPx, look.dissolve);
    } else if (post) {
      post.sync(look.post);
      post.render(dt, time);
    } else {
      renderer.setRenderTarget(null);
      renderer.render(scene, camera);
    }

    if (swarm && view.swarmFade > 0.002) {
      pcfg.attract = view.swarmAttract;
      pcfg.opacity = look.particles.opacity * view.swarmFade;
      swarm.update(dt, time, pcfg);
      renderer.setRenderTarget(null);
      renderer.autoClear = false;
      renderer.clearDepth();
      renderer.render(swarmScene, swarmCam);
      renderer.autoClear = true;
    }
  }

  post = tier === 'high' ? createPost(renderer, scene, camera, look.post) : null;
  resize(true);
  return world;
}
