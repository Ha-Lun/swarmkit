import {
  BufferAttribute, BufferGeometry, CatmullRomCurve3, Color, Group, Mesh, MeshNormalMaterial, MeshPhysicalMaterial, MeshStandardMaterial, Points, ShaderMaterial,
  SphereGeometry, Vector3, type Camera,
} from 'three';
import { look, type Look } from './config';
import { cellTopOf, type Lattice } from './honeycomb';

// The comet: a glass orb (frosted, translucent, bright rim, a glowing core inside) trailing a tapered glass tube that lengthens with the speed
// it is seen to move at, and a few short-lived sparks it sheds. Real meshes, studio-lit; alpha-blended (no additive blending, no soft sprite),
// and it is the only thing on the site that uses the accent.
const TAIL_POINTS = 40;
const TAIL_SIDES = 8;
const MAX_SPARKS = 20;

/** Anything the comet can travel along: distance (world units) to a point. Routes clamp; loops wrap. */
export interface PathSource {
  readonly length: number;
  pointAt(d: number, out: Vector3): Vector3;
}

export interface Packet {
  group: Group;
  /** GTAO G-buffer twin of the head and tail (post.ts renders it): without it the AO of the panels behind the comet darkens the comet. The owner
   *  mirrors the globe's spin onto it (like the honeycomb's aoGroup) and its visibility onto `group`'s. */
  aoGroup: Group;
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

  // head: a glass sphere (unit radius, scaled per frame) with a small opaque glowing core inside, which keeps it readable on any background
  const glass = { transparent: true, depthWrite: false, roughness: 0.12, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.05, sheen: 1, sheenRoughness: 0.35, sheenColor: new Color(1, 1, 1), fog: false } as const;
  const headGeo = new SphereGeometry(1, 32, 16);
  const headMat = new MeshPhysicalMaterial({ ...glass, color: colour.clone().lerp(new Color(1, 1, 1), 0.35), emissive: colour, opacity: cfg.glassOpacity });
  const coreMat = new MeshStandardMaterial({ color: colour, emissive: hot, roughness: 0.5, metalness: 0, fog: false });
  const head = new Mesh(headGeo, headMat);
  const core = new Mesh(headGeo, coreMat);
  core.scale.setScalar(0.5);
  core.castShadow = true;
  head.add(core);
  head.renderOrder = 2;
  head.frustumCulled = core.frustumCulled = false;

  // tail: a tube of TAIL_SIDES per ring, rebuilt every frame in globe space; normals are the radial direction of each ring
  const N = TAIL_POINTS, S = TAIL_SIDES;
  const tailGeo = new BufferGeometry();
  const pos = new Float32Array(N * S * 3);
  const nor = new Float32Array(N * S * 3);
  const col = new Float32Array(N * S * 3);
  const index: number[] = [];
  for (let i = 0; i < N - 1; i++) {
    for (let j = 0; j < S; j++) {
      const a = i * S + j, b = i * S + ((j + 1) % S), c = (i + 1) * S + j, d = (i + 1) * S + ((j + 1) % S);
      index.push(a, c, b, b, c, d);
    }
  }
  tailGeo.setAttribute('position', new BufferAttribute(pos, 3));
  tailGeo.setAttribute('normal', new BufferAttribute(nor, 3));
  tailGeo.setAttribute('color', new BufferAttribute(col, 3));
  tailGeo.setIndex(index);
  const tailMat = new MeshPhysicalMaterial({ ...glass, color: 0xffffff, vertexColors: true, emissive: colour, opacity: cfg.glassOpacity });
  const tail = new Mesh(tailGeo, tailMat);
  tail.renderOrder = 1;
  tail.frustumCulled = false;

  // the GTAO twin: shares both geometries, normal material only (see Packet.aoGroup)
  const aoGroup = new Group();
  const aoMat = new MeshNormalMaterial();
  const aoHead = new Mesh(headGeo, aoMat);
  const aoTail = new Mesh(tailGeo, aoMat);
  aoHead.frustumCulled = aoTail.frustumCulled = false;
  aoGroup.add(aoHead, aoTail);

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
  const tan = new Vector3(), up = new Vector3(), bv = new Vector3(), uv = new Vector3(), side = new Vector3(), tmp = new Vector3(), out = new Vector3();
  const dark = new Color(), lit = new Color(), tint = new Color();
  let lastD = NaN, speed = 0, tailDir = 1, tailLen = look.packet.tailMin;

  return {
    group,
    aoGroup,
    setColor(hex) {
      colour.set(hex); hot.copy(colour).lerp(new Color(1, 1, 1), 0.5);
      headMat.color.copy(colour).lerp(new Color(1, 1, 1), 0.35); headMat.emissive.copy(colour); tailMat.emissive.copy(colour); coreMat.color.copy(colour); coreMat.emissive.copy(hot);
    },
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

      const R = c.headRadius * fade;
      headMat.emissiveIntensity = c.headGlow * c.headBrightness * 0.3;
      tailMat.emissiveIntensity = c.headGlow * c.headBrightness * 0.3;
      coreMat.emissiveIntensity = c.headGlow * c.headBrightness * 2;
      headMat.opacity = c.glassOpacity;
      tailMat.opacity = c.glassOpacity * 0.9;
      path.pointAt(d, out);
      head.position.copy(out);
      head.scale.setScalar(Math.max(R, 1e-4));
      head.visible = aoHead.visible = R > 1e-3;
      aoHead.position.copy(out);
      aoHead.scale.copy(head.scale);
      aoTail.visible = tail.visible = head.visible;

      for (let i = 0; i < N; i++) path.pointAt(d - tailDir * (i / (N - 1)) * tailLen, pts[i]);
      dark.copy(colour).multiplyScalar(0.35);
      lit.copy(colour).lerp(hot, 0.35);
      for (let i = 0; i < N; i++) {
        const prev = pts[Math.max(0, i - 1)], next = pts[Math.min(N - 1, i + 1)];
        tan.subVectors(prev, next);
        if (tan.lengthSq() < 1e-10) tan.set(1, 0, 0);
        tan.normalize();
        // ring frame: b is across the path along the surface, uv is the globe's radial direction made perpendicular to the path
        up.copy(pts[i]).normalize();
        bv.crossVectors(tan, up);
        if (bv.lengthSq() < 1e-8) bv.set(0, 0, 1).cross(tan);
        bv.normalize();
        uv.crossVectors(bv, tan);
        const u = i / (N - 1);
        const r = R * c.tailRadius * Math.pow(1 - u, 0.9);
        tint.copy(dark).lerp(lit, Math.pow(1 - u, c.tailFade));
        const p = pts[i];
        for (let j = 0; j < S; j++) {
          const a = (j / S) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
          const k = (i * S + j) * 3;
          nor[k] = uv.x * ca + bv.x * sa; nor[k + 1] = uv.y * ca + bv.y * sa; nor[k + 2] = uv.z * ca + bv.z * sa;
          pos[k] = p.x + nor[k] * r; pos[k + 1] = p.y + nor[k + 1] * r; pos[k + 2] = p.z + nor[k + 2] * r;
          col[k] = tint.r; col[k + 1] = tint.g; col[k + 2] = tint.b;
        }
      }
      tailGeo.attributes.position.needsUpdate = true;
      tailGeo.attributes.normal.needsUpdate = true;
      tailGeo.attributes.color.needsUpdate = true;

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
      headGeo.dispose(); headMat.dispose(); coreMat.dispose(); tailGeo.dispose(); tailMat.dispose(); aoMat.dispose(); sparkGeo.dispose(); sparkMat.dispose();
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

