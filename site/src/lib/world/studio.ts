// The globe's surroundings: the moving studio lights, the atmosphere halo and the drifting dust. Shared by the real site
// and /lookdev. Every colour is a mix of the palette tokens (never the accent); everything reads `look` each frame, so the
// /lookdev sliders act live. Dust is off in the fallback tier simply because the fallback has no canvas at all.
import {
  AdditiveBlending, AmbientLight, BackSide, BufferGeometry, Color, DirectionalLight, Float32BufferAttribute, Group,
  HemisphereLight, Mesh, Points, ShaderMaterial, SphereGeometry, Vector3, type PerspectiveCamera, type Scene,
} from 'three';
import { look, type Palette, type Tier } from './config';

export interface StudioFrame {
  timeSec: number;
  /** 0..1 lattice dimming (proof chapter) */
  dim: number;
  /** false while the lattice is hidden (finale swarm) */
  visible: boolean;
  /** 0..1 lattice growth: the halo and dust arrive with the globe, not before it */
  growth: number;
}

export interface Studio {
  update(camera: PerspectiveCamera, f: StudioFrame): void;
  setViewportHeight(px: number): void;
  dispose(): void;
  readonly dustCount: number;
}

const DUST_COUNT: Record<Tier, number> = { high: 360, medium: 160 };
const KEY_OFFSET = -0.75; // rad: with sweep 0 the key sits upper left of the view, as in the locked look
const KICKER_BEHIND = 0.8 * Math.PI;

// mulberry32: fixed dust layout, so screenshots and tier switches agree
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const haloVert = /* glsl */ `
  varying vec3 vN; varying vec3 vV;
  void main() {
    vec4 mv = modelViewMatrix * vec4( position, 1.0 );
    vN = normalize( normalMatrix * normal );
    vV = normalize( -mv.xyz );
    gl_Position = projectionMatrix * mv;
  }`;
const haloFrag = /* glsl */ `
  uniform vec3 uColor; uniform float uOpacity, uPower, uEnc;
  varying vec3 vN; varying vec3 vV;
  #include <common>
  #include <dithering_pars_fragment>
  void main() {
    // back faces of a shell around the globe: -N.V is largest just outside the limb and falls to 0 at the shell's own edge
    float f = pow( saturate( -dot( normalize( vN ), normalize( vV ) ) ), uPower );
    float a = f * uOpacity;
    gl_FragColor = vec4( uColor, mix( a, pow( a, 0.4545 ), uEnc ) ); // uEnc: the direct-to-screen path blends in encoded space
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <dithering_fragment>
  }`;

const dustVert = /* glsl */ `
  attribute vec4 aSeed; // phase, speed, brightness, size jitter
  uniform float uTime, uAmp, uSize, uPx;
  varying float vB;
  void main() {
    vec3 d = vec3( sin( uTime * aSeed.y + aSeed.x * 6.2831 ), cos( uTime * aSeed.y * 0.8 + aSeed.x * 17.0 ), sin( uTime * aSeed.y * 0.6 + aSeed.x * 3.0 ) );
    vec4 mv = modelViewMatrix * vec4( position + d * uAmp, 1.0 );
    vB = aSeed.z * ( 0.75 + 0.25 * sin( uTime * 0.5 + aSeed.x * 40.0 ) );
    gl_PointSize = max( 1.0, uSize * uPx * aSeed.w );
    gl_Position = projectionMatrix * mv;
  }`;
const dustFrag = /* glsl */ `
  uniform vec3 uColor; uniform float uOpacity, uEnc;
  varying float vB;
  #include <common>
  #include <dithering_pars_fragment>
  void main() {
    float d = length( gl_PointCoord - 0.5 );
    float a = 1.0 - smoothstep( 0.0, 0.5, d );
    float o = a * a * vB * uOpacity;
    gl_FragColor = vec4( uColor, mix( o, pow( o, 0.4545 ), uEnc ) );
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <dithering_fragment>
  }`;

export function createStudio(scene: Scene, tier: Tier, palette: Palette, radius: number): Studio {
  const ink2 = new Color(palette.ink2), text = new Color(palette.text), wax = new Color(palette.wax);

  // ---- lights: ambient, hemisphere, a key that sweeps round the globe and a soft kicker from behind ----
  const amb = new AmbientLight(text, look.light.ambient);
  const hemi = new HemisphereLight(text, ink2, look.light.hemi);
  const key = new DirectionalLight(text.clone().lerp(wax, 0.25), look.light.key);
  const kicker = new DirectionalLight(text.clone().lerp(ink2, 0.3), look.light.kicker);
  key.position.set(-8, 20, 10);
  scene.add(amb, hemi, key, kicker);

  // medium renders straight to the screen, where additive blending happens on encoded colour; high blends in linear
  // (post-processing), so the same alpha would look much brighter there. uEnc evens the two out.
  const enc = tier === 'medium' ? 1 : 0;

  // ---- atmosphere halo ----
  const haloGeo = new SphereGeometry(radius, 48, 24);
  const haloMat = new ShaderMaterial({
    uniforms: { uColor: { value: wax.clone() }, uOpacity: { value: look.halo.opacity }, uPower: { value: look.halo.power }, uEnc: { value: enc } },
    vertexShader: haloVert, fragmentShader: haloFrag,
    side: BackSide, transparent: true, depthWrite: false, blending: AdditiveBlending, dithering: true, fog: false,
  });
  const halo = new Mesh(haloGeo, haloMat);
  halo.scale.setScalar(look.halo.radius);
  halo.renderOrder = 1;
  halo.frustumCulled = false;

  // ---- dust: a few hundred dim points between 1.3 and 3.5 globe radii ----
  const n = DUST_COUNT[tier];
  const rand = rng(7);
  const pos = new Float32Array(n * 3), seed = new Float32Array(n * 4);
  const v = new Vector3();
  for (let i = 0; i < n; i++) {
    v.set(rand() * 2 - 1, (rand() * 2 - 1) * 0.8, rand() * 2 - 1).normalize().multiplyScalar(radius * (1.3 + 2.2 * Math.pow(rand(), 0.75)));
    pos.set([v.x, v.y, v.z], i * 3);
    seed.set([rand(), 0.06 + rand() * 0.16, 0.35 + rand() * 0.65, 0.7 + rand() * 0.9], i * 4);
  }
  const dustGeo = new BufferGeometry();
  dustGeo.setAttribute('position', new Float32BufferAttribute(pos, 3));
  dustGeo.setAttribute('aSeed', new Float32BufferAttribute(seed, 4));
  const dustMat = new ShaderMaterial({
    uniforms: {
      uColor: { value: wax.clone().lerp(new Color(palette.waxDim), 0.3) }, uOpacity: { value: look.dust.opacity },
      uTime: { value: 0 }, uAmp: { value: 0 }, uSize: { value: look.dust.size }, uPx: { value: 1 }, uEnc: { value: enc },
    },
    vertexShader: dustVert, fragmentShader: dustFrag,
    transparent: true, depthWrite: false, blending: AdditiveBlending, dithering: true, fog: false,
  });
  const dust = new Points(dustGeo, dustMat);
  dust.frustumCulled = false;
  dust.renderOrder = 2;

  const group = new Group();
  group.add(halo, dust);
  scene.add(group);

  const dir = new Vector3();
  const polar = (az: number, el: number, out: Vector3) =>
    out.set(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az));

  return {
    dustCount: n,
    update(camera, f) {
      const L = look.light;
      // medium has no studio reflection, so its hemisphere light stands in for the reflected room
      amb.intensity = L.ambient; hemi.intensity = L.hemi + (tier === 'medium' ? 0.45 : 0); key.intensity = L.key; kicker.intensity = L.kicker;
      // the camera's azimuth about the globe (0 = the core cell's side): the key follows it at (1 - sweep), so the light
      // slides across the ceramic as the camera orbits; the kicker sits behind the globe as seen from the camera
      const camAz = Math.atan2(camera.position.x, camera.position.z);
      const idle = Math.sin(f.timeSec * 0.11) * 0.14;
      polar(camAz * (1 - L.sweep) + KEY_OFFSET + idle, (L.keyElevation * Math.PI) / 180, dir);
      key.position.copy(dir).multiplyScalar(30);
      polar(camAz + KICKER_BEHIND - idle, 0.3, dir);
      kicker.position.copy(dir).multiplyScalar(30);

      group.visible = f.visible;
      const fade = (1 - 0.55 * f.dim) * Math.min(1, Math.max(0, (f.growth - 0.2) / 0.6));
      halo.scale.setScalar(look.halo.radius);
      haloMat.uniforms.uOpacity.value = look.halo.opacity * fade;
      haloMat.uniforms.uPower.value = look.halo.power;
      dustMat.uniforms.uOpacity.value = look.dust.opacity * fade;
      dustMat.uniforms.uSize.value = look.dust.size;
      dustMat.uniforms.uTime.value = f.timeSec;
      dustMat.uniforms.uAmp.value = look.dust.drift * radius * 0.05;
      // gentle parallax: the dust layer shifts against the camera, so it reads as depth between the eye and the globe
      dust.position.copy(camera.position).multiplyScalar(-look.dust.parallax);
    },
    setViewportHeight(px) {
      dustMat.uniforms.uPx.value = px / 1080;
    },
    dispose() {
      scene.remove(amb, hemi, key, kicker, group);
      haloGeo.dispose(); haloMat.dispose(); dustGeo.dispose(); dustMat.dispose();
    },
  };
}
