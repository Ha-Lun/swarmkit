// SwarmKit particle-swarm hero: one THREE.Points draw call morphing through the
// story formations. Scroll progress (via beatAt) drives from/to morphs entirely
// on the GPU; the CPU only swaps two attribute bindings when the beat changes,
// plus a gentle group sway, camera parallax and uniforms. High/medium tiers
// render through bloom (EffectComposer); low renders directly.
import {
  ACESFilmicToneMapping, AdditiveBlending, BufferAttribute, BufferGeometry, Color, GLSL3, Group,
  NoToneMapping, PerspectiveCamera, Points, Scene, ShaderMaterial, SRGBColorSpace,
  Vector2, Vector3, WebGLRenderer,
} from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { beatAt } from './beats.ts';
import type { BeatState, FormationId } from './beats.ts';
import { buildFormations, DISK_AXIS, PALETTE, RING_AXIS } from './formations.ts';
import type { Lane } from './formations.ts';
import { fragmentShader, vertexShader } from './shaders.ts';

export type Tier = 'high' | 'medium' | 'low';

export const PARTICLES: Record<Tier, number> = { high: 18000, medium: 10000, low: 5000 };
const FORMATION_ID: Record<FormationId, number> = {
  disk: 0, lattice: 1, streams: 2, towers: 3, hex: 4, ring: 5, trio: 6,
};

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
const POINT_SIZE = 0.34;
const HALF_FOV_TAN = Math.tan((FOV * Math.PI) / 360);
const FORM_RADIUS = 6.5; // widest formation half-extent, local units
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
  const bloomTier = tier !== 'low';
  renderer.toneMapping = bloomTier ? ACESFilmicToneMapping : NoToneMapping; // applied by OutputPass
  renderer.toneMappingExposure = 1;
  renderer.outputColorSpace = SRGBColorSpace;

  // One BufferAttribute pair (positions, path params) per formation; aFrom/aTo and
  // aFromT/aToT are rebound on beat changes. 'position' shares the from-attribute
  // so three has a draw count.
  const set = buildFormations({ count: PARTICLES[tier], lanes: opts.lanes, seed: opts.seed ?? 7 });
  const posAttrs = {} as Record<FormationId, BufferAttribute>;
  const parAttrs = {} as Record<FormationId, BufferAttribute>;
  for (const id of Object.keys(set.positions) as FormationId[]) {
    posAttrs[id] = new BufferAttribute(set.positions[id], 3);
    parAttrs[id] = new BufferAttribute(set.params[id], 1);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', posAttrs.disk);
  geometry.setAttribute('aFrom', posAttrs.disk);
  geometry.setAttribute('aTo', posAttrs.disk);
  geometry.setAttribute('aFromT', parAttrs.disk);
  geometry.setAttribute('aToT', parAttrs.disk);
  geometry.setAttribute('aColor', new BufferAttribute(set.colors, 3));
  geometry.setAttribute('aRole', new BufferAttribute(set.roles, 1));
  geometry.setAttribute('aDelay', new BufferAttribute(set.delays, 1));
  geometry.setAttribute('aScale', new BufferAttribute(set.scales, 1));
  geometry.setAttribute('aKind', new BufferAttribute(set.kinds, 1));

  const material = new ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uMix: { value: 0 },
      uDrift: { value: reduced ? 0 : 1 },
      uAmb: { value: reduced ? 0 : 1 },
      uFromId: { value: 0 },
      uToId: { value: 0 },
      uFocus: { value: CAM_Z },
      uDirect: { value: bloomTier ? 0 : 1 },
      uDiskAxis: { value: new Vector3(...DISK_AXIS) },
      uRingAxis: { value: new Vector3(...RING_AXIS) },
      uCore: { value: new Vector3(...PALETTE.opus) },
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

  // Bloom chain (high/medium): scene -> half-res bloom -> tone map + sRGB -> dither.
  // Any failure drops to the direct path (uDirect = 1 then applies a manual curve).
  let composer: EffectComposer | null = null;
  let bloom: UnrealBloomPass | null = null;
  const passes: { dispose?: () => void }[] = [];
  if (bloomTier) {
    try {
      composer = new EffectComposer(renderer);
      const renderPass = new RenderPass(scene, camera);
      bloom = new UnrealBloomPass(new Vector2(256, 256), 0.55, 0.4, 0.25); // half-res internally
      const output = new OutputPass();
      const dither = new ShaderPass({
        uniforms: { tDiffuse: { value: null } },
        vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
        fragmentShader: 'uniform sampler2D tDiffuse; varying vec2 vUv; void main() { vec4 c = texture2D(tDiffuse, vUv); float n = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453); gl_FragColor = vec4(c.rgb + (n - 0.5) * 1.5 / 255.0, 1.0); }',
      });
      composer.addPass(renderPass);
      composer.addPass(bloom);
      composer.addPass(output);
      composer.addPass(dither);
      passes.push(renderPass, bloom, output, dither);
    } catch {
      composer = null;
      bloom = null;
      material.uniforms.uDirect.value = 1;
      renderer.toneMapping = NoToneMapping;
    }
  }

  let progress = 0;
  let target = 0;
  let curFrom: FormationId = 'disk';
  let curTo: FormationId = 'disk';
  let pointerSeen = false;
  let pointerOn = 0;
  const pointerNdc = new Vector3();
  const pointerWorld = new Vector3();
  const tmp = new Vector3();
  let camX = 0;
  let camY = 0;
  let raf = 0;
  let disposed = false;
  const t0 = performance.now();
  let lastMs = t0;

  function renderFrame(nowMs: number): void {
    if (disposed) return;
    const dt = Math.min(0.1, Math.max(0, (nowMs - lastMs) / 1000));
    lastMs = nowMs;
    const t = (nowMs - t0) / 1000;
    // Critically damped follow: smooths scroll steps without lag you can feel.
    progress = reduced ? target : progress + (target - progress) * (1 - Math.exp(-dt * 7));
    const st = beatAt(progress);
    if (st.from !== curFrom || st.to !== curTo) {
      curFrom = st.from;
      curTo = st.to;
      geometry.setAttribute('aFrom', posAttrs[curFrom]);
      geometry.setAttribute('aTo', posAttrs[curTo]);
      geometry.setAttribute('aFromT', parAttrs[curFrom]);
      geometry.setAttribute('aToT', parAttrs[curTo]);
      geometry.setAttribute('position', posAttrs[curFrom]);
    }
    const u = material.uniforms;
    u.uFromId.value = FORMATION_ID[curFrom];
    u.uToId.value = FORMATION_ID[curTo];
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
        group.updateMatrixWorld();
        group.worldToLocal(pointerWorld);
        (u.uPointer.value as Vector3).copy(pointerWorld);
      }
      pointerOn += (1 - pointerOn) * Math.min(1, dt * 4);
    } else {
      pointerOn += (0 - pointerOn) * Math.min(1, dt * 4);
    }
    u.uPointerOn.value = pointerOn;

    // Gentle sway for parallax (no tumble: transitions read edge-on otherwise).
    group.rotation.y = reduced ? 0 : 0.12 * Math.sin(t * 0.21);
    group.rotation.x = reduced ? 0 : 0.05 * Math.sin(t * 0.17 + 1.3);

    // Camera eases toward a small pointer parallax offset (0.4 units).
    if (!reduced) {
      camX += (pointerNdc.x * 0.4 - camX) * Math.min(1, dt * 3);
      camY += (pointerNdc.y * 0.4 - camY) * Math.min(1, dt * 3);
    }
    camera.position.x = camX;
    camera.position.y = camY;
    camera.lookAt(0, 0, 0);
    if (composer) {
      try {
        composer.render(dt);
        return;
      } catch {
        composer = null; // fall back to the direct path from the next frame on
        u.uDirect.value = 1;
        renderer.toneMapping = NoToneMapping;
      }
    }
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
    if (composer) {
      composer.setPixelRatio(pr);
      composer.setSize(w, h);
    }
    const aspect = w / h;
    camera.aspect = aspect;
    camera.position.z = aspect < 1 ? Math.min(CAM_Z / Math.max(aspect, 0.01), CAM_Z_MAX) : CAM_Z;
    camera.updateProjectionMatrix();
    // Layout: desktop pushes the formation right of the copy column; portrait
    // phones shrink it and lift it above the bottom-anchored copy.
    const hh = HALF_FOV_TAN * camera.position.z;
    const hw = hh * aspect;
    const wide = aspect >= 1.1;
    const layoutX = wide ? hw * 0.37 : 0;
    const layoutY = wide ? 0 : hh * 0.3;
    const layoutS = wide
      ? Math.min(1, (hw * 0.97 - hw * 0.37) / FORM_RADIUS)
      : Math.min(1, hw / FORM_RADIUS);
    // Portrait phones sit far back: boost the sprite so the swarm stays luminous.
    material.uniforms.uSize.value = POINT_SIZE * (aspect < 1.1 ? 1.9 : 1) * (tier === 'low' ? 1.5 : 1);
    material.uniforms.uFocus.value = camera.position.z;
    group.position.set(layoutX, layoutY, 0);
    group.scale.setScalar(layoutS);
    material.uniforms.uPixelRatio.value = pr;
    if (reduced) renderFrame(performance.now());
  }

  const onResize = (): void => resize();
  window.addEventListener('resize', onResize);

  // resize() already renders once when reduced (static scene), so only animate otherwise.
  resize();
  if (!reduced) raf = requestAnimationFrame(frame);

  return {
    setProgress(p: number): void {
      target = Math.min(1, Math.max(0, p));
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
      for (const p of passes) p.dispose?.();
      composer?.dispose();
      geometry.dispose();
      material.dispose();
      renderer.dispose();
    },
  };
}
