// The globe's studio lighting: ambient, hemisphere, a key that sweeps round the globe as the camera orbits and a soft kicker
// from behind. Shared by the real site and /lookdev. Every colour is a mix of the palette tokens (never the accent); everything
// reads `look.light` each frame, so the /lookdev sliders act live. Nothing here draws anything: it is lights only.
import {
  AmbientLight, Color, DirectionalLight, HemisphereLight, Vector3, type PerspectiveCamera, type Scene,
} from 'three';
import { look, type Palette, type Tier } from './config';
import type { Lattice } from './honeycomb';

export interface StudioFrame {
  timeSec: number;
}

export interface Studio {
  update(camera: PerspectiveCamera, f: StudioFrame): void;
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
  const kicker = new DirectionalLight(text.clone().lerp(ink2, 0.3), look.light.kicker);
  key.position.set(-8, 20, 10);
  scene.add(amb, hemi, key, kicker);
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

  const dir = new Vector3();
  const polar = (az: number, el: number, out: Vector3) =>
    out.set(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az));

  return {
    update(camera, f) {
      const L = look.light;
      // medium has no studio reflection, so its hemisphere light stands in for the reflected room
      amb.intensity = L.ambient; hemi.intensity = L.hemi + (tier === 'medium' ? 0.45 : 0); key.intensity = L.key; kicker.intensity = L.kicker;
      // the camera's azimuth about the globe (0 = the core cell's side): the key follows it at (1 - sweep), so the light
      // slides across the stone as the camera orbits; the kicker sits behind the globe as seen from the camera
      const camAz = Math.atan2(camera.position.x, camera.position.z);
      const idle = Math.sin(f.timeSec * 0.11) * 0.14;
      polar(camAz * (1 - L.sweep) + KEY_OFFSET + idle, (L.keyElevation * Math.PI) / 180, dir);
      key.position.copy(dir).multiplyScalar(SHADOW.keyDistance);
      polar(camAz + KICKER_BEHIND - idle, 0.3, dir);
      kicker.position.copy(dir).multiplyScalar(30);
    },
    dispose() {
      key.shadow.dispose();
      scene.remove(amb, hemi, key, kicker);
    },
  };
}
