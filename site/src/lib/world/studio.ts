// The globe's studio lighting: ambient, hemisphere, a key that sweeps round the globe as the camera orbits and a soft kicker
// from behind. Shared by the real site and /lookdev. Every colour is a mix of the palette tokens (never the accent); everything
// reads `look.light` each frame, so the /lookdev sliders act live. Nothing here draws anything: it is lights only.
import {
  AmbientLight, Color, DirectionalLight, HemisphereLight, Vector3, type PerspectiveCamera, type Scene,
} from 'three';
import { look, type Palette, type Tier } from './config';

export interface StudioFrame {
  timeSec: number;
}

export interface Studio {
  update(camera: PerspectiveCamera, f: StudioFrame): void;
  dispose(): void;
}

const KEY_OFFSET = -0.75; // rad: with sweep 0 the key sits upper left of the view
const KICKER_BEHIND = 0.8 * Math.PI;

export function createStudio(scene: Scene, tier: Tier, palette: Palette): Studio {
  const ink2 = new Color(palette.ink2), text = new Color(palette.text), wax = new Color(palette.wax);

  const amb = new AmbientLight(text, look.light.ambient);
  const hemi = new HemisphereLight(text, ink2, look.light.hemi);
  const key = new DirectionalLight(text.clone().lerp(wax, 0.25), look.light.key);
  const kicker = new DirectionalLight(text.clone().lerp(ink2, 0.3), look.light.kicker);
  key.position.set(-8, 20, 10);
  scene.add(amb, hemi, key, kicker);

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
      key.position.copy(dir).multiplyScalar(30);
      polar(camAz + KICKER_BEHIND - idle, 0.3, dir);
      kicker.position.copy(dir).multiplyScalar(30);
    },
    dispose() {
      scene.remove(amb, hemi, key, kicker);
    },
  };
}
