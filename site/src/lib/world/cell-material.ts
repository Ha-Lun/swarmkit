import {
  BackSide, BoxGeometry, BufferAttribute, Color, Mesh, MeshBasicMaterial, MeshStandardMaterial, PMREMGenerator, Scene,
  SphereGeometry, type IUniform, type Texture, type WebGLRenderer,
} from 'three';
import { CELL_RADIUS, SINK, type Look, type Palette, type Tier } from './config';

export interface CellUniforms {
  uRim: IUniform<number>;
  uRimPower: IUniform<number>;
  uThickness: IUniform<number>;
  uDensity: IUniform<number>;
  uCore: IUniform<number>;
  uCoreRadius: IUniform<number>;
  uBevel: IUniform<number>;
  uDome: IUniform<number>;
  uSheen: IUniform<number>;
  uPearl: IUniform<number>;
  uPearlHorizon: IUniform<number>;
  uSeamGlow: IUniform<number>;
  uSeamDepth: IUniform<number>;
  uRimColor: IUniform<Color>;
  uSssColor: IUniform<Color>;
  uCoreColor: IUniform<Color>;
  uSeamColor: IUniform<Color>;
  uPearlWarm: IUniform<Color>;
  uPearlCool: IUniform<Color>;
}

export interface CellMaterial {
  material: MeshStandardMaterial;
  uniforms: CellUniforms;
  /** colour the seam floor (the sphere under the cells) should have at glow 1, undimmed */
  seamColor: Color;
  /** copy slider/config values into the uniforms (cheap, call per frame or on change) */
  sync(cfg: Look['cell']): void;
}

/**
 * Pearlescent ceramic on top of MeshStandardMaterial, patched via onBeforeCompile. Every colour is a mix of the five
 * palette tokens (wax, wax-dim, text, ink-2, ink); nothing here is a new colour and the accent is never read.
 *  - satin body: low roughness, soft wide highlight; the key and kicker lights drive a grazing-angle sheen
 *  - pearl: a faint hue shift toward each cell's edge and toward the horizon (chroma moves toward a palette mix, luminance kept)
 *  - engraved seams: a bevel on the top edge (vertex stage, so it works on both prism kinds and every instance scale)
 *    and a warm glow that climbs the seam walls; honeycomb.ts adds the matching glowing floor under the cells
 *  - agent cores stay the emissive nodes, with a softer falloff
 * Per-instance attributes (honeycomb.ts): aEmissive (core strength), aLift (world-unit rise along the instance's up axis,
 * i.e. the sphere normal). Per-geometry: aSides (5 or 6), aBev (x: rim drops by the bevel, y: rim insets by the bevel).
 * Medium tier: same body, bevel, seams, sheen and horizon pearl, but no thickness/density, no edge pearl and no studio reflection.
 */
export function createCellMaterial(tier: Tier, palette: Palette, cfg: Look['cell']): CellMaterial {
  const wax = new Color(palette.wax);
  const waxDim = new Color(palette.waxDim);
  const text = new Color(palette.text);
  const ink2 = new Color(palette.ink2);
  const seamColor = waxDim.clone().lerp(wax, 0.35);
  const uniforms: CellUniforms = {
    uRim: { value: cfg.rim },
    uRimPower: { value: cfg.rimPower },
    uThickness: { value: cfg.thickness },
    uDensity: { value: cfg.density },
    uCore: { value: cfg.core },
    uCoreRadius: { value: cfg.coreRadius },
    uBevel: { value: cfg.bevel },
    uDome: { value: cfg.dome },
    uSheen: { value: cfg.sheen },
    uPearl: { value: cfg.pearl },
    uPearlHorizon: { value: cfg.pearlHorizon },
    uSeamGlow: { value: cfg.seamGlow },
    uSeamDepth: { value: cfg.seamDepth },
    uRimColor: { value: wax.clone().lerp(text, 0.45) },
    uSssColor: { value: wax.clone().lerp(waxDim, 0.35) },
    uCoreColor: { value: wax.clone() }, // Colour B, never the accent
    uSeamColor: { value: seamColor.clone() },
    uPearlWarm: { value: wax.clone().lerp(text, 0.55) }, // champagne
    uPearlCool: { value: ink2.clone().lerp(text, 0.55) }, // silvery blue-grey
  };

  const material = new MeshStandardMaterial({
    color: wax.clone().lerp(text, 0.55), // glaze: bone toward the pale text tone
    roughness: cfg.roughness,
    metalness: 0,
    dithering: true,
  });

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    const defs = tier === 'high' ? '#define CELL_HIGH\n' : '';

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute float aEmissive;
        attribute float aLift;
        attribute float aSides;
        attribute vec2 aBev;
        uniform float uBevel, uDome;
        varying vec3 vCellLocal;
        varying float vEmissive;
        varying float vSides;
        varying float vHeightW;
        varying float vNy;`,
      )
      // pillow: the top face's normals lean outward toward the cell's edge, so each cell shades like a soft satin dome
      .replace(
        '#include <beginnormal_vertex>',
        `#include <beginnormal_vertex>
        if ( normal.y > 0.99 ) objectNormal = normalize( objectNormal + vec3( position.x, 0.0, position.z ) * ( uDome / ${CELL_RADIUS.toFixed(4)} ) );`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vCellLocal = position;
        vEmissive = aEmissive;
        vSides = aSides;
        vNy = normal.y;
        {
          // bevel in world units: the rim drops and the top face insets, whatever the instance's own height or footprint scale
          float sx = length( instanceMatrix[ 0 ].xyz );
          float sy = length( instanceMatrix[ 1 ].xyz );
          float b = min( uBevel, min( 0.3 * ${CELL_RADIUS.toFixed(4)} * sx, 0.8 * max( sy - ${SINK.toFixed(4)}, 0.02 ) ) );
          transformed.y -= aBev.x * b / max( sy, 1e-4 );
          transformed.xz *= 1.0 - aBev.y * b / max( ${CELL_RADIUS.toFixed(4)} * sx, 1e-4 );
          vHeightW = position.y * sy;
        }`,
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
        `${defs}#include <common>
        uniform float uRim, uRimPower, uThickness, uDensity, uCore, uCoreRadius, uSheen, uPearl, uPearlHorizon, uSeamGlow, uSeamDepth;
        uniform vec3 uRimColor, uSssColor, uCoreColor, uSeamColor, uPearlWarm, uPearlCool;
        varying vec3 vCellLocal;
        varying float vEmissive;
        varying float vSides;
        varying float vHeightW;
        varying float vNy;`,
      )
      .replace(
        '#include <opaque_fragment>',
        `{
          vec3 N = normalize( normal );
          float ndv = saturate( dot( N, normalize( vViewPosition ) ) );
          float lum = dot( diffuseColor.rgb, vec3( 0.3333 ) );
          float grazing = 1.0 - ndv;
          // polygon distance (5 or 6 sides) in the prism's local xz (1.0 at the wall), y runs 0..1. A vertex sits on +z.
          float sec = 6.2831853 / floor( vSides + 0.5 );
          float ang = mod( atan( vCellLocal.x + 1e-6, vCellLocal.z ) + 6.2831853, sec ) - 0.5 * sec;
          float hd = length( vCellLocal.xz ) * cos( ang ) / ( ${CELL_RADIUS.toFixed(4)} * cos( 0.5 * sec ) );
          float edge = smoothstep( 0.5, 1.0, hd );

          #ifdef CELL_HIGH
            float thin = max( smoothstep( 0.6, 1.0, hd ), smoothstep( 0.82, 1.0, vCellLocal.y ) );
            outgoingLight *= 1.0 - uDensity * ( 1.0 - thin );
            outgoingLight += uSssColor * lum * thin * uThickness * ( 0.4 + 0.6 * grazing );
          #endif

          // satin sheen: a wide soft lift at grazing angles, stronger on the side the key and the kicker light
          float lit = 0.35;
          #if NUM_DIR_LIGHTS > 1
            lit = 0.3 + 0.7 * saturate( dot( N, directionalLights[ 0 ].direction ) )
                + 1.6 * saturate( dot( N, directionalLights[ 1 ].direction ) + 0.1 );
          #endif
          outgoingLight += uRimColor * lum * uSheen * pow( grazing, 2.0 ) * lit;
          outgoingLight += uRimColor * lum * uRim * pow( grazing, uRimPower );

          // pearl: move the chroma toward a palette mix (luminance kept) at the cell's edge and toward the horizon
          float horizon = pow( grazing, 1.8 );
          #ifdef CELL_HIGH
            float pk = saturate( uPearl * edge * 0.8 + uPearlHorizon * horizon );
          #else
            float pk = saturate( uPearlHorizon * horizon );
          #endif
          vec3 pearl = mix( uPearlWarm, uPearlCool, saturate( horizon * 1.5 + edge * 0.35 ) );
          float outLum = dot( outgoingLight, vec3( 0.3333 ) );
          outgoingLight = mix( outgoingLight, pearl * ( outLum / max( dot( pearl, vec3( 0.3333 ) ), 1e-3 ) ), pk );

          // engraved seams: warm glow that climbs the walls from the floor (the floor sphere under the cells glows too)
          float wall = 1.0 - smoothstep( 0.15, 0.6, vNy );
          float rise = max( vHeightW - ${(SINK * 0.5).toFixed(4)}, 0.0 );
          outgoingLight += uSeamColor * uSeamGlow * wall * exp( -rise / max( uSeamDepth, 1e-3 ) );

          float coreMask = ( 1.0 - smoothstep( uCoreRadius * 0.12, uCoreRadius, hd ) )
                         * mix( 0.35, 1.0, smoothstep( 0.3, 1.0, vCellLocal.y ) );
          outgoingLight += uCoreColor * coreMask * coreMask * uCore * vEmissive;
        }
        #include <opaque_fragment>`,
      );
  };
  material.customProgramCacheKey = () => `cell-${tier}-r4`;

  return {
    material,
    uniforms,
    seamColor,
    sync(c) {
      uniforms.uRim.value = c.rim;
      uniforms.uRimPower.value = c.rimPower;
      uniforms.uThickness.value = c.thickness;
      uniforms.uDensity.value = c.density;
      uniforms.uCore.value = c.core;
      uniforms.uCoreRadius.value = c.coreRadius;
      uniforms.uBevel.value = c.bevel;
      uniforms.uDome.value = c.dome;
      uniforms.uSheen.value = c.sheen;
      uniforms.uPearl.value = c.pearl;
      uniforms.uPearlHorizon.value = c.pearlHorizon;
      uniforms.uSeamGlow.value = c.seamGlow;
      uniforms.uSeamDepth.value = c.seamDepth;
      material.roughness = c.roughness;
      material.envMapIntensity = c.envIntensity;
    },
  };
}

/**
 * Procedural studio reflection for the ceramic (high tier): a dark ink room with a soft overhead box, a warm key panel and
 * a cool thin strip behind. Colours are palette mixes; nothing is loaded. Baked once into a PMREM texture.
 */
export function createStudioEnv(renderer: WebGLRenderer, palette: Palette): { texture: Texture; dispose(): void } {
  const ink = new Color(palette.ink), ink2 = new Color(palette.ink2), text = new Color(palette.text);
  const wax = new Color(palette.wax), waxDim = new Color(palette.waxDim);
  const room = new Scene();
  const geos: (SphereGeometry | BoxGeometry)[] = [];
  const mats: MeshBasicMaterial[] = [];
  const add = (geo: SphereGeometry | BoxGeometry, mat: MeshBasicMaterial, x: number, y: number, z: number, look = true) => {
    geos.push(geo); mats.push(mat);
    const m = new Mesh(geo, mat);
    m.position.set(x, y, z);
    if (look) m.lookAt(0, 0, 0);
    room.add(m);
  };

  const dome = new SphereGeometry(40, 24, 12);
  const top = ink.clone().lerp(ink2, 0.6), bottom = ink.clone().lerp(waxDim, 0.12);
  const col = new Float32Array(dome.attributes.position.count * 3);
  const c = new Color();
  for (let i = 0; i < dome.attributes.position.count; i++) {
    c.copy(bottom).lerp(top, (dome.attributes.position.getY(i) / 40 + 1) / 2);
    col.set([c.r, c.g, c.b], i * 3);
  }
  dome.setAttribute('color', new BufferAttribute(col, 3));
  add(dome, new MeshBasicMaterial({ vertexColors: true, side: BackSide }), 0, 0, 0, false);
  const panel = (w: number, h: number, colr: Color, k: number) =>
    [new BoxGeometry(w, h, 0.5), new MeshBasicMaterial({ color: colr.clone().multiplyScalar(k) })] as const;
  add(...panel(26, 26, text.clone().lerp(wax, 0.2), 5.0), 0, 30, 4); // overhead softbox
  add(...panel(10, 22, wax.clone().lerp(text, 0.4), 7.0), -24, 8, 14); // warm key panel, front left
  add(...panel(3, 24, ink2.clone().lerp(text, 0.55), 6.0), 20, 4, -22); // cool strip behind

  const pmrem = new PMREMGenerator(renderer);
  const rt = pmrem.fromScene(room, 0.03);
  pmrem.dispose();
  room.clear();
  return {
    texture: rt.texture,
    dispose() {
      rt.dispose();
      geos.forEach((g) => g.dispose());
      mats.forEach((m) => m.dispose());
    },
  };
}
