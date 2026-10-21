// The pre-rendered nebula (public/nebula, made offline by scripts/render-nebula.mjs): display-referred WebP layers shown as
// parallax planes (hero -> comet) and as a bubble cube + wall shell around Opus (after ignition). The live volume
// (nebula-volume.ts) only covers the dive and the ignition, and is the fallback while these load.
// All layers are drawn premultiplied, far to near, into one half-float target in display-referred linear colour (exactly how the
// offline renderer composited them); a single full-screen quad then puts that target into the scene, applying the inverse of
// the scene's ACES curve so the tone-mapping pass lands back on the rendered pixels (the quad is a straight write on the
// non-tone-mapped low tier). Textures load lazily after the hero has painted: low set on the low tier, portrait and save-data.
import {
  BackSide, BufferAttribute, BufferGeometry, CubeTexture, CustomBlending, DoubleSide, GLSL3, Group, HalfFloatType, LinearFilter,
  LinearMipmapLinearFilter, Matrix4, Mesh, NoBlending, OneFactor, OneMinusSrcAlphaFactor, OrthographicCamera, PlaneGeometry,
  Quaternion, Scene, ShaderMaterial, SphereGeometry, SRGBColorSpace, Texture, UnsignedByteType, Vector2, Vector3, Vector4, WebGLRenderTarget,
} from 'three';
import type { PerspectiveCamera, WebGLRenderer } from 'three';
import { clamp01, M, ss } from './path.ts';
import type { Tier } from './shared.ts';

const BASE = '/nebula/';
const BUBBLE_GAIN = { far: 0.13, shell: 0.15 };
/** hero: the planes are drawn this much larger (about the nebula's upper rim) so the soft lower/side feather falls outside the viewport */
const HERO_GROW = 1.3;
const HERO_ANCHOR = 0.31; // NDC y of the cloud's upper rim in the hero frame

interface Manifest {
  approach: {
    camera: { position: number[]; target: number[]; up: number[]; fov: number; aspect: number };
    layers: { file: { high: string; low: string }; depth: number; planeHeight: number }[];
  };
  bubble: {
    cube: { order: string[]; file: { high: string; low: string } };
    shell: { file: { high: string; low: string }; radius: number; farRadius: number };
  };
}

export interface LayerParams {
  /** legacy progress 0..1 (hero .. dive .. ignition .. plan) and merge progress m */
  pp: number;
  m: number;
  /** copy-column dimming, as the volume does */
  copyAmt: number;
  copyMask: Vector4;
  exposure: number;
}

export interface NebulaLayers {
  object3d: Group;
  /** 0..1 how much of the screen the pre-rendered layers cover now (the live volume fills in the rest) */
  cover: number;
  /** true once the approach layers are drawable */
  readonly ready: boolean;
  update(camera: PerspectiveCamera, p: LayerParams): void;
  resize(drawW: number, drawH: number): void;
  dispose(): void;
}

const vertQuad = /* glsl */ `
out vec2 vUv;
out vec2 vNdc;
void main() {
  vNdc = position.xy;
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 1.0, 1.0);
}
`;

const vertPlane = /* glsl */ `
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;
const fragPlane = /* glsl */ `
precision highp float;
uniform sampler2D uTex;
uniform float uFade;
in vec2 vUv;
out vec4 outColor;
void main() {
  vec4 t = texture(uTex, vUv);
  // straight alpha in the file; a thin feather at the plane's border hides the cut when the camera looks past it
  vec2 e = smoothstep(vec2(0.0), vec2(0.07, 0.16), vUv) * (1.0 - smoothstep(vec2(0.93, 0.97), vec2(1.0), vUv));
  float a = t.a * e.x * e.y * uFade;
  outColor = vec4(t.rgb * a, a);
}
`;

const vertSphere = /* glsl */ `
out vec3 vP;
void main() {
  vP = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;
const fragSphere = /* glsl */ `
precision highp float;
uniform samplerCube uCube;
uniform float uFade;
uniform float uFlip;
uniform vec2 uRes;
uniform vec4 uCopyMask;
uniform float uCopyAmt;
uniform vec4 uClear; // xy: the cluster centre in NDC, z: radius (NDC height units), w: how far the clear zone dims
in vec3 vP;
out vec4 outColor;
void main() {
  vec3 d = normalize(vP);
  vec4 t = texture(uCube, vec3(uFlip * d.x, d.y, d.z));
  // grade the cream/beige toward the palette: keep the luminance, tint it teal -> violet by direction, a little amber in the highlights
  float l = dot(t.rgb, vec3(0.2126, 0.7152, 0.0722));
  float h = 0.5 + 0.5 * sin(d.x * 2.3 + d.y * 1.7 + d.z * 1.1);
  vec3 tint = mix(vec3(0.20, 0.78, 0.72), vec3(0.58, 0.40, 0.92), h);
  tint = mix(tint, vec3(1.0, 0.72, 0.38), 0.18 * smoothstep(0.25, 0.7, l));
  vec3 c = mix(t.rgb, l * tint * 1.5, 0.78);
  vec2 n = gl_FragCoord.xy / uRes * 2.0 - 1.0;
  // the copy column stays dark, and a soft clear zone keeps the stars and threads of the cluster against near-black
  float k = 1.0;
  if (uCopyMask.z > 0.0) k = mix(1.0, mix(0.05, 1.0, smoothstep(0.6, 1.3, length((n - uCopyMask.xy) / uCopyMask.zw))), uCopyAmt);
  vec2 cd = (n - uClear.xy) * vec2(uRes.x / uRes.y, 1.0);
  k *= 1.0 - uClear.w * (1.0 - smoothstep(0.15, 1.0, length(cd) / max(uClear.z, 0.01)));
  float a = t.a * uFade * k;
  outColor = vec4(c * a, a);
}
`;

// display-referred linear (premultiplied) -> scene linear that three's ACES pass maps back to it
const fragComp = /* glsl */ `
precision highp float;
uniform sampler2D tL;
uniform float uMode; // 1: scene is tone-mapped (ACES), 0: written straight to the canvas
uniform float uExp;
uniform float uCopyAmt;
uniform vec4 uCopyMask;
in vec2 vUv;
in vec2 vNdc;
out vec4 outColor;
const mat3 IN_M = mat3(vec3(0.59719, 0.07600, 0.02840), vec3(0.35458, 0.90834, 0.13383), vec3(0.04823, 0.01566, 0.83777));
const mat3 OUT_M = mat3(vec3(1.60475, -0.10208, -0.00327), vec3(-0.53108, 1.10813, -0.07276), vec3(-0.07367, -0.00605, 1.07602));
vec3 invAces(vec3 d) {
  vec3 y = clamp(inverse(OUT_M) * d, 0.0, 0.985);
  vec3 A = 1.0 - 0.983729 * y;
  vec3 B = 0.0245786 - 0.432951 * y;
  vec3 C = -(0.000090537 + 0.238081 * y);
  vec3 v = (-B + sqrt(B * B - 4.0 * A * C)) / (2.0 * A);
  v -= 0.003687 * (1.0 - clamp(y * 20.0, 0.0, 1.0));
  return max(inverse(IN_M) * max(v, 0.0), 0.0) * 0.6 / uExp;
}
void main() {
  vec4 s = texture(tL, vUv);
  if (uCopyMask.z > 0.0) {
    vec2 e = (vNdc - uCopyMask.xy) / uCopyMask.zw;
    float k = mix(1.0, mix(0.12, 1.0, smoothstep(0.6, 1.2, length(e))), uCopyAmt);
    s *= k;
  }
  vec3 c = uMode > 0.5 ? invAces(min(s.rgb, vec3(0.985))) : pow(max(s.rgb, 0.0), vec3(1.0 / 2.2));
  float dn = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) - 0.5;
  c = max(c + dn * 0.0012 * smoothstep(0.0, 0.01, max(c.r, max(c.g, c.b))), 0.0);
  outColor = vec4(c, s.a);
}
`;

const loadImage = (url: string): Promise<HTMLImageElement> => new Promise((res, rej) => {
  const im = new Image();
  im.decoding = 'async';
  im.onload = () => res(im);
  im.onerror = () => rej(new Error(`nebula: ${url}`));
  im.src = url;
});

export function createNebulaLayers(tier: Tier, renderer: WebGLRenderer, opts: { portrait: boolean; onReady?: () => void }): NebulaLayers {
  const toneMapped = tier !== 'low';
  const half = renderer.extensions.has('EXT_color_buffer_float') || renderer.extensions.has('EXT_color_buffer_half_float');
  const rt = new WebGLRenderTarget(2, 2, {
    type: half ? HalfFloatType : UnsignedByteType, depthBuffer: false, stencilBuffer: false,
    minFilter: LinearFilter, magFilter: LinearFilter, generateMipmaps: false,
  });
  const layerScene = new Scene();
  const rtRes = new Vector2(2, 2);
  const clearZone = new Vector4(0, 0, 0.7, 0.55);
  const dummyCam = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  const comp = new ShaderMaterial({
    uniforms: { tL: { value: rt.texture }, uMode: { value: toneMapped ? 1 : 0 }, uExp: { value: 1 }, uCopyAmt: { value: 0 }, uCopyMask: { value: new Vector4() } },
    vertexShader: vertQuad, fragmentShader: fragComp, glslVersion: GLSL3,
    transparent: true, blending: CustomBlending, blendSrc: OneFactor, blendDst: OneMinusSrcAlphaFactor, depthTest: false, depthWrite: false,
  });
  const quad = new Mesh(geo, comp);
  quad.frustumCulled = false;
  quad.renderOrder = 0.5; // where the volume's composite sat: after the deep-field shells, before planets, rings and fx
  quad.visible = false;
  const group = new Group();
  group.add(quad);

  const blend = { blending: CustomBlending, blendSrc: OneFactor, blendDst: OneMinusSrcAlphaFactor } as const;
  const owned: { dispose(): void }[] = [geo, rt, comp];
  let manifest: Manifest | null = null;
  let planes: { mesh: Mesh; mat: ShaderMaterial; depth: number; base: Vector3; h: number }[] = [];
  let approachReady = false;
  let bubbleReady = false;
  let far: Mesh | null = null;
  let shell: Mesh | null = null;
  let farMat: ShaderMaterial | null = null;
  let shellMat: ShaderMaterial | null = null;
  let disposed = false;
  const heroFwd = new Vector3();
  const heroPos = new Vector3();
  const heroQ = new Quaternion();
  const heroUp = new Vector3();
  let aspectKey = 0;
  const saveData = !!(navigator as { connection?: { saveData?: boolean } }).connection?.saveData;
  // phones: the low approach set is blotchy when stretched over a portrait screen, so they take the high approach layers (~0.76 MB);
  // the bubble is dim and distant, the low cube is plenty
  const set: 'high' | 'low' = tier === 'low' || opts.portrait || saveData ? 'low' : 'high';
  const setApproach: 'high' | 'low' = saveData || (tier === 'low' && !opts.portrait) ? 'low' : 'high';
  const upQueue: Texture[] = []; // textures still to upload to the GPU: one per frame, no hitch
  const out = { object3d: group, cover: 0 } as NebulaLayers & { cover: number };
  let t0 = 0;

  function placePlanes(aspect: number): void {
    if (!manifest) return;
    const s = Math.max(1, aspect / manifest.approach.camera.aspect);
    const grow = aspect < 1.1 ? 1.15 : HERO_GROW; // portrait already fills the width, so it only needs the lower feather pushed past the bottom
    // ultrawide: grow the plane away along the hero ray (same look from the hero pose)
    for (const pl of planes) {
      pl.mesh.position.copy(heroPos).addScaledVector(heroFwd, pl.depth * s);
      pl.mesh.scale.set(pl.h * s * grow * manifest.approach.camera.aspect, pl.h * s * grow, 1);
      pl.mesh.position.addScaledVector(heroUp, -HERO_ANCHOR * (grow - 1) * pl.h * s * 0.5);
    }
    aspectKey = aspect;
  }

  async function load(): Promise<void> {
    const mres = await fetch(`${BASE}manifest.json`);
    if (!mres.ok || disposed) return;
    manifest = (await mres.json()) as Manifest;
    const cam = manifest.approach.camera;
    heroPos.fromArray(cam.position);
    heroFwd.fromArray(cam.target).sub(heroPos).normalize();
    const right = new Vector3().crossVectors(heroFwd, new Vector3().fromArray(cam.up)).normalize();
    const up = new Vector3().crossVectors(right, heroFwd);
    heroUp.copy(up);
    heroQ.setFromRotationMatrix(new Matrix4().makeBasis(right, up, heroFwd.clone().negate()));
    const imgs = await Promise.all(manifest.approach.layers.map((l) => loadImage(BASE + l.file[setApproach])));
    if (disposed) return;
    const pg = new PlaneGeometry(1, 1);
    owned.push(pg);
    planes = manifest.approach.layers.map((l, i) => {
      const tex = new Texture(imgs[i]);
      tex.colorSpace = SRGBColorSpace;
      tex.minFilter = LinearMipmapLinearFilter;
      tex.magFilter = LinearFilter;
      tex.anisotropy = 2;
      tex.needsUpdate = true;
      const mat = new ShaderMaterial({
        uniforms: { uTex: { value: tex }, uFade: { value: 0 } }, vertexShader: vertPlane, fragmentShader: fragPlane, glslVersion: GLSL3,
        ...blend, transparent: true, depthTest: false, depthWrite: false, side: DoubleSide,
      });
      const mesh = new Mesh(pg, mat);
      mesh.frustumCulled = false;
      mesh.renderOrder = i; // far -> near
      mesh.quaternion.copy(heroQ);
      layerScene.add(mesh);
      owned.push(tex, mat);
      upQueue.push(tex);
      return { mesh, mat, depth: l.depth, base: new Vector3(), h: l.planeHeight };
    });
    placePlanes(cam.aspect);
    approachReady = true;
    opts.onReady?.();
    // the bubble is only needed at the ignition: load it after the approach, without blocking
    const b = manifest.bubble;
    const mk = (files: { high: string; low: string }): Promise<CubeTexture> => Promise.all(
      b.cube.order.map((f) => loadImage(BASE + files[set].replace('{face}', f))),
    ).then((ims) => {
      const ct = new CubeTexture(ims);
      ct.colorSpace = SRGBColorSpace;
      ct.generateMipmaps = true;
      ct.minFilter = LinearMipmapLinearFilter;
      ct.magFilter = LinearFilter;
      ct.needsUpdate = true;
      return ct;
    });
    const [farTex, shellTex] = await Promise.all([mk(b.cube.file), mk(b.shell.file)]);
    if (disposed) {
      farTex.dispose();
      shellTex.dispose();
      return;
    }
    const sphere = (tex: CubeTexture, r: number, order: number): [Mesh, ShaderMaterial] => {
      const mat = new ShaderMaterial({
        uniforms: { uCube: { value: tex }, uFade: { value: 0 }, uFlip: { value: 1 }, uRes: { value: rtRes }, uCopyMask: { value: new Vector4() }, uCopyAmt: { value: 0 }, uClear: { value: clearZone } }, vertexShader: vertSphere, fragmentShader: fragSphere,
        glslVersion: GLSL3, ...blend, transparent: true, depthTest: false, depthWrite: false, side: BackSide,
      });
      const g = new SphereGeometry(r, 64, 40);
      const mesh = new Mesh(g, mat);
      mesh.frustumCulled = false;
      mesh.renderOrder = order;
      mesh.visible = false;
      layerScene.add(mesh);
      owned.push(tex, mat, g);
      upQueue.push(tex);
      return [mesh, mat];
    };
    [far, farMat] = sphere(farTex, b.shell.farRadius, 10);
    [shell, shellMat] = sphere(shellTex, b.shell.radius, 11);
    bubbleReady = true;
    opts.onReady?.();
  }

  const start = (): void => {
    if (disposed) return;
    t0 = performance.now();
    load().catch(() => { /* stay on the live volume */ });
  };
  // after the hero has painted: next idle slot, but not later than 1.2 s
  const ric = (window as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
  const startTimer = window.setTimeout(() => (ric ? ric(start, { timeout: 1200 }) : start()), 400);

  let ramp = 0;
  let sig = '';
  const tmp = new Vector3();
  out.update = (camera, p) => {
    const { pp, m } = p;
    // envelopes: the planes through the hero and the comet's arrival, the bubble from the ignition until the burst blows it away
    const apE = approachReady ? 1 - ss(0.17, 0.27, pp) : 0;
    const blow = ss(M.burst[0], M.burst[1], m);
    const buE = bubbleReady ? ss(0.535, 0.62, pp) * (1 - blow) : 0;
    ramp = approachReady || bubbleReady ? Math.min(1, ramp + 0.04) : 0; // fade the whole thing in over ~0.6 s once loaded (and it re-fades if still)
    const k = ramp < 1 && !renderer.xr?.isPresenting ? ss(0, 1, ramp) : 1;
    out.cover = Math.max(apE, buE) * k;
    const on = out.cover > 0.002;
    quad.visible = on;
    if (!on) return;
    const up = upQueue.shift();
    if (up) renderer.initTexture(up);
    // approach planes: fade by distance to the plane along the hero axis, so none can fill the screen as a flat card
    const cs = heroPos.clone();
    for (const pl of planes) {
      tmp.copy(pl.mesh.position).sub(camera.position);
      const d = tmp.dot(heroFwd);
      pl.mat.uniforms.uFade.value = apE * k * ss(1.2, 4.5, d);
      pl.mesh.visible = pl.mat.uniforms.uFade.value > 0.002;
    }
    void cs;
    if (Math.abs(camera.aspect - aspectKey) > 1e-3) placePlanes(camera.aspect);
    // bubble: Opus is the origin; it swells out and fades across the burst (blow-away)
    const bs = 1 + 0.7 * blow;
    if (far && shell && farMat && shellMat) {
      const f = buE * k;
      far.visible = f > 0.002;
      shell.visible = far.visible;
      // the cube was rendered from Opus: keep the camera inside the spheres (from outside it would read as a hollow ball)
      const inside = Math.max(1, (camera.position.length() * 1.25) / manifest!.bubble.shell.farRadius);
      far.scale.setScalar(bs * inside);
      shell.scale.setScalar((1 + 0.9 * blow) * inside);
      // a dim, distant remnant behind the nursery (~0.15 of the hero's brightness), not a backdrop that competes with it
      farMat.uniforms.uFade.value = f * BUBBLE_GAIN.far;
      shellMat.uniforms.uFade.value = f * BUBBLE_GAIN.shell;
      tmp.set(0, 0, 0).project(camera);
      clearZone.x = tmp.x;
      clearZone.y = tmp.y;
      for (const m of [farMat, shellMat]) {
        m.uniforms.uCopyAmt.value = p.copyAmt;
        m.uniforms.uCopyMask.value.copy(p.copyMask);
      }
    }
    // pointless to redraw when nothing moved
    const e = camera.matrixWorld.elements;
    const s = `${e.map((v) => v.toFixed(4)).join()}|${camera.fov}|${camera.aspect}|${apE.toFixed(3)}|${buE.toFixed(3)}|${k.toFixed(3)}|${blow.toFixed(3)}|${p.copyAmt.toFixed(3)}|${rt.width}`;
    comp.uniforms.uExp.value = p.exposure;
    comp.uniforms.uCopyAmt.value = p.copyAmt;
    comp.uniforms.uCopyMask.value.copy(p.copyMask);
    if (s === sig) return;
    sig = s;
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(rt);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, false, false);
    renderer.render(layerScene, camera);
    renderer.setRenderTarget(prev);
  };
  out.resize = (w, h) => {
    const sc = Math.min(1, 2560 / w) * (tier === 'low' ? 0.7 : tier === 'medium' ? 0.85 : 1);
    rt.setSize(Math.max(2, Math.round(w * sc)), Math.max(2, Math.round(h * sc)));
    rtRes.set(rt.width, rt.height);
    sig = '';
  };
  out.dispose = () => {
    disposed = true;
    clearTimeout(startTimer);
    for (const o of owned) o.dispose();
  };
  Object.defineProperty(out, 'ready', { get: () => approachReady });
  void t0;
  void NoBlending;
  return out;
}
