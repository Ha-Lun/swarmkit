import {
  AdditiveBlending, BufferAttribute, BufferGeometry, Color, DataTexture, FloatType, NearestFilter, Points,
  RGBAFormat, ShaderMaterial, type Texture, type WebGLRenderer,
} from 'three';
import { GPUComputationRenderer } from 'three/addons/misc/GPUComputationRenderer.js';
import type { Look, Palette, Tier } from './config';

export const TARGET_TEXT = './install.sh --all';

/**
 * Rasterise `text` on an offscreen 2D canvas and sample lit pixels into `count` target points
 * (x, y, 0, 1) centred on the origin, `textWidth` world units wide. The text is never displayed:
 * it only becomes coordinates.
 */
export function rasterizeTargets(text: string, count: number, textWidth: number): Float32Array {
  const fontPx = 160;
  const font = `400 ${fontPx}px "JetBrains Mono", ui-monospace, monospace`;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(text).width) + 32;
  const h = Math.ceil(fontPx * 1.4);
  canvas.width = w;
  canvas.height = h;
  ctx.font = font;
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 3; // thicken thin mono strokes so they sample densely
  ctx.strokeText(text, 16, h / 2);
  ctx.fillText(text, 16, h / 2);
  const data = ctx.getImageData(0, 0, w, h).data;
  const lit: number[] = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (data[(y * w + x) * 4 + 3] > 128) lit.push(x, y);
  const out = new Float32Array(count * 4);
  const n = lit.length / 2;
  const k = textWidth / w;
  for (let i = 0; i < count; i++) {
    const s = lit.length ? Math.floor(Math.random() * n) * 2 : 0;
    out[i * 4] = ((lit[s] ?? 0) - w / 2) * k + (Math.random() - 0.5) * k;
    out[i * 4 + 1] = -((lit[s + 1] ?? 0) - h / 2) * k + (Math.random() - 0.5) * k;
    out[i * 4 + 3] = 1;
  }
  return out;
}

const NOISE = /* glsl */ `
  float hash13( vec3 p ) { p = fract( p * 0.3183099 + 0.1 ); p *= 17.0; return fract( p.x * p.y * p.z * ( p.x + p.y + p.z ) ); }
  float vnoise( vec3 x ) {
    vec3 i = floor( x ), f = fract( x );
    f = f * f * ( 3.0 - 2.0 * f );
    return mix( mix( mix( hash13( i ), hash13( i + vec3( 1, 0, 0 ) ), f.x ), mix( hash13( i + vec3( 0, 1, 0 ) ), hash13( i + vec3( 1, 1, 0 ) ), f.x ), f.y ),
                mix( mix( hash13( i + vec3( 0, 0, 1 ) ), hash13( i + vec3( 1, 0, 1 ) ), f.x ), mix( hash13( i + vec3( 0, 1, 1 ) ), hash13( i + vec3( 1, 1, 1 ) ), f.x ), f.y ), f.z );
  }
  vec3 potential( vec3 p ) { return vec3( vnoise( p ), vnoise( p + vec3( 31.4, 17.1, 5.7 ) ), vnoise( p + vec3( 7.3, 53.9, 23.1 ) ) ); }
  vec3 curlNoise( vec3 p ) {
    const float e = 0.1;
    vec3 dx = potential( p + vec3( e, 0, 0 ) ) - potential( p - vec3( e, 0, 0 ) );
    vec3 dy = potential( p + vec3( 0, e, 0 ) ) - potential( p - vec3( 0, e, 0 ) );
    vec3 dz = potential( p + vec3( 0, 0, e ) ) - potential( p - vec3( 0, 0, e ) );
    return vec3( dy.z - dz.y, dz.x - dx.z, dx.y - dy.x ) / ( 2.0 * e );
  }`;

const velocityShader = /* glsl */ `
  uniform sampler2D tTarget;
  uniform float uTime, uDelta, uAttract, uCurlScale, uCurlStrength, uCurlSpeed, uCohesion, uAttractStrength, uDamping, uMaxSpeed;
  ${NOISE}
  void main() {
    vec2 uv = gl_FragCoord.xy / resolution.xy;
    vec3 pos = texture2D( texturePosition, uv ).xyz;
    vec3 vel = texture2D( textureVelocity, uv ).xyz;
    vec3 tgt = texture2D( tTarget, uv ).xyz;
    float seed = hash13( vec3( uv * 91.7, 3.1 ) );

    // curl-noise flow keeps the swarm alive; it fades but never fully stops so the text shimmers
    vec3 force = curlNoise( pos * uCurlScale + vec3( 0.0, 0.0, uTime * uCurlSpeed ) ) * uCurlStrength * ( 1.0 - 0.85 * uAttract );
    force -= pos * uCohesion * ( 1.0 - uAttract );
    force += ( tgt - pos ) * uAttractStrength * uAttract * ( 0.6 + 0.8 * seed );

    vel += force * uDelta;
    vel *= exp( -uDamping * ( 1.0 + 3.0 * uAttract ) * uDelta );
    float sp = length( vel );
    if ( sp > uMaxSpeed ) vel *= uMaxSpeed / sp;
    gl_FragColor = vec4( vel, 1.0 );
  }`;

const positionShader = /* glsl */ `
  uniform float uDelta;
  void main() {
    vec2 uv = gl_FragCoord.xy / resolution.xy;
    vec3 pos = texture2D( texturePosition, uv ).xyz;
    vec3 vel = texture2D( textureVelocity, uv ).xyz;
    gl_FragColor = vec4( pos + vel * uDelta, 1.0 );
  }`;

const pointsVert = /* glsl */ `
  uniform sampler2D texturePosition, textureVelocity;
  uniform float uSize, uAttract;
  attribute vec2 reference;
  varying float vBright;
  void main() {
    vec3 pos = texture2D( texturePosition, reference ).xyz;
    float sp = length( texture2D( textureVelocity, reference ).xyz );
    vec4 mv = modelViewMatrix * vec4( pos, 1.0 );
    // dim while drifting, brighter as the swarm settles into the target
    vBright = clamp( 0.25 + 0.06 * sp + 0.55 * uAttract, 0.0, 1.0 );
    gl_PointSize = uSize * ( 24.0 / -mv.z );
    gl_Position = projectionMatrix * mv;
  }`;
const pointsFrag = /* glsl */ `
  #include <common>
  #include <dithering_pars_fragment>
  uniform vec3 uDim, uBrightColor;
  uniform float uOpacity;
  varying float vBright;
  void main() {
    float d = length( gl_PointCoord - 0.5 ) * 2.0;
    if ( d > 1.0 ) discard;
    vec3 c = mix( uDim, uBrightColor, vBright ) * uOpacity * ( 1.0 - d * d );
    gl_FragColor = vec4( c, 1.0 );
    #include <colorspace_fragment>
    #include <dithering_fragment>
  }`;

export interface Swarm {
  points: Points;
  count: number;
  update(dt: number, timeSec: number, cfg: Look['particles']): void;
  setViewportHeight(px: number): void;
  /** re-sample target points (e.g. after a textWidth change) */
  retarget(textWidth: number): void;
  dispose(): void;
}

export function createSwarm(renderer: WebGLRenderer, tier: Tier, cfg: Look['particles'], palette: Palette): Swarm {
  const count = tier === 'high' ? cfg.countHigh : cfg.countMedium;
  const size = Math.round(Math.sqrt(count));
  const gpu = new GPUComputationRenderer(size, size, renderer);
  const dtPos = gpu.createTexture();
  const dtVel = gpu.createTexture();
  const pa = dtPos.image.data as unknown as Float32Array;
  for (let i = 0; i < size * size; i++) {
    // uniform in a ball, standing in for the dissolved lattice
    const v = [Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1];
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    const r = cfg.spawnRadius * Math.cbrt(Math.random());
    pa.set([(v[0] / l) * r, (v[1] / l) * r, (v[2] / l) * r, 1], i * 4);
  }

  const targetTex = new DataTexture(rasterizeTargets(TARGET_TEXT, size * size, cfg.textWidth), size, size, RGBAFormat, FloatType);
  targetTex.minFilter = targetTex.magFilter = NearestFilter;
  targetTex.needsUpdate = true;

  const velVar = gpu.addVariable('textureVelocity', velocityShader, dtVel);
  const posVar = gpu.addVariable('texturePosition', positionShader, dtPos);
  gpu.setVariableDependencies(velVar, [posVar, velVar]);
  gpu.setVariableDependencies(posVar, [posVar, velVar]);
  const vu = velVar.material.uniforms;
  vu.tTarget = { value: targetTex as Texture };
  for (const k of ['uTime', 'uDelta', 'uAttract', 'uCurlScale', 'uCurlStrength', 'uCurlSpeed', 'uCohesion', 'uAttractStrength', 'uDamping', 'uMaxSpeed'])
    vu[k] = { value: 0 };
  posVar.material.uniforms.uDelta = { value: 0 };
  const err = gpu.init();
  if (err) throw new Error(`GPUComputationRenderer: ${err}`);

  const geometry = new BufferGeometry();
  const ref = new Float32Array(size * size * 2);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) ref.set([(x + 0.5) / size, (y + 0.5) / size], (y * size + x) * 2);
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(size * size * 3), 3));
  geometry.setAttribute('reference', new BufferAttribute(ref, 2));
  const material = new ShaderMaterial({
    uniforms: {
      texturePosition: { value: null }, textureVelocity: { value: null },
      uSize: { value: cfg.size }, uAttract: { value: 0 }, uOpacity: { value: cfg.opacity },
      uDim: { value: new Color(palette.waxDim) }, uBrightColor: { value: new Color(palette.wax) }, // Colour B, not the accent
    },
    vertexShader: pointsVert, fragmentShader: pointsFrag,
    transparent: true, depthWrite: false, blending: AdditiveBlending, dithering: true,
    toneMapped: false, // renders straight to the canvas after the post chain (round 11 ACES); this colour is already final
  });
  const points = new Points(geometry, material);
  points.frustumCulled = false;

  let viewportScale = 1;
  return {
    points,
    count: size * size,
    setViewportHeight: (px) => (viewportScale = px / 1080),
    retarget(textWidth) {
      targetTex.image.data!.set(rasterizeTargets(TARGET_TEXT, size * size, textWidth));
      targetTex.needsUpdate = true;
    },
    update(dt, t, c) {
      const step = Math.min(dt, 1 / 30);
      vu.uTime.value = t;
      vu.uDelta.value = posVar.material.uniforms.uDelta.value = step;
      vu.uAttract.value = c.attract;
      vu.uCurlScale.value = c.curlScale;
      vu.uCurlStrength.value = c.curlStrength;
      vu.uCurlSpeed.value = c.curlSpeed;
      vu.uCohesion.value = c.cohesion;
      vu.uAttractStrength.value = c.attractStrength;
      vu.uDamping.value = c.damping;
      vu.uMaxSpeed.value = c.maxSpeed;
      gpu.compute();
      const u = material.uniforms;
      u.texturePosition.value = gpu.getCurrentRenderTarget(posVar).texture;
      u.textureVelocity.value = gpu.getCurrentRenderTarget(velVar).texture;
      u.uSize.value = c.size * viewportScale;
      u.uOpacity.value = c.opacity;
      u.uAttract.value = c.attract;
    },
    dispose() {
      gpu.dispose();
      targetTex.dispose();
      geometry.dispose();
      material.dispose();
    },
  };
}
