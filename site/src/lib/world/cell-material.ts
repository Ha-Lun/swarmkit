import { Color, MeshStandardMaterial, type IUniform } from 'three';
import { CELL_RADIUS, type Look, type Palette, type Tier } from './config';

export interface CellUniforms {
  uRim: IUniform<number>;
  uRimPower: IUniform<number>;
  uThickness: IUniform<number>;
  uDensity: IUniform<number>;
  uCore: IUniform<number>;
  uCoreRadius: IUniform<number>;
  uRimColor: IUniform<Color>;
  uSssColor: IUniform<Color>;
  uCoreColor: IUniform<Color>;
}

export interface CellMaterial {
  material: MeshStandardMaterial;
  uniforms: CellUniforms;
  /** copy slider/config values into the uniforms (cheap, call per frame or on change) */
  sync(cfg: Look['cell']): void;
}

/**
 * Translucent wax look on top of MeshStandardMaterial, patched via onBeforeCompile.
 * Per-instance attributes (set by honeycomb.ts): aEmissive (core strength), aLift (world-unit rise along the
 * instance's own up axis, i.e. the sphere normal). Per-geometry: aSides (5 or 6, the footprint).
 * The local prism position drives the thickness/core masks, so no textures are needed. Instances are rotated onto
 * the sphere; three's instancing chunks already rotate the normal, so the fresnel term needs no change.
 * Medium tier: same body, rim and core, but no thickness/density term.
 */
export function createCellMaterial(tier: Tier, palette: Palette, cfg: Look['cell']): CellMaterial {
  const wax = new Color(palette.wax);
  const uniforms: CellUniforms = {
    uRim: { value: cfg.rim },
    uRimPower: { value: cfg.rimPower },
    uThickness: { value: cfg.thickness },
    uDensity: { value: cfg.density },
    uCore: { value: cfg.core },
    uCoreRadius: { value: cfg.coreRadius },
    uRimColor: { value: wax.clone().lerp(new Color(palette.text), 0.35) },
    uSssColor: { value: wax.clone().multiply(new Color(1.0, 0.82, 0.62)) }, // pushed warmer than the body
    uCoreColor: { value: wax.clone() }, // Colour B, never the accent
  };

  const material = new MeshStandardMaterial({
    color: wax,
    roughness: cfg.roughness,
    metalness: 0,
    dithering: true,
  });

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    const sss = tier === 'high' ? '#define CELL_SSS\n' : '';

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute float aEmissive;
        attribute float aLift;
        attribute float aSides;
        varying vec3 vCellLocal;
        varying float vEmissive;
        varying float vSides;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vCellLocal = position;
        vEmissive = aEmissive;
        vSides = aSides;`,
      )
      // project_vertex with the lift applied after the instance matrix, along the instance's up (surface normal)
      .replace(
        '#include <project_vertex>',
        `vec4 mvPosition = vec4( transformed, 1.0 );
        mvPosition = instanceMatrix * mvPosition;
        mvPosition.xyz += normalize( instanceMatrix[ 1 ].xyz ) * aLift;
        mvPosition = modelViewMatrix * mvPosition;
        gl_Position = projectionMatrix * mvPosition;`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `${sss}#include <common>
        uniform float uRim, uRimPower, uThickness, uDensity, uCore, uCoreRadius;
        uniform vec3 uRimColor, uSssColor, uCoreColor;
        varying vec3 vCellLocal;
        varying float vEmissive;
        varying float vSides;`,
      )
      .replace(
        '#include <opaque_fragment>',
        `{
          float ndv = saturate( dot( normalize( normal ), normalize( vViewPosition ) ) );
          float lum = dot( diffuseColor.rgb, vec3( 0.3333 ) );
          // polygon distance (5 or 6 sides) in the prism's local xz (1.0 at the wall), y runs 0..1. A vertex sits on +z.
          float sec = 6.2831853 / floor( vSides + 0.5 );
          float ang = mod( atan( vCellLocal.x + 1e-6, vCellLocal.z ) + 6.2831853, sec ) - 0.5 * sec;
          float hd = length( vCellLocal.xz ) * cos( ang ) / ( ${CELL_RADIUS.toFixed(4)} * cos( 0.5 * sec ) );
          #ifdef CELL_SSS
            float thin = max( smoothstep( 0.6, 1.0, hd ), smoothstep( 0.82, 1.0, vCellLocal.y ) );
            outgoingLight *= 1.0 - uDensity * ( 1.0 - thin );
            outgoingLight += uSssColor * lum * thin * uThickness * ( 0.4 + 0.6 * ( 1.0 - ndv ) );
          #endif
          outgoingLight += uRimColor * lum * uRim * pow( 1.0 - ndv, uRimPower );
          float coreMask = ( 1.0 - smoothstep( uCoreRadius * 0.3, uCoreRadius, hd ) )
                         * mix( 0.35, 1.0, smoothstep( 0.3, 1.0, vCellLocal.y ) );
          outgoingLight += uCoreColor * coreMask * uCore * vEmissive;
        }
        #include <opaque_fragment>`,
      );
  };
  material.customProgramCacheKey = () => `cell-${tier}`;

  return {
    material,
    uniforms,
    sync(c) {
      uniforms.uRim.value = c.rim;
      uniforms.uRimPower.value = c.rimPower;
      uniforms.uThickness.value = c.thickness;
      uniforms.uDensity.value = c.density;
      uniforms.uCore.value = c.core;
      uniforms.uCoreRadius.value = c.coreRadius;
      material.roughness = c.roughness;
    },
  };
}
