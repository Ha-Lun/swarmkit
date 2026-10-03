// The walker's sky: a dome drawn behind everything while the camera is on the ground, so the planet has a horizon. Procedural, palette colours only, no texture.
// The dark limb of the globe is rimmed by a cool haze that fades to ink overhead; the ground fog takes the haze's colour (world.ts), so distant pillars stand as silhouettes
// against it instead of dissolving into black; a sparse field of small stars sits in the dark above. The dome is transparent and depth-tested at a radius far beyond the
// globe, so the stone always draws over it, and its alpha is the walk weight, so the orbit views never see it.
import { BackSide, Color, Mesh, ShaderMaterial, SphereGeometry, Vector3 } from 'three';
import type { Palette } from './config';

export interface Sky {
  mesh: Mesh;
  /** `up` = the walker's up (unit), `dip` = how far below the horizontal the globe's limb sits (radians), `weight` = the walk weight, `haze` and `stars` = the look's strengths */
  update(cameraPos: Vector3, up: Vector3, dip: number, weight: number, haze: number, stars: number): void;
  readonly hazeColor: Color;
  dispose(): void;
}

const vert = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = position;
    vec4 p = modelViewMatrix * vec4( position, 1.0 );
    gl_Position = projectionMatrix * p;
  }`;

const frag = /* glsl */ `
  uniform vec3 uUp, uInk, uInk2, uHaze, uWax;
  uniform float uDip, uWeight, uHazeAmount, uStars;
  varying vec3 vDir;
  float h13( vec3 p ) { p = fract( p * 0.1031 ); p += dot( p, p.zyx + 31.32 ); return fract( ( p.x + p.y ) * p.z ); }
  void main() {
    vec3 d = normalize( vDir );
    float e = dot( d, uUp );
    float ang = asin( clamp( e, -1.0, 1.0 ) ); // elevation above the horizontal
    float above = ang + uDip; // radians above the globe's limb
    float haze = pow( clamp( 1.0 - above, 0.0, 1.0 ), 2.2 );
    vec3 col = mix( uInk, uInk2, smoothstep( -0.3, 1.1, ang ) );
    col += uHaze * uHazeAmount * haze;
    // stars: a jittered point in about one cell in sixty of a grid over the sphere of directions, faded where the haze is bright
    vec3 p = d * 64.0;
    vec3 id = floor( p );
    if ( h13( id ) > 0.984 ) {
      vec3 j = vec3( h13( id + 1.7 ), h13( id + 5.3 ), h13( id + 9.1 ) ) - 0.5;
      float s = smoothstep( 0.1, 0.0, length( fract( p ) - 0.5 - j * 0.7 ) );
      col += uWax * s * uStars * ( 0.25 + 0.75 * h13( id + 3.3 ) ) * ( 1.0 - 0.9 * haze );
    }
    gl_FragColor = vec4( col, uWeight );
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

export function createSky(palette: Palette): Sky {
  const ink = new Color(palette.ink), ink2 = new Color(palette.ink2), wax = new Color(palette.wax), waxDim = new Color(palette.waxDim);
  const hazeColor = ink2.clone().lerp(waxDim, 0.75);
  const material = new ShaderMaterial({
    uniforms: {
      uUp: { value: new Vector3(0, 1, 0) }, uInk: { value: ink }, uInk2: { value: ink2 }, uHaze: { value: hazeColor }, uWax: { value: wax },
      uDip: { value: 0.4 }, uWeight: { value: 0 }, uHazeAmount: { value: 1 }, uStars: { value: 1 },
    },
    vertexShader: vert, fragmentShader: frag,
    side: BackSide, transparent: true, depthWrite: false, fog: false,
  });
  const mesh = new Mesh(new SphereGeometry(100, 48, 24), material);
  mesh.frustumCulled = false;
  mesh.renderOrder = -10;
  mesh.visible = false;
  return {
    mesh,
    hazeColor,
    update(cameraPos, up, dip, weight, haze, stars) {
      mesh.visible = weight > 0.001;
      if (!mesh.visible) return;
      mesh.position.copy(cameraPos);
      const u = material.uniforms;
      (u.uUp.value as Vector3).copy(up);
      u.uDip.value = dip;
      u.uWeight.value = weight;
      u.uHazeAmount.value = haze;
      u.uStars.value = stars;
    },
    dispose() { mesh.geometry.dispose(); material.dispose(); },
  };
}
