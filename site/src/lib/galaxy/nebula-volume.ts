// The emission nebula as a real volume: a full-screen pass rebuilds each pixel's world ray and ray-marches a procedural 3D
// density field (the LOBES layout from generator.ts, domain-warped and stretched toward the knot into filaments and
// pillars, dark dust lanes as absorbing density, teal/amber emission per lobe with a violet rim, a bright ionisation
// front facing the star). Rendered at reduced resolution into a render target, then composited premultiplied before
// the stars-and-planets pass, so dust darkens the deep field behind it; a separable Gaussian (horizontal pass into a second target, vertical in the
// composite) averages the structured step jitter away.
// After ignition the star carves a cavity (density removed inside uCavR, a lit wall at its edge). No assets, no sprites.
import {
  BufferAttribute, BufferGeometry, CustomBlending, GLSL3, HalfFloatType, LinearFilter, Matrix3, Matrix4, Mesh,
  NoBlending, Object3D, OneFactor, OneMinusSrcAlphaFactor, OrthographicCamera, Scene, ShaderMaterial,
  UnsignedByteType, Vector2, Vector3, Vector4, WebGLRenderTarget,
} from 'three';
import type { PerspectiveCamera, WebGLRenderer } from 'three';
import { KNOT_R, LOBES, NEBULA_R, RIM } from './generator.ts';
import { PALETTE, type Tier } from './shared.ts';

/** Per tier: ray steps, noise octaves, render-target scale against the drawing buffer. */
const QUALITY = {
  high: { steps: 40, octaves: 4, scale: 0.5 },
  medium: { steps: 24, octaves: 3, scale: 0.5 },
  low: { steps: 12, octaves: 2, scale: 0.25 },
} as const;

export interface VolumeParams {
  time: number; // idle clock in seconds (0 = static field)
  gain: number; // overall emission
  cavR: number; // world radius of the star-carved bubble (0 = none)
  collapse: number; // 0..1: the knot contracts to a point and brightens (ignition)
  knot: number; // 0..1: knot brightness
  copyAmt: number; // 0..1: dim the copy column
  copyMask: Vector4; // NDC ellipse cx, cy, rx, ry
  /** Star-forming knots (density pockets of the same gas, integrated in closed form): per star three vec4s.
   *  p = position + glow 0..1 (pulse included), c = tint + ignition 0..1, a = bipolar axis + cocoon build 0..1. */
  knots?: { n: number; p: Vector4[]; c: Vector4[]; a: Vector4[]; gain: number };
}

/** Most knots the shader carries (a story with more workers shows the first MAX_KNOTS). */
export const MAX_KNOTS = 24;

export interface NebulaVolume {
  /** Composite quad: add to the scene. */
  object3d: Object3D;
  /** Re-march into the target when the view or params changed since the last call. */
  render(renderer: WebGLRenderer, camera: PerspectiveCamera, p: VolumeParams): void;
  resize(drawW: number, drawH: number): void;
  dispose(): void;
}

const vec3 = (c: readonly number[]): string => `vec3(${c.map((v) => v.toFixed(4)).join(', ')})`;
const lobeConsts = (): string => `
const vec3 LC[${LOBES.length}] = vec3[${LOBES.length}](${LOBES.map((l) => vec3(l.c)).join(', ')});
const vec3 LS[${LOBES.length}] = vec3[${LOBES.length}](${LOBES.map((l) => vec3(l.s)).join(', ')});
const float LM[${LOBES.length}] = float[${LOBES.length}](${LOBES.map((l) => l.m.toFixed(3)).join(', ')});
const float KNOT_R = ${KNOT_R.toFixed(3)};
const float NEB_R = ${(NEBULA_R * 1.15).toFixed(3)};
const vec3 RIMC = ${vec3(RIM)};
`;

const vert = /* glsl */ `
uniform mat4 uInvProj;
uniform mat3 uCamRot;
out vec3 vDir;
void main() {
  vec4 v = uInvProj * vec4(position.xy, 1.0, 1.0);
  vDir = uCamRot * (v.xyz / v.w);
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const marchFrag = /* glsl */ `
precision highp float;
precision highp int;
uniform vec3 uCamPos;
uniform float uTime;
uniform float uGain;
uniform float uCavR;
uniform float uCollapse;
uniform float uKnot;
uniform int uSteps;
uniform int uOct;
uniform vec3 uTeal;
uniform vec3 uAmber;
uniform vec4 uKp[${MAX_KNOTS}];
uniform vec4 uKc[${MAX_KNOTS}];
uniform vec4 uKa[${MAX_KNOTS}];
uniform int uKn;
uniform float uKGain;
in vec3 vDir;
out vec4 outColor;
${lobeConsts()}

float hash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float noise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  return mix(
    mix(mix(hash(i), hash(i + vec3(1, 0, 0)), f.x), mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x), mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y),
    f.z);
}
float fbm(vec3 p) {
  float s = 0.0;
  float a = 0.5;
  float n = 0.0;
  for (int i = 0; i < 4; i++) {
    if (i >= uOct) break;
    s += a * noise(p);
    n += a;
    p = p * 2.07 + vec3(11.7, 3.1, 7.3);
    a *= 0.5;
  }
  return s / n;
}
// per-pixel offset for the ray start: interleaved gradient noise (Jimenez), a low-discrepancy pattern whose error is
// mostly high-frequency, so the separable Gaussian below removes it instead of aliasing it into a visible texture
float ign(vec2 px) { return fract(52.9829189 * fract(dot(px, vec2(0.06711056, 0.00583715)))); }

// Line integral of an anisotropic gaussian density blob along the ray o + t rd, in closed form (no marching, so no step
// noise on a feature smaller than a step). Frame (e1, e2, ax), sigmas sg. tc = the ray parameter of the closest approach.
float blob(vec3 o, vec3 rd, vec3 c, vec3 e1, vec3 e2, vec3 ax, vec3 sg, out float tc) {
  vec3 q = o - c;
  vec3 g = vec3(dot(q, e1), dot(q, e2), dot(q, ax)) / sg;
  vec3 v = vec3(dot(rd, e1), dot(rd, e2), dot(rd, ax)) / sg;
  float vv = dot(v, v);
  tc = -dot(g, v) / vv;
  float m2 = dot(g, g) - dot(g, v) * dot(g, v) / vv;
  return 2.5066283 * inversesqrt(vv) * exp(-0.5 * m2) * step(0.0, tc);
}

void main() {
  vec3 rd = normalize(vDir);
  // ray against the bounding sphere of the nebula
  float b = dot(uCamPos, rd);
  float c = dot(uCamPos, uCamPos) - NEB_R * NEB_R;
  float disc = b * b - c;
  vec3 kcol = vec3(0.0);
  vec3 kdrift = vec3(uTime * 0.018, uTime * 0.007, uTime * 0.012);
  for (int k = 0; k < ${MAX_KNOTS}; k++) {
    if (k >= uKn) break;
    vec4 kp = uKp[k];
    vec4 kc = uKc[k];
    vec4 ka = uKa[k];
    if (kp.w < 0.002 && kc.w < 0.002) continue;
    float ign = kc.w;
    float built = ka.w;
    vec3 ax = normalize(ka.xyz);
    vec3 e1 = normalize(cross(ax, abs(ax.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
    vec3 e2 = cross(ax, e1);
    // the cocoon: a compact pocket that swells a little when its star lights it, then thins as the star builds
    float R = 0.15 + 0.05 * ign + 0.03 * built;
    float tc;
    float body = blob(uCamPos, rd, kp.xyz, e1, e2, ax, vec3(R, R, R * 1.15), tc);
    vec3 pc = uCamPos + rd * tc;
    float mod1 = 0.82 + 0.36 * noise(pc * 2.1 + float(k) * 7.3 + kdrift * 3.0);
    // bipolar clearing along the axis: the jets carve a narrow hourglass through the cocoon
    float tc2;
    float hole = blob(uCamPos, rd, kp.xyz, e1, e2, ax, vec3(0.04 + 0.05 * R, 0.04 + 0.05 * R, R * 1.9), tc2);
    float dens = max(body * mod1 - hole * 0.95 * built, 0.0);
    float tc3;
    float core = blob(uCamPos, rd, kp.xyz, e1, e2, ax, vec3(R * 0.38), tc3);
    vec3 dust = vec3(0.86, 0.7, 1.0);
    vec3 lit = mix(dust, mix(kc.rgb, vec3(1.0), 0.28), 0.62 * ign);
    float glow = kp.w * (1.0 - 0.45 * ign) + 1.4 * ign * (1.0 - 0.5 * built);
    kcol += lit * dens * glow + mix(lit, vec3(1.0), 0.45) * core * (0.45 * kp.w + 0.9 * ign);
  }
  kcol *= uKGain;
  if (disc <= 0.0) { outColor = vec4(kcol, 0.0); return; }
  float sq = sqrt(disc);
  float t0 = max(0.0, -b - sq);
  float t1 = -b + sq;
  if (t1 <= t0) { outColor = vec4(kcol, 0.0); return; }
  float dt = (t1 - t0) / float(uSteps);
  float t = t0 + dt * ign(gl_FragCoord.xy);
  vec3 drift = vec3(uTime * 0.018, uTime * 0.007, uTime * 0.012);

  vec3 acc = vec3(0.0);
  float T = 1.0;
  float kr = KNOT_R * (1.0 - 0.86 * uCollapse);
  for (int i = 0; i < 64; i++) {
    if (i >= uSteps) break;
    vec3 p = uCamPos + rd * t;
    t += dt;
    float r = length(p);
    // the gas lobes: gaussian envelope on a warped position, so the boundary is billowy, never an ellipsoid
    vec3 w = vec3(noise(p * 0.42 + drift + 3.0), noise(p * 0.42 - drift + 17.0), noise(p * 0.42 + drift * 0.5 + 41.0)) - 0.5;
    vec3 pw = p + w * 3.2;
    float env = 0.0;
    float hue = 0.0;
    for (int k = 0; k < ${LOBES.length}; k++) {
      vec3 d = (pw - LC[k]) / LS[k];
      float g = exp(-0.5 * dot(d, d));
      env += g;
      hue += g * LM[k];
    }
    float em = 0.0;
    float sig = 0.0;
    vec3 col = vec3(0.0);
    if (env > 0.015) {
      hue /= env;
      // pillars: stretch the noise domain along the direction to the star, so structure streams toward it
      vec3 rdir = p / max(r, 0.05);
      vec3 q = pw - rdir * dot(pw, rdir) * 0.5;
      float f1 = fbm(q * 1.15 + drift);
      float f2 = fbm(q * 2.3 + 9.0 - drift);
      float rid = pow(1.0 - abs(2.0 * f2 - 1.0), 3.0);
      float gas = env * (0.1 + 1.5 * smoothstep(0.4, 0.74, f1) + 0.9 * rid * smoothstep(0.2, 0.6, f1));
      // dark dust: sheets and lanes in the thick gas
      float lane = pow(1.0 - abs(2.0 * noise(q * 0.85 + 53.0) - 1.0), 7.0);
      float dust = (smoothstep(0.56, 0.78, fbm(q * 0.9 + 31.0)) * 1.4 + lane * 1.8) * smoothstep(0.15, 0.7, env);
      // the carved cavity: no gas inside, a lit wall at its edge
      float cav = smoothstep(uCavR * 0.72, uCavR * 1.22 + 0.001, r);
      float wall = uCavR > 0.01 ? exp(-pow((r - uCavR - 0.35) / 0.9, 2.0)) : 0.0;
      gas *= cav;
      dust *= cav;
      // star light: strong near the star, an ionisation front on the side facing it
      float lit = 1.0 / (1.0 + pow(r / 2.4, 2.0));
      float bell = smoothstep(0.25, 0.5, hue) * (1.0 - smoothstep(0.5, 0.75, hue));
      vec3 base = mix(mix(uTeal, uAmber, hue), RIMC, 0.75 * bell);
      float rimK = 1.0 - smoothstep(0.08, 0.7, env);
      base = mix(base, RIMC, 0.5 * rimK);
      base = mix(base, vec3(0.9, 0.97, 1.0), 0.3 * lit + 0.25 * wall);
      em = gas * (0.5 + 1.2 * lit + 2.8 * wall) + gas * gas * 0.6 * (lit + wall);
      col = base * em;
      sig = gas * 0.35 + dust * 1.6;
    }
    // the knot: a compact bright star-forming core that contracts to a point at ignition
    float kn = exp(-0.5 * (r * r) / (kr * kr)) * uKnot * (3.2 + 14.0 * uCollapse) * (kr / KNOT_R);
    col += kn * mix(vec3(0.85, 0.7, 1.0), vec3(1.0, 0.97, 0.95), uCollapse);
    acc += T * col * dt;
    T *= exp(-sig * dt);
  }
  outColor = vec4(acc * uGain + kcol, 1.0 - T);
}
`;

// separable Gaussian, 13 taps per pass: horizontal here (march target -> blur target), vertical in the composite
const blurHFrag = /* glsl */ `
precision highp float;
uniform sampler2D tVol;
uniform vec2 uTexel;
uniform float uSigma;
in vec2 vUv;
out vec4 outColor;
void main() {
  vec4 s = vec4(0.0);
  float wsum = 0.0;
  for (int i = -6; i <= 6; i++) {
    float w = exp(-0.5 * float(i * i) / (uSigma * uSigma));
    s += w * texture(tVol, vUv + vec2(float(i) * uTexel.x, 0.0));
    wsum += w;
  }
  outColor = s / wsum;
}
`;

const compFrag = /* glsl */ `
precision highp float;
uniform sampler2D tVol;
uniform vec2 uTexel;
uniform float uSigma;
uniform float uCopyAmt;
uniform vec4 uCopyMask;
in vec2 vUv;
in vec2 vNdc;
out vec4 outColor;
void main() {
  vec4 s = vec4(0.0);
  float wsum = 0.0;
  for (int i = -6; i <= 6; i++) {
    float w = exp(-0.5 * float(i * i) / (uSigma * uSigma));
    s += w * texture(tVol, vUv + vec2(0.0, float(i) * uTexel.y));
    wsum += w;
  }
  s /= wsum;
  if (uCopyMask.z > 0.0) {
    vec2 e = (vNdc - uCopyMask.xy) / uCopyMask.zw;
    s.rgb *= mix(1.0, mix(0.12, 1.0, smoothstep(0.6, 1.2, length(e))), uCopyAmt);
  }
  float dn = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) - 0.5;
  s.rgb = max(s.rgb + dn * 0.0015 * smoothstep(0.0, 0.01, max(s.r, max(s.g, s.b))), 0.0);
  outColor = s;
}
`;

const compVert = /* glsl */ `
out vec2 vUv;
out vec2 vNdc;
void main() {
  vNdc = position.xy;
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 1.0, 1.0);
}
`;

export function createNebulaVolume(tier: Tier, renderer: WebGLRenderer): NebulaVolume {
  const q = QUALITY[tier];
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  const half = renderer.extensions.has('EXT_color_buffer_float') || renderer.extensions.has('EXT_color_buffer_half_float');
  const rtOpts = {
    type: half ? HalfFloatType : UnsignedByteType, depthBuffer: false, stencilBuffer: false,
    minFilter: LinearFilter, magFilter: LinearFilter, generateMipmaps: false,
  } as const;
  const rt = new WebGLRenderTarget(2, 2, rtOpts); // the march
  const rtB = new WebGLRenderTarget(2, 2, rtOpts); // after the horizontal blur
  const sigma = tier === 'low' ? 1.3 : 1.7; // texels
  const march = new ShaderMaterial({
    uniforms: {
      uInvProj: { value: new Matrix4() }, uCamRot: { value: new Matrix3() }, uCamPos: { value: new Vector3() },
      uKp: { value: Array.from({ length: MAX_KNOTS }, () => new Vector4()) },
      uKc: { value: Array.from({ length: MAX_KNOTS }, () => new Vector4()) },
      uKa: { value: Array.from({ length: MAX_KNOTS }, () => new Vector4(0, 1, 0, 0)) },
      uKn: { value: 0 }, uKGain: { value: 0 },
      uTime: { value: 0 }, uGain: { value: 0 }, uCavR: { value: 0 }, uCollapse: { value: 0 }, uKnot: { value: 1 },
      uSteps: { value: q.steps }, uOct: { value: q.octaves },
      uTeal: { value: PALETTE.opencode }, uAmber: { value: PALETTE.agy },
    },
    vertexShader: vert, fragmentShader: marchFrag, glslVersion: GLSL3,
    blending: NoBlending, depthTest: false, depthWrite: false,
  });
  const marchMesh = new Mesh(geo, march);
  marchMesh.frustumCulled = false;
  const marchScene = new Scene();
  marchScene.add(marchMesh);
  const dummyCam = new OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const blurH = new ShaderMaterial({
    uniforms: { tVol: { value: rt.texture }, uTexel: { value: new Vector2(1, 1) }, uSigma: { value: sigma } },
    vertexShader: compVert, fragmentShader: blurHFrag, glslVersion: GLSL3,
    blending: NoBlending, depthTest: false, depthWrite: false,
  });
  const blurScene = new Scene();
  const blurMesh = new Mesh(geo, blurH);
  blurMesh.frustumCulled = false;
  blurScene.add(blurMesh);

  const comp = new ShaderMaterial({
    uniforms: { tVol: { value: rtB.texture }, uTexel: { value: new Vector2(1, 1) }, uSigma: { value: sigma }, uCopyAmt: { value: 0 }, uCopyMask: { value: new Vector4() } },
    vertexShader: compVert, fragmentShader: compFrag, glslVersion: GLSL3,
    transparent: true, blending: CustomBlending, blendSrc: OneFactor, blendDst: OneMinusSrcAlphaFactor,
    depthTest: false, depthWrite: false,
  });
  const quad = new Mesh(geo, comp);
  quad.frustumCulled = false;
  quad.renderOrder = 0.5; // after the deep-field shells (dust darkens them), before the planets, rings and fx

  let sig = '';
  return {
    object3d: quad,
    render(rend, camera, p) {
      const kn = p.knots;
      const on = p.gain > 0.001 || (kn !== undefined && kn.n > 0 && kn.gain > 0.001);
      quad.visible = on;
      if (!on) return;
      comp.uniforms.uCopyAmt.value = p.copyAmt;
      comp.uniforms.uCopyMask.value.copy(p.copyMask);
      const u = march.uniforms;
      // the low tier freezes the idle drift so an unchanged view is never re-marched
      const time = tier === 'low' ? 0 : p.time;
      const e = camera.matrixWorld.elements;
      const s = `${e[12].toFixed(4)},${e[13].toFixed(4)},${e[14].toFixed(4)},${e[0].toFixed(4)},${e[1].toFixed(4)},${e[2].toFixed(4)},${e[4].toFixed(4)},${e[5].toFixed(4)},${e[6].toFixed(4)},${camera.fov},${camera.aspect},${time.toFixed(3)},${p.gain.toFixed(4)},${p.cavR.toFixed(4)},${p.collapse.toFixed(4)},${p.knot.toFixed(4)}`
        + (kn ? `|${kn.n},${kn.gain.toFixed(4)},${kn.p.slice(0, kn.n).map((v, i) => `${v.x.toFixed(3)},${v.y.toFixed(3)},${v.z.toFixed(3)},${v.w.toFixed(3)},${kn.c[i].w.toFixed(3)},${kn.a[i].w.toFixed(3)}`).join(';')}` : '');
      if (s === sig) return;
      sig = s;
      u.uCamRot.value.setFromMatrix4(camera.matrixWorld);
      u.uInvProj.value.copy(camera.projectionMatrixInverse);
      u.uCamPos.value.setFromMatrixPosition(camera.matrixWorld);
      u.uTime.value = time;
      u.uGain.value = p.gain;
      u.uCavR.value = p.cavR;
      u.uCollapse.value = p.collapse;
      u.uKnot.value = p.knot;
      const kn2 = p.knots;
      const nk = kn2 ? Math.min(kn2.n, MAX_KNOTS) : 0;
      u.uKn.value = nk;
      u.uKGain.value = kn2 ? kn2.gain : 0;
      for (let i = 0; i < nk; i++) {
        (u.uKp.value as Vector4[])[i].copy(kn2!.p[i]);
        (u.uKc.value as Vector4[])[i].copy(kn2!.c[i]);
        (u.uKa.value as Vector4[])[i].copy(kn2!.a[i]);
      }
      const prev = rend.getRenderTarget();
      rend.setRenderTarget(rt);
      rend.render(marchScene, dummyCam);
      rend.setRenderTarget(rtB);
      rend.render(blurScene, dummyCam);
      rend.setRenderTarget(prev);
    },
    resize(w, h) {
      const rw = Math.max(2, Math.round(w * q.scale));
      const rh = Math.max(2, Math.round(h * q.scale));
      rt.setSize(rw, rh);
      rtB.setSize(rw, rh);
      blurH.uniforms.uTexel.value.set(1 / rw, 1 / rh);
      comp.uniforms.uTexel.value.set(1 / rw, 1 / rh);
      sig = '';
    },
    dispose() {
      geo.dispose();
      march.dispose();
      blurH.dispose();
      comp.dispose();
      rt.dispose();
      rtB.dispose();
    },
  };
}
