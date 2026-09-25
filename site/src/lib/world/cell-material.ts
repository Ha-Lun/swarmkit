import {
  BackSide, BoxGeometry, BufferAttribute, Color, Mesh, MeshBasicMaterial, MeshStandardMaterial, PMREMGenerator, Scene,
  SphereGeometry, type IUniform, type Texture, type WebGLRenderer,
} from 'three';
import { SINK, type Look, type Palette, type Tier } from './config';

export interface CellUniforms {
  uBevel: IUniform<number>;
  uSheen: IUniform<number>;
  uSpeckle: IUniform<number>;
  uSpeckleScale: IUniform<number>;
  uSpeckleDensity: IUniform<number>;
  uMottle: IUniform<number>;
  uTone: IUniform<number>;
  uAgentTone: IUniform<number>;
  uRingWidth: IUniform<number>;
  uRingDepth: IUniform<number>;
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
 * Speckled stone on top of MeshStandardMaterial, patched via onBeforeCompile. Every colour is a mix of the five palette
 * tokens (wax, wax-dim, text, ink-2, ink); nothing here is a new colour and the accent is never read. Nothing is self-lit.
 *  - flush panels: the vertex stage replaces the unit prism's corners with the instance's own Voronoi corners (aCorn*), curves
 *    the top onto its sphere (aStone.w = 1 / body radius) and adds a hairline fillet in world units, so seams stay crisp and even
 *  - stone: procedural flecks (hashed grid dots in three or four sizes, in wax / text / ink-2 tones, plus a slow mottle), matte
 *    with a gentle satin sheen. The field is anchored per panel with a random rotation and offset (aStone), so each panel reads
 *    as its own piece. Fleck size is checked against the pixel footprint so the texture never shimmers at distance
 *  - agents: lighter stone and an engraved ring inlay (aInlay: ring count, width, centre dot, panel half-width), no glow
 *  - hover/focus: aState.x brightens the tone, aState.y lifts the panel along its normal
 * Medium tier: same body, seams, sheen, big and medium flecks and one mottle octave; no fine flecks, no second octave, no studio reflection.
 */
export function createCellMaterial(tier: Tier, palette: Palette, cfg: Look['cell']): CellMaterial {
  const wax = new Color(palette.wax);
  const waxDim = new Color(palette.waxDim);
  const text = new Color(palette.text);
  const ink2 = new Color(palette.ink2);
  const uniforms: CellUniforms = {
    uBevel: { value: cfg.bevel },
    uSheen: { value: cfg.sheen },
    uSpeckle: { value: cfg.speckle },
    uSpeckleScale: { value: cfg.speckleScale },
    uSpeckleDensity: { value: cfg.speckleDensity },
    uMottle: { value: cfg.mottle },
    uTone: { value: cfg.tone },
    uAgentTone: { value: cfg.agentTone },
    uRingWidth: { value: cfg.ringWidth },
    uRingDepth: { value: cfg.ringDepth },
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
        attribute vec4 aCornA;
        attribute vec4 aCornB;
        attribute vec4 aCornC;
        uniform float uBevel;
        varying vec2 vCell;
        varying vec3 vStone;
        varying vec4 vInlay;
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
        vHover = aState.x;
        vNy = normal.y;
        {
          float sx = length( instanceMatrix[ 0 ].xyz );
          float sy = length( instanceMatrix[ 1 ].xyz );
          // hairline fillet in world units: the rim drops and the top face insets, whatever the panel's own footprint
          float b = min( uBevel, min( 0.35 * aInlay.w, 0.8 * max( sy - ${SINK.toFixed(4)}, 0.02 ) ) );
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
        uniform float uSheen, uSpeckle, uSpeckleScale, uSpeckleDensity, uMottle, uTone, uAgentTone, uRingWidth, uRingDepth, uHover;
        uniform vec3 uStoneBase, uStoneMid, uStoneLight, uStoneDark, uSheenColor;
        varying vec2 vCell;
        varying vec3 vStone;
        varying vec4 vInlay;
        varying float vHover;
        varying float vNy;

        float h21( vec2 p ) { vec3 q = fract( vec3( p.xyx ) * 0.1031 ); q += dot( q, q.yzx + 33.33 ); return fract( ( q.x + q.y ) * q.z ); }
        vec2 h22( vec2 p ) { vec3 q = fract( vec3( p.xyx ) * vec3( 0.1031, 0.1030, 0.0973 ) ); q += dot( q, q.yzx + 33.33 ); return fract( ( q.xx + q.yz ) * q.zy ); }
        float vnoise( vec2 p ) {
          vec2 i = floor( p ), f = fract( p );
          f = f * f * ( 3.0 - 2.0 * f );
          return mix( mix( h21( i ), h21( i + vec2( 1.0, 0.0 ) ), f.x ), mix( h21( i + vec2( 0.0, 1.0 ) ), h21( i + vec2( 1.0, 1.0 ) ), f.x ), f.y );
        }
        // One layer of flecks: a grid of cells, each holding at most one soft-edged, slightly stretched dot. The dot is
        // faded out when it is smaller than about a pixel, so the stone never shimmers at distance. Returns coverage.
        float fleck( vec2 uv, float scale, float dens, float rmin, float rmax, float seed ) {
          vec2 q = uv * scale;
          vec2 g = floor( q );
          vec2 f = fract( q );
          vec2 r = h22( g + seed );
          float on = step( h21( g + seed * 3.7 + 11.0 ), dens );
          vec2 e = f - ( 0.3 + 0.4 * h22( g + seed + 5.0 ) );
          e.x *= 1.0 + r.y * 0.9;
          float rad = mix( rmin, rmax, r.x );
          float aa = max( max( fwidth( q.x ), fwidth( q.y ) ), 1e-4 );
          float vis = smoothstep( 1.1, 2.3, 2.0 * rad / aa );
          return on * vis * ( 1.0 - smoothstep( rad - aa * 0.75, rad + aa * 0.75, length( e ) ) );
        }
        vec3 stone( vec2 xz, vec3 sd, float agent ) {
          float ca = cos( sd.x ), sa = sin( sd.x );
          vec2 uv = mat2( ca, -sa, sa, ca ) * xz + sd.yz;
          float k = 1.0 / uSpeckleScale;
          float dn = uSpeckleDensity;
          float mot = vnoise( uv * 0.85 * k ) ;
          #ifdef CELL_HIGH
            mot = 0.65 * mot + 0.35 * vnoise( uv * 2.6 * k + 7.0 );
          #endif
          vec3 col = uStoneBase * ( 1.0 + uMottle * ( mot - 0.5 ) * 1.1 );
          float sp = uSpeckle;
          col = mix( col, uStoneMid, fleck( uv, 2.6 * k, dn * 0.55, 0.16, 0.30, 1.0 ) * 0.7 * sp );
          col = mix( col, uStoneDark, fleck( uv, 5.2 * k, dn * 0.95, 0.15, 0.30, 2.0 ) * 0.9 * sp );
          col = mix( col, uStoneLight, fleck( uv, 6.4 * k, dn * 0.85, 0.14, 0.28, 3.0 ) * 0.95 * sp );
          #ifdef CELL_HIGH
            float fd = fleck( uv, 13.0 * k, dn * 1.0, 0.16, 0.32, 4.0 );
            col = mix( col, h21( floor( uv * 13.0 * k ) + 9.0 ) < 0.5 ? uStoneDark : uStoneLight, fd * 0.8 * sp );
          #endif
          float pt = h21( sd.yz );
          col *= 1.0 + uTone * ( pt - 0.5 ) * 2.0;
          col = mix( col, col * ( 1.0 + 0.9 * uAgentTone ) + uStoneLight * 0.05 * uAgentTone, agent );
          return col;
        }`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        {
          float agent = step( 0.5, vInlay.x );
          vec3 col = stone( vCell, vStone, agent );
          // engraved inlay: rings (and a centre dot) cut into the stone, crisp edges
          float rr = length( vCell ) / max( vInlay.w, 1e-3 );
          float px = max( fwidth( rr ), 1e-4 );
          float w = vInlay.y * uRingWidth;
          float g = 0.0;
          float r0 = vInlay.x < 1.5 ? 0.66 : 0.74;
          for ( int k = 0; k < 3; k++ ) {
            if ( float( k ) + 0.5 > vInlay.x ) break;
            g = max( g, 1.0 - smoothstep( 0.5 * w - px, 0.5 * w + px, abs( rr - ( r0 - float( k ) * 0.2 ) ) ) );
          }
          if ( vInlay.z > 0.5 ) g = max( g, 1.0 - smoothstep( 0.14 - px, 0.14 + px, rr ) );
          col = mix( col, uStoneDark * 0.55, g * uRingDepth );
          col = mix( col * ( 1.0 + uHover * vHover ), uStoneLight, 0.3 * vHover );
          diffuseColor.rgb *= col;
        }`,
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
          // the seam walls sit in shadow
          outgoingLight *= 1.0 - 0.5 * ( 1.0 - smoothstep( 0.15, 0.6, vNy ) );
        }
        #include <opaque_fragment>`,
      );
  };
  material.customProgramCacheKey = () => `cell-${tier}-r5`;

  return {
    material,
    uniforms,
    sync(c) {
      uniforms.uBevel.value = c.bevel;
      uniforms.uSheen.value = c.sheen;
      uniforms.uSpeckle.value = c.speckle;
      uniforms.uSpeckleScale.value = c.speckleScale;
      uniforms.uSpeckleDensity.value = c.speckleDensity;
      uniforms.uMottle.value = c.mottle;
      uniforms.uTone.value = c.tone;
      uniforms.uAgentTone.value = c.agentTone;
      uniforms.uRingWidth.value = c.ringWidth;
      uniforms.uRingDepth.value = c.ringDepth;
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
