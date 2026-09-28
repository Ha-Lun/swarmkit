import { MeshNormalMaterial, type IUniform } from 'three';
import { CELL_VERT_DECL, CELL_VERT_PROJECT, CELL_VERT_SHAPE } from './cell-vertex';

/**
 * View-space normal caster for the instanced cells, round 11's GTAO G-buffer. Mirrors cell-depth.ts: the default
 * MeshNormalMaterial would rasterise the unpatched unit prism, so this runs the same vertex chunks as the lit
 * material, and post.ts's own G-buffer render (honeycomb.ts's aoGroup) reads each panel's own reshaped, bevelled
 * surface instead of a flat box. `shared` are the lit material's bevel uniforms, so the sliders move both.
 */
export function createCellNormalMaterial(shared: { uBevel: IUniform<number>; uCapBevel: IUniform<number> }): MeshNormalMaterial {
  const mat = new MeshNormalMaterial();
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uBevel = shared.uBevel;
    shader.uniforms.uCapBevel = shared.uCapBevel;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${CELL_VERT_DECL}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${CELL_VERT_SHAPE}`)
      .replace('#include <project_vertex>', CELL_VERT_PROJECT);
  };
  mat.customProgramCacheKey = () => 'cell-normal-r11';
  return mat;
}
