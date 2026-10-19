// SwarmKit particle-swarm hero: one THREE.Points draw call morphing through the
// story formations. Scroll progress (via beatAt) drives from/to morphs entirely
// on the GPU; the CPU only swaps two attribute bindings when the beat changes,
// plus a group rotation, camera parallax and uniforms. No postprocessing.
import {
  AdditiveBlending, BufferAttribute, BufferGeometry, Color, GLSL3, Group,
  NoToneMapping, PerspectiveCamera, Points, Scene, ShaderMaterial, SRGBColorSpace,
  Vector3, WebGLRenderer,
} from 'three';
import { beatAt } from './beats.ts';
import type { BeatState, FormationId } from './beats.ts';
import { buildFormations, PALETTE } from './formations.ts';
import type { Lane } from './formations.ts';
import { fragmentShader, vertexShader } from './shaders.ts';

export type Tier = 'high' | 'medium' | 'low';

export const PARTICLES: Record<Tier, number> = { high: 24000, medium: 12000, low: 5000 };

/** '?tier=high|medium|low|fallback' URL override first; 'fallback' if WebGL2 is
 *  unavailable; 'low' if innerWidth < 768 or hardwareConcurrency <= 4; 'medium'
 *  if devicePixelRatio > 2 or innerWidth < 1200; else 'high'. Window is only
 *  touched inside this function, so importing this module during SSR is safe. */
export function detectTier(): Tier | 'fallback' {
  if (typeof window === 'undefined' || typeof document === 'undefined') return 'high';
  const m = /[?&]tier=(high|medium|low|fallback)/.exec(window.location.search);
  if (m) return m[1] as Tier | 'fallback';
  try {
    const probe = document.createElement('canvas');
    if (!probe.getContext('webgl2')) return 'fallback';
  } catch {
    return 'fallback';
  }
  const w = window.innerWidth || 0;
  const cores = typeof navigator !== 'undefined' && navigator.hardwareConcurrency
    ? navigator.hardwareConcurrency
    : 8;
  if (w < 768 || cores <= 4) return 'low';
  if ((window.devicePixelRatio || 1) > 2 || w < 1200) return 'medium';
  return 'high';
}

export interface SwarmOptions {
  tier: Tier;
  lanes: Lane[];
  reducedMotion: boolean;
  seed?: number;
}

export interface Swarm {
  /** 0..1 story progress; stored, applied on the next frame. */
  setProgress(p: number): void;
  /** NDC, -1..1 (y up). */
  setPointer(x: number, y: number): void;
  resize(): void;
  dispose(): void;
}

const CLEAR = '#05060a';
const FOV = 45;
const CAM_Z = 11;
const CAM_Z_MAX = 22;
const POINT_SIZE = 0.09;
/** Weight of hex/ring in the current from/to mix -> unify toward merged gold. */
function unifyWeight(st: BeatState): number {
  const w = (f: FormationId): number => (f === 'hex' || f === 'ring' ? 1 : 0);
  return Math.min(1, w(st.from) * (1 - st.mix) + w(st.to) * st.mix);
}
/** Scan plane world y: sweeps -3 -> 4.6 over the build beat's hold half, then
 *  holds above max height (all verified) while morphing out of build; -99
 *  everywhere else so nothing verifies. */
function scanY(st: BeatState): number {
  if (st.beat !== 'build') return -99;
  const k = Math.min(st.local / 0.5, 1);
  if (k >= 1) return 99;
  const s = k * k * (3 - 2 * k);
  return -3 + 7.6 * s;
}

/** Throws if a WebGL2 context cannot be created (the caller then falls back). */
export function createSwarm(canvas: HTMLCanvasElement, opts: SwarmOptions): Swarm {
  const tier = opts.tier;
  const reduced = opts.reducedMotion;

  const renderer = new WebGLRenderer({
    canvas, antialias: false, alpha: false, powerPreference: 'high-performance',
  });
  if (!renderer.capabilities.isWebGL2) {
    renderer.dispose();
    throw new Error('swarm: WebGL2 unavailable');
  }
  renderer.setClearColor(new Color(CLEAR), 1);
  renderer.toneMapping = NoToneMapping;
  renderer.outputColorSpace = SRGBColorSpace;

  // One BufferAttribute per formation; aFrom/aTo are rebound on beat changes.
  // 'position' shares the from-attribute so three has a draw count.
  const set = buildFormations({ count: PARTICLES[tier], lanes: opts.lanes, seed: opts.seed ?? 7 });
  const posAttrs = {} as Record<FormationId, BufferAttribute>;
  for (const id of Object.keys(set.positions) as FormationId[]) {
    posAttrs[id] = new BufferAttribute(set.positions[id], 3);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', posAttrs.disk);
  geometry.setAttribute('aFrom', posAttrs.disk);
  geometry.setAttribute('aTo', posAttrs.disk);
  geometry.setAttribute('aColor', new BufferAttribute(set.colors, 3));
  geometry.setAttribute('aRole', new BufferAttribute(set.roles, 1));
  geometry.setAttribute('aDelay', new BufferAttribute(set.delays, 1));
  geometry.setAttribute('aScale', new BufferAttribute(set.scales, 1));

  const material = new ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uMix: { value: 0 },
      uDrift: { value: reduced ? 0 : 1 },
      uSize: { value: POINT_SIZE },
      uPixelRatio: { value: 1 },
      uPointer: { value: new Vector3(0, 0, 0) },
      uPointerOn: { value: 0 },
      uUnify: { value: 0 },
      uScanY: { value: -99 },
      uVerified: { value: new Vector3(...PALETTE.verified) },
      uMerged: { value: new Vector3(...PALETTE.merged) },
    },
    vertexShader,
    fragmentShader,
    glslVersion: GLSL3,
    blending: AdditiveBlending,
    depthWrite: false,
    transparent: true,
  });

  const scene = new Scene();
  const group = new Group();
  const points = new Points(geometry, material);
  points.frustumCulled = false;
  group.add(points);
  scene.add(group);
  const camera = new PerspectiveCamera(FOV, 1, 0.1, 100);
  camera.position.set(0, 0, CAM_Z);

  let progress = 0;
  let curFrom: FormationId = 'disk';
  let curTo: FormationId = 'disk';
  let pointerSeen = false;
  let pointerOn = 0;
  const pointerNdc = new Vector3();
  const pointerWorld = new Vector3();
  const tmp = new Vector3();
  let camX = 0;
  let camY = 0;
  let spin = 0;
  let raf = 0;
  let disposed = false;
  const t0 = performance.now();
  let lastMs = t0;

  function renderFrame(nowMs: number): void {
    if (disposed) return;
    const dt = Math.min(0.1, Math.max(0, (nowMs - lastMs) / 1000));
    lastMs = nowMs;
    const t = (nowMs - t0) / 1000;
    const st = beatAt(progress);
    if (st.from !== curFrom || st.to !== curTo) {
      curFrom = st.from;
      curTo = st.to;
      geometry.setAttribute('aFrom', posAttrs[curFrom]);
      geometry.setAttribute('aTo', posAttrs[curTo]);
      geometry.setAttribute('position', posAttrs[curFrom]);
    }
    const u = material.uniforms;
    u.uTime.value = t;
    u.uMix.value = st.mix;
    u.uUnify.value = unifyWeight(st);
    u.uScanY.value = scanY(st);

    if (!reduced && pointerSeen) {
      // World point on the z=0 plane under the cursor (camera-space unproject).
      tmp.set(pointerNdc.x, pointerNdc.y, 0.5).unproject(camera);
      tmp.sub(camera.position).normalize();
      if (tmp.z < -1e-4) {
        const s = -camera.position.z / tmp.z;
        pointerWorld.copy(camera.position).addScaledVector(tmp, s);
        (u.uPointer.value as Vector3).copy(pointerWorld);
      }
      pointerOn += (1 - pointerOn) * Math.min(1, dt * 4);
    } else {
      pointerOn += (0 - pointerOn) * Math.min(1, dt * 4);
    }
    u.uPointerOn.value = pointerOn;

    // Cinematic motion: story rotation + slow sway; disk spins during hero/cta.
    group.rotation.y = progress * 0.6 + (reduced ? 0 : 0.05 * Math.sin(t * 0.25));
    if (!reduced) {
      const diskW = (st.from === 'disk' ? 1 - st.mix : 0) + (st.to === 'disk' ? st.mix : 0);
      spin += dt * 0.03 * diskW;
    }
    group.rotation.z = spin;

    // Camera eases toward a small pointer parallax offset (0.4 units).
    if (!reduced) {
      camX += (pointerNdc.x * 0.4 - camX) * Math.min(1, dt * 3);
      camY += (pointerNdc.y * 0.4 - camY) * Math.min(1, dt * 3);
    }
    camera.position.x = camX;
    camera.position.y = camY;
    camera.lookAt(0, 0, 0);
    renderer.render(scene, camera);
  }

  function frame(nowMs: number): void {
    if (disposed) return;
    raf = requestAnimationFrame(frame);
    if (typeof document !== 'undefined' && document.hidden) {
      lastMs = nowMs;
      return;
    }
    renderFrame(nowMs);
  }

  function resize(): void {
    if (disposed) return;
    const w = Math.max(1, canvas.clientWidth || 1);
    const h = Math.max(1, canvas.clientHeight || 1);
    const pr = Math.min(window.devicePixelRatio || 1, tier === 'high' ? 2 : 1.5);
    renderer.setPixelRatio(pr);
    renderer.setSize(w, h, false);
    const aspect = w / h;
    camera.aspect = aspect;
    camera.position.z = aspect < 1 ? Math.min(CAM_Z / Math.max(aspect, 0.01), CAM_Z_MAX) : CAM_Z;
    camera.updateProjectionMatrix();
    material.uniforms.uPixelRatio.value = pr;
    if (reduced) renderFrame(performance.now());
  }

  const onResize = (): void => resize();
  window.addEventListener('resize', onResize);

  resize();
  if (reduced) {
    renderFrame(performance.now());
  } else {
    raf = requestAnimationFrame(frame);
  }

  return {
    setProgress(p: number): void {
      progress = Math.min(1, Math.max(0, p));
      if (reduced) renderFrame(performance.now());
    },
    setPointer(x: number, y: number): void {
      if (reduced) return;
      pointerNdc.set(x, y, 0);
      pointerSeen = true;
    },
    resize,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      window.removeEventListener('resize', onResize);
      scene.remove(group);
      geometry.dispose();
      material.dispose();
      renderer.dispose();
    },
  };
}
