// Galaxy shaders (GLSL ES 3.00 through THREE.ShaderMaterial + GLSL3). GPU-only motion: the CPU writes uniforms.
// Everything is additive HDR into the bloom chain except the dust (alpha-blended near-black).

/** Star / haze / dust / deep-field sprites. Differential rotation of the galaxy happens here. */
export const spriteVert = /* glsl */ `
uniform float uTime;
uniform float uSpin;
uniform float uScale; // device px per world unit at depth 1
uniform float uSize;
uniform float uMax;
uniform float uGain;
uniform float uRotate;
uniform float uPx; // >0: fixed pixel size (deep field)
uniform float uPR;
uniform float uCoreDim;
uniform float uBig; // 1 = large soft sprites (haze, dust): no energy normalisation
in vec3 aColor;
in vec4 aData;
out vec3 vC;
out float vA;

void main() {
  vec3 p = position;
  float r = length(p.xz);
  if (uRotate > 0.5) {
    float ang = uTime * 0.026 * (1.0 + 1.6 * exp(-r * 0.3)) + uSpin * (1.0 + 1.1 * exp(-r * 0.25));
    float c = cos(ang);
    float s = sin(ang);
    p.xz = mat2(c, s, -s, c) * p.xz;
  }
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float depth = max(-mv.z, 0.01);
  float tw = 1.0 + 0.28 * sin(uTime * (0.7 + aData.z * 2.2) + aData.y * 40.0);
  float size = uPx > 0.0 ? aData.x * uPx * uPR : aData.x * uSize * uScale / depth;
  float a = uGain * tw;
  if (uBig < 0.5 && uPx <= 0.0) {
    a /= 1.0 + pow(size / (16.0 * uPR), 2.0); // keep energy when a star is close to the lens
    a *= 1.0 - (1.0 - uCoreDim) * exp(-r * r * 0.35);
  } else if (uBig > 0.5) {
    a *= 1.0 - (1.0 - uCoreDim) * exp(-r * r * 0.35);
  }
  a *= smoothstep(0.12, 1.2, depth);
  size = min(size, uMax);
  float minPx = 1.5 * uPR;
  if (size < minPx) { a *= size / minPx; size = minPx; }
  gl_PointSize = size;
  vC = aColor;
  vA = a;
}
`;

export const spriteFrag = /* glsl */ `
uniform float uMode; // 0 star, 1 haze, 2 dust
in vec3 vC;
in float vA;
out vec4 fragColor;

void main() {
  vec2 q = gl_PointCoord - 0.5;
  float d = length(q) * 2.0;
  if (d > 1.0) discard;
  float edge = 1.0 - smoothstep(0.55, 1.0, d);
  if (uMode > 1.5) {
    fragColor = vec4(0.0, 0.0, 0.0, exp(-d * d * 2.4) * edge * vC.x * vA);
    return;
  }
  float g = uMode < 0.5 ? (exp(-d * d * 7.0) * 0.72 + exp(-d * 3.0) * 0.28) * edge : exp(-d * d * 3.0) * edge * edge;
  vec3 rgb = vC * g * vA;
  float n = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  fragColor = vec4(rgb + (n - 0.5) / 255.0 * step(0.0001, g), 1.0);
}
`;

/** Velocity-stretched star quads for the dive: head at the star, tail toward the vanishing point. */
export const streakVert = /* glsl */ `
uniform vec2 uRes;
uniform vec3 uFwd;
uniform float uStretch;
uniform float uVis;
uniform float uWidth;
uniform float uPR;
in vec2 aCorner;
in vec3 aData;
out vec2 vUv;
out float vA;
out vec3 vCol;

void main() {
  vec3 head = position;
  vec3 tail = position + uFwd * uStretch * aData.x;
  vec4 mvh = modelViewMatrix * vec4(head, 1.0);
  vec4 mvt = modelViewMatrix * vec4(tail, 1.0);
  float near = -0.25;
  if (mvt.z > near) {
    float k = clamp((near - mvh.z) / (mvt.z - mvh.z), 0.0, 1.0);
    mvt = mix(mvh, mvt, k);
  }
  vec4 ch = projectionMatrix * mvh;
  vec4 ct = projectionMatrix * mvt;
  if (mvh.z > near) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vUv = vec2(0.0); vA = 0.0; vCol = vec3(0.0); return; }
  vec2 nh = ch.xy / ch.w;
  vec2 nt = ct.xy / ct.w;
  vec2 dpx = (nh - nt) * uRes * 0.5;
  float len = length(dpx);
  vec2 dir = len > 0.001 ? dpx / len : vec2(1.0, 0.0);
  vec2 perp = vec2(-dir.y, dir.x);
  float w = uWidth * uPR * (0.7 + aData.z * 0.9);
  float isHead = aCorner.x;
  vec2 ndc = mix(nt, nh, isHead);
  vec2 off = (perp * aCorner.y * w * mix(0.25, 1.0, isHead) + dir * (isHead * 2.0 - 1.0) * w * 0.8) / (uRes * 0.5);
  ndc += off;
  float W = mix(ct.w, ch.w, isHead);
  float Z = mix(ct.z / ct.w, ch.z / ch.w, isHead);
  gl_Position = vec4(ndc * W, Z * W, W);
  vUv = vec2(isHead, aCorner.y);
  float depth = -mvh.z;
  vA = uVis * aData.y * smoothstep(0.25, 1.6, depth) / (1.0 + depth * 0.06);
  vCol = mix(vec3(0.72, 0.84, 1.0), aData.z > 0.8 ? vec3(1.0, 0.8, 0.55) : (aData.z < 0.15 ? vec3(0.4, 1.0, 0.85) : vec3(1.0)), 0.7);
}
`;
export const streakFrag = /* glsl */ `
in vec2 vUv;
in float vA;
in vec3 vCol;
out vec4 fragColor;
void main() {
  float along = pow(clamp(vUv.x, 0.0, 1.0), 1.4);
  float across = exp(-vUv.y * vUv.y * 3.2);
  float a = along * across * vA * 3.2;
  fragColor = vec4(vCol * a, 1.0);
}
`;

/** Comet: head + dust tail positioned wholly from uniforms. */
export const cometVert = /* glsl */ `
uniform vec3 uHead;
uniform vec3 uDir;
uniform float uLen;
uniform float uVis;
uniform float uScale;
uniform float uMax;
uniform float uTime;
uniform float uFlash;
in float aT;
in vec3 aRand;
out vec3 vC;
out float vA;
void main() {
  float spread = 0.02 + 0.5 * aT * aT;
  vec3 p = uHead - uDir * aT * uLen + aRand * spread * (1.0 + 0.3 * sin(uTime * 3.0 + aT * 20.0));
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float depth = max(-mv.z, 0.01);
  bool head = aT < 0.021;
  float size = 0.34 * uScale / depth * (1.0 + uFlash * 2.0);
  vec3 tailCol = mix(vec3(0.35, 0.85, 1.0), vec3(0.62, 0.42, 1.0), smoothstep(0.1, 0.9, aT));
  vC = head ? vec3(2.2, 2.3, 2.6) : tailCol * 1.6;
  vA = uVis * (head ? 1.0 : 0.55 * pow(1.0 - aT, 1.5)) * smoothstep(0.1, 1.0, depth);
  gl_PointSize = clamp(size, 1.5, uMax);
}
`;

/** Comet tail: one continuous ribbon from the head backwards, width tapering to nothing, additive falloff. */
export const tailVert = /* glsl */ `
uniform vec3 uHead;
uniform vec3 uDir;
uniform float uLen;
uniform vec2 uRes;
uniform float uScale;
uniform float uPR;
in vec2 aT; // t along the tail 0 head .. 1 end, side -1|1
out float vT;
out float vSide;
vec3 at(float t) { return uHead - uDir * t * t * uLen * 0.6 - uDir * t * uLen * 0.4; }
void main() {
  float t = aT.x;
  vec3 pa = at(t);
  vec3 pb = at(min(1.0, t + 0.02));
  vec4 ma = modelViewMatrix * vec4(pa, 1.0);
  vec4 ca = projectionMatrix * ma;
  vec4 cb = projectionMatrix * modelViewMatrix * vec4(pb, 1.0);
  vec2 d = (cb.xy / max(cb.w, 1e-3) - ca.xy / max(ca.w, 1e-3)) * uRes * 0.5;
  float l = length(d);
  vec2 dir = l > 1e-4 ? d / l : vec2(1.0, 0.0);
  vec2 perp = vec2(-dir.y, dir.x);
  float depth = max(-ma.z, 0.05);
  float w = clamp(0.13 * uScale / depth, 2.0 * uPR, 30.0 * uPR) * pow(1.0 - t, 0.85);
  vec2 off = perp * aT.y * w / (uRes * 0.5);
  gl_Position = ca + vec4(off * ca.w, 0.0, 0.0);
  vT = t;
  vSide = aT.y;
}
`;
export const tailFrag = /* glsl */ `
uniform float uVis;
in float vT;
in float vSide;
out vec4 fragColor;
void main() {
  float across = exp(-vSide * vSide * 3.4);
  float along = pow(1.0 - vT, 1.6);
  vec3 col = mix(vec3(0.9, 0.97, 1.0), vec3(0.3, 0.82, 1.0), smoothstep(0.0, 0.3, vT));
  col = mix(col, vec3(0.55, 0.4, 1.0), smoothstep(0.35, 1.0, vT));
  float a = across * along * uVis * 1.5;
  fragColor = vec4(col * a, 1.0);
}
`;

export const nodeVert = /* glsl */ `
uniform float uOn[9];
uniform float uScale;
uniform float uTime;
uniform float uPulseR;
uniform float uPulseOn;
uniform float uMax;
in vec3 aColor;
in vec4 aData; // size, index, phase
out vec3 vC;
out float vA;
void main() {
  float on = uOn[int(aData.y + 0.5)];
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float depth = max(-mv.z, 0.01);
  float pulse = uPulseOn * exp(-pow((length(position) - uPulseR) / 0.45, 2.0));
  float breathe = 1.0 + 0.08 * sin(uTime * 1.3 + aData.z * 6.0);
  float size = aData.x * uScale / depth * (0.18 + 0.82 * on) * breathe * (1.0 + 0.5 * pulse);
  gl_PointSize = clamp(size, 2.0, uMax);
  vC = aColor;
  vA = (0.08 + on * 1.25 + pulse * 1.4);
}
`;
export const nodeFrag = /* glsl */ `
in vec3 vC;
in float vA;
out vec4 fragColor;
void main() {
  vec2 q = (gl_PointCoord - 0.5) * 2.0;
  float d = length(q);
  if (d > 1.0) discard;
  float core = exp(-d * d * 30.0);
  float halo = exp(-d * d * 6.0) * 0.3;
  float spikes = (exp(-abs(q.x) * 20.0) * exp(-abs(q.y) * 2.4) + exp(-abs(q.y) * 20.0) * exp(-abs(q.x) * 2.4)) * 0.6;
  float g = (core * 1.6 + halo + spikes) * (1.0 - smoothstep(0.8, 1.0, d));
  fragColor = vec4(mix(vC, vec3(1.0), core * 0.6) * g * vA, 1.0);
}
`;

/** Glowing constellation lines: screen-space ribbons, drawn on by uProg[line]. */
export const ribbonVert = /* glsl */ `
uniform vec2 uRes;
uniform float uWidth;
uniform float uPR;
uniform float uProg[24];
in vec3 aNext;
in vec3 aColor;
in vec4 aData; // t, side, line, weight
out float vT;
out float vSide;
out float vProg;
out float vW;
out vec3 vWorld;
out vec3 vCol;
void main() {
  vec4 ca = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  vec4 cb = projectionMatrix * modelViewMatrix * vec4(aNext, 1.0);
  vec2 d = (cb.xy / cb.w - ca.xy / ca.w) * uRes * 0.5;
  float l = length(d);
  vec2 dir = l > 1e-4 ? d / l : vec2(1.0, 0.0);
  vec2 perp = vec2(-dir.y, dir.x);
  vec2 off = perp * aData.y * uWidth * uPR / (uRes * 0.5);
  gl_Position = ca + vec4(off * ca.w, 0.0, 0.0);
  vT = aData.x;
  vSide = aData.y;
  vProg = uProg[int(aData.z + 0.5)];
  vW = aData.w;
  vWorld = position;
  vCol = aColor;
}
`;
export const ribbonFrag = /* glsl */ `
uniform float uTime;
uniform float uPulseR;
uniform float uPulseOn;
in float vT;
in float vSide;
in float vProg;
in float vW;
in vec3 vWorld;
in vec3 vCol;
out vec4 fragColor;
void main() {
  float shown = 1.0 - smoothstep(vProg - 0.012, vProg, vT);
  if (shown <= 0.0) discard;
  float head = vProg < 0.999 ? exp(-pow((vT - vProg) * 9.0, 2.0)) : 0.0;
  float across = exp(-vSide * vSide * 3.0);
  float flow = 0.72 + 0.28 * sin(vT * 24.0 - uTime * 1.4);
  float pulse = uPulseOn * exp(-pow((length(vWorld) - uPulseR) / 0.5, 2.0));
  float a = across * shown * (0.8 * flow * vW + head * 2.2 + pulse * 2.4 * vW);
  fragColor = vec4(mix(vCol, vec3(1.0), clamp(head + pulse * 0.6, 0.0, 1.0) * 0.5) * a, 1.0);
}
`;

export const ringVert = /* glsl */ `
out vec2 vP;
void main() {
  vP = position.xy;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;
export const ringFrag = /* glsl */ `
uniform float uR;
uniform float uAlpha;
in vec2 vP;
out vec4 fragColor;
void main() {
  float d = length(vP);
  float ring = exp(-pow((d - uR) / 0.07, 2.0)) * 1.4 + exp(-pow((d - uR) / 0.5, 2.0)) * 0.08;
  vec3 col = mix(vec3(0.72, 0.62, 1.0), vec3(1.0), 0.5);
  fragColor = vec4(col * ring * uAlpha, 1.0);
}
`;
