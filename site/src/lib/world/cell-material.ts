import {
  BackSide, BoxGeometry, BufferAttribute, Color, Mesh, MeshBasicMaterial, MeshPhysicalMaterial, PMREMGenerator, Scene,
  SphereGeometry, type IUniform, type Texture, type WebGLRenderer,
} from 'three';
import type { Look, Palette, Tier } from './config';
import { CELL_VERT_DECL, CELL_VERT_PROJECT, CELL_VERT_SHAPE, CELL_VERT_WORLDPOS_LIFT } from './cell-vertex';

export interface CellUniforms {
  uBevel: IUniform<number>;
  uSheen: IUniform<number>;
  uSideDark: IUniform<number>;
  uGrain: IUniform<number>;
  uMottle: IUniform<number>;
  uTone: IUniform<number>;
  uAgentTone: IUniform<number>;
  uPillow: IUniform<number>;
  uHueDrift: IUniform<number>;
  uGrainBump: IUniform<number>;
  uEdge: IUniform<number>;
  uAO: IUniform<number>;
  uRoughJitter: IUniform<number>;
  uTintJitter: IUniform<number>;
  uGradient: IUniform<number>;
  uCapGloss: IUniform<number>;
  uCapBevel: IUniform<number>;
  uCapEnv: IUniform<number>;
  uHover: IUniform<number>;
  uStoneBase: IUniform<Color>;
  uStoneMid: IUniform<Color>;
  uStoneLight: IUniform<Color>;
  uStoneDark: IUniform<Color>;
  uSheenColor: IUniform<Color>;
}

export interface CellMaterial {
  material: MeshPhysicalMaterial;
  uniforms: CellUniforms;
  /** copy slider/config values into the uniforms (cheap, call per frame or on change) */
  sync(cfg: Look['cell']): void;
}

/**
 * Machined metal panels (round 11) on top of MeshPhysicalMaterial (metalness, roughness, a light clearcoat), patched via
 * onBeforeCompile. Every colour is a mix of the five palette tokens (wax, wax-dim, text, ink-2, ink); nothing here is a
 * new colour and the accent is never read. Nothing is self-lit (the emissive core is honeycomb.ts's own seam floor).
 *  - flush panels: the vertex stage replaces the unit prism's corners with the instance's own Voronoi corners (aCorn*), curves
 *    the top onto its sphere (aStone.w = 1 / body radius) and adds a hairline fillet in world units, so seams stay crisp and even.
 *    Each column has its own (quantised) height (honeycomb.ts applies the terrain), so the side walls are visible
 *  - tops: a pale metal token with a soft pillow gradient, a per-column tone/hue/tint drift, a slow mottle, a soft top-lit/cool-shadowed
 *    gradient across the whole sphere (uGradient, world-space normal.y); a fine grain on the high tier only, faded by the pixel
 *    footprint, plus a very fine bump normal (uGrainBump) there. A thin catch-light (uEdge) runs along every column's chamfer.
 *    Roughness carries its own per-tile + fine-noise jitter (uRoughJitter) so the metal never reads as one flat sheet
 *  - sides: dark metal (uSideDark), vertical striation and faint horizontal cooling bands, darker toward the foot, lit by the env
 *  - agents: towers (honeycomb.ts stands them above every rod) with a polished pale cap: lighter stone with a small tone step per band
 *    (aRock.y), roughness scaled by (1 - capGloss), a harder env reflection on caps only, a wider chamfer so the edge catches the light.
 *    The shaft keeps the dark filler wall shading. No inlay, no ring, no accent, no glow (aInlay.x = agent flag, aInlay.w = half-width)
 *  - hover/focus: aState.x brightens the tone, aState.y lifts the panel along its normal
 * Medium tier: same body, seams and striation, and (round 11) the same env map and gradient; no grain, no shadow map (a per-cell
 * ambient-occlusion stand-in, aState.z, darkens tops beside taller neighbours instead).
 */
// medium has no shadow map to sculpt the cap, so its chamfer is a touch wider to read as polished at a glance
const capBevelOf = (c: Look['cell'], tier: Tier) => c.capBevel * (tier === 'high' ? 1 : 1.4);
// the cap reflects the env harder than the raw metal (envMapIntensity applies to the whole material; this multiplies it on caps only).
// This constant was tuned for round 8-10's envIntensity ~0.07; round 11 raised envIntensity to ~1 for the metal, so the same
// multiplier here would push the caps to ~17x and blow out to white in close framing (found via /lookdev's `cell` view) - scaled
// down so the cap reads as polished against the metal body rather than as a flat white mirror.
const capEnvOf = (c: Look["cell"]) => 1 + 3 * c.capGloss;

// medium has no shadow map: tops are darkened by how much taller their neighbours are (honeycomb.ts writes aState.z), this strong at most
const MEDIUM_AO = 0.5;

export function createCellMaterial(tier: Tier, palette: Palette, cfg: Look['cell']): CellMaterial {
  const wax = new Color(palette.wax);
  const waxDim = new Color(palette.waxDim);
  const text = new Color(palette.text);
  const ink2 = new Color(palette.ink2);
  const uniforms: CellUniforms = {
    uBevel: { value: cfg.bevel },
    uSheen: { value: cfg.sheen },
    uSideDark: { value: cfg.sideDark },
    uGrain: { value: tier === 'high' ? cfg.grain : 0 },
    uMottle: { value: cfg.mottle },
    uTone: { value: cfg.tone },
    uAgentTone: { value: cfg.agentTone },
    uPillow: { value: cfg.pillow },
    uHueDrift: { value: cfg.hueDrift },
    uGrainBump: { value: tier === 'high' ? cfg.grainBump : 0 },
    uEdge: { value: cfg.edge },
    uAO: { value: tier === 'medium' ? MEDIUM_AO : 0 },
    uRoughJitter: { value: cfg.roughJitter },
    uTintJitter: { value: cfg.tintJitter },
    uGradient: { value: cfg.gradient },
    uCapGloss: { value: cfg.capGloss },
    uCapBevel: { value: capBevelOf(cfg, tier) },
    uCapEnv: { value: capEnvOf(cfg) },
    uHover: { value: cfg.hover },
    uStoneBase: { value: waxDim.clone() }, // the column sides start from this, then darken toward ink-2
    uStoneMid: { value: wax.clone() },
    uStoneLight: { value: text.clone() },
    uStoneDark: { value: ink2.clone() },
    uSheenColor: { value: wax.clone().lerp(text, 0.45) },
  };

  const material = new MeshPhysicalMaterial({
    color: new Color(1, 1, 1), // the stone colour is computed in the shader; this only carries the proof-chapter dimming
    roughness: cfg.roughness,
    envMapIntensity: cfg.envIntensity, // (the site never calls sync(), so the constructor must carry it; before round 9 it silently stayed at 1)
    metalness: cfg.metalness,
    clearcoat: cfg.clearcoat,
    clearcoatRoughness: cfg.clearcoatRoughness,
    dithering: true,
  });

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    const defs = tier === 'high' ? '#define CELL_HIGH\n' : '';

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        ${CELL_VERT_DECL}
        varying vec2 vCell;
        varying vec3 vStone;
        varying vec4 vInlay;
        varying vec2 vRock;
        varying float vWallH;
        varying float vHover;
        varying float vNy;
        varying float vAO;
        varying vec3 vWorldN;`,
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
        ${CELL_VERT_SHAPE}
        vCell = cxz;
        vStone = aStone.xyz;
        vInlay = aInlay;
        vRock = aRock;
        vHover = aState.x;
        vAO = aState.z;
        vNy = normal.y;
        vWallH = cellWallH;
        // world-space panel normal (curvature lean included): drives the soft top-lit/cool-shadowed gradient across the sphere.
        // The globe only ever rotates about Y, so its .y is stable under the spin.
        vWorldN = normalize( ( modelMatrix * instanceMatrix * vec4( objectNormal, 0.0 ) ).xyz );`,
      )
      .replace('#include <project_vertex>', CELL_VERT_PROJECT)
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>\n${CELL_VERT_WORLDPOS_LIFT}`);

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `${defs}#include <common>
        uniform float uSheen, uSideDark, uGrain, uMottle, uTone, uAgentTone, uHover, uCapGloss, uCapEnv, uPillow, uHueDrift, uGrainBump, uEdge, uAO;
        uniform float uRoughJitter, uTintJitter, uGradient;
        uniform vec3 uStoneBase, uStoneMid, uStoneLight, uStoneDark, uSheenColor;
        varying vec2 vCell;
        varying vec3 vStone;
        varying vec4 vInlay;
        varying vec2 vRock;
        varying float vWallH;
        varying float vHover;
        varying float vNy;
        varying float vAO;
        varying vec3 vWorldN;
        float gAgent = 0.0;
        float gWall = 0.0;

        float h21( vec2 p ) { vec3 q = fract( vec3( p.xyx ) * 0.1031 ); q += dot( q, q.yzx + 33.33 ); return fract( ( q.x + q.y ) * q.z ); }
        float vnoise( vec2 p ) {
          vec2 i = floor( p ), f = fract( p );
          f = f * f * ( 3.0 - 2.0 * f );
          return mix( mix( h21( i ), h21( i + vec2( 1.0, 0.0 ) ), f.x ), mix( h21( i + vec2( 0.0, 1.0 ) ), h21( i + vec2( 1.0, 1.0 ) ), f.x ), f.y );
        }
        // 1 while a detail of frequency freq is well resolved by the pixel grid, 0 once a pixel spans most of its period
        float octFade( vec2 q, float freq ) { vec2 w = fwidth( q ) * freq; return 1.0 - smoothstep( 0.3, 0.8, max( w.x, w.y ) ); }
        vec2 cellUV( vec2 xz, vec3 sd ) { float ca = cos( sd.x ), sa = sin( sd.x ); return mat2( ca, -sa, sa, ca ) * xz + sd.yz; }
        // The basalt: xz is the panel-local position, sd its anchor (rotation, offset), wall 1 on a side wall and 0 on the top.
        // Tops: light stone with a per-column tone and hue drift (wax, wax-dim, ink-2), a soft pillow gradient, a slow mottle, fine grain
        // (high tier). Sides: dark stone, vertical columnar striation and faint horizontal cooling bands.
        vec3 stone( vec2 xz, vec3 sd, float wall, float terr, float bandStep, float agent ) {
          vec2 uv = cellUV( xz, sd );
          float pt = h21( sd.yz );
          float ph = h21( sd.zy + 7.0 );
          float mot = vnoise( uv * 0.55 );
          vec3 top = uStoneMid * ( 1.0 + uMottle * ( mot - 0.5 ) * 0.5 ) * ( 0.94 + 0.12 * terr );
          // each column drifts toward wax-dim (about a third of them, up to 60%) or ink-2 (a few, up to 30%)
          top = mix( top, uStoneBase * 1.25, uHueDrift * 0.6 * smoothstep( 0.25, 0.65, ph ) );
          top = mix( top, uStoneDark * 2.2, uHueDrift * 0.3 * smoothstep( 0.8, 1.0, ph ) );
          // a small extra per-tile shift toward the pale tone, layered on the hue drift above
          top = mix( top, uStoneLight, uTintJitter * 0.4 * smoothstep( 0.5, 1.0, h21( sd.zy + 19.0 ) ) );
          // pillow: the middle catches a little more, the edge a little less
          float rr = length( xz ) / max( vInlay.w * 1.15, 1e-3 );
          top *= 1.0 + uPillow * ( 0.35 - 0.9 * smoothstep( 0.25, 1.0, rr ) );
          #ifdef CELL_HIGH
            top *= 1.0 + uGrain * ( vnoise( uv * 14.0 + 2.0 ) - 0.5 ) * octFade( uv, 14.0 );
          #endif
          // walls: a 1D noise along the face (vertical lines), faded once a line is about a pixel wide
          float along = uv.x + 0.61 * uv.y;
          float sf = 1.0 - smoothstep( 0.2, 0.5, fwidth( along * 7.0 ) );
          float striae = ( vnoise( vec2( along * 7.0, 3.0 ) ) - 0.5 ) * sf;
          // faint horizontal cooling bands: rock cools in layers, each column with its own phase
          float hw = vWallH * 9.0;
          float bf = 1.0 - smoothstep( 0.25, 0.6, fwidth( hw ) );
          float bands = ( vnoise( vec2( hw, 11.0 + pt * 40.0 ) ) - 0.5 ) * bf;
          vec3 side = mix( uStoneBase * 0.7, uStoneDark, uSideDark ) * ( 1.0 + 0.35 * striae + 0.22 * bands );
          vec3 col = mix( top, side, wall );
          col *= 1.0 + uTone * ( pt - 0.5 ) * 2.0;
          // agents are cut flat and polished: a paler cap, a small tone step per band
          vec3 ag = mix( uStoneMid, uStoneLight, min( 1.0, uAgentTone * 2.2 ) ) * ( 1.0 + bandStep );
          ag *= 1.0 + 0.5 * uPillow * ( 0.35 - 0.9 * smoothstep( 0.25, 1.0, rr ) );
          return mix( col, ag, agent * ( 1.0 - wall ) ) ;
        }`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        {
          float agent = step( 0.5, vInlay.x );
          gAgent = agent;
          gWall = 1.0 - smoothstep( 0.35, 0.75, vNy );
          vec3 col = stone( vCell, vStone, gWall, vRock.x, vRock.y, agent );
          // soft gradient across the whole sphere: brighter toward the top, a cool shift toward the bottom
          col = mix( col, uStoneDark * 0.85, uGradient * 0.5 * saturate( -vWorldN.y ) );
          col = mix( col, uStoneLight, uGradient * 0.22 * saturate( vWorldN.y ) );
          // thin catch-light along the chamfer (the rounded edge between wall and top): a small albedo lift, twice as strong on the caps
          float chamfer = smoothstep( 0.2, 0.5, vNy ) * ( 1.0 - smoothstep( 0.94, 0.995, vNy ) );
          col = mix( col, uStoneLight, saturate( uEdge * chamfer * ( 0.5 + 0.5 * agent ) ) );
          col *= 1.0 - uAO * vAO * ( 1.0 - gWall ); // medium: the cheap stand-in for shadow, tops in a well of taller neighbours
          col = mix( col * ( 1.0 + uHover * vHover ), uStoneLight, 0.3 * vHover );
          diffuseColor.rgb *= col;
        }`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
        #ifdef CELL_HIGH
        if ( uGrainBump > 0.0 && gWall < 0.5 && gAgent < 0.5 ) { // the polished caps stay smooth
          // very fine grain as a bump normal (tilt = amplitude x noise gradient, in world units), faded by the pixel footprint
          vec2 guv = cellUV( vCell, vStone ) * 22.0;
          float gh = ( vnoise( guv ) - 0.5 ) * uGrainBump * 0.02 * octFade( guv, 1.0 ) * ( 1.0 - gWall );
          vec3 sX = dFdx( - vViewPosition ), sY = dFdy( - vViewPosition );
          vec3 R1 = cross( sY, normal ), R2 = cross( normal, sX );
          float fDet = dot( sX, R1 ) * faceDirection;
          vec3 grad = sign( fDet ) * ( dFdx( gh ) * R1 + dFdy( gh ) * R2 );
          // (guarded: at close range fDet and grad can both vanish on a pixel, normalize(0) is NaN, and bloom/GTAO spread one NaN pixel over the whole frame)
          vec3 bumped = abs( fDet ) * normal - grad;
          if ( dot( bumped, bumped ) > 1e-20 ) normal = normalize( bumped );
        }
        #endif`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        {
          // procedural roughness: a per-tile hash step plus a fine noise term, so the metal never reads as one flat sheet
          float ptR = h21( vStone.yz );
          float rn = vnoise( cellUV( vCell, vStone ) * 9.0 + 4.0 ) - 0.5;
          roughnessFactor = clamp( roughnessFactor * ( 1.0 + uRoughJitter * ( ( ptR - 0.5 ) * 1.4 + 0.8 * rn ) ), 0.04, 1.0 );
        }
        roughnessFactor = mix( roughnessFactor, roughnessFactor * ( 1.0 - uCapGloss ), gAgent * ( 1.0 - gWall ) ); // the cap is polished`,
      )
      .replace(
        '#include <lights_fragment_maps>',
        `#include <lights_fragment_maps>
        #if defined( USE_ENVMAP ) && defined( RE_IndirectSpecular )
          radiance *= mix( mix( 1.0, uCapEnv, gAgent ), 0.2, gWall ); // shafts and walls do not mirror the studio
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
          float sheen = uSheen;
          #ifndef CELL_HIGH
            sheen *= 1.0 + 1.6 * gAgent * ( 1.0 - gWall ); // no studio reflection on medium: the cap gets a stronger satin lift instead
          #endif
          outgoingLight += uSheenColor * lum * sheen * pow( grazing, 2.0 ) * lit;
          // the column walls sit in soft shadow, deeper toward the foot: dark metal lit by the env, never a black gap
          outgoingLight *= 1.0 - gWall * ( 0.12 + 0.15 * ( 1.0 - smoothstep( 0.0, 0.16, vWallH ) ) );
        }
        #include <opaque_fragment>`,
      );
  };
  material.customProgramCacheKey = () => `cell-${tier}-r11`;

  return {
    material,
    uniforms,
    sync(c) {
      uniforms.uBevel.value = c.bevel;
      uniforms.uSheen.value = c.sheen;
      uniforms.uSideDark.value = c.sideDark;
      uniforms.uGrain.value = tier === 'high' ? c.grain : 0;
      uniforms.uMottle.value = c.mottle;
      uniforms.uTone.value = c.tone;
      uniforms.uAgentTone.value = c.agentTone;
      uniforms.uPillow.value = c.pillow;
      uniforms.uHueDrift.value = c.hueDrift;
      uniforms.uGrainBump.value = tier === 'high' ? c.grainBump : 0;
      uniforms.uEdge.value = c.edge;
      uniforms.uRoughJitter.value = c.roughJitter;
      uniforms.uTintJitter.value = c.tintJitter;
      uniforms.uGradient.value = c.gradient;
      uniforms.uCapGloss.value = c.capGloss;
      uniforms.uCapBevel.value = capBevelOf(c, tier);
      uniforms.uCapEnv.value = capEnvOf(c);
      uniforms.uHover.value = c.hover;
      material.roughness = c.roughness;
      material.metalness = c.metalness;
      material.clearcoat = c.clearcoat;
      material.clearcoatRoughness = c.clearcoatRoughness;
      material.envMapIntensity = c.envIntensity;
    },
  };
}

/**
 * Procedural studio reflection for the metal (round 11: both tiers): a dark ink room with a bright overhead softbox, a
 * warm key panel, a dim fill card opposite it, a cool rim strip behind and a faint floor bounce below. Metal needs
 * something to reflect. Colours are palette mixes; nothing is loaded. Baked once into a PMREM texture.
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
  add(...panel(26, 26, text.clone().lerp(wax, 0.2), 6.0), 0, 30, 4); // overhead softbox
  add(...panel(10, 22, wax.clone().lerp(text, 0.4), 8.0), -24, 8, 14); // warm key panel, front left
  add(...panel(12, 20, ink2.clone().lerp(wax, 0.3), 2.2), 24, 2, -6); // dim fill card, opposite the key
  add(...panel(3, 24, ink2.clone().lerp(text, 0.55), 6.0), 20, 4, -22); // cool rim strip behind
  add(...panel(30, 30, ink.clone().lerp(waxDim, 0.2), 1.0), 0, -26, 0); // faint floor bounce

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
