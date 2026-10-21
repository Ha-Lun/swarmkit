// GLSL for the offline nebula renderer (WebGL2, GLSL ES 3.00). The field follows src/lib/galaxy/nebula-volume.ts (lobes, double
// domain warp, ridged filaments, dust lanes, ionisation front, knot) with three changes for the offline look:
//  - gradient noise on an integer pcg3d hash with the whole domain rotated by an off-axis rotation (value noise and an
//    unrotated first octave were the axis-aligned streaks), and every octave rotated again;
//  - the baked 3D texture is 512^3 with the octaves capped at its Nyquist; finer structure is analytic in the march (three
//    ridged octaves, faded out below the pixel footprint) and is averaged by the jittered frames;
//  - the bubble: the same gas with the cavity carved at cavR and the swept-up gas piled into a wall (radial remap).

export const NOISE = /* glsl */ `
uvec3 pcg3d(uvec3 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v;
}
// a fixed off-axis rotation of the whole noise domain (axis (0.37, 0.81, 0.45), 0.93 rad): no lattice axis lines up with y
const mat3 GR = mat3(0.6531, 0.4826, -0.5835, -0.2405, 0.8629, 0.4445, 0.7180, -0.1500, 0.6796);
vec3 grad3(ivec3 c) {
  uvec3 h = pcg3d(uvec3(c + 32768));
  vec3 g = vec3(h >> 8u) * (2.0 / 16777216.0) - 1.0;
  return g * inversesqrt(max(dot(g, g), 0.05));
}
// gradient noise, ~0..1 centred on 0.5 (about the spread of the value noise it replaces)
float noise(vec3 x) {
  x = GR * x;
  vec3 i = floor(x);
  vec3 f = x - i;
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  ivec3 c = ivec3(i);
  float a = dot(grad3(c), f);
  float b = dot(grad3(c + ivec3(1, 0, 0)), f - vec3(1, 0, 0));
  float cc = dot(grad3(c + ivec3(0, 1, 0)), f - vec3(0, 1, 0));
  float d = dot(grad3(c + ivec3(1, 1, 0)), f - vec3(1, 1, 0));
  float e = dot(grad3(c + ivec3(0, 0, 1)), f - vec3(0, 0, 1));
  float ff = dot(grad3(c + ivec3(1, 0, 1)), f - vec3(1, 0, 1));
  float g = dot(grad3(c + ivec3(0, 1, 1)), f - vec3(0, 1, 1));
  float h = dot(grad3(c + ivec3(1, 1, 1)), f - vec3(1, 1, 1));
  float n = mix(mix(mix(a, b, u.x), mix(cc, d, u.x), u.y), mix(mix(e, ff, u.x), mix(g, h, u.x), u.y), u.z);
  return clamp(0.5 + 1.05 * n, 0.0, 1.0);
}
`;

const vec3s = (c) => `vec3(${c.map((v) => v.toFixed(4)).join(', ')})`;
export const lobeConsts = (cfg) => `
const vec3 LC[${cfg.lobes.length}] = vec3[${cfg.lobes.length}](${cfg.lobes.map((l) => vec3s(l.c)).join(', ')});
const vec3 LS[${cfg.lobes.length}] = vec3[${cfg.lobes.length}](${cfg.lobes.map((l) => vec3s(l.s)).join(', ')});
const float LM[${cfg.lobes.length}] = float[${cfg.lobes.length}](${cfg.lobes.map((l) => l.m.toFixed(3)).join(', ')});
const float KNOT_R = ${cfg.knotR.toFixed(3)};
const vec3 RIMC = ${vec3s(cfg.rim)};
`;

export const fullscreenVert = /* glsl */ `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

// ---- bake: one z slice of the 3D texture per draw (RGBA8: sqrt gas, dust, palette mix, violet fraction) ----------------------
export const bakeFrag = (cfg) => /* glsl */ `#version 300 es
precision highp float;
precision highp int;
uniform float uZ;
uniform float uN;     // texture size
uniform float uVH;    // half extent of the baked cube (world units)
uniform int uMode;    // 0: the nebula as seen from the hero camera; 1: the bubble (cavity carved, wall swept up)
uniform float uRC;    // bubble: cavity radius
uniform float uW;     // bubble: wall thickness (the swept-up gas)
uniform float uRS0;   // bubble: source radius mapped to the inner face
uniform float uRS1;   // bubble: source radius mapped to the outer edge of the wall
uniform float uBias;  // bubble: floor added to the lobe envelope so the wall is a continuous shell
uniform int uSS;      // 1 or 2: supersampling of each voxel (2 = 8 samples)
uniform int uOut;     // 0: the field; 1: the warp offset q - p (smooth, stored at lower resolution for the analytic filaments)
out vec4 outColor;
${lobeConsts(cfg)}
${NOISE}
const mat3 ROT = mat3(0.00, 0.80, 0.60, -0.80, 0.36, -0.48, -0.60, -0.48, 0.64);
float fbm(vec3 p, int oct) {
  float s = 0.0, a = 0.5, n = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= oct) break;
    s += a * noise(p); n += a;
    p = ROT * p * 2.03 + vec3(11.7, 3.1, 7.3);
    a *= 0.5;
  }
  return s / n;
}
// ridged multifractal: thin bright ridges (filaments), each octave weighted by the last so detail gathers on the ridges
float ridged(vec3 p, int oct) {
  float s = 0.0, a = 0.55, n = 0.0, w = 1.0;
  for (int i = 0; i < 8; i++) {
    if (i >= oct) break;
    float r = 1.0 - abs(2.0 * noise(p) - 1.0);
    r *= r;
    s += a * r * w; n += a;
    w = clamp(r * 2.0, 0.0, 1.0);
    p = ROT * p * 2.1 + vec3(5.3, 9.1, 2.7);
    a *= 0.52;
  }
  return s / n;
}
vec4 fieldSrc(vec3 p, float bias, out vec3 qo) {
  qo = p;
  float r = length(p);
  vec3 w = vec3(noise(p * 0.42 + 3.0), noise(p * 0.42 + 17.0), noise(p * 0.42 + 41.0)) - 0.5;
  vec3 pw = p + w * 3.2;
  float env = bias, hue = bias * 0.5;
  for (int k = 0; k < ${cfg.lobes.length}; k++) {
    vec3 d = (pw - LC[k]) / LS[k];
    float g = exp(-0.5 * dot(d, d));
    env += g; hue += g * LM[k];
  }
  if (env < 0.015 && uOut == 0) return vec4(0.0);
  hue /= env;
  vec3 w2 = vec3(fbm(pw * 1.3 + 5.0, 3), fbm(pw * 1.3 + 23.0, 3), fbm(pw * 1.3 + 61.0, 3)) - 0.5;
  vec3 pw2 = pw + w2 * 1.1;
  // a gentle stretch along a warped direction to the star: structure streams toward it but fans and curls
  vec3 rdir = normalize(p / max(r, 0.05) + w2 * 2.6 + 1e-4);
  vec3 q = pw2 - rdir * dot(pw2, rdir) * 0.14;
  qo = q;
  if (uOut == 1) return vec4(0.0);
  float f1 = fbm(q * 1.15, 3);
  float fil = smoothstep(0.22, 0.75, ridged(ROT * q * 1.5 + 9.0, 3));
  float det = fbm(q * 2.6 + 13.0, 2);
  float gas = env * (0.1 + 1.5 * smoothstep(0.4, 0.74, f1) * (0.45 + 0.95 * fil) + 0.9 * fil * smoothstep(0.2, 0.6, f1));
  gas *= 0.3 + 1.5 * det * det * 1.6 * 0.8;
  float lane = pow(1.0 - abs(2.0 * noise(q * 0.85 + 53.0) - 1.0), 7.0);
  float lane2 = pow(1.0 - abs(2.0 * fbm(q * 2.2 + 77.0, 2) - 1.0), 6.0);
  float dust = (smoothstep(0.56, 0.78, fbm(q * 0.9 + 31.0, 3)) * 1.4 + lane * 1.8 + lane2 * 0.9 * smoothstep(0.4, 0.7, f1)) * smoothstep(0.15, 0.7, env);
  float bell = smoothstep(0.25, 0.5, hue) * (1.0 - smoothstep(0.5, 0.75, hue));
  float rimK = 1.0 - smoothstep(0.08, 0.7, env);
  float vio = 1.0 - (1.0 - 0.75 * bell) * (1.0 - 0.5 * rimK);
  return vec4(gas, dust, hue, vio);
}
vec4 fieldAt(vec3 p) {
  vec4 f;
  vec3 q0;
  if (uMode == 0) {
    f = fieldSrc(p, 0.0, q0);
  } else {
    float r = length(p);
    float s = (r - uRC) / uW;
    if (s < -0.12) return vec4(0.0);
    float sc = clamp(s, 0.0, 1.0);
    // the gas that stood inside the bubble is swept up into the wall: its radial extent is compressed onto [uRC, uRC + uW],
    // keeping the direction, so the filaments that streamed toward the star now run along the line of sight
    float rs = mix(uRS0, uRS1, sc);
    f = fieldSrc(p / max(r, 1e-3) * rs, uBias, q0);
    float prof = smoothstep(-0.12, 0.06, s) * (0.3 + 1.25 * exp(-3.2 * s)) * (1.0 - smoothstep(0.72, 1.0, s));
    f.x *= prof;
    f.y *= smoothstep(-0.05, 0.25, s) * (1.0 - 0.5 * smoothstep(0.7, 1.0, s));
  }
  return vec4(sqrt(clamp(f.x * 0.25, 0.0, 1.0)), clamp(f.y * 0.25, 0.0, 1.0), f.z, f.w);
}
void main() {
  float vox = 2.0 * uVH / uN;
  vec3 p0 = (vec3(gl_FragCoord.xy / uN, uZ) * 2.0 - 1.0) * uVH;
  if (uOut == 1) {
    vec3 q0;
    fieldSrc(p0, 0.0, q0);
    outColor = vec4(q0 - p0, 1.0);
    return;
  }
  // box filter over the voxel (uSS^3 samples): the field has content above the voxel Nyquist (sharpened ridges, razor lanes)
  // that would otherwise alias into a regular hatch
  vec4 acc = vec4(0.0);
  for (int k = 0; k < 2; k++) for (int j = 0; j < 2; j++) for (int i = 0; i < 2; i++) {
    if (uSS < 2 && (i + j + k) > 0) continue;
    vec3 o = uSS < 2 ? vec3(0.0) : (vec3(float(i), float(j), float(k)) - 0.5) * 0.5 * vox;
    acc += fieldAt(p0 + o);
  }
  vec4 o = acc / (uSS < 2 ? 1.0 : 8.0);
  // triangular dither of one 8-bit step, so the quantised density does not show as contour lines once the filtering stretches it
  uvec3 hh = pcg3d(uvec3(uvec2(gl_FragCoord.xy), uint(uZ * uN)));
  vec3 dn = (vec3(hh >> 8u) + vec3(pcg3d(hh + 7u) >> 8u)) * (1.0 / 16777216.0) - 1.0;
  outColor = vec4(o.rgb + dn / 255.0, o.a);
}
`;

// ---- march: per pixel, per frame, MRT of up to 5 depth slabs (nearest slab first), each with its own transmittance -----------
export const marchFrag = (cfg) => /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler3D;
uniform sampler3D uVol;
uniform sampler3D uWarp;
uniform float uVH;
uniform float uWH;           // half extent of the warp texture (source space)
uniform vec4 uMap;           // bubble source-radius map: cavity radius, wall width, rs0, rs1
uniform vec3 uCamPos, uRight, uUp, uFwd;
uniform float uTanY, uAspect;
uniform vec2 uFull;          // full image size in px
uniform vec2 uTile;          // tile origin in px
uniform vec2 uJit;           // sub-pixel offset of this frame, -0.5..0.5
uniform uint uFrame;
uniform int uFace;           // -1: pinhole camera; 0..5: cube face (GL order +x -x +y -y +z -z, three flip applied)
uniform float uPixAng;       // world width of one pixel at unit distance
uniform int uSteps;
uniform int uNSlab;
uniform int uSlabMode;       // 0: slabs on view depth (planes facing the camera); 1: on radius from the origin
uniform float uB[4];         // slab boundaries, ascending along the ray
uniform float uTMin;         // start the march no nearer than this (the carved cavity is skipped)
uniform float uGain;
uniform float uCavR;
uniform float uWall;
uniform float uCollapse;
uniform float uKnot;
uniform int uBubble;
uniform float uDet;          // analytic fine-detail amplitude
uniform float uDust;         // dust absorption coefficient (the live march uses 3.4 on a blurred 160^3 bake)
uniform int uMoment;         // 1: accumulate (sum w*coord, sum w) per slab instead of colour (centroids of the layers)
uniform vec3 uTeal, uAmber;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
layout(location = 2) out vec4 o2;
layout(location = 3) out vec4 o3;
layout(location = 4) out vec4 o4;
${lobeConsts(cfg)}
${NOISE}
float rnd(uvec3 v) { return float(pcg3d(v).x >> 8u) * (1.0 / 16777216.0); }
const mat3 ROT = mat3(0.00, 0.80, 0.60, -0.80, 0.36, -0.48, -0.60, -0.48, 0.64);
// the filament series continued: the same ridged multifractal as the bake (3 octaves), carried on to 6 octaves on the same warped
// domain q, so the extra structure follows the filaments instead of being isotropic grain. Octaves finer than ~2.5 px fade out.
// Returns the ratio of the 6-octave filament weight to the baked 3-octave one.
float fineRatio(vec3 q, float pxw) {
  vec3 p = ROT * q * 1.5 + 9.0;
  float s = 0.0, a = 0.55, n = 0.0, w = 1.0, f = 1.5;
  float s3 = 0.0, n3 = 0.0;
  for (int i = 0; i < 6; i++) {
    float vis = i < 3 ? 1.0 : 1.0 - smoothstep(0.3, 0.6, pxw * f);
    float r = 1.0 - abs(2.0 * noise(p) - 1.0);
    r *= r;
    s += a * r * w * vis; n += a * vis;
    if (i == 2) { s3 = s; n3 = n; }
    w = clamp(r * 2.0, 0.0, 1.0);
    p = ROT * p * 2.1 + vec3(5.3, 9.1, 2.7);
    a *= 0.52; f *= 2.1;
  }
  float lo = smoothstep(0.22, 0.75, s3 / n3);
  float hi = smoothstep(0.22, 0.75, s / n);
  return clamp((0.2 + hi * 1.4) / (0.2 + lo * 1.4), 0.2, 4.0);
}
vec3 faceDir(int face, float u, float v) {
  vec3 d;
  if (face == 0) d = vec3(1.0, -v, -u);
  else if (face == 1) d = vec3(-1.0, -v, u);
  else if (face == 2) d = vec3(u, 1.0, v);
  else if (face == 3) d = vec3(u, -1.0, -v);
  else if (face == 4) d = vec3(u, -v, 1.0);
  else d = vec3(-u, -v, -1.0);
  return normalize(vec3(-d.x, d.y, d.z)); // three flips x for CubeTexture backgrounds
}
void main() {
  vec2 px = uTile + vec2(gl_FragCoord.x - 0.5, gl_FragCoord.y - 0.5); // image row 0 = top
  vec2 pj = px + 0.5 + uJit;
  vec3 rd;
  if (uFace < 0) {
    float nx = 2.0 * pj.x / uFull.x - 1.0;
    float ny = 1.0 - 2.0 * pj.y / uFull.y;
    rd = normalize(uFwd + uRight * (nx * uTanY * uAspect) + uUp * (ny * uTanY));
  } else {
    rd = faceDir(uFace, 2.0 * pj.x / uFull.x - 1.0, 2.0 * pj.y / uFull.y - 1.0);
  }
  vec4 L[5];
  for (int m = 0; m < 5; m++) L[m] = vec4(0.0);
  vec3 inv = 1.0 / (rd + vec3(1e-6));
  vec3 ta = (-vec3(uVH) - uCamPos) * inv;
  vec3 tb2 = (vec3(uVH) - uCamPos) * inv;
  vec3 tn = min(ta, tb2);
  vec3 tf = max(ta, tb2);
  float t0 = max(max(max(tn.x, tn.y), tn.z), uTMin);
  float t1 = min(min(tf.x, tf.y), tf.z);
  float rdf = dot(rd, uFwd);
  if (t1 > t0) {
    float tb[6];
    tb[0] = t0; tb[5] = t1;
    for (int k = 0; k < 4; k++) {
      float tt = uSlabMode == 0 ? uB[k] / max(rdf, 1e-3) : uB[k];
      tb[k + 1] = k + 1 < uNSlab ? clamp(tt, t0, t1) : t1;
    }
    float dt0 = (t1 - t0) / float(uSteps);
    float kr = KNOT_R * (1.0 - 0.86 * uCollapse);
    for (int m = 0; m < 5; m++) {
      if (m >= uNSlab) break;
      float len = tb[m + 1] - tb[m];
      if (len < 1e-4) continue;
      int n = int(ceil(len / dt0));
      float dt = len / float(n);
      float t = tb[m] + dt * rnd(uvec3(uvec2(px), uFrame * 8u + uint(m)));
      vec3 acc = vec3(0.0);
      float T = 1.0;
      for (int i = 0; i < 1100; i++) {
        if (i >= n) break;
        vec3 p = uCamPos + rd * t;
        float tc = t;
        t += dt;
        float r = length(p);
        vec4 s = texture(uVol, p * (0.5 / uVH) + 0.5);
        float gB = s.r * s.r * 4.0;
        float g = gB;
        float du = s.g * 4.0;
        vec3 col = vec3(0.0);
        float sig = 0.0;
        if (g > 0.003 || du > 0.008) {
          if (uDet > 0.0) {
            vec3 ps = p;
            float pxw = tc * uPixAng;
            if (uBubble == 1) {
              float sc = clamp((r - uMap.x) / uMap.y, 0.0, 1.0);
              float rs = mix(uMap.z, uMap.w, sc);
              ps = p / max(r, 1e-3) * rs;
              pxw *= rs / max(r, 1e-3);
            }
            vec3 q = ps + texture(uWarp, ps * (0.5 / uWH) + 0.5).xyz;
            float fr = fineRatio(q, pxw);
            g *= mix(1.0, fr, uDet * smoothstep(0.02, 0.15, gB));
          }
          float lit, wall;
          if (uBubble == 0) {
            lit = 1.0 / (1.0 + pow(r / 2.4, 2.0));
            wall = 0.0;
          } else {
            float d = r - uCavR;
            lit = 0.55 * exp(-d / 2.4);
            wall = exp(-pow((d - 0.25) / 0.7, 2.0));
          }
          vec3 base = mix(mix(uTeal, uAmber, s.b), RIMC, s.a);
          base = mix(base, vec3(0.9, 0.97, 1.0), 0.3 * lit + 0.25 * wall);
          float front = 0.0, scat = 0.0;
          if (g > 0.03 && r > 0.3) {
            vec3 dir = p / r;
            vec4 sS = texture(uVol, (p - dir * 0.5) * (0.5 / uVH) + 0.5);
            front = clamp((gB - sS.r * sS.r * 4.0) * 1.6, 0.0, 1.0);
            if (uBubble == 0) {
              float hg = 0.6975 / pow(1.3025 - 1.1 * dot(dir, -rd), 1.5);
              scat = hg * 0.12 / (1.0 + pow(r / 5.0, 2.0));
            }
          }
          float em = g * (0.5 + 1.2 * lit + 2.8 * wall * (1.0 + 0.85 * uWall))
            + g * g * (0.28 + 0.9 * (lit + wall))
            + g * scat
            + g * front * (0.5 + 1.6 * lit) * 0.8;
          col = base * em;
          // the young star's light clears the dust around the knot
          if (uBubble == 0) du *= smoothstep(1.0, 3.8, r);
          sig = g * 0.35 + du * uDust;
        }
        if (uBubble == 0) {
          float kn = exp(-0.5 * (r * r) / (kr * kr)) * uKnot * (3.2 + 14.0 * uCollapse) * (kr / KNOT_R);
          col += kn * mix(vec3(0.85, 0.7, 1.0), vec3(1.0, 0.97, 0.95), uCollapse);
        }
        if (uMoment == 1) {
          float wl = dot(col, vec3(0.3, 0.55, 0.15));
          float zc = uSlabMode == 0 ? tc * rdf : tc;
          acc += T * dt * vec3(wl * zc, wl, 0.0);
        } else acc += T * col * dt;
        T *= exp(-sig * dt);
        if (T < 0.01) break;
      }
      L[m] = vec4(acc * uGain, 1.0 - T);
    }
  }
  o0 = L[0]; o1 = L[1]; o2 = L[2]; o3 = L[3]; o4 = L[4];
}
`;
