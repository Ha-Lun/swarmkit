// Crisp rings drawn on the globe surface by the comet: the thin scanning ring that is engraved onto the core panel while the
// task is classified, and the short ripple that travels outward across the surface where the comet lands. One transparent-free
// shell just above the panels; the fragment shader draws hard-edged rings (great-circle distance from a centre) and discards
// everything else, so there is no glow, no blending and no soft falloff. Rings are the comet's own, so they use the accent.
import { Color, Mesh, ShaderMaterial, SphereGeometry, Vector4, type Vector3 } from 'three';

export const RING_SLOTS = 8;

export interface RingFx {
  mesh: Mesh;
  /** arc of a ring: centre = unit direction, radius/width in world units along the surface, sweep 0..1 = how much of the circle is drawn */
  set(slot: number, centre: Vector3, radius: number, width: number, sweep: number): void;
  clear(slot: number): void;
  clearAll(): void;
  /** radius of the shell the rings are drawn on (the comet's rings sit just above the panel they mark) */
  setShell(radius: number): void;
  dispose(): void;
}

export function createRingFx(shellRadius: number, accent: string): RingFx {
  const geo = new SphereGeometry(shellRadius, 192, 96);
  const mat = new ShaderMaterial({
    uniforms: {
      uColor: { value: new Color(accent) },
      uA: { value: Array.from({ length: RING_SLOTS }, () => new Vector4(0, 0, 1, 0)) },
      uB: { value: Array.from({ length: RING_SLOTS }, () => new Vector4()) },
      uR: { value: shellRadius },
    },
    vertexShader: /* glsl */ `varying vec3 vP; void main() { vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 ); }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; uniform vec4 uA[${RING_SLOTS}]; uniform vec4 uB[${RING_SLOTS}]; uniform float uR;
      varying vec3 vP;
      void main() {
        vec3 n = normalize( vP );
        float cov = 0.0;
        for ( int i = 0; i < ${RING_SLOTS}; i++ ) {
          if ( uB[ i ].z < 0.5 ) continue;
          vec3 c = uA[ i ].xyz;
          float ang = 2.0 * asin( clamp( 0.5 * length( n - c ), 0.0, 1.0 ) ) * uR; // distance along the surface from the centre
          float px = max( fwidth( ang ), 1e-4 );
          float w = max( uB[ i ].x, px * 1.6 ); // never thinner than about a pixel and a half: a crisp line, not a dotted one
          float hit = 1.0 - smoothstep( 0.5 * w - px * 0.75, 0.5 * w + px * 0.75, abs( ang - uA[ i ].w ) );
          if ( uB[ i ].y < 0.999 ) {
            vec3 t = normalize( cross( c, abs( c.y ) < 0.9 ? vec3( 0.0, 1.0, 0.0 ) : vec3( 1.0, 0.0, 0.0 ) ) );
            vec3 b = cross( c, t );
            float f = atan( dot( n, b ), dot( n, t ) ) / 6.2831853 + 0.5;
            hit *= 1.0 - smoothstep( uB[ i ].y - 0.004, uB[ i ].y + 0.004, f );
          }
          cov = max( cov, hit );
        }
        if ( cov < 0.5 ) discard;
        gl_FragColor = vec4( uColor, 1.0 );
        #include <colorspace_fragment>
      }`,
    fog: false,
  });
  mat.polygonOffset = true;
  mat.polygonOffsetFactor = -2;
  const mesh = new Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.visible = false;
  const a = mat.uniforms.uA.value as Vector4[], b = mat.uniforms.uB.value as Vector4[];
  const refresh = () => { mesh.visible = b.some((s) => s.z > 0.5); };
  return {
    mesh,
    set(slot, centre, radius, width, sweep) {
      a[slot].set(centre.x, centre.y, centre.z, radius);
      b[slot].set(Math.max(width, 0), sweep, width > 1e-4 ? 1 : 0, 0);
      refresh();
    },
    clear(slot) { b[slot].z = 0; refresh(); },
    clearAll() { b.forEach((s) => (s.z = 0)); mesh.visible = false; },
    setShell(radius) { mesh.scale.setScalar(radius / shellRadius); },
    dispose() { geo.dispose(); mat.dispose(); },
  };
}
