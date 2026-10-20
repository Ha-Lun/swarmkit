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
uniform float uGrow; // grows a cloud outward from the core: points with aData.w = t appear once uGrow passes t
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
  float a = uGain * tw * smoothstep(aData.w - 0.12, aData.w, uGrow);
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

/** The dive's star tunnel: stars in a cylinder around the camera axis (position = [right, up, depth phase]) that stream
 *  past as the scroll travels (uTravel), drawn as quads stretched toward the vanishing point by uStretch. */
export const streakVert = /* glsl */ `
uniform vec2 uRes;
uniform vec3 uFwd;
uniform vec3 uRight;
uniform vec3 uUp;
uniform vec3 uCam;
uniform float uTravel;
uniform float uDepth;
uniform float uStretch;
uniform float uVis;
uniform float uWidth;
uniform float uPR;
uniform vec4 uClear; // ndc ellipse (cx, cy, rx, ry) kept dark behind the copy
in vec2 aCorner;
in vec3 aData; // length factor, brightness, layer 0 (far) .. 1 (near)
out vec2 vUv;
out float vA;
out vec3 vCol;

void main() {
  float ph = fract(position.z + uTravel * (0.75 + 0.5 * aData.z));
  float zd = 0.35 + ph * uDepth;
  vec3 head = uCam + uRight * position.x + uUp * position.y + uFwd * zd;
  vec3 tail = head + uFwd * uStretch * aData.x * (0.5 + aData.z);
  vec4 mvh = modelViewMatrix * vec4(head, 1.0);
  vec4 mvt = modelViewMatrix * vec4(tail, 1.0);
  vec4 ch = projectionMatrix * mvh;
  vec4 ct = projectionMatrix * mvt;
  if (mvh.z > -0.2) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vUv = vec2(0.0); vA = 0.0; vCol = vec3(0.0); return; }
  vec2 nh = ch.xy / ch.w;
  vec2 nt = ct.xy / ct.w;
  vec2 dpx = (nh - nt) * uRes * 0.5;
  float len = length(dpx);
  vec2 dir = len > 0.001 ? dpx / len : vec2(1.0, 0.0);
  vec2 perp = vec2(-dir.y, dir.x);
  float w = uWidth * uPR * (0.65 + aData.z * 1.5);
  float isHead = aCorner.x;
  vec2 ndc = mix(nt, nh, isHead);
  vec2 off = (perp * aCorner.y * w * mix(0.2, 1.0, isHead) + dir * (isHead * 2.0 - 1.0) * w * 0.8) / (uRes * 0.5);
  ndc += off;
  float W = mix(ct.w, ch.w, isHead);
  float Z = mix(ct.z / ct.w, ch.z / ch.w, isHead);
  gl_Position = vec4(ndc * W, Z * W, W);
  vUv = vec2(isHead, aCorner.y);
  float fade = smoothstep(0.0, 0.1, ph) * (1.0 - smoothstep(0.82, 1.0, ph));
  // tunnel, not starburst: streaks live toward the periphery and fade out near the centre and behind the copy
  float rad = length(nh * vec2(uRes.x / uRes.y, 1.0));
  float tunnel = smoothstep(0.38, 1.05, rad);
  float clear = 1.0 - 0.92 * (1.0 - smoothstep(0.55, 1.0, length((nh - uClear.xy) / uClear.zw)));
  vA = uVis * aData.y * fade * tunnel * clear * (0.45 + 0.9 * aData.z) / (1.0 + zd * 0.03);
  vec3 tint = aData.z > 0.7 ? vec3(1.0, 0.82, 0.6) : (aData.z < 0.25 ? vec3(0.45, 0.95, 0.85) : vec3(0.62, 0.7, 1.0));
  vCol = mix(vec3(0.8, 0.88, 1.0), tint, 0.6);
}
`;
export const streakFrag = /* glsl */ `
in vec2 vUv;
in float vA;
in vec3 vCol;
out vec4 fragColor;
void main() {
  float along = pow(clamp(vUv.x, 0.0, 1.0), 1.3);
  float across = exp(-vUv.y * vUv.y * 3.2);
  float a = along * across * vA * 1.05;
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
  float size = 0.26 * uScale / depth * (1.0 + uFlash * 2.0);
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
  float a = across * along * uVis * 1.2;
  fragColor = vec4(col * a, 1.0);
}
`;

/**
 * The solar system's bodies: one camera-facing quad each (not point sprites, so there is no point-size limit in the
 * close-up). kind 0 sun, 1 planet (solid core, small halo, hairline worktree ring), 2 fixer spark, 3 plan slot (dim dot).
 * uP = world centre + radius, uS = alpha, ring growth, ok (green), red.
 */
export const bodyVert = (n: number): string => /* glsl */ `
uniform vec4 uP[${n}];
uniform vec4 uS[${n}];
uniform float uScale; // device px per world unit at depth 1
uniform float uPR;
in vec4 aData; // index, kind, corner x, corner y
in vec3 aColor;
out vec2 vP;
out vec3 vC;
out vec3 vL;
out vec4 vS;
out float vKind;
out float vIdx;
void main() {
  int i = int(aData.x + 0.5);
  float kind = aData.y;
  vec4 pr = uP[i];
  vec4 s = uS[i];
  vec4 mc = modelViewMatrix * vec4(pr.xyz, 1.0);
  float depth = max(-mc.z, 0.05);
  float r = pr.w;
  if (kind > 1.5 && kind < 2.5) r = max(r, 2.0 * uPR * depth / uScale);
  if (kind > 2.5) r = max(r, 1.5 * uPR * depth / uScale);
  float ext = kind < 0.5 ? 9.0 : (kind < 1.5 ? 3.4 : (kind < 2.5 ? 7.0 : 3.0));
  vec4 sunV = modelViewMatrix * vec4(uP[0].xyz, 1.0);
  vL = normalize(sunV.xyz - mc.xyz);
  mc.xy += aData.zw * ext * r;
  gl_Position = projectionMatrix * mc;
  if (s.x < 0.002) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  vP = aData.zw * ext;
  vC = aColor;
  vS = s;
  vKind = kind;
  vIdx = aData.x;
}
`;
export const bodyFrag = /* glsl */ `
uniform float uFlare;
in vec2 vP;
in vec3 vC;
in vec3 vL;
in vec4 vS;
in float vKind;
in float vIdx;
out vec4 fragColor;
void main() {
  float d = length(vP);
  float aa = max(fwidth(d), 1e-4) * 0.9;
  vec3 col = vec3(0.0);
  if (vKind < 0.5) {
    // sun: a warm disc, a short glow and a flare that swells with each arrival; soft-clipped so it never whites out
    float core = 1.0 - smoothstep(1.0 - aa, 1.0 + aa, d);
    float glow = 0.42 * exp(-d * 0.95) + 0.16 * exp(-d * d * 0.07) + uFlare * (0.9 * exp(-d * 0.55) + 0.3 * exp(-d * d * 0.05));
    vec3 hot = vec3(1.0, 0.86, 0.62);
    vec3 warm = vec3(1.0, 0.66, 0.30);
    vec3 c = hot * core * 1.05 + warm * glow;
    c = vec3(1.0) - exp(-c * 1.15);
    col = c * (1.0 - smoothstep(6.5, 9.0, d)) * vS.x;
  } else if (vKind < 1.5) {
    float disc = 1.0 - smoothstep(1.0 - aa, 1.0 + aa, d);
    vec3 n = vec3(vP, sqrt(max(0.0, 1.0 - d * d)));
    float diff = max(dot(n, vL), 0.0);
    vec3 st = mix(vC, vec3(0.3, 1.0, 0.55), vS.z);
    st = mix(st, vec3(1.0, 0.22, 0.18), clamp(vS.w, 0.0, 1.0));
    vec3 body = vC * (0.34 + 0.9 * diff) + vC * pow(1.0 - n.z, 3.0) * 0.22;
    col += body * disc;
    col += st * exp(-pow(max(d - 1.0, 0.0) * 1.8, 2.0)) * (1.0 - disc) * (0.2 + 0.55 * vS.w + 0.2 * vS.z);
    if (vS.y > 0.002) {
      float tilt = -0.42 + 0.18 * sin(vIdx * 2.7);
      float ratio = 0.34 + 0.05 * sin(vIdx * 1.9);
      float ca = cos(tilt);
      float sa = sin(tilt);
      vec2 q = vec2(ca * vP.x + sa * vP.y, -sa * vP.x + ca * vP.y);
      float ra = 2.5 * vS.y;
      float f = length(vec2(q.x / ra, q.y / (ra * ratio)));
      float w = max(fwidth(f), 1e-4);
      float line = 1.0 - smoothstep(0.3 * w, 1.0 * w, abs(f - 1.0));
      line *= 1.0 - step(0.0, q.y) * disc; // the far half passes behind the planet
      col += st * line * (0.5 + 0.7 * vS.w + 0.3 * vS.z) * smoothstep(0.0, 0.25, vS.y);
    }
    col *= vS.x;
  } else if (vKind < 2.5) {
    // fixer: a small amber spark
    float core = exp(-d * d * 3.5);
    float halo = 0.22 * exp(-d * 0.8);
    vec3 c = mix(vC, vec3(1.0, 0.95, 0.85), core * 0.55) * (core * 1.1 + halo);
    c = vec3(1.0) - exp(-c * 1.3);
    col = c * (1.0 - smoothstep(4.5, 7.0, d)) * vS.x;
  } else {
    // plan slot: a dim dot on the orbit
    float disc = 1.0 - smoothstep(1.0 - aa, 1.0 + aa, d);
    col = vC * (disc * 0.8 + 0.18 * exp(-d * d * 1.2)) * vS.x;
  }
  fragColor = vec4(col, 1.0);
}
`;

/** Orbit hairlines and the fixer's short tail: screen-space ribbons, drawn on by uProg[line], dimmed by uAl[line]. */
export const lineVert = (n: number): string => /* glsl */ `
uniform vec2 uRes;
uniform float uWidth;
uniform float uPR;
uniform float uProg[${n}];
uniform float uAl[${n}];
in vec3 aNext;
in vec3 aColor;
in vec4 aData; // t, side, line, kind (0 orbit, 1 tail)
out float vT;
out float vSide;
out float vProg;
out float vAl;
out float vK;
out vec3 vCol;
void main() {
  vec4 ca = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  vec4 cb = projectionMatrix * modelViewMatrix * vec4(aNext, 1.0);
  vec2 d = (cb.xy / cb.w - ca.xy / ca.w) * uRes * 0.5;
  float l = length(d);
  vec2 dir = l > 1e-4 ? d / l : vec2(1.0, 0.0);
  vec2 perp = vec2(-dir.y, dir.x);
  float wpx = uWidth * uPR * (aData.w > 0.5 ? 1.6 * aData.x : 1.0);
  vec2 off = perp * aData.y * wpx / (uRes * 0.5);
  gl_Position = ca + vec4(off * ca.w, 0.0, 0.0);
  int li = int(aData.z + 0.5);
  vT = aData.x;
  vSide = aData.y;
  vProg = uProg[li];
  vAl = uAl[li];
  vK = aData.w;
  vCol = aColor;
  if (vAl < 0.002) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}
`;
export const lineFrag = /* glsl */ `
in float vT;
in float vSide;
in float vProg;
in float vAl;
in float vK;
in vec3 vCol;
out vec4 fragColor;
void main() {
  float across = exp(-vSide * vSide * 2.6);
  float a;
  if (vK < 0.5) {
    float shown = 1.0 - smoothstep(vProg - 0.012, vProg, vT);
    if (shown <= 0.0) discard;
    float head = vProg < 0.999 ? exp(-pow((vT - vProg) * 16.0, 2.0)) : 0.0;
    a = across * shown * (0.2 + head * 0.8) * vAl;
  } else {
    a = across * pow(vT, 1.7) * vAl;
  }
  fragColor = vec4(mix(vCol, vec3(1.0), 0.2) * a, 1.0);
}
`;

/** Flat effects in the orbital plane: the sun's approval pulse (one hairline ring) and the scan arc. */
export const fxVert = /* glsl */ `
out vec2 vP;
void main() {
  vP = position.xy;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;
export const fxFrag = /* glsl */ `
uniform float uPulseR;
uniform float uPulseA;
uniform float uAng;
uniform float uScanVis;
uniform float uR;
in vec2 vP;
out vec4 fragColor;
void main() {
  float r = length(vP);
  vec3 col = vec3(0.0);
  if (uPulseA > 0.001) {
    float aa = max(fwidth(r), 1e-4);
    float line = 1.0 - smoothstep(0.0, 1.5 * aa, abs(r - uPulseR));
    float soft = exp(-pow((r - uPulseR) / 0.16, 2.0)) * 0.25;
    col += vec3(0.84, 0.78, 1.0) * (line * 0.6 + soft) * uPulseA;
  }
  if (uScanVis > 0.001) {
    float th = atan(-vP.y, vP.x);
    float da = mod(uAng - th + 12.566371, 6.283185);
    float perp = r * sin(min(da, 1.5707));
    float aa = max(fwidth(perp), 1e-4);
    float edge = da < 1.5707 ? 1.0 - smoothstep(0.0, 1.4 * aa, abs(perp)) : 0.0;
    float sector = da < 1.9 ? exp(-da * 3.2) * 0.07 : 0.0;
    float radial = (1.0 - smoothstep(uR - 0.9, uR, r)) * smoothstep(0.1, 0.7, r);
    col += vec3(0.55, 0.92, 1.0) * (edge * 0.55 + sector) * radial * uScanVis;
  }
  fragColor = vec4(col, 1.0);
}
`;
