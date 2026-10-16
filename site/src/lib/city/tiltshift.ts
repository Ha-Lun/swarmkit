// SwarmKit City tilt-shift: a cheap two-pass miniature blur (high tier only).
//
// Two separable blur passes, horizontal then vertical, whose strength rises
// smoothly away from a horizontal focus band. The scene wires them into its
// EffectComposer via install(); setEnabled(false) skips them entirely so they
// cost nothing when the tier or the user disables them.
//
// The blur is resolution-aware (offsets are in pixels via the resolution
// uniform) and focus-aware: inside the band (|vUv.y - 0.5| < 0.22) every tap
// lands on the same texel, so the city stays sharp; outside, the taps spread
// up to maxRadius pixels and the blur fades in with a smoothstep.
import { ShaderMaterial, Vector2 } from 'three';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import type { CreateTiltShift, PassHost, TiltShift } from './types.ts';

/** Focus band centre in UV space (v). */
const FOCUS_CENTER = 0.5;
/** Focus band half-width in UV space: the sharp strip of the miniature. */
const FOCUS_HALF_WIDTH = 0.22;
/** Extra v distance past the band edge over which the blur fades in. */
const FOCUS_FEATHER = 0.28;
/** Blur radius in pixels at full strength (frame top and bottom). */
const MAX_RADIUS = 2.5;

const VERTEX_SHADER = [
  'varying vec2 vUv;',
  'void main() {',
  '  vUv = uv;',
  '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
  '}',
].join('\n');

// 5-tap gaussian along `direction` (weights sum to 1). `strength` is 0
// inside the focus band so all taps coincide and the picture stays sharp,
// and rises smoothly to 1 away from it.
const FRAGMENT_SHADER = [
  'uniform sampler2D tDiffuse;',
  'uniform vec2 direction;',
  'uniform vec2 resolution;',
  'uniform float focusCenter;',
  'uniform float focusHalfWidth;',
  'uniform float maxRadius;',
  'varying vec2 vUv;',
  'void main() {',
  '  float dist = abs(vUv.y - focusCenter);',
  `  float strength = smoothstep(focusHalfWidth, focusHalfWidth + ${FOCUS_FEATHER.toFixed(2)}, dist);`,
  '  vec2 step = direction * (maxRadius * strength) / resolution;',
  '  vec3 colour = texture2D(tDiffuse, vUv) * 0.38774;',
  '  colour += texture2D(tDiffuse, vUv + step * 1.0) * 0.24477;',
  '  colour += texture2D(tDiffuse, vUv - step * 1.0) * 0.24477;',
  '  colour += texture2D(tDiffuse, vUv + step * 2.0) * 0.06136;',
  '  colour += texture2D(tDiffuse, vUv - step * 2.0) * 0.06136;',
  '  gl_FragColor = vec4(colour, 1.0);',
  '}',
].join('\n');

function makeMaterial(direction: Vector2, resolution: Vector2): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      tDiffuse: { value: null },
      direction: { value: direction },
      resolution: { value: resolution },
      focusCenter: { value: FOCUS_CENTER },
      focusHalfWidth: { value: FOCUS_HALF_WIDTH },
      maxRadius: { value: MAX_RADIUS },
    },
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
  });
}

export const createTiltShift: CreateTiltShift = (): TiltShift => {
  const hResolution = new Vector2(1, 1);
  const vResolution = new Vector2(1, 1);
  const hMaterial = makeMaterial(new Vector2(1, 0), hResolution);
  const vMaterial = makeMaterial(new Vector2(0, 1), vResolution);
  const hPass = new ShaderPass(hMaterial);
  const vPass = new ShaderPass(vMaterial);
  let host: PassHost | null = null;
  let disposed = false;

  function install(next: PassHost): void {
    if (disposed || host !== null) return;
    host = next;
    next.addPass(hPass);
    next.addPass(vPass);
  }

  function setSize(width: number, height: number): void {
    hResolution.set(width, height);
    vResolution.set(width, height);
  }

  function setEnabled(enabled: boolean): void {
    hPass.enabled = enabled;
    vPass.enabled = enabled;
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    if (host !== null) {
      host.removePass?.(hPass);
      host.removePass?.(vPass);
      host = null;
    }
    hMaterial.dispose();
    vMaterial.dispose();
  }

  return { install, setSize, setEnabled, dispose };
};
