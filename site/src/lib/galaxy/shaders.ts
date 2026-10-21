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
uniform float uDof; // 0..1 close-up fake depth of field: things far behind the focus plane get bigger and dimmer
uniform float uFocusD;
uniform float uNear; // >0: fade by view distance (the nebula gas): nothing fills the screen when the camera flies through it
uniform float uCollapse; // 0..1: the nebula knot (points within ~0.9 of the origin) pulls into a point and brightens (ignition)
uniform float uKnot; // 0..1 brightness of the knot points (fades out after the ignition flash)
uniform vec4 uCopyMask; // NDC ellipse cx, cy, rx, ry that dims this cloud (the close-up headline column)
uniform float uCopyAmt;
uniform float uClearR; // >0: clean black around the origin — brightness fades in from uClearR*0.5 out to uClearR (the system beats)
in vec3 aColor;
in vec4 aData;
out vec3 vC;
out float vA;

void main() {
  vec3 p = position;
  float kn = 0.0;
  if (uCollapse > 0.0 || uKnot < 1.0) {
    kn = 1.0 - smoothstep(0.7, 0.95, length(p));
    p *= 1.0 - 0.94 * uCollapse * kn;
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
  float a = uGain * tw * smoothstep(aData.w - 0.12, aData.w, uGrow);
  if (uBig < 0.5 && uPx <= 0.0) {
    a /= 1.0 + pow(size / (16.0 * uPR), 2.0); // keep energy when a star is close to the lens
    a *= 1.0 - (1.0 - uCoreDim) * exp(-r * r * 0.35);
  } else if (uBig > 0.5) {
    a *= 1.0 - (1.0 - uCoreDim) * exp(-r * r * 0.35);
  }
  a *= smoothstep(0.12, 1.2, depth);
  if (uNear > 0.0) a *= smoothstep(uNear * 0.3, uNear, depth);
  if (kn > 0.0) { a *= mix(1.0, uKnot, kn) * (1.0 + 0.8 * uCollapse * kn) * (1.0 - 0.45 * (1.0 - uCollapse) * kn); size *= 1.0 - 0.75 * uCollapse * kn; }
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
out float vRpx;
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
  vRpx = r * uScale / depth; // body radius in device px: detail fades in with it
}
`;

/**
 * Body shading, all procedural. Planets: sphere normal rebuilt per pixel, spun by the scroll clock (uSpin), 3D noise.
 * agy = gas giants (bands, domain-warped turbulence, storm ovals); opencode = ice giants (soft banding, haze, dark spot).
 * Rings are a real plane (ray-plane in the impostor) that shadows and is shadowed. Sun: limb darkening, granulation,
 * smooth corona. `oct` = noise octave cap per tier.
 */
export const bodyFrag = (oct: number): string => /* glsl */ `
#define OCT ${oct}
uniform float uFlare;
uniform float uSpin; // scroll-driven rotation clock
uniform float uTime; // wall seconds for idle motion (0 under reduced motion)
in vec2 vP;
in vec3 vC;
in vec3 vL;
in vec4 vS;
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
float fbm(vec3 p, int nOct) {
  float a = 0.5;
  float s = 0.0;
  float tot = 0.0;
  for (int i = 0; i < OCT; i++) {
    if (i >= nOct) break;
    s += a * vn(p);
    tot += a;
    p = p * 2.03 + vec3(17.1, 3.7, 9.2);
    a *= 0.5;
  }
  return s / tot;
}
float ringDen(float r, float sd, float det) {
  float x = r * 46.0;
  float broad = vn(vec3(x * 0.3, sd, 1.0));
  float mid = vn(vec3(x * 1.1, sd, 5.0));
  float fine = vn(vec3(x * 3.6, sd, 7.0));
  float ultra = mix(0.5, vn(vec3(x * 14.0, sd, 9.0)), det);
  float n = 0.42 * broad + 0.3 * mid + 0.19 * fine + 0.09 * ultra;
  float dens = smoothstep(0.2, 0.78, n);
  dens *= 0.7 + 0.3 * (0.5 + 0.5 * sin(x * 4.0 + 3.0 * mid + sd)); // many thin ringlets
  dens = 0.06 + dens;
  dens *= 1.0 - 0.96 * (1.0 - smoothstep(0.0, 0.04, abs(r - (0.58 + 0.04 * sin(sd * 5.0)))));
  dens *= 1.0 - 0.8 * (1.0 - smoothstep(0.0, 0.014, abs(r - 0.86)));
  dens *= 0.22 + 0.78 * smoothstep(0.0, 0.3, r);
  dens *= smoothstep(0.0, 0.03, r) * (1.0 - smoothstep(0.94, 1.0, r));
  return clamp(dens, 0.0, 1.0);
}

void main() {
  float d = length(vP);
  float aa = max(fwidth(d), 1e-4) * 0.9;
  vec3 col = vec3(0.0);
  float det = smoothstep(14.0, 80.0, vRpx);
  int nOct = vRpx < 14.0 ? 2 : (vRpx < 45.0 ? min(3, OCT) : OCT);
  if (vKind < 0.5) {
    // sun: hot emissive disc (white-yellow core, orange limb), boiling granulation, slow prominences, breathing corona
    float disc = 1.0 - smoothstep(1.0 - aa, 1.0 + aa, d);
    float mu = sqrt(max(0.0, 1.0 - d * d));
    float cs = cos(uSpin * 0.35 + uTime * 0.02);
    float sn = sin(uSpin * 0.35 + uTime * 0.02);
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
    float breath = 1.0 + 0.07 * sin(uTime * 0.55) + 0.04 * sin(uTime * 0.97 + 1.3);
    // streamers: broad slow lobes, faded in with distance so nothing spikes at the limb
    float lobes = 0.5 + 0.5 * (0.6 * sin(a * 2.0 + uSpin * 0.2 + uTime * 0.03 + 1.0) + 0.4 * sin(a * 3.0 - uSpin * 0.15 - uTime * 0.025 + 2.0));
    float streak = lobes * lobes * exp(-rr * (0.7 - 0.15 * uFlare)) * (0.12 + 0.3 * uFlare);
    float coronaE = (0.95 * exp(-rr * 6.0) + (0.22 + 0.35 * uFlare) * exp(-rr * 1.5) + (0.05 + 0.22 * uFlare) * exp(-rr * 0.5) + streak * smoothstep(0.0, 0.8, rr)) * breath;
    // faint prominences: slow arcs of plasma just above the limb
    float pn = vn(vec3(cos(a) * 2.2, sin(a) * 2.2, uTime * 0.06 + uSpin * 0.2));
    float prom = smoothstep(0.55, 0.85, pn) * exp(-rr * 11.0) * 0.5 * smoothstep(0.0, 0.02, rr) * (0.4 + 0.6 * det);
    vec3 corona = mix(vec3(1.0, 0.4, 0.1), vec3(1.0, 0.76, 0.42), exp(-rr * 2.0)) * coronaE * (d > 1.0 ? 1.0 : 0.55);
    corona += vec3(1.0, 0.35, 0.12) * prom;
    vec3 c = surf * disc + corona * (1.0 - 0.6 * disc);
    c = vec3(1.0) - exp(-c);
    col = c * (1.0 - smoothstep(6.5, 9.0, d)) * vS.x;
  } else if (vKind < 1.5) {
    float disc = 1.0 - smoothstep(1.0 - aa, 1.0 + aa, d);
    float gas = step(vC.b, vC.r); // agy amber = gas giant, opencode teal = ice giant
    float sd = vIdx * 1.713;
    float tilt = -0.42 + 0.18 * sin(vIdx * 2.7); // ringTilt() in scene.ts
    float ratio = 0.34 + 0.05 * sin(vIdx * 1.9);
    float ca = cos(tilt);
    float sa = sin(tilt);
    mat2 R = mat2(ca, -sa, sa, ca);
    vec2 q = R * vP;
    float sinP = sqrt(1.0 - ratio * ratio);
    vec3 pole = vec3(0.0, sinP, ratio); // spin axis = ring-plane normal, in the tilted screen frame
    vec3 e2 = vec3(0.0, ratio, -sinP);
    vec3 Lq = vec3(R * vL.xy, vL.z);
    vec3 stT = mix(vC, vec3(0.3, 1.0, 0.55), vS.z);
    stT = mix(stT, vec3(1.0, 0.22, 0.18), clamp(vS.w, 0.0, 1.0));
    float stat = clamp(vS.z + vS.w, 0.0, 1.0);
    vec3 outc = vec3(0.0);

    // ring plane
    float ringA = 0.0;
    vec3 ringC = vec3(0.0);
    vec3 rbase = mix(vec3(0.9, 0.82, 0.7), vC, 0.2); // icy grey-beige, a hint of lane tint
    float ringFront = 1.0;
    float gr = vS.y;
    if (gr > 0.002) {
      float rin = 1.18;
      float rout = rin + 1.35 * gr;
      float zr = -sinP * q.y / ratio;
      vec3 P = vec3(q, zr);
      float rho = length(P);
      float rn = (rho - rin) / (rout - rin);
      if (rn > 0.0 && rn < 1.0) {
        float dens = ringDen(rn, sd, det);
        float pl = dot(pole, Lq);
        // planet shadow on the ring
        float b = dot(P, Lq);
        float disc2 = b * b - (dot(P, P) - 1.0);
        float shadow = (b < 0.0 && disc2 > 0.0) ? smoothstep(0.0, 0.12, disc2) : 0.0;
        float lit = (0.3 + 0.7 * abs(pl)) * (1.0 - 0.93 * shadow);
        float fs = pow(max(0.0, -Lq.z), 2.2) * pow(1.0 - dens, 1.4) * (1.0 - 0.9 * shadow); // forward scatter: thin parts glow when backlit
        bool sunSide = pl * ratio > 0.0;
        float refl = sunSide ? lit : 0.2 * lit + 0.9 * (1.0 - dens) * (1.0 - 0.9 * shadow) * (0.3 + 0.7 * abs(pl));
        vec3 base = mix(rbase, vec3(0.62, 0.56, 0.5), 0.5 * smoothstep(0.55, 0.62, rn) * (1.0 - smoothstep(0.62, 0.7, rn)));
        base *= 0.7 + 0.6 * vn(vec3(rn * 9.0, sd, 3.0));
        ringC = base * (refl * 0.8 + fs * 1.8);
        ringA = clamp(dens * 0.8, 0.0, 1.0) * smoothstep(0.0, 0.2, gr);
        ringFront = (zr > 0.0 || d > 1.0) ? 1.0 : 0.0;
        ringA *= ringFront;
        float nearHalf = step(0.0, zr);
        ringFront = nearHalf; // near half composites over the planet, far half only shows outside the disc
      }
    }

    if (disc > 0.0 || d < 1.05) {
      float mu = sqrt(max(0.0, 1.0 - d * d));
      vec3 N = vec3(q, mu);
      float lat = dot(N, pole);
      float u = N.x;
      float v = dot(N, e2);
      float spin = uSpin * (0.42 + 0.2 * sin(sd * 3.0)) + sd * 2.0 + uTime * (0.012 + 0.006 * sin(sd * 2.0));
      float cs = cos(spin);
      float sn = sin(spin);
      vec3 p3 = vec3(u * cs - v * sn, u * sn + v * cs, lat);
      vec3 sdv = vec3(sd, sd * 0.7, sd * 1.3);
      vec3 c;
      float spec = 0.0;
      if (gas > 0.5) {
        float n1 = fbm(vec3(p3.xy * 1.9, lat * 6.5) + sdv, nOct);
        float turb = 0.5 + 0.9 * det;
        float ph = lat * (5.2 + 1.6 * sin(sd)) + (n1 - 0.5) * 1.7 * turb + 0.4 * sin(lat * 3.0 + sd);
        float bnd = 0.5 + 0.5 * sin(ph * 6.2832 * 0.5);
        bnd = smoothstep(0.22, 0.78, bnd + (n1 - 0.5) * 0.25);
        float fine = mix(0.5, fbm(vec3(p3.xy * 3.2, lat * 20.0) + sdv * 2.0, nOct), det);
        vec3 belt = vC * vec3(0.5, 0.3, 0.2) * 0.75;
        vec3 zone = mix(vC, vec3(1.0, 0.88, 0.64), 0.55);
        c = mix(belt, zone, bnd);
        c *= 0.78 + 0.5 * fine;
        // drifting cloud layer: differential rotation, stretched along the bands
        float dr = uTime * (0.025 + 0.03 * (1.0 - abs(lat)));
        float cdr = cos(dr);
        float sdr = sin(dr);
        vec2 cp = vec2(p3.x * cdr - p3.y * sdr, p3.x * sdr + p3.y * cdr);
        float cl = fbm(vec3(cp * 3.4, lat * 9.0) + sdv * 3.0 + vec3(0.0, 0.0, uTime * 0.02), min(nOct, 3));
        c = mix(c, vec3(1.0, 0.92, 0.78), smoothstep(0.5, 0.75, cl) * 0.2475 * (0.3 + 0.7 * det));
        c *= mix(1.0, 0.62, smoothstep(0.68, 1.0, abs(lat)));
        for (int k = 0; k < 3; k++) {
          float h1 = h31(vec3(vIdx, float(k), 7.1));
          float h2 = h31(vec3(vIdx, float(k), 13.7));
          float la = (h2 - 0.5) * 1.1;
          float lo = h1 * 6.2832;
          float rl = sqrt(max(0.0, 1.0 - la * la));
          vec3 cd = vec3(cos(lo) * rl, sin(lo) * rl, la);
          vec3 dd = p3 - cd;
          float sz = k == 0 ? 1.0 : 0.55;
          float r2 = pow(length(dd.xy) / (0.26 * sz), 2.0) + pow(dd.z / (0.1 * sz), 2.0);
          float storm = exp(-r2 * 1.4) * (k == 0 ? 1.0 : 0.65) * step(0.0, dot(p3, cd));
          vec3 sc = k == 1 ? vec3(0.95, 0.9, 0.8) : vec3(0.82, 0.34, 0.18) * vC.r;
          c = mix(c, sc, storm * 0.75);
          c += 0.12 * vC * exp(-pow(sqrt(r2) - 1.15, 2.0) * 6.0) * det;
        }
      } else {
        float n1 = fbm(vec3(p3.xy * 1.6, lat * 4.0) + sdv, nOct);
        float ph = lat * 3.3 + (n1 - 0.5) * 0.9 + 0.3 * sin(sd);
        float bnd = 0.5 + 0.5 * sin(ph * 3.1416);
        vec3 deep = vC * vec3(0.3, 0.65, 1.15) * 0.42;
        vec3 pale = mix(vC, vec3(0.6, 0.98, 1.0), 0.28);
        c = mix(deep, pale, 0.08 + 0.85 * smoothstep(0.15, 0.85, bnd));
        float dri = uTime * 0.03;
        float cdi = cos(dri);
        float sdi = sin(dri);
        vec2 cpi = vec2(p3.x * cdi - p3.y * sdi, p3.x * sdi + p3.y * cdi);
        float cir2 = det * fbm(vec3(cpi * 2.6, lat * 11.0) + sdv * 2.0 + 4.0 + vec3(0.0, 0.0, uTime * 0.02), nOct);
        c = mix(c, vec3(0.82, 1.0, 1.0), smoothstep(0.52, 0.72, cir2) * 0.38);
        c = mix(c, pale * 1.05, smoothstep(0.6, 1.0, abs(lat)) * 0.3);
        float la = (h31(vec3(vIdx, 3.0, 2.0)) - 0.5) * 0.9;
        float lo = h31(vec3(vIdx, 5.0, 2.0)) * 6.2832;
        float rl = sqrt(max(0.0, 1.0 - la * la));
        vec3 dd = p3 - vec3(cos(lo) * rl, sin(lo) * rl, la);
        float r2 = pow(length(dd.xy) / 0.24, 2.0) + pow(dd.z / 0.11, 2.0);
        c *= 1.0 - 0.45 * exp(-r2 * 1.6) * (0.4 + 0.6 * det);
      }
      float diff = dot(N, Lq);
      float lam = clamp((diff + 0.1) / 1.1, 0.0, 1.0);
      float lit = pow(lam, 1.05);
      // ring shadow on the planet: march from the surface toward the sun to the ring plane
      float rs = 0.0;
      if (gr > 0.002) {
        float pL = dot(pole, Lq);
        float sT = -dot(pole, N) / (abs(pL) < 1e-3 ? 1e-3 : pL);
        if (sT > 0.0) {
          vec3 H = N + sT * Lq;
          float rn2 = (length(H) - 1.18) / (1.35 * gr);
          if (rn2 > 0.0 && rn2 < 1.0) rs = ringDen(rn2, sd, 0.0) * 0.85 * smoothstep(0.0, 0.2, gr);
        }
      }
      float scat = exp(-pow(diff / 0.17, 2.0)) * 0.3;
      vec3 scatC = mix(vC, vec3(1.0, 0.5, 0.3), 0.45);
      vec3 body = c * lit * 1.15 * (1.0 - rs) + scatC * scat * smoothstep(-0.25, 0.05, diff) * 0.55;
      // small on screen: blend toward a soft, lane-coloured, mostly lit disc (gibbous) so the lane reads
      float small = 1.0 - smoothstep(14.0, 48.0, vRpx);
      float soft = pow(clamp((diff + 0.7) / 1.7, 0.0, 1.0), 0.9);
      body = mix(body, c * soft * 1.05 + vC * 0.08 * small, small * 0.8);
      float night = 1.0 - smoothstep(-0.15, 0.35, diff);
      float rshine = smoothstep(0.0, 0.3, gr) * 0.05;
      body += (vC * 0.014 * (0.5 + c) + c * rbase * rshine + scatC * 0.012) * night; // night side: ring-shine and scattered light
      float fres = pow(1.0 - mu, 4.5);
      vec3 atm = mix(vC, vec3(0.6, 0.88, 1.0), (1.0 - gas) * 0.45 + 0.1);
      atm = mix(atm, stT, 0.75 * stat);
      body += atm * fres * (0.03 + 0.62 * pow(clamp(diff * 0.8 + 0.4, 0.0, 1.0), 1.3)) * (1.0 + 0.6 * stat);
      vec3 Hh = normalize(Lq + vec3(0.0, 0.0, 1.0));
      spec = (pow(max(dot(N, Hh), 0.0), 70.0) * 0.3 + pow(max(dot(N, Hh), 0.0), 14.0) * 0.04) * (1.0 - gas) * lit;
      body += vec3(0.8, 0.97, 1.0) * spec;
      outc = body * disc;
    }
    // atmosphere glow outside the limb: lane tinted, status tint when verifying; lit side brighter
    float lb = 0.5 + 0.5 * dot(vP / max(d, 1e-3), vL.xy / max(length(vL.xy), 1e-3)) * min(1.0, length(vL.xy) * 1.3 + 0.2);
    float halo = exp(-max(d - 1.0, 0.0) * 26.0) * (1.0 - disc) * (0.028 + 0.1 * vS.w + 0.07 * vS.z) * (0.3 + 0.9 * lb);
    outc += mix(vC, stT, stat) * halo;
    // composite the ring: near half over, far half behind (only visible off the disc)
    float aR = ringA;
    if (ringFront < 0.5) aR *= (1.0 - disc);
    outc = outc * (1.0 - aR) + ringC * aR;
    col = outc * vS.x;
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
    // a marker: small core, soft halo, and a faint ring that breathes outward (idle only: uTime is 0 under reduced motion)
    float on = step(0.0001, uTime);
    float cyc = fract(uTime * 0.32 + vIdx * 0.37);
    float pulse = on * (1.0 - cyc) * exp(-pow((d - (1.0 + 1.7 * cyc)) * 3.2, 2.0));
    float breathe = 1.0 + on * 0.25 * sin(uTime * 1.9 + vIdx * 2.3);
    float halo = exp(-d * d * 0.9) * 0.3 * breathe;
    col = vC * (disc * 0.8 + halo + 0.35 * pulse) * (1.0 - smoothstep(2.4, 3.0, d)) * vS.x;
  }
  float dn = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  col += (dn - 0.5) / 255.0 * step(0.002, dot(col, vec3(1.0)));
  fragColor = vec4(col, 1.0);
}
`;

/**
 * Orbit hairlines and the fixer's short tail: screen-space ribbons, drawn on by uProg[line], dimmed by uAl[line].
 * Orbits carry a depth cue (near side thicker/brighter, far side finer/dimmer, dimmed where they cross the sun's glow),
 * a lane-coloured light trail behind the planet, and a faint dashed base with a slow idle shimmer (uIdle 0 = off).
 */
export const lineVert = (n: number): string => /* glsl */ `
uniform vec2 uRes;
uniform float uWidth;
uniform float uPR;
uniform float uProg[${n}];
uniform float uAl[${n}];
uniform float uAng[${n}]; // each orbit's planet angle (rad), idle drift included
uniform vec3 uFocus; // the close-up planet
uniform float uDof;
uniform vec4 uCopyMask; // NDC ellipse that dims orbit hairlines behind the close-up headline
uniform float uCopyAmt;
in vec3 aNext;
in vec3 aColor;
in vec4 aData; // t, side, line, kind (0 orbit, 1 tail)
out float vT;
out float vSide;
out float vProg;
out float vAl;
out float vK;
out float vAng;
out float vRad;
out float vBlur;
out float vDepth;
out float vTrail;
out vec3 vCol;
void main() {
  float blur = uDof * clamp(length(position - uFocus) / 4.5, 0.0, 1.0);
  vec4 mvA = modelViewMatrix * vec4(position, 1.0);
  vec4 ca = projectionMatrix * mvA;
  vec4 cb = projectionMatrix * modelViewMatrix * vec4(aNext, 1.0);
  vec2 d = (cb.xy / cb.w - ca.xy / ca.w) * uRes * 0.5;
  float l = length(d);
  vec2 dir = l > 1e-4 ? d / l : vec2(1.0, 0.0);
  vec2 perp = vec2(-dir.y, dir.x);
  bool orbit = aData.w < 0.5;
  // depth cue: view distance relative to the sun's, eased out in the close-up (where the fake DoF takes over)
  float near = length(cameraPosition) / max(-mvA.z, 0.05);
  near = mix(1.0, clamp(near, 0.4, 2.0), orbit ? 1.0 - uDof : 0.0);
  float dW = pow(near, 1.1);
  float dB = pow(near, 1.7);
  // the sun's glow: rings dim where they pass over it in screen space
  vec4 cs = projectionMatrix * modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  vec2 sd = (ca.xy / ca.w - cs.xy / cs.w) * uRes * 0.5 / (uRes.y * 0.5);
  float glow = exp(-dot(sd, sd) / 0.045);
  int li = int(aData.z + 0.5);
  float behind = mod(uAng[li] - aData.x * 6.2831853, 6.2831853);
  float trail = orbit && behind < 1.5 ? pow(1.0 - behind / 1.5, 2.2) * smoothstep(0.0, 0.05, behind) : 0.0;
  float wpx = uWidth * uPR * (orbit ? clamp(dW, 0.6, 1.7) * (1.0 + 0.9 * trail) : 1.6 * aData.x) * (1.0 + 2.2 * blur);
  vec2 off = perp * aData.y * wpx / (uRes * 0.5);
  gl_Position = ca + vec4(off * ca.w, 0.0, 0.0);
  vT = aData.x;
  vSide = aData.y;
  vProg = uProg[li];
  vAl = uAl[li];
  if (orbit && uCopyAmt > 0.0) {
    vec2 nd = (ca.xy / max(ca.w, 1e-3) - uCopyMask.xy) / uCopyMask.zw;
    vAl *= 1.0 - 0.92 * uCopyAmt * (1.0 - smoothstep(0.75, 1.25, length(nd)));
  }
  vAng = uAng[li];
  vRad = length(position);
  vBlur = blur;
  vK = aData.w;
  vCol = aColor;
  vTrail = trail;
  vDepth = orbit ? clamp(dB, 0.3, 1.5) * (1.0 - 0.7 * glow) : 1.0;
  if (vAl < 0.002) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}
`;
export const lineFrag = /* glsl */ `
uniform float uTime;
uniform float uIdle;
in float vT;
in float vSide;
in float vProg;
in float vAl;
in float vK;
in float vAng;
in float vRad;
in float vBlur;
in float vDepth;
in float vTrail;
in vec3 vCol;
out vec4 fragColor;
void main() {
  float across = exp(-vSide * vSide * 2.6 / (1.0 + 1.6 * vBlur)) / (1.0 + 1.6 * vBlur);
  vec3 col;
  float a;
  if (vK < 0.5) {
    float shown = 1.0 - smoothstep(vProg - 0.012, vProg, vT);
    if (shown <= 0.0) discard;
    float head = vProg < 0.999 ? exp(-pow((vT - vProg) * 16.0, 2.0)) : 0.0;
    float rad = 1.5 / (1.0 + 0.2 * vRad); // brighter near the sun, fading outward
    // faint dashed base: dash count rounded per orbit so it closes; slow shimmer drifts along the ring (idle only)
    float dn = floor(vRad * 14.0 + 0.5) * 2.0;
    float ph = vT * dn - uIdle * uTime * 0.06;
    float dash = smoothstep(0.35, 0.75, 1.0 - abs(fract(ph) * 2.0 - 1.0));
    float shim = 1.0 + uIdle * 0.35 * sin(uTime * 0.7 + vT * 18.0 + vRad * 3.0);
    float base = 0.13 * rad * (0.45 + 0.75 * dash) * shim;
    vec3 ring = mix(vCol, vec3(1.0), 0.55);
    vec3 tr = mix(vCol, vec3(1.0), 0.1);
    col = (ring * base + tr * (vTrail * 0.8 * rad + head * 0.7)) ;
    a = across * shown * vAl * vDepth;
    fragColor = vec4(col * a, 1.0);
    return;
  }
  a = across * pow(vT, 1.7) * vAl;
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
uniform float uPool;
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
  if (uPool > 0.001) {
    // a very soft warm glow pool in the orbital plane around the sun; fades to nothing before the plane's edge
    float pool = 0.075 * exp(-r / 1.2) + 0.03 * exp(-r / 3.4);
    pool *= 1.0 - smoothstep(uR - 2.2, uR, r);
    col += vec3(1.0, 0.66, 0.34) * pool * uPool;
  }
  if (uPulseA > 0.001) {
    float aa = max(fwidth(r), 1e-4);
    float line = 1.0 - smoothstep(0.0, 1.5 * aa, abs(r - uPulseR));
    float soft = exp(-pow((r - uPulseR) / 0.09, 2.0)) * 0.1;
    col += vec3(0.84, 0.78, 1.0) * (line * 0.3 + soft) * uPulseA;
  }
  if (uScanVis > 0.001) {
    float th = atan(-vP.y, vP.x);
    float da = mod(uAng - th + 12.566371, 6.283185);
    float perp = r * sin(min(da, 1.5707));
    float aa = max(fwidth(perp), 1e-4);
    float edge = da < 1.5707 ? 1.0 - smoothstep(0.0, 1.4 * aa, abs(perp)) : 0.0;
    float sector = da < 1.6 ? exp(-da * 4.5) * 0.04 : 0.0;
    float radial = (1.0 - smoothstep(uR - 0.9, uR, r)) * smoothstep(0.1, 0.7, r);
    col += vec3(0.55, 0.92, 1.0) * (edge * 0.4 + sector) * radial * uScanVis;
  }
  float dn = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
  col += dn / 255.0 * step(0.002, dot(col, vec3(1.0)));
  fragColor = vec4(col, 1.0);
}
`;
