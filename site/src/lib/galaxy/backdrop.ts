// Far procedural backdrop: a faint Milky-Way band with dust lanes plus three dim nebula clouds.
// One full-screen triangle at max depth; the fragment shader rebuilds the world view direction from the camera
// rotation, so the sky never translates (infinitely far) but rotates correctly against the system. No assets.
import {
  AdditiveBlending, BufferAttribute, BufferGeometry, GLSL3, Matrix3, Mesh, Object3D, PerspectiveCamera,
  ShaderMaterial, Vector4,
} from 'three';
import { PALETTE, type Tier } from './shared';

export interface Backdrop {
  object3d: Object3D;
  update(camera: PerspectiveCamera, timeSec: number, amount: number): void;
  dispose(): void;
}

const vert = /* glsl */ `
uniform mat4 uInvProj;
uniform mat3 uCamRot;
out vec3 vDir;
out vec2 vNdc;
void main() {
  vNdc = position.xy;
  vec4 v = uInvProj * vec4(position.xy, 1.0, 1.0);
  vDir = uCamRot * (v.xyz / v.w);
  gl_Position = vec4(position.xy, 1.0, 1.0);
}
`;

const frag = /* glsl */ `
precision highp float;
uniform float uTime;
uniform float uAmount;
uniform float uOctaves; // 5 high, 4 medium, 3 low
uniform vec4 uCopyMask; // NDC ellipse cx, cy, rx, ry; rx <= 0 = off
uniform vec3 uTeal;
uniform vec3 uViolet;
uniform vec3 uAmber;
in vec3 vDir;
in vec2 vNdc;
out vec4 outColor;

float hash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float noise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash(i), hash(i + vec3(1, 0, 0)), f.x), mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x), mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y),
    f.z);
}
float fbm(vec3 p) {
  float s = 0.0;
  float a = 0.5;
  mat3 rot = mat3(0.00, 0.80, 0.60, -0.80, 0.36, -0.48, -0.60, -0.48, 0.64);
  for (int i = 0; i < 5; i++) {
    if (float(i) >= uOctaves) break;
    s += a * noise(p);
    p = rot * p * 2.03 + 11.7;
    a *= 0.5;
  }
  return s;
}

void main() {
  vec3 d = normalize(vDir);
  // Slow drift: rotate the noise domain a hair around the galactic axis; static when uTime = 0.
  float t = uTime * 0.004;
  vec3 q = vec3(d.x * cos(t) - d.z * sin(t), d.y, d.x * sin(t) + d.z * cos(t));

  // Galactic plane: tilted so the band crosses the system view on a diagonal.
  vec3 n = normalize(vec3(0.5, 0.8, -0.36));
  vec3 u = normalize(cross(n, vec3(0.0, 0.0, 1.0)));
  vec3 w = cross(n, u);
  float b = dot(d, n);
  float l = atan(dot(d, w), dot(d, u));
  // Warp the plane so the band is not a perfect great circle.
  float warp = (fbm(q * 1.3 + 3.0) - 0.5) * 0.30;
  float bb = b + warp + 0.04;

  float core = exp(-bb * bb / 0.030); // wide glow
  float thin = exp(-bb * bb / 0.0045); // bright inner spine
  float clump = fbm(q * 3.2 + 7.0);
  float clump2 = fbm(q * 7.5 + 19.0);
  // Brighter toward a galactic-centre longitude, but never zero elsewhere.
  float bulge = 0.65 + 0.35 * cos(l - 0.6);
  float glow = (core * 0.55 + thin * 0.9) * (0.12 + 2.2 * clump * clump) * bulge;
  glow += thin * smoothstep(0.55, 0.9, clump2) * 0.5; // unresolved star clouds

  // Dust lane: a darker ridge slightly off the spine, broken up by noise.
  float lane = exp(-pow(bb - 0.012 + (fbm(q * 4.5 + 31.0) - 0.5) * 0.05, 2.0) / 0.0012);
  float laneMask = lane * smoothstep(0.30, 0.65, fbm(q * 2.6 + 41.0) + 0.25);
  glow *= 1.0 - 0.8 * laneMask;

  glow *= 0.7 + 0.6 * noise(q * 22.0); // fine star-cloud grain

  // Warm core to cool edges.
  vec3 warm = mix(uAmber, vec3(1.0, 0.88, 0.75), 0.3);
  vec3 cool = mix(uViolet, uTeal, 0.5) * vec3(0.8, 0.85, 1.0);
  vec3 band = mix(cool, warm, clamp(thin * 0.8 + core * 0.25, 0.0, 1.0)) * glow;

  // Three large dim nebulae in lane hues, tied to fixed sky directions.
  vec3 c1 = normalize(vec3(-0.55, -0.05, -0.85));
  vec3 c2 = normalize(vec3(0.6, -0.5, -0.7));
  vec3 c3 = normalize(vec3(0.25, 0.3, -0.95));
  float n1 = smoothstep(0.80, 0.99, dot(d, c1));
  float n2 = smoothstep(0.80, 0.99, dot(d, c2));
  float n3 = smoothstep(0.82, 0.99, dot(d, c3));
  float f1 = fbm(q * 2.2 + 53.0);
  float f2 = fbm(q * 2.6 + 67.0);
  float f3 = fbm(q * 3.0 + 79.0);
  vec3 neb = uTeal * n1 * smoothstep(0.30, 0.75, f1) * 0.55
           + uViolet * n2 * smoothstep(0.30, 0.75, f2) * 0.65
           + uAmber * n3 * smoothstep(0.35, 0.80, f3) * 0.28;

  vec3 col = (band * 0.075 + neb * 0.07);
  // Hard ceiling keeps peak linear around 0.05 so bloom never grabs it.
  col = min(col, vec3(0.05));

  if (uCopyMask.z > 0.0) {
    vec2 e = (vNdc - uCopyMask.xy) / uCopyMask.zw;
    col *= mix(0.25, 1.0, smoothstep(0.6, 1.2, length(e)));
  }

  // Tiny hash dither so the dim gradient does not band in 8 bit.
  float dn = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
  col = max(col * uAmount + dn * 0.0012 * step(0.0005, uAmount), 0.0);
  outColor = vec4(col, 1.0);
}
`;

export function createBackdrop(tier: Tier): Backdrop {
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  const mat = new ShaderMaterial({
    uniforms: {
      uInvProj: { value: new PerspectiveCamera().projectionMatrixInverse },
      uCamRot: { value: new Matrix3() },
      uTime: { value: 0 },
      uAmount: { value: 0 },
      uOctaves: { value: tier === 'high' ? 5 : tier === 'medium' ? 4 : 3 },
      uCopyMask: { value: new Vector4(0, 0, 0, 0) },
      uTeal: { value: PALETTE.opencode },
      uViolet: { value: PALETTE.opus },
      uAmber: { value: PALETTE.agy },
    },
    vertexShader: vert,
    fragmentShader: frag,
    glslVersion: GLSL3,
    transparent: true,
    blending: AdditiveBlending,
    depthTest: false,
    depthWrite: false,
  });
  const mesh = new Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1000;
  mesh.visible = false;
  const rot = new Matrix3();

  return {
    object3d: mesh,
    update(camera, timeSec, amount) {
      const a = Math.min(1, Math.max(0, amount));
      mesh.visible = a > 0.001;
      if (!mesh.visible) return;
      camera.updateMatrixWorld();
      rot.setFromMatrix4(camera.matrixWorld);
      mat.uniforms.uCamRot.value.copy(rot);
      mat.uniforms.uInvProj.value.copy(camera.projectionMatrixInverse);
      mat.uniforms.uTime.value = timeSec;
      mat.uniforms.uAmount.value = a;
    },
    dispose() {
      geo.dispose();
      mat.dispose();
    },
  };
}
