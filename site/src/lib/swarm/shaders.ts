// SwarmKit particle-swarm shaders (GLSL ES 3.00, via THREE.ShaderMaterial with
// glslVersion THREE.GLSL3). Three injects `#version 300 es`, the built-in
// attributes (position) and matrices (modelViewMatrix, projectionMatrix), and
// maps gl_FragColor to the declared out — so only custom attributes, uniforms
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

in vec3 aFrom;
in vec3 aTo;
in vec3 aColor;
in float aRole;
in float aDelay;
in float aScale;

out vec3 vColor;
out float vAlpha;

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

float easeInOutCubic(float x) {
  return x < 0.5 ? 4.0 * x * x * x : 1.0 - pow(-2.0 * x + 2.0, 3.0) / 2.0;
}

void main() {
  // Per-particle staggered morph: each particle sweeps aDelay*0.35..+0.65 of uMix.
  float t = clamp((uMix - aDelay * 0.35) / 0.65, 0.0, 1.0);
  float te = easeInOutCubic(t);
  vec3 pos = mix(aFrom, aTo, te);

  // Drift field: gentle shimmer at rest, dramatic swirl mid-morph.
  float swirl = 0.06 + 0.35 * sin(3.14159265 * te);
  vec3 drift = vec3(
    snoise(pos * 0.45 + vec3(0.0, uTime * 0.22, uTime * 0.13)),
    snoise(pos * 0.45 + vec3(uTime * 0.17, 0.0, uTime * 0.19)),
    snoise(pos * 0.45 + vec3(uTime * 0.11, uTime * 0.21, 0.0))
  );
  pos += drift * (uDrift * swirl);

  // Pointer repulsion: push particles within radius 1.6 away, smooth falloff.
  vec3 delta = pos - uPointer;
  float dist = length(delta);
  float fall = 1.0 - smoothstep(0.0, 1.6, dist);
  pos += (delta / max(dist, 0.001)) * (fall * fall * 0.6 * uPointerOn);

  // Colour: unify toward merged gold-white, scan plane toward verified mint.
  vec3 col = mix(aColor, uMerged, uUnify);
  float below = 1.0 - smoothstep(uScanY - 0.001, uScanY, pos.y);
  col = mix(col, uVerified, below * 0.6);
  float band = 1.0 - smoothstep(0.0, 0.25, abs(pos.y - uScanY));
  col += vec3(1.0) * (band * 0.9);
  vColor = col;
  vAlpha = 1.0 + band * 0.5;

  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mv;
  float pulse = aRole < 0.5 ? 1.0 + 0.12 * sin(uTime * 2.0) : 1.0;
  gl_PointSize = uSize * aScale * pulse * uPixelRatio * (300.0 / max(-mv.z, 0.1));
}
`;

export const fragmentShader = /* glsl */ `
in vec3 vColor;
in float vAlpha;

void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c) * 2.0;
  if (d > 1.0) discard;
  float a = exp(-d * d * 6.0) * 0.9 + exp(-d * 3.0) * 0.25;
  gl_FragColor = vec4(vColor, a * vAlpha);
}
`;
