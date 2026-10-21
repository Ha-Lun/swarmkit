// The emission nebula as a real volume, baked once and marched cheaply at (near) full resolution.
// BAKE (once, GPU, spread over a few frames after load): the LOBES layout from generator.ts, double domain-warped, with
// 7-8 octave ridged multifractal filaments/pillars stretched toward the knot and dark dust lanes, written slice by slice
// into a 3D texture (RGBA8: sqrt gas, dust, palette mix, violet fraction).
// MARCH: a full-screen pass rebuilds each pixel's world ray and takes one trilinear fetch per step (Beer-Lambert absorption,
// emission ~ density^2, an ionisation front facing the star, a forward single-scatter term). Deterministic: fixed step start, no
// per-pixel jitter, no blur, so one pass per view change and nothing to converge. Bicubic upsample in the composite.
// The result is composited premultiplied before the stars-and-planets pass, so dust darkens the deep field behind it.
// After ignition the star carves a cavity (density removed inside uCavR, a lit wall at its edge). No assets, no sprites.
// Round K: the hero and the plan beats are the pre-rendered layers and bubble cube (nebula-layers.ts). This volume only runs for the
// dive and the ignition (and as the fallback while those images load): a cheap march, no spike stars. Outside that window it
// skips the march (vol = 0) and only draws the star-forming knots and cocoons, which are analytic.
import {
  BufferAttribute, BufferGeometry, ClampToEdgeWrapping, CustomBlending, GLSL3, Group, HalfFloatType,
  LinearFilter, Matrix3, Matrix4, Mesh, NoBlending, OneFactor, OneMinusSrcAlphaFactor, OrthographicCamera, Scene,
  ShaderMaterial, UnsignedByteType, Vector2, Vector3, Vector4, WebGL3DRenderTarget, WebGLRenderTarget,
} from 'three';
import type { Object3D, PerspectiveCamera, WebGLRenderer } from 'three';
import { KNOT_R, LOBES, RIM } from './generator.ts';
import { PALETTE, type Tier } from './shared.ts';

/** Per tier: ray steps, baked volume size, bake slices per frame, and a scale on the drawing buffer (the march target; 1 = full
 *  resolution). */
/** Highest pixel ratio the march target follows on the high tier (the others use the drawing buffer as is). */
const HIGH_DPR_CAP = 1.25;
const QUALITY = {
  high: { steps: 96, vol: 160, slices: 10, scale: 0.66 },
  medium: { steps: 96, vol: 128, slices: 8, scale: 0.55 },
  low: { steps: 64, vol: 128, slices: 6, scale: 0.5 },
} as const;
/** Half extent of the baked cube in world units (the lobes end within ~8.9 of the origin). */
const VH = 9;

export interface VolumeParams {
  gain: number; // overall emission
  vol: number; // 0..1 how much of the gas is marched (0 = knots and cocoons only, no bake, no march)
  cavR: number; // world radius of the star-carved bubble (0 = none)
  collapse: number; // 0..1: the knot contracts to a point and brightens (ignition)
  knot: number; // 0..1: knot brightness
  copyAmt: number; // 0..1: dim the copy column
  wall?: number; // 0..1: Opus lights the bubble walls (a gentle ramp of the cavity-wall emission; 0 = as carved)
  copyMask: Vector4; // NDC ellipse cx, cy, rx, ry
  /** Render one frame (reduced motion): bake every slice in this call instead of over the next frames. */
  still?: boolean;
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
const float VH = ${VH.toFixed(1)};
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


const NOISE = /* glsl */ `
// integer lattice hash (pcg3d, Jarzynski & Olano): the old product-of-fract hash correlated along the lattice axes, which
// showed up as long vertical streaks in the gas
float hash(vec3 p) {
  uvec3 v = uvec3(ivec3(floor(p)) + 32768) * 1664525u + 1013904223u;
  v.x += v.y * v.z;
  v.y += v.z * v.x;
  v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z;
  v.y += v.z * v.x;
  v.z += v.x * v.y;
  return float(v.x >> 8u) * (1.0 / 16777216.0);
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
`;

// the bake: one 2D slice of the 3D texture per draw. Octaves stop at the voxel Nyquist (cycles per world unit = vol / (2 VH) / 2,
// about 4.5 at 160^3): finer octaves would only be white noise frozen into the voxels (a hatch after trilinear filtering);
// the finer structure is the live edge detail in the march, whose jittered steps integrate it.
const bakeFrag = /* glsl */ `
precision highp float;
uniform float uZ;
in vec2 vUv;
out vec4 outColor;
${lobeConsts()}
${NOISE}
const mat3 ROT = mat3(0.00, 0.80, 0.60, -0.80, 0.36, -0.48, -0.60, -0.48, 0.64);
float fbm(vec3 p, int oct) {
  float s = 0.0;
  float a = 0.5;
  float n = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= oct) break;
    s += a * noise(p);
    n += a;
    p = ROT * p * 2.03 + vec3(11.7, 3.1, 7.3);
    a *= 0.5;
  }
  return s / n;
}
// ridged multifractal: thin bright ridges (filaments), each octave weighted by the last so detail gathers on the ridges
float ridged(vec3 p, int oct) {
  float s = 0.0;
  float a = 0.55;
  float n = 0.0;
  float w = 1.0;
  for (int i = 0; i < 8; i++) {
    if (i >= oct) break;
    float r = 1.0 - abs(2.0 * noise(p) - 1.0);
    r *= r;
    s += a * r * w;
    n += a;
    w = clamp(r * 2.0, 0.0, 1.0);
    p = ROT * p * 2.1 + vec3(5.3, 9.1, 2.7);
    a *= 0.52;
  }
  return s / n;
}
void main() {
  vec3 p = (vec3(vUv, uZ) * 2.0 - 1.0) * VH;
  float r = length(p);
  // the gas lobes: gaussian envelope on a warped position, so the boundary is billowy, never an ellipsoid
  vec3 w = vec3(noise(p * 0.42 + 3.0), noise(p * 0.42 + 17.0), noise(p * 0.42 + 41.0)) - 0.5;
  vec3 pw = p + w * 3.2;
  float env = 0.0;
  float hue = 0.0;
  for (int k = 0; k < ${LOBES.length}; k++) {
    vec3 d = (pw - LC[k]) / LS[k];
    float g = exp(-0.5 * dot(d, d));
    env += g;
    hue += g * LM[k];
  }
  if (env < 0.015) { outColor = vec4(0.0); return; }
  hue /= env;
  // second, finer warp: curls the filaments
  vec3 w2 = vec3(fbm(pw * 1.3 + 5.0, 3), fbm(pw * 1.3 + 23.0, 3), fbm(pw * 1.3 + 61.0, 3)) - 0.5;
  vec3 pw2 = pw + w2 * 1.1;
  // pillars: stretch the noise domain along the direction to the star, so structure streams toward it
  // (a gentle stretch along a direction that is itself warped, so the streaks fan and curl instead of running parallel;
  // the ridge domain is rotated so no octave lines up with a view axis)
  vec3 rdir = normalize(p / max(r, 0.05) + w2 * 2.6 + 1e-4);
  vec3 q = pw2 - rdir * dot(pw2, rdir) * 0.14;
  float f1 = fbm(q * 1.15, 3);
  float fil = smoothstep(0.22, 0.75, ridged(ROT * q * 1.5 + 9.0, 4));
  float det = fbm(q * 2.6 + 13.0, 2);
  float gas = env * (0.1 + 1.5 * smoothstep(0.4, 0.74, f1) * (0.45 + 0.95 * fil) + 0.9 * fil * smoothstep(0.2, 0.6, f1));
  gas *= 0.3 + 1.5 * det * det * 1.6 * 0.8;
  // dark dust: sheets and razor lanes in the thick gas
  float lane = pow(1.0 - abs(2.0 * noise(q * 0.85 + 53.0) - 1.0), 7.0);
  float lane2 = pow(1.0 - abs(2.0 * fbm(q * 2.2 + 77.0, 2) - 1.0), 6.0);
  float dust = (smoothstep(0.56, 0.78, fbm(q * 0.9 + 31.0, 3)) * 1.4 + lane * 1.8 + lane2 * 0.9 * smoothstep(0.4, 0.7, f1)) * smoothstep(0.15, 0.7, env);
  float bell = smoothstep(0.25, 0.5, hue) * (1.0 - smoothstep(0.5, 0.75, hue));
  float rimK = 1.0 - smoothstep(0.08, 0.7, env);
  float vio = 1.0 - (1.0 - 0.75 * bell) * (1.0 - 0.5 * rimK);
  outColor = vec4(sqrt(clamp(gas * 0.25, 0.0, 1.0)), clamp(dust * 0.25, 0.0, 1.0), hue, vio);
}
`;

const marchFrag = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler3D;
uniform sampler3D uVol;
uniform float uBaked;
uniform vec3 uCamPos;
uniform float uGain;
uniform float uCavR;
uniform float uCollapse;
uniform float uKnot;
uniform int uSteps;
uniform vec3 uTeal;
uniform vec3 uAmber;
uniform vec4 uKp[${MAX_KNOTS}];
uniform vec4 uKc[${MAX_KNOTS}];
uniform vec4 uKa[${MAX_KNOTS}];
uniform int uKn;
uniform float uKGain;
uniform float uWall;
in vec3 vDir;
out vec4 outColor;
${lobeConsts()}
${NOISE}

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

vec4 shade() {
  vec3 rd = normalize(vDir);
  vec3 kcol = vec3(0.0);
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
    float mod1 = 0.82 + 0.36 * noise(pc * 2.1 + float(k) * 7.3);
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
  if (uBaked < 0.001) return vec4(kcol, 0.0);
  // ray against the baked cube
  vec3 inv = 1.0 / (rd + vec3(1e-6));
  vec3 ta = (-vec3(VH) - uCamPos) * inv;
  vec3 tb = (vec3(VH) - uCamPos) * inv;
  vec3 tn = min(ta, tb);
  vec3 tf = max(ta, tb);
  float t0 = max(max(max(tn.x, tn.y), tn.z), 0.0);
  float t1 = min(min(tf.x, tf.y), tf.z);
  if (t1 <= t0) return vec4(kcol, 0.0);
  float dt = (t1 - t0) / float(uSteps);
  float t = t0 + dt * 0.5;
  float invV = 0.5 / VH;

  vec3 acc = vec3(0.0);
  float T = 1.0;
  float kr = KNOT_R * (1.0 - 0.86 * uCollapse);
  for (int i = 0; i < 128; i++) {
    if (i >= uSteps) break;
    vec3 p = uCamPos + rd * t;
    t += dt;
    float r = length(p);
    vec4 s = texture(uVol, p * invV + 0.5);
    float gB = s.r * s.r * 4.0 * uBaked;
    float g = gB;
    float du = s.g * 4.0 * uBaked;
    vec3 col = vec3(0.0);
    float sig = 0.0;
    if (g > 0.004 || du > 0.01) {
      // the carved cavity: no gas inside, a lit wall at its edge
      float cav = smoothstep(uCavR * 0.72, uCavR * 1.22 + 0.001, r);
      float wall = uCavR > 0.01 ? exp(-pow((r - uCavR - 0.35) / 0.9, 2.0)) : 0.0;
      g *= cav;
      du *= cav;
      // star light: strong near the star, an ionisation front on the side facing it
      float lit = 1.0 / (1.0 + pow(r / 2.4, 2.0));
      vec3 base = mix(mix(uTeal, uAmber, s.b), RIMC, s.a);
      base = mix(base, vec3(0.9, 0.97, 1.0), 0.3 * lit + 0.25 * wall);
      float front = 0.0;
      float scat = 0.0;
      if (g > 0.03 && r > 0.3) {
        vec3 dir = p / r;
        vec4 sS = texture(uVol, (p - dir * 0.5) * invV + 0.5);
        front = clamp((gB - sS.r * sS.r * 4.0 * uBaked) * 1.6, 0.0, 1.0);
        // soft forward single scatter toward the camera: gas between the star and the eye glows
        float hg = 0.6975 / pow(1.3025 - 1.1 * dot(dir, -rd), 1.5);
        scat = hg * 0.12 / (1.0 + pow(r / 5.0, 2.0));
      }
      float em = g * (0.5 + 1.2 * lit + 2.8 * wall * (1.0 + 0.85 * uWall))
        + g * g * (0.28 + 0.9 * (lit + wall))
        + g * scat * 1.0
        + g * front * (0.5 + 1.6 * lit) * 0.8;
      col = base * em;
      sig = g * 0.35 + du * 3.4;
    }
    // the knot: a compact bright star-forming core that contracts to a point at ignition
    float kn = exp(-0.5 * (r * r) / (kr * kr)) * uKnot * (3.2 + 14.0 * uCollapse) * (kr / KNOT_R);
    col += kn * mix(vec3(0.85, 0.7, 1.0), vec3(1.0, 0.97, 0.95), uCollapse);
    acc += T * col * dt;
    T *= exp(-sig * dt);
    if (T < 0.015) break;
  }
  return vec4(acc * uGain + kcol, 1.0 - T);
}

void main() {
  outColor = shade();
}
`;

const compFrag = /* glsl */ `
precision highp float;
uniform sampler2D tVol;
uniform float uCopyAmt;
uniform vec4 uCopyMask;
in vec2 vUv;
in vec2 vNdc;
out vec4 outColor;
uniform vec2 uRes;
float lum(vec4 c) { return dot(c.rgb, vec3(0.3, 0.55, 0.15)); }
// Catmull-Rom bicubic upsample in 5 bilinear taps (Jimenez): sharper than bilinear, no ringing worth seeing on soft gas
vec4 bicubic(vec2 uv) {
  vec2 sp = uv * uRes;
  vec2 c = floor(sp - 0.5) + 0.5;
  vec2 f = sp - c;
  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  vec2 w3 = f * f * (-0.5 + 0.5 * f);
  vec2 s12 = w1 + w2;
  vec2 off12 = w2 / s12;
  vec2 t0 = (c - 1.0) / uRes;
  vec2 t3 = (c + 2.0) / uRes;
  vec2 t12 = (c + off12) / uRes;
  vec4 r = texture(tVol, vec2(t12.x, t0.y)) * (s12.x * w0.y)
    + texture(tVol, vec2(t0.x, t12.y)) * (w0.x * s12.y)
    + texture(tVol, t12) * (s12.x * s12.y)
    + texture(tVol, vec2(t3.x, t12.y)) * (w3.x * s12.y)
    + texture(tVol, vec2(t12.x, t3.y)) * (s12.x * w3.y);
  return max(r, vec4(0.0));
}
void main() {
  vec4 s = bicubic(vUv);
  if (uCopyMask.z > 0.0) {
    vec2 e = (vNdc - uCopyMask.xy) / uCopyMask.zw;
    s.rgb *= mix(1.0, mix(0.12, 1.0, smoothstep(0.6, 1.2, length(e))), uCopyAmt);
  }
  // filmic contrast: a toe that deepens the shadows and a lift in the mids and highlights
  s.rgb *= mix(0.8, 1.22, smoothstep(0.015, 0.5, lum(s)));
  float dn = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) - 0.5;
  s.rgb = max(s.rgb + dn * 0.0035 * smoothstep(0.0, 0.01, max(s.r, max(s.g, s.b))), 0.0);
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
  const rt = new WebGLRenderTarget(2, 2, rtOpts);
  // the baked volume
  const vol = new WebGL3DRenderTarget(q.vol, q.vol, q.vol, {
    type: UnsignedByteType, depthBuffer: false, stencilBuffer: false, minFilter: LinearFilter, magFilter: LinearFilter, generateMipmaps: false,
  });
  vol.texture.wrapS = vol.texture.wrapT = vol.texture.wrapR = ClampToEdgeWrapping;
  const dummyCam = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const bake = new ShaderMaterial({
    uniforms: { uZ: { value: 0 } },
    vertexShader: compVert, fragmentShader: bakeFrag, glslVersion: GLSL3,
    blending: NoBlending, depthTest: false, depthWrite: false,
  });
  const bakeMesh = new Mesh(geo, bake);
  bakeMesh.frustumCulled = false;
  const bakeScene = new Scene();
  bakeScene.add(bakeMesh);

  const march = new ShaderMaterial({
    uniforms: {
      uInvProj: { value: new Matrix4() }, uCamRot: { value: new Matrix3() }, uCamPos: { value: new Vector3() },
      uVol: { value: vol.texture }, uBaked: { value: 0 },
      uKp: { value: Array.from({ length: MAX_KNOTS }, () => new Vector4()) },
      uKc: { value: Array.from({ length: MAX_KNOTS }, () => new Vector4()) },
      uKa: { value: Array.from({ length: MAX_KNOTS }, () => new Vector4(0, 1, 0, 0)) },
      uKn: { value: 0 }, uKGain: { value: 0 }, uWall: { value: 0 },
      uGain: { value: 0 }, uCavR: { value: 0 }, uCollapse: { value: 0 }, uKnot: { value: 1 },
      uSteps: { value: q.steps },
      uTeal: { value: PALETTE.opencode }, uAmber: { value: PALETTE.agy },
    },
    vertexShader: vert, fragmentShader: marchFrag, glslVersion: GLSL3,
    blending: NoBlending, depthTest: false, depthWrite: false,
  });
  const marchMesh = new Mesh(geo, march);
  marchMesh.frustumCulled = false;
  const marchScene = new Scene();
  marchScene.add(marchMesh);

  const comp = new ShaderMaterial({
    uniforms: { tVol: { value: rt.texture }, uRes: { value: new Vector2(2, 2) }, uCopyAmt: { value: 0 }, uCopyMask: { value: new Vector4() } },
    vertexShader: compVert, fragmentShader: compFrag, glslVersion: GLSL3,
    transparent: true, blending: CustomBlending, blendSrc: OneFactor, blendDst: OneMinusSrcAlphaFactor,
    depthTest: false, depthWrite: false,
  });
  const quad = new Mesh(geo, comp);
  quad.frustumCulled = false;
  quad.renderOrder = 0.5; // after the deep-field shells (dust darkens them), before the planets, rings and fx

  const group = new Group();
  group.add(quad);

  const t0 = performance.now();
  let slice = 0; // next slice to bake
  let readyAt = 0; // performance.now() when the bake finished
  let nCalls = 0;
  let sig = '';
  function bakeChunk(rend: WebGLRenderer, n: number): void {
    const prev = rend.getRenderTarget();
    const end = Math.min(q.vol, slice + n);
    for (; slice < end; slice++) {
      bake.uniforms.uZ.value = (slice + 0.5) / q.vol;
      rend.setRenderTarget(vol, slice);
      rend.render(bakeScene, dummyCam);
    }
    rend.setRenderTarget(prev);
    if (slice >= q.vol) readyAt = performance.now();
  }
  return {
    object3d: group,
    render(rend, camera, p) {
      const kn = p.knots;
      const on = p.gain > 0.001 || (kn !== undefined && kn.n > 0 && kn.gain > 0.001);
      group.visible = on;
      if (!on) return;
      // bake after the DOM hero has painted (a few frames and 350 ms), a few slices per frame
      nCalls++;
      // (reduced motion draws on demand, not per frame: bake all at once and show it without a fade)
      if (p.vol > 0.002 && slice < q.vol && (p.still || (nCalls > 3 && performance.now() - t0 > 350))) bakeChunk(rend, p.still ? q.vol : q.slices);
      const ramp = readyAt && p.vol > 0.002 ? (p.still ? 1 : Math.min(1, (performance.now() - readyAt) / 700)) : 0;
      comp.uniforms.uCopyAmt.value = p.copyAmt;
      comp.uniforms.uCopyMask.value.copy(p.copyMask);
      const u = march.uniforms;
      const e = camera.matrixWorld.elements;
      const s = `${e[12].toFixed(4)},${e[13].toFixed(4)},${e[14].toFixed(4)},${e[0].toFixed(4)},${e[1].toFixed(4)},${e[2].toFixed(4)},${e[4].toFixed(4)},${e[5].toFixed(4)},${e[6].toFixed(4)},${camera.fov},${camera.aspect},${p.gain.toFixed(4)},${p.cavR.toFixed(4)},${p.collapse.toFixed(4)},${p.knot.toFixed(4)},${(p.wall ?? 0).toFixed(3)},${ramp.toFixed(3)}`
        + (kn ? `|${kn.n},${kn.gain.toFixed(4)},${kn.p.slice(0, kn.n).map((v, i) => `${v.x.toFixed(3)},${v.y.toFixed(3)},${v.z.toFixed(3)},${v.w.toFixed(3)},${kn.c[i].w.toFixed(3)},${kn.a[i].w.toFixed(3)}`).join(';')}` : '');
      if (s === sig) return; // nothing changed: a still view costs nothing
      sig = s;
      u.uCamRot.value.setFromMatrix4(camera.matrixWorld);
      u.uInvProj.value.copy(camera.projectionMatrixInverse);
      u.uCamPos.value.setFromMatrixPosition(camera.matrixWorld);
      u.uGain.value = p.gain;
      u.uCavR.value = p.cavR;
      u.uCollapse.value = p.collapse;
      u.uKnot.value = p.knot;
      u.uWall.value = p.wall ?? 0;
      u.uBaked.value = ramp;
      const nk = kn ? Math.min(kn.n, MAX_KNOTS) : 0;
      u.uKn.value = nk;
      u.uKGain.value = kn ? kn.gain : 0;
      for (let i = 0; i < nk; i++) {
        (u.uKp.value as Vector4[])[i].copy(kn!.p[i]);
        (u.uKc.value as Vector4[])[i].copy(kn!.c[i]);
        (u.uKa.value as Vector4[])[i].copy(kn!.a[i]);
      }
      const prev = rend.getRenderTarget();
      rend.setRenderTarget(rt);
      rend.render(marchScene, dummyCam);
      rend.setRenderTarget(prev);
    },
    resize(w, h) {
      const pr = renderer.getPixelRatio();
      const sc = (tier === 'high' ? Math.min(1, HIGH_DPR_CAP / pr) : 1) * q.scale;
      const rw = Math.max(2, Math.round(w * sc));
      const rh = Math.max(2, Math.round(h * sc));
      rt.setSize(rw, rh);
      comp.uniforms.uRes.value.set(rw, rh);
      sig = '';
    },
    dispose() {
      geo.dispose();
      march.dispose();
      bake.dispose();
      comp.dispose();
      rt.dispose();
      vol.dispose();
    },
  };
}
