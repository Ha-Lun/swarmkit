import {
  BackSide, BoxGeometry, BufferAttribute, Color, Mesh, MeshBasicMaterial, MeshStandardMaterial, PMREMGenerator, Scene,
  SphereGeometry, type IUniform, type Texture, type WebGLRenderer,
} from 'three';
import { SINK, type Look, type Palette, type Tier } from './config';

export interface CellUniforms {
  uBevel: IUniform<number>;
  uSheen: IUniform<number>;
  uCrag: IUniform<number>;
  uStrata: IUniform<number>;
  uCrack: IUniform<number>;
  uMottle: IUniform<number>;
  uTone: IUniform<number>;
  uAgentTone: IUniform<number>;
  uHover: IUniform<number>;
  uStoneBase: IUniform<Color>;
  uStoneMid: IUniform<Color>;
  uStoneLight: IUniform<Color>;
  uStoneDark: IUniform<Color>;
  uSheenColor: IUniform<Color>;
}

export interface CellMaterial {
  material: MeshStandardMaterial;
  uniforms: CellUniforms;
  /** copy slider/config values into the uniforms (cheap, call per frame or on change) */
  sync(cfg: Look['cell']): void;
}

/**
 * Jagged rock on top of MeshStandardMaterial, patched via onBeforeCompile. Every colour is a mix of the five palette
 * tokens (wax, wax-dim, text, ink-2, ink); nothing here is a new colour and the accent is never read. Nothing is self-lit.
 *  - flush panels: the vertex stage replaces the unit prism's corners with the instance's own Voronoi corners (aCorn*), curves
 *    the top onto its sphere (aStone.w = 1 / body radius) and adds a hairline fillet in world units, so seams stay crisp and even.
 *    Each column has its own height (honeycomb.ts applies the terrain), so the side walls are visible and get the rock too
 *  - rock: ridged fBm crags, wobbly strata bands (horizontal on the column walls, so bedding runs across neighbours), fine cracks
 *    (a level set of a noise), a slow mottle and a tint by elevation (higher = paler). The same field is a height that perturbs the
 *    normal (screen-derivative bump mapping), so the key and kicker lights catch the crags. Octaves smaller than the pixel
 *    footprint fade out, so it never shimmers at distance. The field is anchored per panel (aStone: rotation, offset)
 *  - agents: cut flat and polished: no crags or cracks, lighter stone with a small tone step per band (aRock.y), lower roughness,
 *    a slightly wider bevel so the cut edge catches the light. No inlay, no accent, no glow (aInlay.x = agent flag, aInlay.w = half-width)
 *  - hover/focus: aState.x brightens the tone, aState.y lifts the panel along its normal
 * Medium tier: same body, seams, sheen, strata, cracks and two crag octaves; no finest octave, no bump normal, one mottle
 * octave, no studio reflection.
 */
export function createCellMaterial(tier: Tier, palette: Palette, cfg: Look['cell']): CellMaterial {
  const wax = new Color(palette.wax);
  const waxDim = new Color(palette.waxDim);
  const text = new Color(palette.text);
  const ink2 = new Color(palette.ink2);
  const uniforms: CellUniforms = {
    uBevel: { value: cfg.bevel },
    uSheen: { value: cfg.sheen },
    uCrag: { value: cfg.crag },
    uStrata: { value: cfg.strata },
    uCrack: { value: cfg.crack },
    uMottle: { value: cfg.mottle },
    uTone: { value: cfg.tone },
    uAgentTone: { value: cfg.agentTone },
    uHover: { value: cfg.hover },
    uStoneBase: { value: waxDim.clone().lerp(wax, 0.55) }, // the body of the stone
    uStoneMid: { value: wax.clone() },
    uStoneLight: { value: text.clone() },
    uStoneDark: { value: ink2.clone() },
    uSheenColor: { value: wax.clone().lerp(text, 0.45) },
  };

  const material = new MeshStandardMaterial({
    color: new Color(1, 1, 1), // the stone colour is computed in the shader; this only carries the proof-chapter dimming
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
        attribute float aK;
        attribute vec2 aBev;
        attribute vec2 aState;
        attribute vec4 aStone;
        attribute vec4 aInlay;
        attribute vec2 aRock;
        attribute vec4 aCornA;
        attribute vec4 aCornB;
        attribute vec4 aCornC;
        uniform float uBevel;
        varying vec2 vCell;
        varying vec3 vStone;
        varying vec4 vInlay;
        varying vec2 vRock;
        varying float vWallH;
        varying float vHover;
        varying float vNy;
        vec2 cornerOf() {
          float k = floor( aK + 0.5 );
          return k < 0.0 ? vec2( 0.0 ) : k < 0.5 ? aCornA.xy : k < 1.5 ? aCornA.zw : k < 2.5 ? aCornB.xy : k < 3.5 ? aCornB.zw : k < 4.5 ? aCornC.xy : aCornC.zw;
        }`,
      )
      // the top face follows its sphere: its normals lean outward by (distance from the panel centre) / (body radius)
      .replace(
        '#include <beginnormal_vertex>',
        `#include <beginnormal_vertex>
        if ( normal.y > 0.99 ) {
          float sxn = length( instanceMatrix[ 0 ].xyz );
          float syn = length( instanceMatrix[ 1 ].xyz );
          objectNormal = normalize( objectNormal + vec3( cornerOf().x, 0.0, cornerOf().y ) * ( -sxn * sxn * aStone.w / max( syn, 1e-4 ) ) );
        }`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vec2 cxz = cornerOf();
        transformed.xz = cxz;
        vCell = cxz;
        vStone = aStone.xyz;
        vInlay = aInlay;
        vRock = aRock;
        vHover = aState.x;
        vNy = normal.y;
        {
          float sx = length( instanceMatrix[ 0 ].xyz );
          float sy = length( instanceMatrix[ 1 ].xyz );
          // hairline fillet in world units: the rim drops and the top face insets, whatever the panel's own footprint
          vWallH = position.y * sy - ${SINK.toFixed(4)}; // height above the sphere, for the wall shading and the strata
          float b = min( uBevel * ( 1.0 + 0.9 * step( 0.5, aInlay.x ) ), // the cut facet has a slightly wider bevel that catches the light
             min( 0.35 * aInlay.w, 0.8 * max( sy - ${SINK.toFixed(4)}, 0.02 ) ) );
          transformed.y -= aBev.x * b / max( sy, 1e-4 );
          transformed.xz *= 1.0 - aBev.y * b / max( length( cxz ) * sx, 1e-4 );
          // the whole panel sits on its sphere: drop by (distance^2) / (2 body radius)
          vec2 wxz = transformed.xz * sx;
          transformed.y -= dot( wxz, wxz ) * aStone.w * 0.5 / max( sy, 1e-4 );
        }`,
      )
      // project_vertex with the lift applied after the instance matrix, along the instance's up (surface normal)
      .replace(
        '#include <project_vertex>',
        `vec4 mvPosition = vec4( transformed, 1.0 );
        mvPosition = instanceMatrix * mvPosition;
        mvPosition.xyz += normalize( instanceMatrix[ 1 ].xyz ) * aState.y;
        mvPosition = modelViewMatrix * mvPosition;
        gl_Position = projectionMatrix * mvPosition;`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `${defs}#include <common>
        uniform float uSheen, uCrag, uStrata, uCrack, uMottle, uTone, uAgentTone, uHover;
        uniform vec3 uStoneBase, uStoneMid, uStoneLight, uStoneDark, uSheenColor;
        varying vec2 vCell;
        varying vec3 vStone;
        varying vec4 vInlay;
        varying vec2 vRock;
        varying float vWallH;
        varying float vHover;
        varying float vNy;
        float gH = 0.0;    // rock height (world units) for the bump normal
        float gAgent = 0.0;
        float gWall = 0.0;

        float h21( vec2 p ) { vec3 q = fract( vec3( p.xyx ) * 0.1031 ); q += dot( q, q.yzx + 33.33 ); return fract( ( q.x + q.y ) * q.z ); }
        float vnoise( vec2 p ) {
          vec2 i = floor( p ), f = fract( p );
          f = f * f * ( 3.0 - 2.0 * f );
          return mix( mix( h21( i ), h21( i + vec2( 1.0, 0.0 ) ), f.x ), mix( h21( i + vec2( 0.0, 1.0 ) ), h21( i + vec2( 1.0, 1.0 ) ), f.x ), f.y );
        }
        vec2 h22( vec2 p ) { vec3 q = fract( vec3( p.xyx ) * vec3( 0.1031, 0.1030, 0.0973 ) ); q += dot( q, q.yzx + 33.33 ); return fract( ( q.xx + q.yz ) * q.zy ); }
        // Fractured slab: a jittered Voronoi grid where every facet is its own tilted plane. x = distance to the nearest fracture line
        // (F2 - F1), y = height of the facet plane at this point, z = a per-facet random. Angular, jagged, and flat inside each facet.
        vec3 facets( vec2 p ) {
          vec2 n = floor( p ), f = fract( p );
          float d1 = 8.0, d2 = 8.0;
          vec2 rb = vec2( 0.0 ), id = vec2( 0.0 );
          for ( int j = -1; j <= 1; j++ ) for ( int i = -1; i <= 1; i++ ) {
            vec2 g = vec2( float( i ), float( j ) );
            vec2 r = g + h22( n + g ) - f;
            float d = dot( r, r );
            if ( d < d1 ) { d2 = d1; d1 = d; rb = r; id = n + g; } else if ( d < d2 ) d2 = d;
          }
          vec2 tilt = ( h22( id + 7.0 ) - 0.5 ) * 2.0;
          return vec3( sqrt( d2 ) - sqrt( d1 ), 0.5 * dot( tilt, -rb ) + ( h21( id ) - 0.5 ) * 0.5, h21( id + 3.0 ) );
        }
        // a sharp crest where the noise crosses one half: ridged noise
        float ridged( vec2 p ) { return 1.0 - abs( 2.0 * vnoise( p ) - 1.0 ); }
        // 1 while an octave of frequency freq is well resolved by the pixel grid, 0 once a pixel spans most of its period
        float octFade( vec2 q, float freq ) { vec2 w = fwidth( q ) * freq; return 1.0 - smoothstep( 0.3, 0.8, max( w.x, w.y ) ); }
        // Mikkelsen bump: the normal tilted by the screen-space gradient of the height H (world units), so strength does not depend on distance
        vec3 bumpNormal( vec3 P, vec3 N, float H ) {
          vec3 dPdx = dFdx( P ), dPdy = dFdy( P );
          float lim = 0.7;
          float dHx = clamp( dFdx( H ), -lim * length( dPdx ), lim * length( dPdx ) );
          float dHy = clamp( dFdy( H ), -lim * length( dPdy ), lim * length( dPdy ) );
          vec3 R1 = cross( dPdy, N ), R2 = cross( N, dPdx );
          float det = dot( dPdx, R1 );
          return normalize( abs( det ) * N - sign( det ) * ( dHx * R1 + dHy * R2 ) );
        }
        // The stone: xz is the panel-local position, sd its anchor (rotation, offset), hAbs the height above the sphere,
        // wall 1 on a side wall and 0 on the top, terr the panel's terrain value. Also writes gH (the bump height).
        vec3 stone( vec2 xz, vec3 sd, float hAbs, float wall, float terr, float bandStep, float agent ) {
          float ca = cos( sd.x ), sa = sin( sd.x );
          vec2 uv = mat2( ca, -sa, sa, ca ) * xz + sd.yz;
          // tops use the panel's plane; walls run along the face and up it (up in world height, so bedding lines up across columns)
          vec2 q = mix( uv, vec2( uv.x + 0.61 * uv.y, hAbs * 1.7 ), wall );
          vec2 sq = mix( vec2( uv.x * 0.45, uv.y * 1.3 ), vec2( q.x * 0.45, hAbs * 9.0 ), wall );
          float mot = vnoise( q * 0.85 );
          float r1 = ridged( q * 0.9 + 3.1 );
          float r2 = ridged( q * 2.3 + 11.7 );
          float crag = 0.62 * r1 + 0.3 * r2;
          #ifdef CELL_HIGH
            mot = 0.65 * mot + 0.35 * vnoise( q * 2.6 + 7.0 );
            crag += 0.16 * ridged( q * 5.7 + 5.3 ) * octFade( q, 5.7 ); // the finest octave, faded by the pixel footprint
          #endif
          float sf = 1.0 - smoothstep( 0.15, 0.45, max( fwidth( sq.x ), fwidth( sq.y ) ) ); // strata fade once a band is about a pixel
          float band = 0.5 + 0.5 * sin( sq.y * 6.2832 + 4.0 * vnoise( sq * 1.3 + 9.0 ) );
          float ledge = smoothstep( 0.3, 0.7, band ) * sf;
          vec3 fc = facets( q * 1.9 + 4.0 );
          float aa = max( fwidth( fc.x ), 1e-4 );
          float crack = ( 1.0 - smoothstep( 0.02, 0.02 + aa * 1.3, fc.x ) ) * ( 1.0 - smoothstep( 0.1, 0.35, aa ) );
          float grain = 0.5;
          #ifdef CELL_HIGH
            grain = mix( 0.5, vnoise( q * 9.0 + 2.0 ), octFade( q, 9.0 ) );
          #endif
          gH = uCrag * ( 0.1 * crag + 0.28 * fc.y + 0.02 * ledge * ( 0.4 + uStrata ) - 0.02 * uCrack * crack + 0.008 * ( grain - 0.5 ) ) * ( 1.0 - agent ) * ( 1.0 - 0.65 * wall ); // walls: gentler bump (grazing angles alias)

          vec3 col = uStoneBase * ( 1.0 + uMottle * ( mot - 0.5 ) * 1.4 );
          col = mix( col, uStoneDark, uStrata * 0.5 * ( 1.0 - band ) * sf * ( 0.15 + 0.85 * wall ) );
          col *= 0.86 + 0.28 * fc.z; // each facet is its own tone
          col *= 0.75 + 0.5 * crag; // crests catch more, hollows less
          col = mix( col, uStoneLight, 0.08 * smoothstep( 0.8, 1.0, crag ) );
          col *= 0.7 + 0.6 * terr; // higher columns are paler
          col *= 1.0 + 0.3 * ( grain - 0.5 );
          col = mix( col, uStoneDark * 0.4, crack * uCrack * ( 1.0 - agent ) );
          float pt = h21( sd.yz );
          col *= 1.0 + uTone * ( pt - 0.5 ) * 2.0;
          // agents are cut flat and polished: no crags or cracks (agent zeroes them above), lighter stone, a small tone step per band
          col = mix( col, uStoneBase * ( 1.0 + uMottle * ( mot - 0.5 ) * 0.3 ) * ( 1.0 + 0.9 * uAgentTone + bandStep ) + uStoneLight * 0.05 * uAgentTone, agent );
          return col;
        }`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        {
          float agent = step( 0.5, vInlay.x );
          gAgent = agent;
          gWall = 1.0 - smoothstep( 0.35, 0.75, vNy );
          vec3 col = stone( vCell, vStone, vWallH, gWall, vRock.x, vRock.y, agent );
          col = mix( col * ( 1.0 + uHover * vHover ), uStoneLight, 0.3 * vHover );
          diffuseColor.rgb *= col;
        }`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        roughnessFactor = mix( roughnessFactor, roughnessFactor * 0.62, gAgent ); // the facet is polished`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
        #ifdef CELL_HIGH
          normal = bumpNormal( -vViewPosition, normal, gH );
        #endif`,
      )
      .replace(
        '#include <opaque_fragment>',
        `{
          vec3 N = normalize( normal );
          float ndv = saturate( dot( N, normalize( vViewPosition ) ) );
          float lum = dot( diffuseColor.rgb, vec3( 0.3333 ) );
          float grazing = 1.0 - ndv;
          // satin sheen: a wide soft lift at grazing angles, stronger on the side the key and the kicker light
          float lit = 0.35;
          #if NUM_DIR_LIGHTS > 1
            lit = 0.3 + 0.7 * saturate( dot( N, directionalLights[ 0 ].direction ) )
                + 1.2 * saturate( dot( N, directionalLights[ 1 ].direction ) + 0.1 );
          #endif
          outgoingLight += uSheenColor * lum * uSheen * pow( grazing, 2.0 ) * lit;
          // the column walls sit in soft shadow, deeper toward the foot: rock faces, not black gaps
          outgoingLight *= 1.0 - gWall * ( 0.25 + 0.3 * ( 1.0 - smoothstep( 0.0, 0.16, vWallH ) ) );
        }
        #include <opaque_fragment>`,
      );
  };
  material.customProgramCacheKey = () => `cell-${tier}-r6`;

  return {
    material,
    uniforms,
    sync(c) {
      uniforms.uBevel.value = c.bevel;
      uniforms.uSheen.value = c.sheen;
      uniforms.uCrag.value = c.crag;
      uniforms.uStrata.value = c.strata;
      uniforms.uCrack.value = c.crack;
      uniforms.uMottle.value = c.mottle;
      uniforms.uTone.value = c.tone;
      uniforms.uAgentTone.value = c.agentTone;
      uniforms.uHover.value = c.hover;
      material.roughness = c.roughness;
      material.envMapIntensity = c.envIntensity;
    },
  };
}

/**
 * Procedural studio reflection for the stone (high tier): a dark ink room with a soft overhead box, a warm key panel and
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
