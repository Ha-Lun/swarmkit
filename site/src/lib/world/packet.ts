import {
  AdditiveBlending, BufferAttribute, BufferGeometry, CatmullRomCurve3, Color, Group, Mesh, Points, ShaderMaterial,
  Vector3, type Camera,
} from 'three';
import type { Look } from './config';
import type { Lattice } from './honeycomb';

const TRAIL_POINTS = 48;

export interface Packet {
  group: Group;
  /** phase is 0..1 along the loop; the trail is sampled backwards from it, so it is frame-rate independent */
  update(phase: number, camera: Camera, cfg: Look['packet']): void;
  setColor(hex: string): void;
  /** viewport height in device px, for point-size scaling */
  setViewportHeight(px: number): void;
  dispose(): void;
}

/** Test curve: a closed spline through agent cell tops, derived from the lattice (never hardcoded). */
export function createTestCurve(lattice: Lattice, count = 8): CatmullRomCurve3 {
  const agents = lattice.cells.filter((c) => c.agent && c.agent.band !== 'satellite');
  const core = agents.find((c) => c.agent!.band === 'core');
  const ring = agents.filter((c) => c !== core).sort((a, b) => Math.atan2(a.z, a.x) - Math.atan2(b.z, b.x));
  const pick = Array.from({ length: Math.min(count, ring.length) }, (_, i) => ring[Math.floor((i * ring.length) / count)]);
  if (core) pick.splice(Math.ceil(pick.length / 2), 0, core);
  const pts = pick.map((c) => new Vector3(c.x, c.height, c.z));
  return new CatmullRomCurve3(pts, true, 'centripetal');
}

const headVert = /* glsl */ `
  uniform float uSize;
  void main() {
    gl_PointSize = uSize;
    gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
  }`;
const headFrag = /* glsl */ `
  uniform vec3 uColor;
  uniform float uBright;
  void main() {
    float d = length( gl_PointCoord - 0.5 ) * 2.0;
    if ( d > 1.0 ) discard;
    float halo = pow( 1.0 - d, 2.5 );
    float core = pow( 1.0 - d, 8.0 );
    vec3 c = uColor * halo * uBright + mix( uColor, vec3( 1.0 ), 0.35 ) * core * uBright;
    gl_FragColor = vec4( c, 1.0 );
    #include <colorspace_fragment>
  }`;
const trailVert = /* glsl */ `
  attribute float aFade;
  varying float vFade;
  void main() {
    vFade = aFade;
    gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
  }`;
const trailFrag = /* glsl */ `
  uniform vec3 uColor;
  uniform float uBright;
  varying float vFade;
  void main() {
    gl_FragColor = vec4( uColor * vFade * uBright * 0.85, 1.0 );
    #include <colorspace_fragment>
  }`;

export function createPacket(curve: CatmullRomCurve3, color: string, cfg: Look['packet']): Packet {
  const group = new Group();
  const colour = new Color(color);

  const headGeo = new BufferGeometry();
  headGeo.setAttribute('position', new BufferAttribute(new Float32Array(3), 3));
  const headMat = new ShaderMaterial({
    uniforms: { uColor: { value: colour }, uBright: { value: cfg.headBrightness }, uSize: { value: cfg.headSize } },
    vertexShader: headVert, fragmentShader: headFrag,
    transparent: true, blending: AdditiveBlending, depthWrite: false,
  });
  const head = new Points(headGeo, headMat);
  head.frustumCulled = false;

  const N = TRAIL_POINTS;
  const trailGeo = new BufferGeometry();
  const pos = new Float32Array(N * 2 * 3);
  const fade = new Float32Array(N * 2);
  const index: number[] = [];
  for (let i = 0; i < N - 1; i++) {
    const a = i * 2;
    index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  trailGeo.setAttribute('position', new BufferAttribute(pos, 3));
  trailGeo.setAttribute('aFade', new BufferAttribute(fade, 1));
  trailGeo.setIndex(index);
  const trailMat = new ShaderMaterial({
    uniforms: { uColor: { value: colour }, uBright: { value: cfg.headBrightness } },
    vertexShader: trailVert, fragmentShader: trailFrag,
    transparent: true, blending: AdditiveBlending, depthWrite: false,
  });
  const trail = new Mesh(trailGeo, trailMat);
  trail.frustumCulled = false;
  group.add(trail, head);

  let viewportScale = 1;
  const pts = Array.from({ length: N }, () => new Vector3());
  const tan = new Vector3(), view = new Vector3(), side = new Vector3(), world = new Vector3();

  return {
    group,
    setColor: (hex) => colour.set(hex),
    setViewportHeight: (px) => (viewportScale = px / 1080),
    update(phase, camera, c) {
      headMat.uniforms.uBright.value = trailMat.uniforms.uBright.value = c.headBrightness;
      headMat.uniforms.uSize.value = c.headSize * viewportScale;
      group.position.y = c.height;
      for (let i = 0; i < N; i++) {
        const u = (((phase - (i / (N - 1)) * c.trailLength) % 1) + 1) % 1;
        curve.getPointAt(u, pts[i]);
      }
      headGeo.attributes.position.setXYZ(0, pts[0].x, pts[0].y, pts[0].z);
      headGeo.attributes.position.needsUpdate = true;
      for (let i = 0; i < N; i++) {
        const prev = pts[Math.max(0, i - 1)], next = pts[Math.min(N - 1, i + 1)];
        tan.subVectors(prev, next).normalize();
        world.copy(pts[i]).add(group.position);
        view.subVectors(camera.position, world);
        side.crossVectors(tan, view).normalize().multiplyScalar(c.trailWidth * 0.5 * (1 - i / (N - 1)));
        const p = pts[i];
        pos.set([p.x + side.x, p.y + side.y, p.z + side.z, p.x - side.x, p.y - side.y, p.z - side.z], i * 6);
        fade[i * 2] = fade[i * 2 + 1] = Math.pow(1 - i / (N - 1), c.trailFade);
      }
      trailGeo.attributes.position.needsUpdate = true;
      trailGeo.attributes.aFade.needsUpdate = true;
    },
    dispose() {
      headGeo.dispose(); headMat.dispose(); trailGeo.dispose(); trailMat.dispose();
    },
  };
}
