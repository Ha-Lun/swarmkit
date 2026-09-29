import { SINK } from './config';

// The vertex-stage geometry of a cell, as GLSL chunk strings. The lit material (cell-material.ts) and the shadow depth material
// (cell-depth.ts) both splice these in, so a panel's shape in the shadow map can never drift from the shape on screen: each panel
// takes its own Voronoi corners, curves onto its sphere, gets its fillet and its lift. The lit material adds its varyings around them.

/** attributes, the bevel uniforms and the corner lookup (goes after `#include <common>`) */
export const CELL_VERT_DECL = /* glsl */ `
attribute float aK;
attribute vec2 aBev;
attribute vec3 aState;
attribute vec4 aStone;
attribute vec4 aInlay;
attribute vec2 aRock;
attribute vec4 aCornA;
attribute vec4 aCornB;
attribute vec4 aCornC;
uniform float uBevel, uCapBevel, uRadial;
vec2 cornerOf() {
  float k = floor( aK + 0.5 );
  return k < 0.0 ? vec2( 0.0 ) : k < 0.5 ? aCornA.xy : k < 1.5 ? aCornA.zw : k < 2.5 ? aCornB.xy : k < 3.5 ? aCornB.zw : k < 4.5 ? aCornC.xy : aCornC.zw;
}`;

/** the shape: replaces the unit prism's corner with the instance's own, insets the fillet, drops onto the sphere. Leaves `cxz` (the
 *  panel's own corner) and `cellWallH` (height above the sphere) for the lit material to read. Goes after `#include <begin_vertex>`. */
export const CELL_VERT_SHAPE = /* glsl */ `
vec2 cxz = cornerOf();
transformed.xz = cxz;
float cellWallH;
{
  float sx = length( instanceMatrix[ 0 ].xyz );
  float sy = length( instanceMatrix[ 1 ].xyz );
  // hairline fillet in world units: the rim drops and the top face insets, whatever the panel's own footprint
  cellWallH = position.y * sy - ${SINK.toFixed(4)}; // height above the sphere, for the wall shading and the strata
  float b = min( uBevel * mix( 1.0, uCapBevel, step( 0.5, aInlay.x ) ), // the tower cap has a wider chamfer that catches the light
     min( 0.35 * aInlay.w, 0.8 * max( sy - ${SINK.toFixed(4)}, 0.02 ) ) );
  transformed.y -= aBev.x * b / max( sy, 1e-4 );
  transformed.xz *= 1.0 - aBev.y * b / max( length( cxz ) * sx, 1e-4 );
  // the whole panel sits on its sphere: drop by (distance^2) / (2 body radius)
  // radial walls (uRadial 0..1): the footprint widens with height in proportion to the sphere (R + h) / R, so the walls run out from the
  // globe centre and the seam between neighbours keeps (nearly) its base width instead of opening up along the column
  transformed.xz *= 1.0 + uRadial * max( cellWallH, 0.0 ) * aStone.w;
  vec2 wxz = transformed.xz * sx;
  transformed.y -= dot( wxz, wxz ) * aStone.w * 0.5 / max( sy, 1e-4 );
}`;

/** replaces `#include <project_vertex>`: the lift is applied after the instance matrix, along the instance's up (the surface normal) */
export const CELL_VERT_PROJECT = /* glsl */ `
vec4 mvPosition = vec4( transformed, 1.0 );
mvPosition = instanceMatrix * mvPosition;
mvPosition.xyz += normalize( instanceMatrix[ 1 ].xyz ) * aState.y;
mvPosition = modelViewMatrix * mvPosition;
gl_Position = projectionMatrix * mvPosition;`;

/** goes after `#include <worldpos_vertex>` in the lit material: the lift moves the world position the shadow lookup uses too, so a lifted
 *  panel does not sit inside its own shadow (the depth material lifts it in CELL_VERT_PROJECT) */
export const CELL_VERT_WORLDPOS_LIFT = /* glsl */ `
#if defined( USE_ENVMAP ) || defined( DISTANCE ) || defined ( USE_SHADOWMAP ) || defined ( USE_TRANSMISSION ) || NUM_SPOT_LIGHT_COORDS > 0
  worldPosition.xyz += ( modelMatrix * vec4( normalize( instanceMatrix[ 1 ].xyz ) * aState.y, 0.0 ) ).xyz;
#endif`;
