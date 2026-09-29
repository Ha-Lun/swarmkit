import { ShaderMaterial, Vector2, type Texture, type WebGLRenderer, type WebGLRenderTarget } from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import type { Look } from './config';

/** On-screen circumradius (device px) of one lattice cell (world circumradius `cellRadius`) at `distance` from the camera. */
export function hexPixelSize(fovDeg: number, viewportHeightPx: number, cellRadius: number, distance: number): number {
  return (cellRadius * (viewportHeightPx / 2)) / (Math.tan((fovDeg * Math.PI) / 360) * distance);
}

const vert = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4( position.xy, 0.0, 1.0 ); }`;

const frag = /* glsl */ `
  uniform sampler2D tFrom, tTo;
  uniform vec2 uRes;
  uniform float uProgress, uHex, uSpread, uNoise, uEdge;
  varying vec2 vUv;

  // pointy-top hex grid, same orientation as the lattice
  vec2 pixelToHex( vec2 p, float s ) {
    float q = ( 0.57735027 * p.x - p.y / 3.0 ) / s;
    float r = ( 2.0 / 3.0 * p.y ) / s;
    vec3 c = vec3( q, r, -q - r );
    vec3 rc = floor( c + 0.5 );
    vec3 d = abs( rc - c );
    if ( d.x > d.y && d.x > d.z ) rc.x = -rc.y - rc.z;
    else if ( d.y > d.z ) rc.y = -rc.x - rc.z;
    return rc.xy;
  }
  vec2 hexToPixel( vec2 h, float s ) { return vec2( s * 1.7320508 * ( h.x + h.y * 0.5 ), s * 1.5 * h.y ); }
  float hash( vec2 p ) { return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453 ); }

  void main() {
    vec2 p = vUv * uRes;
    vec2 hc = pixelToHex( p, uHex );
    vec2 cen = hexToPixel( hc, uHex );
    vec2 d = p - cen;
    float hd = max( abs( d.x ), 0.5 * abs( d.x ) + 0.8660254 * abs( d.y ) ) / ( 0.8660254 * uHex ); // 1.0 at the cell wall

    float aspect = uRes.x / uRes.y;
    vec2 c = ( cen / uRes - 0.5 ) * vec2( aspect, 1.0 );
    float wave = clamp( length( c ) / ( 0.5 * length( vec2( aspect, 1.0 ) ) ), 0.0, 1.0 );
    float delay = mix( wave, hash( hc ), uNoise );
    float start = delay * ( 1.0 - uSpread );
    float local = clamp( ( uProgress - start ) / uSpread, 0.0, 1.0 );

    float scale = ( 1.0 - local ) * 1.05; // outgoing hex shrinks to nothing
    float aa = uEdge / ( 0.8660254 * uHex );
    float keep = ( 1.0 - smoothstep( scale - aa, scale, hd ) ) * step( local, 0.9999 );
    gl_FragColor = vec4( mix( texture2D( tTo, vUv ).rgb, texture2D( tFrom, vUv ).rgb, keep ), 1.0 );
    #include <colorspace_fragment>
  }`;

export interface HexDissolve {
  /** draws to the canvas (or `target`, which the post chain then reads). hexPx is the native lattice cell size in device px (see hexPixelSize). */
  render(renderer: WebGLRenderer, from: Texture, to: Texture, progress: number, hexPx: number, cfg: Look['dissolve'], target?: WebGLRenderTarget | null): void;
  dispose(): void;
}

export function createHexDissolve(): HexDissolve {
  const material = new ShaderMaterial({
    uniforms: {
      tFrom: { value: null }, tTo: { value: null }, uRes: { value: new Vector2(1, 1) },
      uProgress: { value: 0 }, uHex: { value: 32 }, uSpread: { value: 0.35 }, uNoise: { value: 0.25 }, uEdge: { value: 1.25 },
    },
    vertexShader: vert,
    fragmentShader: frag,
    depthTest: false,
    depthWrite: false,
  });
  const quad = new FullScreenQuad(material);
  const size = new Vector2();
  return {
    render(renderer, from, to, progress, hexPx, cfg, target = null) {
      renderer.getDrawingBufferSize(size);
      const u = material.uniforms;
      u.tFrom.value = from;
      u.tTo.value = to;
      u.uRes.value.copy(size);
      u.uProgress.value = progress;
      u.uHex.value = Math.max(4, hexPx * cfg.hexScale);
      u.uSpread.value = cfg.spread;
      u.uNoise.value = cfg.noise;
      u.uEdge.value = cfg.edge;
      renderer.setRenderTarget(target);
      quad.render(renderer);
    },
    dispose() {
      quad.dispose();
      material.dispose();
    },
  };
}
