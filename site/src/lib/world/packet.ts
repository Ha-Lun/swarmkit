import {
  BufferAttribute, BufferGeometry, CatmullRomCurve3, Color, DoubleSide, Group, Mesh, Points, ShaderMaterial, Vector3, type Camera,
} from 'three';
import { look, type Look } from './config';
import { cellTopOf, type Lattice } from './honeycomb';

// The comet: a large hard bright head, a camera-facing tail that tapers to a point and lengthens with the speed it is seen
// to move at, and a few short-lived sparks it sheds. Everything is opaque with crisp edges (no additive blending, no soft
// sprite), and it is the only thing on the site that uses the accent.
const TAIL_POINTS = 40;
const MAX_SPARKS = 20;

/** Anything the comet can travel along: distance (world units) to a point. Routes clamp; loops wrap. */
export interface PathSource {
  readonly length: number;
  pointAt(d: number, out: Vector3): Vector3;
}

export interface Packet {
  group: Group;
  /** draw the comet with its head at distance d along the path; dt (s) drives the observed speed and the sparks */
  update(path: PathSource, d: number, camera: Camera, cfg: Look['packet'], fade: number, dt: number): void;
  /** forget the observed speed and clear the sparks (after a route change or a jump) */
  reset(): void;
  setColor(hex: string): void;
  /** viewport height in device px, for point-size scaling */
  setViewportHeight(px: number): void;
  dispose(): void;
}

/** Test curve: a closed spline through agent cell tops on the globe, derived from the lattice (never hardcoded). */
export function createTestCurve(lattice: Lattice, count = 8): CatmullRomCurve3 {
  const agents = lattice.cells.filter((c) => c.agent && c.agent.band !== 'satellite');
  const core = agents.find((c) => c.agent!.band === 'core');
  const ring = agents.filter((c) => c !== core).sort((a, b) => Math.atan2(a.pos.y, a.pos.x) - Math.atan2(b.pos.y, b.pos.x));
  const pick = Array.from({ length: Math.min(count, ring.length) }, (_, i) => ring[Math.floor((i * ring.length) / count)]);
  if (core) pick.splice(Math.ceil(pick.length / 2), 0, core);
  // the packet height is baked into the curve (routes lift their own points); the test curve reads it once
  const pts = pick.map((c) => { const t = cellTopOf(c); return t.addScaledVector(t.clone().normalize(), look.packet.height); });
  // a great-circle midpoint per hop keeps the closed spline above the surface
  const loop = pts.flatMap((a, i) => {
    const b = pts[(i + 1) % pts.length];
    const mid = a.clone().add(b).normalize().multiplyScalar(Math.max(a.length(), b.length()) + 0.3);
    return [a, mid];
  });
  return new CatmullRomCurve3(loop, true, 'centripetal');
}

const headVert = /* glsl */ `
  uniform float uSize;
  void main() {
    gl_PointSize = uSize;
    gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
  }`;
// a hard disc: a white-hot core, an accent body and a darker outline ring (so it reads on pale tile tops and on dark seams alike), one pixel of edge anti-aliasing and nothing outside it
const headFrag = /* glsl */ `
  uniform vec3 uColor;
  uniform vec3 uHot;
  uniform float uBright;
  uniform float uSize;
  void main() {
    float d = length( gl_PointCoord - 0.5 ) * 2.0;
    float px = 2.0 / max( uSize, 2.0 );
    if ( d > 1.0 ) discard;
    vec3 c = mix( uHot, uColor, smoothstep( 0.45 - px, 0.45 + px, d ) );
    c = mix( c, uColor * 0.4, smoothstep( 0.82 - px, 0.82 + px, d ) ) * uBright;
    gl_FragColor = vec4( c, 1.0 );
    #include <colorspace_fragment>
  }`;
const tailVert = /* glsl */ `
  attribute float aFade;
  varying float vFade;
  void main() {
    vFade = aFade;
    gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
  }`;
const tailFrag = /* glsl */ `
  uniform vec3 uColor;
  uniform vec3 uHot;
  uniform float uBright;
  varying float vFade;
  void main() {
    // solid colour, darker toward the tail end; the taper is geometry, so the edges stay crisp
    gl_FragColor = vec4( mix( uColor * 0.35, mix( uColor, uHot, 0.35 ), vFade ) * uBright, 1.0 );
    #include <colorspace_fragment>
  }`;
const sparkVert = /* glsl */ `
  attribute float aSize;
  uniform float uPx;
  void main() {
    gl_PointSize = aSize * uPx;
    gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
  }`;
const sparkFrag = /* glsl */ `
  uniform vec3 uColor;
  uniform vec3 uHot;
  void main() {
    if ( length( gl_PointCoord - 0.5 ) > 0.5 ) discard;
    gl_FragColor = vec4( mix( uColor, uHot, 0.6 ), 1.0 );
    #include <colorspace_fragment>
  }`;

export function createPacket(color: string, cfg: Look['packet']): Packet {
  const group = new Group();
  const colour = new Color(color);
  const hot = colour.clone().lerp(new Color(1, 1, 1), 0.5);

  const headGeo = new BufferGeometry();
  headGeo.setAttribute('position', new BufferAttribute(new Float32Array(3), 3));
  const headMat = new ShaderMaterial({
    uniforms: { uColor: { value: colour }, uHot: { value: hot }, uBright: { value: cfg.headBrightness }, uSize: { value: cfg.headSize } },
    vertexShader: headVert, fragmentShader: headFrag, fog: false,
  });
  const head = new Points(headGeo, headMat);
  head.frustumCulled = false;

  const N = TAIL_POINTS;
  const tailGeo = new BufferGeometry();
  const pos = new Float32Array(N * 2 * 3);
  const fadeA = new Float32Array(N * 2);
  const index: number[] = [];
  for (let i = 0; i < N - 1; i++) {
    const a = i * 2;
    index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  tailGeo.setAttribute('position', new BufferAttribute(pos, 3));
  tailGeo.setAttribute('aFade', new BufferAttribute(fadeA, 1));
  tailGeo.setIndex(index);
  const tailMat = new ShaderMaterial({
    uniforms: { uColor: { value: colour }, uHot: { value: hot }, uBright: { value: cfg.headBrightness } },
    vertexShader: tailVert, fragmentShader: tailFrag, side: DoubleSide, fog: false,
  });
  const tail = new Mesh(tailGeo, tailMat);
  tail.frustumCulled = false;

  // sparks: a small pool, CPU-simulated, hard dots that shrink to nothing over their life
  const sparkGeo = new BufferGeometry();
  const sPos = new Float32Array(MAX_SPARKS * 3);
  const sSize = new Float32Array(MAX_SPARKS);
  sparkGeo.setAttribute('position', new BufferAttribute(sPos, 3));
  sparkGeo.setAttribute('aSize', new BufferAttribute(sSize, 1));
  const sparkMat = new ShaderMaterial({
    uniforms: { uColor: { value: colour }, uHot: { value: hot }, uPx: { value: 1 } },
    vertexShader: sparkVert, fragmentShader: sparkFrag, fog: false,
  });
  const sparks = new Points(sparkGeo, sparkMat);
  sparks.frustumCulled = false;
  const vel = Array.from({ length: MAX_SPARKS }, () => new Vector3());
  const life = new Float32Array(MAX_SPARKS); // remaining seconds
  const span = new Float32Array(MAX_SPARKS); // total seconds
  let emitAcc = 0;
  let seed = 12345;
  const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) | 0) >>> 0) / 4294967296;

  group.add(tail, sparks, head);

  let viewportScale = 1;
  const pts = Array.from({ length: N }, () => new Vector3());
  const tan = new Vector3(), view = new Vector3(), side = new Vector3(), tmp = new Vector3(), out = new Vector3();
  let lastD = NaN, speed = 0, tailDir = 1, tailLen = look.packet.tailMin;

  return {
    group,
    setColor(hex) { colour.set(hex); hot.copy(colour).lerp(new Color(1, 1, 1), 0.5); },
    setViewportHeight: (px) => (viewportScale = px / 1080),
    reset() {
      lastD = NaN; speed = 0; tailLen = look.packet.tailMin;
      life.fill(0); sSize.fill(0);
      sparkGeo.attributes.aSize.needsUpdate = true;
    },
    update(path, d, camera, c, fade, dt) {
      // observed speed (world units/s) and direction, smoothed; a jump (a new route, a hidden frame) does not count
      if (dt > 0 && Number.isFinite(lastD)) {
        const raw = (d - lastD) / dt;
        const v = Math.abs(raw) < 40 ? raw : 0;
        const k = 1 - Math.exp(-dt * 12);
        speed += (Math.abs(v) - speed) * k;
        if (Math.abs(v) > 0.05) tailDir += (Math.sign(v) - tailDir) * (1 - Math.exp(-dt * 9));
      }
      lastD = d;
      const want = Math.min(c.tailMax, c.tailMin + c.tailGain * speed);
      tailLen += (want - tailLen) * (1 - Math.exp(-dt * 10));

      headMat.uniforms.uBright.value = tailMat.uniforms.uBright.value = c.headBrightness;
      headMat.uniforms.uSize.value = Math.max(2, c.headSize * viewportScale * fade);
      path.pointAt(d, out);
      headGeo.attributes.position.setXYZ(0, out.x, out.y, out.z);
      headGeo.attributes.position.needsUpdate = true;

      for (let i = 0; i < N; i++) path.pointAt(d - tailDir * (i / (N - 1)) * tailLen, pts[i]);
      for (let i = 0; i < N; i++) {
        const prev = pts[Math.max(0, i - 1)], next = pts[Math.min(N - 1, i + 1)];
        tan.subVectors(prev, next);
        if (tan.lengthSq() < 1e-10) tan.set(1, 0, 0);
        tan.normalize();
        view.subVectors(camera.position, pts[i]);
        const u = i / (N - 1);
        side.crossVectors(tan, view).normalize().multiplyScalar(c.tailWidth * 0.5 * fade * Math.pow(1 - u, 0.9));
        const p = pts[i];
        pos.set([p.x + side.x, p.y + side.y, p.z + side.z, p.x - side.x, p.y - side.y, p.z - side.z], i * 6);
        fadeA[i * 2] = fadeA[i * 2 + 1] = Math.pow(1 - u, c.tailFade);
      }
      tailGeo.attributes.position.needsUpdate = true;
      tailGeo.attributes.aFade.needsUpdate = true;

      // sparks: shed from the head while it moves fast, thrown back and a little outward, gone in half a second
      emitAcc += dt * c.sparks * 11 * Math.min(1, Math.max(0, (speed - 0.8) / 2.6));
      path.pointAt(d + 0.02, tmp).sub(out);
      tmp.normalize();
      while (emitAcc >= 1) {
        emitAcc -= 1;
        const s = life.findIndex((l) => l <= 0);
        if (s < 0) break;
        span[s] = life[s] = 0.35 + rnd() * 0.35;
        const outward = out.clone().normalize();
        vel[s].copy(tmp).multiplyScalar(-(0.5 + rnd()) * (0.6 + 0.3 * speed) * Math.sign(tailDir || 1))
          .addScaledVector(outward, 0.5 + rnd() * 0.9)
          .add(side.set(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).multiplyScalar(0.9));
        sPos.set([out.x, out.y, out.z], s * 3);
      }
      for (let s = 0; s < MAX_SPARKS; s++) {
        if (life[s] > 0) {
          life[s] -= dt;
          vel[s].multiplyScalar(Math.exp(-dt * 2.2));
          sPos[s * 3] += vel[s].x * dt; sPos[s * 3 + 1] += vel[s].y * dt; sPos[s * 3 + 2] += vel[s].z * dt;
        }
        sSize[s] = life[s] > 0 ? Math.max(0, 8 * (life[s] / span[s])) * viewportScale * fade : 0;
      }
      sparkGeo.attributes.position.needsUpdate = true;
      sparkGeo.attributes.aSize.needsUpdate = true;
      sparkMat.uniforms.uPx.value = 1;
    },
    dispose() {
      headGeo.dispose(); headMat.dispose(); tailGeo.dispose(); tailMat.dispose(); sparkGeo.dispose(); sparkMat.dispose();
    },
  };
}

/** A closed test curve as a looping path (lookdev): distances wrap. */
export function loopPath(curve: CatmullRomCurve3): PathSource {
  const length = curve.getLength();
  return {
    length,
    pointAt: (d, out) => curve.getPointAt((((d / length) % 1) + 1) % 1, out),
  };
}

