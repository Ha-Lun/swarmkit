// The one WebGL world: renderer, scene, locked lights, honeycomb, packets, hex-dissolve targets, post, swarm.
// It reads the shared scroll state and the locked look; it never re-tunes either, and never listens to scroll.
// The camera reads a critically damped copy of the scroll progress (about 0.15 s), so wheel and trackpad steps never reach it raw.
import {
  ACESFilmicToneMapping, CanvasTexture, Color, Fog, Group, HalfFloatType, PCFShadowMap, PerspectiveCamera, Scene,
  Quaternion, SRGBColorSpace, Vector2, Vector3, WebGLRenderer, WebGLRenderTarget,
} from 'three';
import type { Agent } from '../agents';
import type { ScrollState } from '../scroll';
import { createCameraPath, progressOfG, scrollToProgress, SEGMENTS } from './camera-path';
import { createWalkRoute, horizonFog, walkBlendBase, walkCameraPose, type WalkPose, type WalkRoute } from './walk';
import { sceneAlpha } from './scene-dom';
import { accentCandidates, look, readPalette, type Palette } from './config';
import { cellTopOf, createHoneycomb, layoutLattice, type Honeycomb } from './honeycomb';
import { motion, spinWeight, SWARM_CAM, walkCfg, walkRamp, walkWeight } from './motion-config';
import { createPost, type Post } from './post';
import { createStudio, shadowExtentOf, type Studio } from './studio';
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
/** The walk fills the screen with close-up metal, which costs far more fragment work than the orbit views: on a 2015 laptop GPU the high tier fell to 30-40 fps at a
 *  pixel ratio of 2 and held 60 at 1.5. So the ratio is capped here while the camera is on the ground (switched once, with hysteresis, at the start of the dive and after the rise). */
const WALK_DPR = 1.5;

/** Radial gradient background (round 11): ink-2 centre fading to ink at the edge, strength look.bg.gradient. Procedural,
 *  sRGB (matches the palette tokens' own space), small (256px: it only ever shows through as a soft blend). Shared with
 *  /lookdev, so the two renderers show the same backdrop. */
export function createBgTexture(palette: Palette, strength: number): CanvasTexture {
  const s = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = s;
  const ctx = canvas.getContext('2d')!;
  const inner = `#${new Color(palette.ink).lerp(new Color(palette.ink2), strength).getHexString()}`;
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, inner);
  g.addColorStop(1, palette.ink);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  return tex;
}

function readAccent(): string {
  // The accent belongs to the comet (head, tail, sparks, its rings) only; this is the one place it is read.
  const css = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  return css || accentCandidates.find((c) => c.name === 'violet')!.hex;
}

export function createWorld(opts: WorldOptions): World {
  const { canvas, agents, routing, state, scroll } = opts;
  let tier = opts.tier;
  let walkDprCap = false; // true while the walk is on screen (WALK_DPR); declared here because resize() runs during setup
  const palette = readPalette();

  const renderer = new WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setClearColor(palette.ink);
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = look.post.exposure;
  renderer.outputColorSpace = SRGBColorSpace;
  const scene = new Scene();
  const bgTex = createBgTexture(palette, look.bg.gradient);
  scene.background = bgTex;
  scene.fog = new Fog(palette.ink, 20, 120);
  const camera = new PerspectiveCamera(40, 1, 0.1, 400);

  const lattice = layoutLattice(agents); // identical for every tier: cell indices stay valid across a rebuild
  // the key's shadow frustum covers the globe (tallest tower included) and the moon; the moon's drift is added, so one radius fits
  const shadowExtent = shadowExtentOf(lattice);
  const cellByName = new Map<string, number>();
  lattice.cells.forEach((c, i) => c.agent && cellByName.set(c.agent.name, i));

  // Everything that turns with the globe: the lattice (moon included), the ring shell and the comet groups. Lights and the camera stay put.
  const globe = new Group();
  scene.add(globe);
  let comb: Honeycomb = createHoneycomb(agents, tier, renderer);
  globe.add(comb.object);
  // moving studio lights for the stone (lights only: nothing here draws a glow)
  let studio: Studio = createStudio(scene, tier, palette, shadowExtent);
  // cast shadows: high tier only. The map is drawn once per frame on request (needsUpdate in render()), never once per dissolve half.
  const applyShadows = () => {
    renderer.shadowMap.enabled = tier === 'high';
    renderer.shadowMap.type = PCFShadowMap;
    renderer.shadowMap.autoUpdate = false;
  };
  applyShadows();
  const path = createCameraPath(lattice);

  const accent = readAccent();
  const flows: Flow[] = Array.from({ length: 4 }, () => createFlow(accent));
  flows.forEach((f) => globe.add(f.packet.group));
  // the comet's crisp scan ring and arrival ripples sit just above the tower cap they mark (hive.ts moves the shell to it)
  const agentTop = Math.max(...lattice.cells.filter((c) => c.agent && !c.moon).map((c) => c.reach));
  const rings = createRingFx(lattice.radius + agentTop + 0.045, accent);
  globe.add(rings.mesh);

  // ---- view + panel highlight ----
  const view: View = {
    growth: 1, dim: 0, dissolve: 0, canvasOpacity: 1, latticeVisible: true, swarmFade: 0, swarmAttract: 0,
    focus: new Vector3(), focusWeight: 0, focusDrop: 0, overview: 0, camFloor: 0, walk: 0,
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
      return cellTopOf(lattice.cells[i], out).applyMatrix4(globe.matrixWorld); // world space, whatever the spin
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
  let rtC: WebGLRenderTarget | null = null; // the dissolve composite (high tier only: it feeds the post chain)
  let swarm: Swarm | null = null;
  let swarmBuilding = false;
  const swarmScene = new Scene();
  const swarmCam = new PerspectiveCamera(SWARM_CAM.fov, 1, 0.1, 100);
  swarmCam.position.set(0, 0, SWARM_CAM.z);
  const pcfg = { ...look.particles }; // per-frame copy: attract and opacity come from chapterProgress, look stays untouched

  function ensureTargets() {
    if (rtA) return;
    // high tier: post.renderScene already resolves MSAA into its own scratch target before writing here; medium
    // tier renders straight into these, so they carry their own antialiasing
    const samples = tier === 'high' ? 0 : 2;
    rtA = new WebGLRenderTarget(1, 1, { type: HalfFloatType, samples });
    rtB = new WebGLRenderTarget(1, 1, { type: HalfFloatType, samples });
    if (tier === 'high') rtC = new WebGLRenderTarget(1, 1, { type: HalfFloatType });
    resize(true);
  }
  function freeTargets() {
    rtA?.dispose(); rtB?.dispose(); rtC?.dispose();
    rtA = rtB = rtC = null;
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
    globe.remove(comb.object);
    comb.dispose();
    comb = createHoneycomb(agents, tier, renderer);
    walkCoreApplied = 1; // the new honeycomb starts at full glow; render() re-applies the walk's dimming
    globe.add(comb.object);
    studio.dispose();
    studio = createStudio(scene, tier, palette, shadowExtent);
    applyShadows();
    hiCur.clear();
    post?.dispose();
    post = tier === 'high' ? createPost(renderer, scene, camera, look.post, comb.aoGroup) : null;
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
    const pr = Math.min(window.devicePixelRatio || 1, MAX_DPR[tier], walkDprCap ? WALK_DPR : Infinity);
    renderer.setPixelRatio(pr);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    swarmCam.aspect = w / h;
    swarmCam.setViewOffset(w, h, 0, motion.finale.textLift * h, w, h); // + y moves the scene up
    swarmCam.updateProjectionMatrix();
    rtA?.setSize(w * pr, h * pr);
    rtB?.setSize(w * pr, h * pr);
    rtC?.setSize(w * pr, h * pr);
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

  // Slow spin that parks. `free` advances at rate * w. Displayed angle = lerp(home, free, w), where home is the nearest multiple of 2 pi to
  // `free`, latched the moment w starts to drop below 1: the globe eases to face home (at most half a turn), never jumps, and at w = 0 the angle is
  // exactly home, so the framing, routes and fly-over match the un-spun ones. Parked, `free` is re-anchored to home so the next spin starts from rest.
  const TAU = Math.PI * 2;
  let spinFree = 0, spinHome = 0, spinWPrev = 1, spinW = 1; // spinW also parks the moon's own motion (honeycomb.ts)
  // The walk (Cells): one weight (walkWeight of the DAMPED progress) blends the spline camera into a walker on the ground and drives everything that
  // changes with it: the pistons hold at rest, the lights follow the walker's frame, the fog comes from the horizon, the seam glow dims, the comet hides.
  let walkW = 0, walkCoreApplied = 1;
  let walkRoute: WalkRoute | null = null;
  const walkBase = new Quaternion(); // the orientation the dive and the rise are blended about (walkBlendBase)
  const buildWalk = () => {
    walkRoute = createWalkRoute(lattice);
    walkBase.copy(walkBlendBase(walkRoute, (p, o, t) => path.sample(scrollToProgress(2, p), o, t), [[walkRamp.inFrom, walkRamp.inTo], [walkRamp.outFrom, walkRamp.outTo]], walkCfg));
  };
  const wpose: WalkPose = { position: new Vector3(), quaternion: new Quaternion(), fov: 40, up: new Vector3(), forward: new Vector3(), ground: 0, stop: 0 };
  let walkCp = 0; // Cells chapter progress read back from the damped camera parameter
  function stepSpin(dt: number) {
    const w = spinW = spinWeight(state.chapter, state.chapterProgress);
    if (w < 1 && spinWPrev >= 1) spinHome = Math.round(spinFree / TAU) * TAU;
    spinWPrev = w;
    spinFree += (TAU / motion.spin.turnSec) * w * dt;
    if (w <= 0) spinFree = spinHome = 0;
    globe.rotation.y = w <= 0 ? 0 : spinHome + (spinFree - spinHome) * w;
    globe.updateMatrixWorld(true);
    // the G-buffer twin (post.ts) is unparented (its own private scene, so nothing else can corrupt it): keep its spin in sync by hand
    if (comb.aoGroup) comb.aoGroup.rotation.y = globe.rotation.y;
  }

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
    let fov = 40, near = 0.1;
    if (walkW > 0.001) {
      // the walk: blend the spline pose into the walker's pose with the one walk weight (position, orientation and FOV on the same curve)
      if (!walkRoute) buildWalk();
      fov = walkCameraPose(walkRoute!, walkBase, pos, target, walkW, walkCp, walkCfg, camera.position, camera.quaternion, wpose);
      near = 0.1 + (walkCfg.near - 0.1) * walkW;
    }
    if (camera.fov !== fov || camera.near !== near) { camera.fov = fov; camera.near = near; camera.updateProjectionMatrix(); }
    // the key sweeps round the globe as the camera orbits (studio.ts), with a soft kicker from behind; while walking it follows the walker's own frame
    studio.update(camera, { timeSec: time, frame: walkW > 0.001 ? { up: wpose.up, forward: wpose.forward, weight: walkW } : undefined });
    // fog follows camera distance so the recede reads as dimming, not clipping; look.bg.fog > 1 pushes it farther out
    const d = camera.position.length();
    let fogNear = d * 0.6 * look.bg.fog, fogFar = (d * 3 + 40) * look.bg.fog;
    if (walkW > 0.001) { // ... and on the ground it follows the distance to the horizon, so the limb fades out instead of ending in a hard edge
      const hf = horizonFog(lattice.radius, d, walkCfg.fogNear, walkCfg.fogFar);
      fogNear += (hf.near - fogNear) * walkW; fogFar += (hf.far - fogFar) * walkW;
    }
    (scene.fog as Fog).near = fogNear;
    (scene.fog as Fog).far = fogFar;
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
      stepSpin(dt); // before the chapters, so ctx.cellTop is in this frame's pose

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
      if (!walkRoute && ch >= 1) buildWalk(); // ahead of the Cells chapter (a few tens of ms, off the dive)
      if (!swarm && !swarmBuilding && ch >= 2) void ensureSwarm();
      if (ch === 3 || (ch === 2 && state.chapterProgress > 0.8)) ensureTargets();
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
    const dp = progressOfG(g);
    walkW = walkWeight(dp.chapter, dp.chapterProgress);
    walkCp = dp.chapterProgress;
    view.walk = walkW;
    if (!walkDprCap && walkW > 0.05) { walkDprCap = true; resize(true); } // (hysteresis: back to full resolution only once the rise is over)
    else if (walkDprCap && walkW < 0.005) { walkDprCap = false; resize(true); }
    if (walkW > 0.001) { flows.forEach((f) => (f.packet.group.visible = false)); rings.mesh.visible = false; } // the walker does not see the comet
    const coreScale = 1 - walkCfg.coreDim * walkW; // the seam glow dims under the walk camera so bloom does not bleed through the seams
    if (Math.abs(coreScale - walkCoreApplied) > 0.005 || (walkW === 0 && walkCoreApplied !== 1)) { comb.setCoreScale(coreScale); walkCoreApplied = coreScale; }
    comb.uniforms.uDetail.value = Math.max(look.cell.detail, walkCfg.detail * walkW); // the close-up richness of the metal fades in with the dive (the orbit views are untouched)
    comb.update(view.growth, view.dim, time, spinW, walkW);
    comb.object.visible = view.latticeVisible;
    pose(g);
    // the key moved in pose(): refresh its shadow map once, on the first render of this frame (the dissolve draws two halves)
    if (renderer.shadowMap.enabled && view.latticeVisible) renderer.shadowMap.needsUpdate = true;

    if (view.dissolve > 0.001 && view.dissolve < 0.999 && rtA && rtB) {
      // Both halves are drawn at the LIVE camera pose (pose(g) above), so they move together and the only difference is the dim:
      // outgoing = the lattice undimmed, incoming = the lattice as dimmed by the same ease that drives the dissolve. On the high
      // tier each half already carries GTAO and bloom (post.renderScene), so neither pops in or out of the transition; the
      // composite then goes through the same output stage (ACES, aberration, grain, vignette) as every other frame.
      if (post) post.sync(look.post);
      comb.update(view.growth, 0, time, spinW, walkW);
      if (post) post.renderScene(rtA, dt); else { renderer.setRenderTarget(rtA); renderer.render(scene, camera); }
      comb.update(view.growth, view.dim, time, spinW, walkW);
      if (post) post.renderScene(rtB, dt); else { renderer.setRenderTarget(rtB); renderer.render(scene, camera); }
      // distance to the visible cells: when the look-at is the globe centre, the surface is one radius nearer
      const dCell = Math.max(2, camera.position.distanceTo(target) - (target.length() < lattice.radius * 0.5 ? lattice.radius : 0));
      const hexPx = hexPixelSize(camera.fov, rtA.height, lattice.cellRadius, dCell);
      if (post && rtC) {
        dissolve.render(renderer, rtA.texture, rtB.texture, view.dissolve, hexPx, look.dissolve, rtC);
        post.renderTexture(rtC.texture, dt, time);
      } else {
        dissolve.render(renderer, rtA.texture, rtB.texture, view.dissolve, hexPx, look.dissolve);
      }
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

  post = tier === 'high' ? createPost(renderer, scene, camera, look.post, comb.aoGroup) : null;
  resize(true);
  return world;
}
