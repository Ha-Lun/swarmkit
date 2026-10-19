// SwarmKit particle-swarm shaders (GLSL ES 3.00, via THREE.ShaderMaterial with
// glslVersion THREE.GLSL3). Three injects `#version 300 es`, the built-in
// attributes (position) and matrices (modelViewMatrix, projectionMatrix), and
// does NOT map gl_FragColor under GLSL3 (the fragment shader declares its own out) — so only custom attributes, uniforms
// and varyings are declared here. GPU-only: every animated value is a uniform;
// the vertex shader does the whole morph, so the CPU never loops over particles.

export const vertexShader = /* glsl */ `
uniform float uTime;
uniform float uMix;
uniform float uDrift;
uniform float uSize;
uniform float uPixelRatio;
uniform vec3 uPointer;
uniform float uPointerOn;
uniform vec3 uMerged;
uniform vec3 uVerified;
uniform float uUnify;
uniform float uScanY;
uniform float uFromId; // formation ids: 0 disk 1 lattice 2 streams 3 towers 4 hex 5 ring 6 trio
uniform float uToId;
uniform float uAmb; // ambient motion strength (0 = static, reduced motion)
uniform float uFocus; // camera distance that is in focus
uniform vec3 uDiskAxis;
uniform vec3 uRingAxis;
uniform vec3 uCore;

in vec3 aFrom;
in vec3 aTo;
in float aFromT;
in float aToT;
in vec3 aColor;
in float aRole;
in float aDelay;
in float aScale;
in float aKind; // 0 worker, 1 Opus core, 2 Opus halo

out vec3 vColor;
out float vAlpha;
out float vKind;

// Ashima / Ian McEwan 3D simplex noise (MIT): compact curl-ish drift field.
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

float snoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);

  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);

  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);

  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;

  i = mod289(i);
  vec4 p = permute(permute(permute(
      i.z + vec4(0.0, i1.z, i2.z, 1.0))
    + i.y + vec4(0.0, i1.y, i2.y, 1.0))
    + i.x + vec4(0.0, i1.x, i2.x, 1.0));

  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;

  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);

  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);

  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);

  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);

  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));

  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;

  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);

  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x;
  p1 *= norm.y;
  p2 *= norm.z;
  p3 *= norm.w;

  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}

const float PI = 3.14159265;
const float TAU = 6.2831853;

vec3 rotAxis(vec3 v, vec3 a, float ang) {
  float c = cos(ang);
  float s = sin(ang);
  return v * c + cross(a, v) * s + a * dot(a, v) * (1.0 - c);
}

// Ambient life of a formation (applied to both morph endpoints, so holds move and
// the morph never starts from a frozen frame). pt = path parameter, glow = pulse.
vec3 ambient(float id, vec3 p0, float pt, float rnd, out float glow) {
  vec3 p = p0;
  float T = uTime;
  glow = 0.0;
  if (id < 0.5) {
    // disk: slow rotation about its axis; the core breathes a little faster (bounded)
    vec3 rel = p - uDiskAxis * dot(p, uDiskAxis);
    float r = length(rel);
    float ang = T * 0.07 + 0.22 * sin(T * 0.21) * exp(-r * 0.4);
    p = rotAxis(p, uDiskAxis, ang);
    glow = 0.35 * (0.5 + 0.5 * sin(TAU * (pt * 1.5 - T * 0.07)));
  } else if (id < 1.5) {
    // lattice: pulses travel outward along every ray
    float w = TAU * (pt * 2.0 - T * 0.2);
    p.xy += p.xy / max(length(p.xy), 0.001) * 0.16 * sin(w);
    glow = pow(0.5 + 0.5 * sin(w), 3.0);
  } else if (id < 2.5) {
    // streams: flow runs head-ward along each comet
    float w = TAU * (pt * 1.5 - T * 0.3);
    p.xy += p.xy / max(length(p.xy), 0.001) * 0.2 * pt * sin(w);
    glow = pow(0.5 + 0.5 * sin(w), 4.0);
  } else if (id < 3.5) {
    // towers: a scan band loops up the columns
    float dd = abs(pt - fract(T * 0.11));
    dd = min(dd, 1.0 - dd);
    glow = 1.1 * exp(-dd * dd * 70.0);
    p.x += 0.03 * sin(T * 1.3 + pt * 6.0);
  } else if (id < 4.5) {
    // hex: shimmer runs around the edge
    glow = 1.1 * pow(0.5 + 0.5 * sin(TAU * (pt * 3.0 - T * 0.12)), 5.0);
    p *= 1.0 + 0.012 * sin(T * 0.9);
  } else if (id < 5.5) {
    // ring: slow turn
    p = rotAxis(p, uRingAxis, T * 0.1);
    glow = 0.8 * pow(0.5 + 0.5 * sin(TAU * (pt * 2.0 - T * 0.1)), 4.0);
  } else {
    // trio: each cluster orbits and breathes
    float cx = clamp(floor(p.x / 4.2 + 0.5), -1.0, 1.0) * 4.2;
    vec3 c = vec3(cx, -0.4, 0.0);
    vec3 rel = p - c;
    rel = rotAxis(rel, normalize(vec3(0.3, 1.0, 0.2)), T * (0.3 + 0.08 * cx / 4.2));
    rel *= 1.0 + 0.06 * sin(T * 1.1 + cx);
    p = c + rel;
    glow = 0.4 * (0.5 + 0.5 * sin(TAU * (pt * 1.0 - T * 0.12)));
  }
  glow *= uAmb;
  return mix(p0, p, uAmb);
}

void main() {
  // Per-particle lag by path position (+ a little randomness): streams peel off
  // the core in order, so neighbours move together and read as ribbons.
  float lag = 0.38 * 0.5 * (aFromT + aToT) + 0.18 * aDelay;
  float t = clamp((uMix - lag) / (1.0 - 0.56), 0.0, 1.0);
  float te = t * t * (3.0 - 2.0 * t);
  float arc = sin(PI * te);

  float gA;
  float gB;
  vec3 a = ambient(uFromId, aFrom, aFromT, aDelay, gA);
  vec3 b = ambient(uToId, aTo, aToT, aDelay, gB);

  // Quadratic Bezier: control point = midpoint + perpendicular bow (consistent
  // sign per travel direction -> rotational flow, not a straight collapse).
  vec3 d = b - a;
  float len = length(d);
  vec3 mid = 0.5 * (a + b);
  vec3 side = cross(d, vec3(0.0, 0.0, 1.0)) + 0.6 * cross(d, vec3(0.0, 1.0, 0.0));
  side /= max(length(side), 1e-4);
  vec3 ctrl = mid + side * (len * 0.42 * (0.75 + 0.5 * aDelay));
  vec3 pos = mix(mix(a, ctrl, te), mix(ctrl, b, te), te);

  // Swirl about the vertical axis, scaled by travel distance; zero at both ends.
  float ang = 0.7 * arc * clamp(len / 7.0, 0.0, 1.0);
  float cs = cos(ang);
  float sn = sin(ang);
  pos.xz = mat2(cs, sn, -sn, cs) * pos.xz;

  // Low-frequency vector noise: neighbours share it, so ribbons stay coherent.
  vec3 q = pos * 0.22;
  vec3 curl = vec3(
    snoise(q + vec3(0.0, uTime * 0.08, 3.1)),
    snoise(q + vec3(7.3, 0.0, uTime * 0.08)),
    snoise(q + vec3(uTime * 0.08, 5.1, 0.0))
  );
  pos += curl * (uDrift * 0.9 * arc);
  float glow = mix(gA, gB, te);

  // Pointer repulsion: push particles within radius 1.6 away, smooth falloff.
  vec3 delta = pos - uPointer;
  float dist = length(delta);
  float fall = 1.0 - smoothstep(0.0, 1.6, dist);
  pos += (delta / max(dist, 0.001)) * (fall * fall * 0.6 * uPointerOn);

  // Colour: white-violet at the core fading to the lane colour along the path,
  // a bright tip on comets / tower tops; then unify toward gold, scan mint.
  float tm = mix(aFromT, aToT, te);
  bool opus = aKind > 0.5 && aKind < 2.5;
  // Towers keep the lane colour on their bodies (little white-violet at the base).
  float towerW = mix(step(2.5, uFromId) * step(uFromId, 3.5), step(2.5, uToId) * step(uToId, 3.5), te);
  vec3 col = opus ? uCore : mix(uCore, aColor, mix(0.12, 0.8, towerW) + (0.88 - 0.8 * towerW) * smoothstep(0.0, 0.5, tm));
  float tipW = mix(step(1.5, uFromId) * step(uFromId, 3.5), step(1.5, uToId) * step(uToId, 3.5), te);
  col = mix(col, vec3(1.0), 0.3 * tipW * smoothstep(0.88, 1.0, tm));
  if (!opus) col *= 1.0 + 0.5 * (1.0 - smoothstep(0.0, 0.35, tm)) * (1.0 - towerW);
  col *= 1.0 + glow * mix(0.9, 0.5, towerW);
  col = mix(col, uMerged, uUnify);
  float below = 1.0 - smoothstep(uScanY - 0.001, uScanY, pos.y);
  col = mix(col, uVerified, below * 0.6);
  float band = 1.0 - smoothstep(0.0, 0.25, abs(pos.y - uScanY));
  col += mix(vec3(1.0), col, 0.5) * (band * 0.45);
  vColor = col;
  vKind = aKind;

  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mv;
  float depth = max(-mv.z, 0.1);

  // Kind: core sprites are small and intense, the halo is a few modest faint
  // breathing sprites.
  float breathe = 1.0 + 0.2 * sin(uTime * 0.8 + aDelay * 6.0) * uAmb;
  float kindSize = 1.0;
  float kindAlpha = 0.3;
  if (aKind > 1.5) { kindSize = 2.6 * breathe; kindAlpha = 0.012 * breathe; }
  else if (aKind > 0.5) { kindSize = 0.5; kindAlpha = 0.14; }

  // Depth of field: only genuinely off-plane particles defocus, and mildly.
  float coc = clamp((abs(depth - uFocus) / uFocus - 0.18) / 0.5, 0.0, 1.0);
  vAlpha = kindAlpha * mix(1.0, 0.42, uUnify) / (1.0 + 1.0 * coc) + band * 0.3;
  gl_PointSize = uSize * aScale * kindSize * (1.0 + 0.9 * coc) * uPixelRatio * (300.0 / depth);
}
`;

export const fragmentShader = /* glsl */ `
uniform float uDirect; // 1 = no postprocessing: tone + gamma here
in vec3 vColor;
in float vAlpha;
in float vKind;
out vec4 fragColor;

void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c) * 2.0;
  if (d > 1.0) discard;
  float edge = 1.0 - smoothstep(0.55, 1.0, d);
  float a;
  if (vKind > 1.5) {
    a = exp(-d * d * 2.4) * edge;
  } else {
    // soft gaussian core + wide halo, no hard disc
    a = (exp(-d * d * 6.0) * 0.7 + exp(-d * 2.8) * 0.3) * edge;
  }
  vec3 rgb = vColor * a * vAlpha;
  if (uDirect > 0.5) {
    // Per-fragment (blending is additive): lift faint sprites, keep overlaps summing.
    rgb = pow(rgb, vec3(0.8)) * 0.6;
  }
  // Tiny screen-space dither so the additive glow never bands in 8-bit.
  float n = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  fragColor = vec4(rgb + (n - 0.5) / 255.0, 1.0);
}
`;
