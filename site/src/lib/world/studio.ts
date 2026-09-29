// The globe's studio lighting: ambient, hemisphere, a key that sweeps round the globe as the camera orbits, a dim fill
// opposite it and a kicker rim from behind. Shared by the real site and /lookdev. Every colour is a mix of the palette
// tokens (never the accent); everything reads `look.light` each frame, so the /lookdev sliders act live. Nothing here
// draws anything: it is lights only.
import {
  AmbientLight, Color, DirectionalLight, HemisphereLight, Vector3, type PerspectiveCamera, type Scene,
} from 'three';
import { look, type Palette, type Tier } from './config';
import type { Lattice } from './honeycomb';

export interface StudioFrame {
  timeSec: number;
  /** the walk camera's local frame (unit vectors): with weight > 0 the key, fill and kicker are placed relative to `up` and `forward` instead of the
   *  camera's azimuth about Y, so the light stays consistent wherever on the globe the walker stands. weight 0 = the azimuth rig. */
  frame?: { up: Vector3; forward: Vector3; weight: number };
}

export interface Studio {
  update(camera: PerspectiveCamera, f: StudioFrame): void;
  /** high tier: fit the key's shadow frustum tightly (+-extent world units) round `center`, snapped to shadow texels so it never shimmers
   *  while the camera moves; null restores the full-globe frustum. No effect on medium (no shadow map). */
  fitShadow(focus: { center: Vector3; extent: number } | null): void;
  dispose(): void;
}

const KEY_OFFSET = -0.75; // rad: with sweep 0 the key sits upper left of the view
const KICKER_BEHIND = 0.8 * Math.PI;

/** Shadow-map settings of the key (high tier only). The map is a 2048 orthographic frustum, +-`extent` world units: `extent` bounds the globe
 *  and the moon (drift included) about the origin, and the globe only turns about the origin, so the frustum never has to move except with the key itself
 *  (three aims it along the key each frame), which keeps the texel density stable. */
const SHADOW = { map: 2048, bias: -0.0004, normalBias: 0.05, radius: 2.5, keyDistance: 30 };

/** Half-width of the key's shadow frustum: bounds the globe (tallest tower included) and the moon about the origin. The globe only turns about the origin
 *  and the moon's own spin is about its own centre, but the moon also drifts (up to `driftMax` from home, see honeycomb.ts), so that is added to its reach. */
export const shadowExtentOf = (l: Lattice): number => Math.max(
  l.radius + Math.max(...l.cells.filter((c) => !c.moon).map((c) => c.reach)),
  l.moon.centre.length() + l.moon.radius + Math.max(0, ...l.cells.filter((c) => c.moon).map((c) => c.reach)) + l.moon.driftMax,
) + 0.5;

export function createStudio(scene: Scene, tier: Tier, palette: Palette, shadowExtent?: number): Studio {
  const ink2 = new Color(palette.ink2), text = new Color(palette.text), wax = new Color(palette.wax);

  const amb = new AmbientLight(text, look.light.ambient);
  const hemi = new HemisphereLight(text, ink2, look.light.hemi);
  const key = new DirectionalLight(text.clone().lerp(wax, 0.25), look.light.key);
  const fill = new DirectionalLight(ink2.clone().lerp(wax, 0.4), look.light.fill);
  const kicker = new DirectionalLight(text.clone().lerp(ink2, 0.3), look.light.kicker);
  key.position.set(-8, 20, 10);
  scene.add(amb, hemi, key, fill, kicker);
  if (tier === 'high' && shadowExtent) {
    key.castShadow = true;
    const sh = key.shadow, e = shadowExtent;
    sh.mapSize.set(SHADOW.map, SHADOW.map);
    Object.assign(sh.camera, { left: -e, right: e, top: e, bottom: -e, near: SHADOW.keyDistance - e - 1, far: SHADOW.keyDistance + e + 1 });
    sh.camera.updateProjectionMatrix();
    sh.bias = SHADOW.bias;
    sh.normalBias = SHADOW.normalBias;
    sh.radius = SHADOW.radius;
  }

  const dir = new Vector3(), dirB = new Vector3(), lr = new Vector3(), lu = new Vector3(), lz = new Vector3();
  const baseNear = key.shadow.camera.near, baseFar = key.shadow.camera.far;
  let focus: { center: Vector3; extent: number } | null = null;
  const baseExt = shadowExtent ?? 0;
  const polar = (az: number, el: number, out: Vector3) =>
    out.set(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az));

  return {
    fitShadow(f) {
      if (!key.castShadow) return;
      focus = f;
      const e = f ? f.extent : baseExt;
      const sc = key.shadow.camera;
      Object.assign(sc, f ? { left: -e, right: e, top: e, bottom: -e, near: SHADOW.keyDistance - e - 2, far: SHADOW.keyDistance + e + 2 } : { left: -e, right: e, top: e, bottom: -e, near: baseNear, far: baseFar });
      sc.updateProjectionMatrix();
    },
    update(camera, f) {
      const L = look.light;
      amb.intensity = L.ambient; hemi.intensity = L.hemi; key.intensity = L.key; fill.intensity = L.fill; kicker.intensity = L.kicker;
      // the camera's azimuth about the globe (0 = the core cell's side): the key follows it at (1 - sweep), so the light
      // slides across the stone as the camera orbits; the fill sits opposite the key, the kicker behind the globe as seen from the camera
      const camAz = Math.atan2(camera.position.x, camera.position.z);
      const idle = Math.sin(f.timeSec * 0.11) * 0.14;
      polar(camAz * (1 - L.sweep) + KEY_OFFSET + idle, (L.keyElevation * Math.PI) / 180, dir);
      polar(camAz + KICKER_BEHIND - idle, 0.3, dirB);
      if (f.frame && f.frame.weight > 0) {
        // walking: the same rig in the walker's own frame. The key sits behind-left and above, the fill opposite it, the kicker ahead and high
        // (rimming the towers without glaring off the ground), each blended with the azimuth rig by the frame weight
        const { up, forward, weight } = f.frame;
        lr.crossVectors(forward, up).normalize();
        const el = (L.keyElevation * Math.PI) / 180, ce = Math.cos(el), se = Math.sin(el);
        const a = KEY_OFFSET + idle; // rad, as in the azimuth rig, measured from behind the walker
        // local key direction: behind (-forward) rotated by a about up, raised by el
        lz.copy(forward).multiplyScalar(-Math.cos(a)).addScaledVector(lr, Math.sin(a)).multiplyScalar(ce).addScaledVector(up, se);
        dir.multiplyScalar(1 - weight).addScaledVector(lz, weight).normalize();
        // high (about 55 degrees) and to the left of ahead: a low kicker straight ahead mirrors off the flat tile tops into the camera and blooms
        lu.copy(forward).multiplyScalar(Math.cos(0.95)).addScaledVector(lr, -0.5).addScaledVector(up, Math.sin(0.95)).normalize();
        dirB.multiplyScalar(1 - weight).addScaledVector(lu, weight).normalize();
      }
      if (focus) {
        // the tight shadow frustum is centred on the walker's focus point, snapped to the light's own texel grid so texels never crawl
        lz.copy(dir);
        lr.set(0, 1, 0).cross(lz);
        if (lr.lengthSq() < 1e-6) lr.set(1, 0, 0);
        lr.normalize();
        lu.crossVectors(lz, lr);
        const texel = (2 * focus.extent) / SHADOW.map;
        key.target.position.set(0, 0, 0)
          .addScaledVector(lr, Math.round(focus.center.dot(lr) / texel) * texel)
          .addScaledVector(lu, Math.round(focus.center.dot(lu) / texel) * texel)
          .addScaledVector(lz, focus.center.dot(lz));
        key.position.copy(key.target.position).addScaledVector(dir, SHADOW.keyDistance);
      } else {
        key.target.position.set(0, 0, 0);
        key.position.copy(dir).multiplyScalar(SHADOW.keyDistance);
      }
      key.target.updateMatrixWorld();
      fill.position.copy(dir).multiplyScalar(-30);
      kicker.position.copy(dirB).multiplyScalar(30);
    },
    dispose() {
      key.shadow.dispose();
      scene.remove(amb, hemi, key, fill, kicker);
    },
  };
}
