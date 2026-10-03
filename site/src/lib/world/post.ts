import {
  DepthStencilFormat, DepthTexture, Group, HalfFloatType, NearestFilter, Scene, UnsignedInt248Type, Vector2,
  type Camera, type Texture, type WebGLRenderer, WebGLRenderTarget,
} from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { TexturePass } from 'three/addons/postprocessing/TexturePass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import type { Look } from './config';

// Runs after OutputPass, i.e. in display (sRGB) space, so grain and vignette amplitude are what you see.
const PostShader = {
  uniforms: {
    tDiffuse: { value: null },
    uRes: { value: new Vector2(1, 1) },
    uTime: { value: 0 },
    uCA: { value: 0.01 },
    uGrain: { value: 0.03 },
    uGrainSize: { value: 1.5 },
    uVignette: { value: 0.3 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 ); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 uRes;
    uniform float uTime, uCA, uGrain, uGrainSize, uVignette;
    varying vec2 vUv;
    float hash( vec3 p ) { p = fract( p * 0.1031 ); p += dot( p, p.zyx + 31.32 ); return fract( ( p.x + p.y ) * p.z ); }
    void main() {
      vec2 dir = vUv - 0.5;
      vec2 off = dir * dot( dir, dir ) * uCA; // zero at centre, grows toward the edges
      vec3 col = vec3( texture2D( tDiffuse, vUv + off ).r, texture2D( tDiffuse, vUv ).g, texture2D( tDiffuse, vUv - off ).b );
      float n = hash( vec3( floor( vUv * uRes / uGrainSize ), floor( uTime * 24.0 ) ) ) - 0.5;
      float luma = dot( col, vec3( 0.299, 0.587, 0.114 ) );
      col += n * uGrain * ( 1.0 - 0.6 * luma );
      col *= 1.0 - uVignette * dot( dir, dir ) * 1.7;
      gl_FragColor = vec4( col, 1.0 );
    }`,
};

export interface Post {
  /** live frame: the scene stage (GTAO, bloom) into an internal target, then the output stage, straight to screen */
  render(dt: number, timeSec: number): void;
  /** scene stage only (G-buffer, GTAO, bloom): linear HDR into an external target. Used for the two Cells -> Proof
   *  dissolve halves, so AO/bloom never pop in or out of the transition. */
  renderScene(target: WebGLRenderTarget, dt: number): void;
  /** the same output stage (ACES + sRGB, chromatic aberration, grain, vignette) fed from a finished HDR texture: the
   *  dissolve composite, or renderScene's own result, so a transition has no seam against `render` */
  renderTexture(map: Texture, dt: number, timeSec: number): void;
  setSize(w: number, h: number, pixelRatio: number): void;
  sync(cfg: Look['post']): void;
  dispose(): void;
}

/**
 * High tier only. Two stages (round 11):
 *  - scene stage: RenderPass -> GTAOPass -> UnrealBloomPass, linear HDR, MSAA x4 on the RenderPass target. GTAO reads a
 *    dedicated G-buffer (cell-normal.ts's twin of the panels via `aoGroup`, at half resolution: honeycomb.ts's shader
 *    reshapes every panel, so the default normal override would miss them entirely).
 *  - output stage: OutputPass (ACES + sRGB) -> chromatic aberration, grain and a vignette.
 * The three scene-stage passes are called directly (not through an EffectComposer), so their result can land in
 * whichever caller-owned target the frame needs (world.ts's dissolve halves, or this module's own `sceneOut`).
 */
export function createPost(renderer: WebGLRenderer, scene: Scene, camera: Camera, cfg: Look['post'], aoGroups: Group[]): Post {
  const gScene = new Scene(); // G-buffer only: the panels' twin and the comets' twins, nothing else (no overrideMaterial, no other scene content to corrupt it)
  gScene.add(...aoGroups);
  const gDepth = new DepthTexture(1, 1);
  gDepth.format = DepthStencilFormat;
  gDepth.type = UnsignedInt248Type;
  const gTarget = new WebGLRenderTarget(1, 1, { minFilter: NearestFilter, magFilter: NearestFilter, type: HalfFloatType, depthTexture: gDepth });

  const renderPass = new RenderPass(scene, camera);
  const gtaoPass = new GTAOPass(scene, camera, 1, 1);
  gtaoPass.setGBuffer(gDepth, gTarget.texture); // our own G-buffer: skips GTAOPass's default (unreshaped) normal render
  const bloomPass = new UnrealBloomPass(new Vector2(1, 1), cfg.bloomStrength, cfg.bloomRadius, cfg.bloomThreshold);

  const sceneA = new WebGLRenderTarget(1, 1, { type: HalfFloatType, samples: 4 }); // RenderPass's own MSAA target
  const sceneOut = new WebGLRenderTarget(1, 1, { type: HalfFloatType }); // the live path's finished scene-stage result

  function renderScene(target: WebGLRenderTarget, dt: number) {
    renderer.setRenderTarget(gTarget);
    renderer.render(gScene, camera);
    renderPass.render(renderer, sceneA, sceneA, dt, false); // scene -> sceneA (MSAA)
    gtaoPass.render(renderer, target, sceneA, dt, false); // sceneA -> target, AO blended in
    bloomPass.render(renderer, target, target, dt, false); // target -> target, bloom blended in additively
  }

  // output stage: a finished HDR texture -> OutputPass (ACES + sRGB) -> CA/grain/vignette -> screen
  const composerOutput = new EffectComposer(renderer, new WebGLRenderTarget(1, 1, { type: HalfFloatType }));
  const texPass = new TexturePass();
  const outPass = new ShaderPass(PostShader);
  composerOutput.addPass(texPass);
  composerOutput.addPass(new OutputPass());
  composerOutput.addPass(outPass);
  const u = outPass.uniforms;
  const size = new Vector2();
  const syncOutput = (c: Look['post']) => {
    u.uCA.value = c.chromaticAberration;
    u.uGrain.value = c.grain;
    u.uGrainSize.value = c.grainSize;
    u.uVignette.value = c.vignette;
  };
  syncOutput(cfg);

  return {
    sync(c) {
      syncOutput(c);
      gtaoPass.updateGtaoMaterial({ radius: c.aoRadius });
      gtaoPass.blendIntensity = c.aoIntensity;
      bloomPass.threshold = c.bloomThreshold;
      bloomPass.strength = c.bloomStrength;
      bloomPass.radius = c.bloomRadius;
    },
    setSize(w, h, pr) {
      const dw = Math.max(1, Math.round(w * pr)), dh = Math.max(1, Math.round(h * pr));
      sceneA.setSize(dw, dh);
      sceneOut.setSize(dw, dh);
      const hw = Math.max(1, Math.round(dw / 2)), hh = Math.max(1, Math.round(dh / 2));
      gTarget.setSize(hw, hh);
      gtaoPass.setSize(hw, hh); // half resolution: the AO probe, not the frame it blends onto
      bloomPass.setSize(dw, dh);
      composerOutput.setPixelRatio(pr);
      composerOutput.setSize(w, h);
      renderer.getDrawingBufferSize(size);
      u.uRes.value.copy(size);
    },
    renderScene,
    renderTexture(map, dt, t) {
      texPass.map = map;
      u.uTime.value = t;
      composerOutput.render(dt);
    },
    render(dt, t) {
      renderScene(sceneOut, dt);
      this.renderTexture(sceneOut.texture, dt, t);
    },
    dispose() {
      gTarget.dispose();
      sceneA.dispose();
      sceneOut.dispose();
      gtaoPass.dispose();
      bloomPass.dispose();
      composerOutput.dispose();
      texPass.dispose();
    },
  };
}
