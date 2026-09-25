import {
  HalfFloatType, type Camera, type Scene, type WebGLRenderer, Vector2, WebGLRenderTarget,
} from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import type { Look } from './config';

// Runs after OutputPass, i.e. in display (sRGB) space, so grain amplitude is what you see.
const PostShader = {
  uniforms: {
    tDiffuse: { value: null },
    uRes: { value: new Vector2(1, 1) },
    uTime: { value: 0 },
    uCA: { value: 0.01 },
    uGrain: { value: 0.03 },
    uGrainSize: { value: 1.5 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 ); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 uRes;
    uniform float uTime, uCA, uGrain, uGrainSize;
    varying vec2 vUv;
    float hash( vec3 p ) { p = fract( p * 0.1031 ); p += dot( p, p.zyx + 31.32 ); return fract( ( p.x + p.y ) * p.z ); }
    void main() {
      vec2 dir = vUv - 0.5;
      vec2 off = dir * dot( dir, dir ) * uCA; // zero at centre, grows toward the edges
      vec3 col = vec3( texture2D( tDiffuse, vUv + off ).r, texture2D( tDiffuse, vUv ).g, texture2D( tDiffuse, vUv - off ).b );
      float n = hash( vec3( floor( vUv * uRes / uGrainSize ), floor( uTime * 24.0 ) ) ) - 0.5;
      float luma = dot( col, vec3( 0.299, 0.587, 0.114 ) );
      col += n * uGrain * ( 1.0 - 0.6 * luma );
      gl_FragColor = vec4( col, 1.0 );
    }`,
};

export interface Post {
  render(dt: number, timeSec: number): void;
  setSize(w: number, h: number, pixelRatio: number): void;
  sync(cfg: Look['post']): void;
  dispose(): void;
}

/** Chromatic aberration + grain. High tier only: the caller must not build this on medium/low. */
export function createPost(renderer: WebGLRenderer, scene: Scene, camera: Camera, cfg: Look['post']): Post {
  const composer = new EffectComposer(renderer, new WebGLRenderTarget(1, 1, { type: HalfFloatType, samples: 4 })); // MSAA kept: composer targets default to none
  const pass = new ShaderPass(PostShader);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(new OutputPass());
  composer.addPass(pass);
  const u = pass.uniforms;
  const size = new Vector2();
  const sync = (c: Look['post']) => {
    u.uCA.value = c.chromaticAberration;
    u.uGrain.value = c.grain;
    u.uGrainSize.value = c.grainSize;
  };
  sync(cfg);
  return {
    sync,
    setSize(w, h, pr) {
      composer.setPixelRatio(pr);
      composer.setSize(w, h);
      renderer.getDrawingBufferSize(size);
      u.uRes.value.copy(size);
    },
    render(dt, t) {
      u.uTime.value = t;
      composer.render(dt);
    },
    dispose() {
      composer.dispose();
    },
  };
}
