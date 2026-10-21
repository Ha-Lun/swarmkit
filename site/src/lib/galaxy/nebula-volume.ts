// The emission nebula as a real volume, baked once and marched cheaply at (near) full resolution.
// BAKE (once, GPU, spread over a few frames after load): the LOBES layout from generator.ts, double domain-warped, with
// 7-8 octave ridged multifractal filaments/pillars stretched toward the knot and dark dust lanes, written slice by slice
// into a 3D texture (RGBA8: sqrt gas, dust, palette mix, violet fraction).
// MARCH: a full-screen pass rebuilds each pixel's world ray and takes one trilinear fetch per step (Beer-Lambert absorption,
// emission ~ density^2, an ionisation front facing the star, a forward single-scatter term, 1-2 octaves of fine 3D detail
// noise only on density edges). No blur: step start jitter (IGN, rotated per frame) is converged by temporal accumulation
// while the view is still (history blend, reset on any camera/param change); during motion only a 3x3 edge-aware filter.
// The result is composited premultiplied before the stars-and-planets pass, so dust darkens the deep field behind it.
// After ignition the star carves a cavity (density removed inside uCavR, a lit wall at its edge). No assets, no sprites.
// After ignition the star carves a cavity (density removed inside uCavR, a lit wall at its edge). No assets, no sprites.
import {
  AdditiveBlending, BufferAttribute, BufferGeometry, ClampToEdgeWrapping, CustomBlending, GLSL3, Group, HalfFloatType,
  LinearFilter, Matrix3, Matrix4, Mesh, NoBlending, OneFactor, OneMinusSrcAlphaFactor, OrthographicCamera, Points, Scene,
  ShaderMaterial, UnsignedByteType, Vector2, Vector3, Vector4, WebGL3DRenderTarget, WebGLRenderTarget,
} from 'three';
import type { Object3D, PerspectiveCamera, WebGLRenderer } from 'three';
import { buildSpikeStars, KNOT_R, LOBES, RIM } from './generator.ts';
import { PALETTE, type Tier } from './shared.ts';

/** Per tier: ray steps, edge-detail octaves, baked volume size, bake slices per frame, converge frames, max drawing-buffer pixel
 *  ratio (cap) and a scale on the drawing buffer (the march target; 1 = full resolution). */
const QUALITY = {
  high: { steps: 64, detail: 2, vol: 160, slices: 10, frames: 16, dprCap: 1.5, scale: 1 },
  medium: { steps: 40, detail: 1, vol: 128, slices: 8, frames: 12, dprCap: 99, scale: 0.75 },
  low: { steps: 24, detail: 0, vol: 96, slices: 6, frames: 8, dprCap: 99, scale: 0.7 },
} as const;
/** Half extent of the baked cube in world units (the lobes end within ~8.9 of the origin). */
const VH = 9;

export interface VolumeParams {
  time: number; // idle clock in seconds (unused: the baked field is static, so a still view converges and costs nothing)
  gain: number; // overall emission
  cavR: number; // world radius of the star-carved bubble (0 = none)
  collapse: number; // 0..1: the knot contracts to a point and brightens (ignition)
  knot: number; // 0..1: knot brightness
  copyAmt: number; // 0..1: dim the copy column
  wall?: number; // 0..1: Opus lights the bubble walls (a gentle ramp of the cavity-wall emission; 0 = as carved)
  copyMask: Vector4; // NDC ellipse cx, cy, rx, ry
  /** Render one frame (reduced motion): converge in this call instead of over the next frames. */
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
  vec3 rdir = p / max(r, 0.05);
  vec3 q = pw2 - rdir * dot(pw2, rdir) * 0.5;
  float f1 = fbm(q * 1.15, 3);
  float fil = smoothstep(0.22, 0.75, ridged(q * 1.5 + 9.0, 4));
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
uniform sampler2D uHist;
uniform vec2 uRes;
uniform float uAlpha;
uniform float uFrame;
uniform float uBaked;
uniform float uDetAmp;
uniform int uDetOct;
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

// per-pixel offset for the ray start: interleaved gradient noise (Jimenez), rotated by the golden ratio each frame so the
// accumulated frames sample different depths (a converging low-discrepancy sequence per pixel)
// (frame 0 keeps the pure IGN pattern, which the 3x3 filter handles best; later frames add a per-pixel white offset so the
// residual after accumulating is unstructured instead of IGN stripes)
float ign(vec2 px) {
  float w = fract(sin(dot(px, vec2(12.9898, 78.233))) * 43758.5453);
  return fract(52.9829189 * fract(dot(px, vec2(0.06711056, 0.00583715))) + uFrame * 0.61803399 + w * step(0.5, uFrame));
}

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
  float t = t0 + dt * ign(gl_FragCoord.xy);
  float detK = uDetAmp * clamp(0.35 / dt, 0.25, 1.0);
  float invV = 0.5 / VH;

  vec3 acc = vec3(0.0);
  float T = 1.0;
  float kr = KNOT_R * (1.0 - 0.86 * uCollapse);
  for (int i = 0; i < 64; i++) {
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
      // fine detail below the baked resolution, carved only where the density is in a mid band (the edges of the clouds and lanes)
      if (detK > 0.0) {
        float dn = 1.0 - abs(2.0 * noise(p * 4.3 + 7.0) - 1.0);
        if (uDetOct > 1) dn = dn * 0.62 + 0.38 * (1.0 - abs(2.0 * noise(p * 9.7 + 19.0) - 1.0));
        float eg = smoothstep(0.03, 0.2, gB) * (1.0 - smoothstep(0.7, 1.8, gB));
        float ed = smoothstep(0.1, 0.5, du) * (1.0 - smoothstep(1.6, 3.2, du));
        g *= 1.0 + (dn - 0.5) * 2.2 * detK * eg;
        du *= 1.0 + (0.5 - dn) * 2.0 * detK * ed;
      }
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
  vec4 cur = shade();
  if (uAlpha < 1.0) cur = mix(texture(uHist, gl_FragCoord.xy / uRes), cur, uAlpha);
  outColor = cur;
}
`;

const compFrag = /* glsl */ `
precision highp float;
uniform sampler2D tVol;
uniform vec2 uTexel;
uniform float uConv;
uniform float uCopyAmt;
uniform vec4 uCopyMask;
in vec2 vUv;
in vec2 vNdc;
out vec4 outColor;
float lum(vec4 c) { return dot(c.rgb, vec3(0.3, 0.55, 0.15)); }
void main() {
  vec4 s = texture(tVol, vUv);
  if (uConv < 0.999) {
    // moving: a 3x3 edge-aware (bilateral on luminance and alpha) average; fades out as the accumulation converges
    float lc = lum(s);
    vec4 sum = s;
    float ws = 1.0;
    for (int j = -1; j <= 1; j++) {
      for (int i = -1; i <= 1; i++) {
        if (i == 0 && j == 0) continue;
        vec4 n = texture(tVol, vUv + vec2(float(i), float(j)) * uTexel);
        float ln = lum(n);
        float d = abs(lc - ln) / (lc + ln + 0.03) + abs(s.a - n.a) * 1.5;
        float w = (i == 0 || j == 0 ? 1.0 : 0.7) * exp(-d * d * 36.0);
        sum += n * w;
        ws += w;
      }
    }
    s = mix(sum / ws, s, uConv);
  }
  if (uCopyMask.z > 0.0) {
    vec2 e = (vNdc - uCopyMask.xy) / uCopyMask.zw;
    s.rgb *= mix(1.0, mix(0.12, 1.0, smoothstep(0.6, 1.2, length(e))), uCopyAmt);
  }
  // filmic contrast: a toe that deepens the shadows and a lift in the mids and highlights
  s.rgb *= mix(0.8, 1.22, smoothstep(0.015, 0.5, lum(s)));
  float dn = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) - 0.5;
  s.rgb = max(s.rgb + dn * 0.0015 * smoothstep(0.0, 0.01, max(s.r, max(s.g, s.b))), 0.0);
  outColor = s;
}
`;

// a few bright young stars with small six-point diffraction spikes (three crossed lines), additive, crisp core
const spikeVert = /* glsl */ `
uniform float uPx;
uniform float uGain;
in vec3 aColor;
in float aSize;
out vec3 vC;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = aSize * uPx;
  // near-faded by view distance so the camera can fly through them
  vC = aColor * uGain * smoothstep(0.8, 2.4, -mv.z);
}
`;
const spikeFrag = /* glsl */ `
precision highp float;
in vec3 vC;
out vec4 outColor;
void main() {
  vec2 q = (gl_PointCoord - 0.5) * 2.0;
  float d = length(q);
  if (d > 1.0) discard;
  float core = exp(-d * d * 220.0) + 0.18 * exp(-d * d * 26.0);
  float sp = 0.0;
  for (int k = 0; k < 3; k++) {
    float a = 0.3 + float(k) * 1.0471976;
    vec2 t = vec2(cos(a), sin(a));
    float al = abs(dot(q, t));
    float pe = abs(q.x * t.y - q.y * t.x);
    sp += exp(-pe * pe * 2600.0) * exp(-al * 4.2) * (1.0 - smoothstep(0.7, 1.0, al));
  }
  outColor = vec4(vC * (core + 0.34 * sp), 1.0);
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
  // two full-resolution targets: the march blends against the other one (history), the composite reads the newest
  const rts = [new WebGLRenderTarget(2, 2, rtOpts), new WebGLRenderTarget(2, 2, rtOpts)];
  let cur = 0;
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
      uVol: { value: vol.texture }, uHist: { value: rts[1].texture }, uRes: { value: new Vector2(2, 2) },
      uAlpha: { value: 1 }, uFrame: { value: 0 }, uBaked: { value: 0 }, uDetAmp: { value: tier === 'high' ? 0.9 : tier === 'medium' ? 0.7 : 0 },
      uDetOct: { value: q.detail },
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
    uniforms: { tVol: { value: rts[0].texture }, uTexel: { value: new Vector2(1, 1) }, uConv: { value: 1 }, uCopyAmt: { value: 0 }, uCopyMask: { value: new Vector4() } },
    vertexShader: compVert, fragmentShader: compFrag, glslVersion: GLSL3,
    transparent: true, blending: CustomBlending, blendSrc: OneFactor, blendDst: OneMinusSrcAlphaFactor,
    depthTest: false, depthWrite: false,
  });
  const quad = new Mesh(geo, comp);
  quad.frustumCulled = false;
  quad.renderOrder = 0.5; // after the deep-field shells (dust darkens them), before the planets, rings and fx

  // the brightest young stars with diffraction spikes (subtle; fewer on the lower tiers)
  const sp = buildSpikeStars(tier === 'high' ? 24 : tier === 'medium' ? 16 : 10);
  const spGeo = new BufferGeometry();
  spGeo.setAttribute('position', new BufferAttribute(sp.position, 3));
  spGeo.setAttribute('aColor', new BufferAttribute(sp.color, 3));
  const size = new Float32Array(sp.count);
  for (let i = 0; i < sp.count; i++) size[i] = sp.data[i * 4];
  spGeo.setAttribute('aSize', new BufferAttribute(size, 1));
  const spMat = new ShaderMaterial({
    uniforms: { uPx: { value: 1 }, uGain: { value: 0 } },
    vertexShader: spikeVert, fragmentShader: spikeFrag, glslVersion: GLSL3,
    blending: AdditiveBlending, depthTest: false, depthWrite: false, transparent: true,
  });
  const spPts = new Points(spGeo, spMat);
  spPts.frustumCulled = false;
  spPts.renderOrder = 2;
  const group = new Group();
  group.add(quad, spPts);

  const t0 = performance.now();
  let slice = 0; // next slice to bake
  let readyAt = 0; // performance.now() when the bake finished
  let nCalls = 0;
  let acc = 0; // frames accumulated for the current view
  let sig = '';
  const held: number[] = new Array(16).fill(0);
  let hasHeld = false;
  const heldM = new Matrix4();
  const converge = half ? q.frames : 4;
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
  function pass(rend: WebGLRenderer, alpha: number, frame: number): void {
    const w = 1 - cur;
    march.uniforms.uHist.value = rts[cur].texture;
    march.uniforms.uAlpha.value = alpha;
    march.uniforms.uFrame.value = frame;
    rend.setRenderTarget(rts[w]);
    rend.render(marchScene, dummyCam);
    cur = w;
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
      if (slice < q.vol && (p.still || (nCalls > 3 && performance.now() - t0 > 350))) bakeChunk(rend, p.still ? q.vol : q.slices);
      const ramp = readyAt ? (p.still ? 1 : Math.min(1, (performance.now() - readyAt) / 700)) : 0;
      comp.uniforms.uCopyAmt.value = p.copyAmt;
      comp.uniforms.uCopyMask.value.copy(p.copyMask);
      spMat.uniforms.uGain.value = Math.min(1, p.gain / 0.3) * 0.62 * ramp;
      spPts.visible = ramp > 0;
      const u = march.uniforms;
      // The scene sways the camera a hair at idle, which would restart the accumulation forever. Hold the pose the volume was
      // last marched from until the camera leaves it by about a pixel (position 0.012, rotation 0.0006), so a view that is
      // still, or drifting at idle, converges between steps; scrolling moves past the threshold every frame.
      const cw = camera.matrixWorld.elements;
      let dev = 0;
      for (const k of [12, 13, 14]) dev = Math.max(dev, Math.abs(cw[k] - held[k]) / 0.012);
      for (const k of [0, 1, 2, 4, 5, 6, 8, 9, 10]) dev = Math.max(dev, Math.abs(cw[k] - held[k]) / 0.0006);
      if (dev > 1 || !hasHeld) {
        for (let k = 0; k < 16; k++) held[k] = cw[k];
        hasHeld = true;
      }
      const e = held;
      const s = `${e[12].toFixed(4)},${e[13].toFixed(4)},${e[14].toFixed(4)},${e[0].toFixed(4)},${e[1].toFixed(4)},${e[2].toFixed(4)},${e[4].toFixed(4)},${e[5].toFixed(4)},${e[6].toFixed(4)},${camera.fov},${camera.aspect},${p.gain.toFixed(4)},${p.cavR.toFixed(4)},${p.collapse.toFixed(4)},${p.knot.toFixed(4)},${(p.wall ?? 0).toFixed(3)},${ramp.toFixed(3)}`
        + (kn ? `|${kn.n},${kn.gain.toFixed(4)},${kn.p.slice(0, kn.n).map((v, i) => `${v.x.toFixed(3)},${v.y.toFixed(3)},${v.z.toFixed(3)},${v.w.toFixed(3)},${kn.c[i].w.toFixed(3)},${kn.a[i].w.toFixed(3)}`).join(';')}` : '');
      const changed = s !== sig;
      if (!changed && acc >= converge) return; // converged: a still view costs nothing
      if (changed) {
        sig = s;
        acc = 0;
        heldM.fromArray(held);
        u.uCamRot.value.setFromMatrix4(heldM);
        u.uInvProj.value.copy(camera.projectionMatrixInverse);
        u.uCamPos.value.setFromMatrixPosition(heldM);
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
      }
      const prev = rend.getRenderTarget();
      // reduced motion renders one frame per change: converge inside this call
      const n = p.still && changed ? Math.min(converge, 8) : 1;
      for (let k = 0; k < n; k++) {
        pass(rend, acc === 0 ? 1 : Math.max(1 / (acc + 1), half ? 0 : 0.25), acc);
        acc++;
      }
      rend.setRenderTarget(prev);
      comp.uniforms.tVol.value = rts[cur].texture;
      comp.uniforms.uConv.value = Math.min(1, (acc - 1) / Math.max(1, converge * 0.5));
    },
    resize(w, h) {
      const pr = renderer.getPixelRatio();
      const sc = Math.min(1, q.dprCap / pr) * q.scale;
      const rw = Math.max(2, Math.round(w * sc));
      const rh = Math.max(2, Math.round(h * sc));
      rts[0].setSize(rw, rh);
      rts[1].setSize(rw, rh);
      march.uniforms.uRes.value.set(rw, rh);
      comp.uniforms.uTexel.value.set(1 / rw, 1 / rh);
      spMat.uniforms.uPx.value = pr;
      sig = '';
    },
    dispose() {
      geo.dispose();
      spGeo.dispose();
      spMat.dispose();
      march.dispose();
      bake.dispose();
      comp.dispose();
      rts[0].dispose();
      rts[1].dispose();
      vol.dispose();
    },
  };
}
