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
uniform float uDof; // 0..1 close-up fake depth of field: things far behind the focus plane get bigger and dimmer
uniform float uFocusD;
uniform float uNear; // >0: fade by view distance (the nebula stars): nothing fills the screen when the camera flies through it
uniform vec4 uCopyMask; // NDC ellipse cx, cy, rx, ry that dims this cloud (the close-up headline column)
uniform float uCopyAmt;
uniform float uForm; // 0..1 supernova formation: each star flies from the core to its place (inner first) while swirling in; 1 = untouched
uniform float uSpark; // >0: the debris leaving the supernova core is hot and streaky at first, then settles into the arm
uniform float uClearR; // >0: clean black around the origin — brightness fades in from uClearR*0.5 out to uClearR (the system beats)
in vec3 aColor;
in vec4 aData;
out vec3 vC;
out float vA;

void main() {
  vec3 p = position;
  float fa = 1.0;
  float spark = 0.0;
  if (uForm < 1.0) {
    float d = 0.34 * clamp(length(p.xz) * 0.1, 0.0, 1.0) + 0.1 * aData.y; // inner stars land first, with per-star jitter
    float k = clamp(uForm * 1.65 - d, 0.0, 1.0);
    float e = 1.0 - pow(1.0 - k, 3.0); // thrown out fast, settling softly
    float sw = (1.0 - k) * (1.0 - k) * 2.8; // spin-up: the debris swirls into its arm
    float cs = cos(sw);
    float sn = sin(sw);
    p *= e;
    p.xz = mat2(cs, sn, -sn, cs) * p.xz;
    fa = smoothstep(0.0, 0.1, k) * (1.0 + 3.0 * k * (1.0 - k));
    // sparks: a tenth of the outer stars are thrown out hot and streaky (the bulge never gets this boost, it would stack into a white-out)
    spark = uSpark * step(aData.z, 0.1) * smoothstep(1.5, 4.0, length(position.xz)) * pow(1.0 - k, 2.0) * smoothstep(0.0, 0.06, k);
    fa *= 1.0 + 9.0 * spark;
  }
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
  float a = uGain * tw * fa;
  size *= 1.0 + 1.6 * spark;
  if (uBig < 0.5 && uPx <= 0.0) {
    a /= 1.0 + pow(size / (16.0 * uPR), 2.0); // keep energy when a star is close to the lens
    a *= 1.0 - (1.0 - uCoreDim) * exp(-r * r * 0.35);
  } else if (uBig > 0.5) {
    a *= 1.0 - (1.0 - uCoreDim) * exp(-r * r * 0.35);
  }
  a *= smoothstep(0.12, 1.2, depth);
  if (uNear > 0.0) a *= smoothstep(uNear * 0.3, uNear, depth);
  if (uCopyAmt > 0.0) {
    vec2 nd = (gl_Position.xy / max(gl_Position.w, 1e-3) - uCopyMask.xy) / uCopyMask.zw;
    a *= 1.0 - 0.9 * uCopyAmt * (1.0 - smoothstep(0.75, 1.25, length(nd)));
  }
  if (uClearR > 0.0) a *= smoothstep(uClearR * 0.5, uClearR, r); // radial clear around the sun (r is the cylindrical radius, rotation-invariant)
  if (uDof > 0.0 && uBig < 0.5) {
    float bl = uDof * smoothstep(uFocusD * 1.6, uFocusD * 14.0, depth);
    size *= 1.0 + 2.2 * bl;
    a /= 1.0 + 3.0 * bl;
  }
  size = min(size, uMax);
  float minPx = 1.5 * uPR;
  if (size < minPx) { a *= size / minPx; size = minPx; }
  gl_PointSize = size;
  vC = aColor;
  vA = a;
}
`;

export const spriteFrag = /* glsl */ `
uniform float uMode; // 0 star, 1 haze, 2 dust, 3 hot point core (steep falloff, no flat disc)
in vec3 vC;
in float vA;
out vec4 fragColor;

void main() {
  vec2 q = gl_PointCoord - 0.5;
  float d = length(q) * 2.0;
  if (d > 1.0) discard;
  if (uMode > 2.5) {
    float edge3 = 1.0 - smoothstep(0.55, 1.0, d);
    vec3 rgb = (vec3(1.0, 0.96, 1.0) * exp(-d * 16.0) + vC * vec3(0.7, 0.45, 1.0) * exp(-d * 4.5) * 0.28) * edge3 * vA;
    fragColor = vec4(rgb, 1.0);
    return;
  }
  float edge = 1.0 - smoothstep(0.55, 1.0, d);
  if (uMode > 1.5) {
    fragColor = vec4(0.0, 0.0, 0.0, exp(-d * d * 2.4) * edge * vC.x * vA);
    return;
  }
  float g = uMode < 0.5 ? (exp(-d * d * 7.0) * 0.72 + exp(-d * 3.0) * 0.28) * edge : exp(-d * d * 3.0) * edge * edge;
  vec3 rgb = vC * g * vA;
  float n = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  // dither only the big soft haze glows, and only where they carry light: dithering every faint star footprint reads as sandy grain
  fragColor = vec4(rgb + (n - 0.5) / 255.0 * step(0.5, uMode) * step(0.006, dot(rgb, vec3(1.0))), 1.0);
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
 * The bodies: one camera-facing quad each (not point sprites, so there is no point-size limit in the close-up).
 * kind 0 Opus (the sun), 1 young star (a protostar in its cocoon: small star, faint accretion disc, two short jets),
 * 2 fixer spark. uP = world centre + radius, uS = alpha, ok (steady burn), red (sputter), close-up (softens the glow),
 * uA = jet axis angle on screen, disc ellipse ratio (|axis . view|), ignition 0..1, build 0..1.
 */
export const bodyVert = (n: number): string => /* glsl */ `
uniform vec4 uP[${n}];
uniform vec4 uS[${n}];
uniform vec4 uA[${n}];
uniform float uScale; // device px per world unit at depth 1
uniform float uPR;
in vec4 aData; // index, kind, corner x, corner y
in vec3 aColor;
out vec2 vP;
out vec3 vC;
out vec4 vS;
out vec4 vA;
out float vKind;
out float vIdx;
out float vRpx;
void main() {
  int i = int(aData.x + 0.5);
  float kind = aData.y;
  vec4 pr = uP[i];
  vec4 s = uS[i];
  vec4 mc = modelViewMatrix * vec4(pr.xyz, 1.0);
  float depth = max(-mc.z, 0.05);
  float r = pr.w;
  if (kind > 1.5) r = max(r, 2.0 * uPR * depth / uScale);
  if (kind > 0.5 && kind < 1.5) r = max(r, 1.6 * uPR * depth / uScale);
  float ext = kind < 0.5 ? 9.0 : (kind < 1.5 ? 18.0 : 7.0);
  mc.xy += aData.zw * ext * r;
  gl_Position = projectionMatrix * mc;
  if (s.x < 0.002) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  vP = aData.zw * ext;
  vC = aColor;
  vS = s;
  vA = uA[i];
  vKind = kind;
  vIdx = aData.x;
  vRpx = r * uScale / depth; // body radius in device px: detail fades in with it
}
`;

/**
 * Body shading, all procedural. Opus: limb darkening, granulation, smooth corona. Young star: the same star shading at a
 * small radius, lane tinted, a brief ignition flash, a faint thin accretion disc (tilted ellipse) and two short bipolar jets
 * along the disc axis. Everything is smooth radial/gaussian falloff (no speckle).
 */
export const bodyFrag = (): string => /* glsl */ `
uniform float uFlare;
uniform float uSpin; // scroll-driven rotation clock
uniform float uTime; // wall seconds for idle motion (0 under reduced motion)
in vec2 vP;
in vec3 vC;
in vec4 vS;
in vec4 vA;
in float vKind;
in float vIdx;
in float vRpx;
out vec4 fragColor;

float h31(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}
float vn(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  return mix(
    mix(mix(h31(i), h31(i + vec3(1, 0, 0)), f.x), mix(h31(i + vec3(0, 1, 0)), h31(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(h31(i + vec3(0, 0, 1)), h31(i + vec3(1, 0, 1)), f.x), mix(h31(i + vec3(0, 1, 1)), h31(i + vec3(1, 1, 1)), f.x), f.y),
    f.z);
}

void main() {
  float d = length(vP);
  float aa = max(fwidth(d), 1e-4) * 0.9;
  vec3 col = vec3(0.0);
  float det = smoothstep(14.0, 80.0, vRpx);
  if (vKind < 1.5) {
    // star: hot emissive disc (white-yellow core, orange limb), boiling granulation, slow prominences, breathing corona.
    // kind 1 (young star) is the same body in the lane tint, with a small corona, its ignition flash, disc and jets.
    float young = step(0.5, vKind);
    float ign = young > 0.5 ? vA.z : 1.0;
    float bld = vA.w;
    float disc = 1.0 - smoothstep(1.0 - aa, 1.0 + aa, d);
    float mu = sqrt(max(0.0, 1.0 - d * d));
    float cs = cos(uSpin * 0.35 + uTime * 0.02 + vIdx);
    float sn = sin(uSpin * 0.35 + uTime * 0.02 + vIdx);
    vec3 N = vec3(vP, mu);
    vec3 p3 = vec3(N.x * cs + N.z * sn, N.y, -N.x * sn + N.z * cs);
    float tb = uTime * 0.11;
    float warp = vn(p3 * 5.0 + vec3(0.0, tb * 0.6, uSpin * 0.4));
    float g1 = vn(p3 * 15.0 + warp * 2.4 + vec3(0.0, 0.0, tb));
    float g2 = vn(p3 * 33.0 + warp * 3.0 + vec3(7.0, tb * 1.7, 0.0));
    float detS = smoothstep(4.0, 40.0, vRpx);
    float gran = mix(0.5, 0.6 * g1 + 0.4 * g2, detS);
    float spots = smoothstep(0.74, 0.86, vn(p3 * 2.4 + 3.0 + vec3(0.0, tb * 0.1, 0.0))) * detS;
    float limb = 1.0 - 0.5 * (1.0 - mu) - 0.15 * (1.0 - mu) * (1.0 - mu);
    float temp = clamp(limb * (0.9 + 0.9 * (gran - 0.5)) - 0.12 * spots, 0.0, 1.4);
    // hot: white-yellow; cooler toward the limb: orange. Emissive (>1) so it blooms.
    vec3 surf = mix(vec3(1.0, 0.3, 0.04), vec3(1.0, 0.8, 0.4), smoothstep(0.35, 0.95, temp));
    surf = mix(surf, vec3(1.0, 0.93, 0.72), smoothstep(0.9, 1.25, temp));
    surf *= 0.6 + 1.7 * temp * temp;
    float rr = max(d - 1.0, 0.0);
    float a = atan(vP.y, vP.x);
    float breath = 1.0 + 0.07 * sin(uTime * 0.55 + vIdx) + 0.04 * sin(uTime * 0.97 + 1.3);
    float lobes = 0.5 + 0.5 * (0.6 * sin(a * 2.0 + uSpin * 0.2 + uTime * 0.03 + 1.0) + 0.4 * sin(a * 3.0 - uSpin * 0.15 - uTime * 0.025 + 2.0));
    float streak = lobes * lobes * exp(-rr * (0.7 - 0.15 * uFlare)) * (0.12 + 0.3 * uFlare);
    float coronaE = (0.95 * exp(-rr * 6.0) + (0.22 + 0.35 * uFlare) * exp(-rr * 1.5) + (0.05 + 0.22 * uFlare) * exp(-rr * 0.5) + streak * smoothstep(0.0, 0.8, rr)) * breath;
    float pn = vn(vec3(cos(a) * 2.2, sin(a) * 2.2, uTime * 0.06 + uSpin * 0.2));
    float prom = smoothstep(0.55, 0.85, pn) * exp(-rr * 11.0) * 0.5 * smoothstep(0.0, 0.02, rr) * (0.4 + 0.6 * det);
    vec3 corona = mix(vec3(1.0, 0.4, 0.1), vec3(1.0, 0.76, 0.42), exp(-rr * 2.0)) * coronaE * (d > 1.0 ? 1.0 : 0.55);
    corona += vec3(1.0, 0.35, 0.12) * prom;
    vec3 c;
    float fade;
    if (young < 0.5) {
      c = surf * disc + corona * (1.0 - 0.6 * disc);
      fade = 1.0 - smoothstep(6.5, 9.0, d);
    } else {
      // lane tint: a white-hot core, the lane colour toward the limb and in the corona
      vec3 lane = mix(vC, vec3(1.0), 0.28);
      vec3 sy = surf * mix(vec3(1.0), lane * 1.15, 0.62);
      float ok = clamp(vS.y, 0.0, 1.0);
      float bad = clamp(vS.z, 0.0, 1.0);
      // passing: a steady, calm lane-tinted burn (slightly brighter surface, softer corona); failing: a red sputter
      sy = mix(sy * (1.0 + 0.18 * ok), vec3(1.0, 0.1, 0.05) * (0.45 + 0.6 * temp), 0.92 * bad);
      vec3 stT = mix(lane, vec3(0.3, 1.0, 0.55), 0.4 * ok);
      stT = mix(stT, vec3(1.0, 0.1, 0.06), bad);
      vec3 cy = mix(vec3(1.0), stT, 0.7 + 0.3 * bad) * coronaE * (d > 1.0 ? 0.42 : 0.3) * (1.0 - 0.28 * ok) * (1.0 - 0.6 * vS.w);
      // ignition: a short flash that blooms out of the star and settles, as the thread of light lands
      float fl = 4.0 * ign * (1.0 - ign);
      cy += mix(vec3(1.0), lane, 0.6) * (1.05 * exp(-d * 0.55) + 0.3 * exp(-d * 0.16)) * fl;
      // the star's own glow while it builds (a soft lane-coloured halo, steady)
      cy += stT * (0.1 + 0.16 * bld) * exp(-d * 0.42) * ign * (1.0 - 0.6 * vS.w);
      c = sy * disc * ign + cy * (1.0 - 0.5 * disc);
      fade = 1.0 - smoothstep(8.0, 13.0, d);
      // jet frame: q.y along the disc axis (screen angle vA.x), q.x across
      float ca = cos(vA.x);
      float sa = sin(vA.x);
      vec2 q = vec2(dot(vP, vec2(sa, -ca)), dot(vP, vec2(ca, sa)));
      float ratio = clamp(vA.y, 0.2, 1.0);
      float proj = sqrt(max(0.0, 1.0 - vA.y * vA.y)); // the axis foreshortens when it points at the camera
      float b3 = smoothstep(0.0, 0.5, bld) * ign;
      // HH 30 / L1527 look: a flared disc with a dark mid-plane lane, bright inner rim and scattered light on its faces,
      // a faint hourglass cavity along the axis, and two narrow, tapered, wavy jets with a few knots and a bow shock at the tip.
      float ax = abs(q.x);
      float ay = abs(q.y);
      float sgn = q.y < 0.0 ? 1.0 : 0.0;
      float Rd = 1.8 + 1.9 * bld;
      float rho = length(vec2(q.x, q.y / ratio));
      float face = smoothstep(1.2, 1.9, rho) * (1.0 - smoothstep(0.6 * Rd, Rd, rho)); // the disc itself: a soft-edged ellipse
      float rim = exp(-pow((rho - 1.7) / 0.5, 2.0));
      float above = max(ay - ratio * sqrt(max(0.0, Rd * Rd - q.x * q.x)), 0.0); // scattered light flaring above and below the disc
      float flare = exp(-pow(above / (0.16 + 0.1 * ax), 2.0)) * smoothstep(1.2, 2.0, ax) * (1.0 - smoothstep(0.7 * Rd, 1.25 * Rd, ax));
      float lnm = exp(-pow(q.y / (0.08 + 0.045 * ax), 2.0)); // the dark mid-plane lane, deeper the more edge-on
      float lobe = (face * (0.3 / (0.5 + 0.45 * rho) + 0.42 * rim) + 0.3 * flare / (0.6 + 0.4 * ax));
      float sheen = 0.5 + 0.5 * sin(rho * 2.1 + q.y * 1.3 + vIdx * 2.0 + uTime * 0.03);
      lobe *= (0.82 + 0.18 * sheen) * (1.0 - 0.9 * lnm * (1.0 - 0.7 * ratio));
      vec3 discC = mix(lane, vec3(1.0, 0.82, 0.62), 0.5) * lobe * 2.0 * b3 * (1.0 - 0.3 * vS.w);
      // outflow cavity: a faint hourglass, brighter along its walls, fading with distance
      float wc = 0.55 + 0.62 * pow(ay, 0.85);
      float cav = (1.0 - smoothstep(0.55 * wc, wc * 1.1, ax)) * smoothstep(1.3, 2.4, ay) * exp(-ay / (1.4 + 2.2 * bld));
      cav += 0.6 * exp(-pow((ax - wc) / 0.22, 2.0)) * smoothstep(1.3, 2.4, ay) * exp(-ay / (1.1 + 1.6 * bld));
      vec3 cavC = mix(lane, vec3(1.0, 0.7, 0.55), 0.5) * cav * 0.1 * b3;
      // jets: narrow beams that taper, wobble a little, break into knots, end in a bow shock
      float jl = (2.4 + 4.2 * bld) * (0.5 + 0.5 * proj);
      float wob = 0.09 * sin(ay * 1.7 + vIdx * 3.0 + sgn * 2.0) * min(ay, 3.0) * 0.4;
      float qx = q.x - wob;
      float jw = 0.07 + 0.026 * ay;
      float beam = exp(-pow(qx / jw, 2.0)) + 0.16 * exp(-pow(qx / (jw * 3.2), 2.0));
      float knots = 0.38 + 0.9 * pow(0.5 + 0.5 * cos((ay - 1.7) * 2.7 + vIdx * 1.7 + sgn * 1.4), 7.0);
      float bow = 0.5 * exp(-pow((ay - 0.8 * jl) / 0.3, 2.0)) * exp(-pow(qx / (jw * 1.6 + 0.05), 2.0));
      float along = smoothstep(1.2, 1.9, ay) * exp(-ay / (0.5 * jl)) * (1.0 - smoothstep(0.9 * jl, 1.12 * jl, ay));
      float beads = 1.0 + 0.12 * (1.0 - ok) * sin(ay * 1.9 - uTime * 0.7 + vIdx);
      vec3 jetC = mix(vec3(1.0, 0.66, 0.5), lane, 0.4) * (beam * knots * along * beads * 0.75 + bow) * b3 * (0.55 + 0.45 * proj) * (1.0 - 0.4 * bad);
      c += discC + cavC + jetC;
    }
    c = vec3(1.0) - exp(-c);
    col = c * fade * vS.x;
  } else {
    // fixer: a small amber spark
    float core = exp(-d * d * 3.5);
    float halo = 0.22 * exp(-d * 0.8);
    vec3 c = mix(vC, vec3(1.0, 0.95, 0.85), core * 0.55) * (core * 1.1 + halo);
    c = vec3(1.0) - exp(-c * 1.3);
    col = c * (1.0 - smoothstep(4.5, 7.0, d)) * vS.x;
  }
  float dn = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  col += (dn - 0.5) / 255.0 * step(0.002, dot(col, vec3(1.0)));
  fragColor = vec4(col, 1.0);
}
`;

/**
 * Light threads from Opus to the young stars and the fixer's short tail: screen-space ribbons, drawn on by uProg[line]
 * (the head's travel 0..1), dimmed by uAl[line].
 */
export const lineVert = (n: number): string => /* glsl */ `
uniform vec2 uRes;
uniform float uWidth;
uniform float uPR;
uniform float uProg[${n}];
uniform float uAl[${n}];
uniform float uPul[${n}]; // test pulse position along the thread (0..1 while travelling, 0 = none)
uniform vec3 uFocus; // the close-up star
uniform float uDof;
uniform vec4 uCopyMask; // NDC ellipse that dims threads behind the close-up headline
uniform float uCopyAmt;
in vec3 aNext;
in vec3 aColor;
in vec4 aData; // t, side, line, kind (0 thread, 1 tail)
out float vT;
out float vSide;
out float vProg;
out float vAl;
out float vPul;
out float vK;
out float vBlur;
out vec3 vCol;
void main() {
  float blur = uDof * clamp(length(position - uFocus) / 4.5, 0.0, 1.0);
  vec4 ca = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  vec4 cb = projectionMatrix * modelViewMatrix * vec4(aNext, 1.0);
  vec2 d = (cb.xy / cb.w - ca.xy / ca.w) * uRes * 0.5;
  float l = length(d);
  vec2 dir = l > 1e-4 ? d / l : vec2(1.0, 0.0);
  vec2 perp = vec2(-dir.y, dir.x);
  bool thread = aData.w < 0.5;
  float wpx = uWidth * uPR * (thread ? 1.0 : (aData.w < 1.5 ? 1.6 * aData.x : 0.8 + 3.2 * pow(sin(3.14159 * aData.x), 0.7))) * (1.0 + 2.2 * blur);
  vec2 off = perp * aData.y * wpx / (uRes * 0.5);
  gl_Position = ca + vec4(off * ca.w, 0.0, 0.0);
  int li = int(aData.z + 0.5);
  vT = aData.x;
  vSide = aData.y;
  vProg = uProg[li];
  vAl = uAl[li];
  vPul = uPul[li];
  if (thread && uCopyAmt > 0.0) {
    vec2 nd = (ca.xy / max(ca.w, 1e-3) - uCopyMask.xy) / uCopyMask.zw;
    vAl *= 1.0 - 0.92 * uCopyAmt * (1.0 - smoothstep(0.75, 1.25, length(nd)));
  }
  vBlur = blur;
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
in float vPul;
in float vK;
in float vBlur;
in vec3 vCol;
out vec4 fragColor;
void main() {
  float across = exp(-vSide * vSide * 2.6 / (1.0 + 1.6 * vBlur)) / (1.0 + 1.6 * vBlur);
  float a;
  if (vK < 0.5) {
    // a thread of light: drawn behind its travelling head, brighter toward the head; once landed (vProg = 1) a steady filament
    bool flying = vProg < 0.999;
    float shown = flying ? 1.0 - smoothstep(vProg, vProg + 0.025, vT) : 1.0;
    float head = flying ? exp(-pow((vT - vProg) * 22.0, 2.0)) : 0.0;
    float trail = flying ? 0.3 + 0.7 * smoothstep(vProg - 0.45, vProg, vT) : 1.0;
    float ends = smoothstep(0.0, 0.07, vT);
    vec3 body = mix(vCol, vec3(1.0), 0.3) * 0.5 * trail;
    vec3 tip = mix(vCol, vec3(1.0), 0.75) * head * 1.5;
    a = across * shown * ends;
    // test pulse: a bright head travels out from Opus and the thread glows behind it
    vec3 pl = vec3(0.0);
    if (vPul > 0.0 && vPul < 1.0) {
      float fade = 1.0 - smoothstep(0.88, 1.0, vPul);
      float ph = exp(-pow((vT - vPul) * 16.0, 2.0));
      float pt = vT < vPul ? exp(-(vPul - vT) * 7.0) : 0.0;
      pl = mix(vCol, vec3(1.0), 0.6) * (1.5 * ph + 0.6 * pt) * fade * across * ends;
    }
    fragColor = vec4(body * vAl * a + tip * clamp(vAl * 4.0, 0.0, 1.0) * a + pl, 1.0);
    return;
  }
  if (vK > 1.5) {
    // the fixer's stream of gas: soft clumps flowing along the arc toward the star, thin and bright at the core, no hard edges
    float stream = exp(-vSide * vSide * 3.2) * 0.55 + exp(-vSide * vSide * 14.0) * 0.5;
    float wave = 0.5 + 0.5 * sin(6.28318 * (vT * 3.0 - vProg));
    float clump = 0.35 + 0.9 * wave * wave;
    float ends = smoothstep(0.0, 0.12, vT) * (1.0 - smoothstep(0.88, 1.0, vT));
    vec3 sc = mix(vCol, vec3(1.0, 0.95, 0.85), 0.25 + 0.4 * vT);
    fragColor = vec4(sc * stream * clump * ends * vAl, 1.0);
    return;
  }
  a = across * pow(vT, 1.7) * vAl;
  fragColor = vec4(mix(vCol, vec3(1.0), 0.2) * a, 1.0);
}
`;

/** Flat effects: Opus's approval pulse (one soft expanding ring, facing the camera) and the supernova shock ring (in the galaxy plane). */
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
uniform float uShockR;
uniform float uShockA;
in vec2 vP;
out vec4 fragColor;
void main() {
  float r = length(vP);
  vec3 col = vec3(0.0);
  if (uPulseA > 0.001) {
    // a soft violet front with a faint trailing glow, no hairline
    float dr = r - uPulseR;
    float front = exp(-pow(dr / 0.32, 2.0)) * 0.1 + (dr < 0.0 ? exp(dr / 1.2) * 0.02 : 0.0);
    col += vec3(0.8, 0.74, 1.0) * front * uPulseA;
  }
  if (uShockA > 0.001) {
    // the supernova shock: one crisp hairline ring, brightest on its leading edge, with a soft glowing shoulder behind it
    float aa = max(fwidth(r), 1e-4);
    float dr = r - uShockR;
    float line = 1.0 - smoothstep(0.0, 1.6 * aa, abs(dr));
    float lead = exp(-pow(dr / 0.2, 2.0)) * (dr > 0.0 ? 1.0 : 0.55);
    float trail = step(r, uShockR) * exp(dr / 0.55);
    col += mix(vec3(0.62, 0.55, 1.0), vec3(1.0, 0.95, 1.0), smoothstep(-0.6, 0.0, dr)) * (line * 0.55 + lead * 0.3 + trail * 0.05) * uShockA;
  }
  float dn = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
  col += dn / 255.0 * step(0.002, dot(col, vec3(1.0)));
  fragColor = vec4(col, 1.0);
}
`;
