import { MeshDepthMaterial, type IUniform } from 'three';
import { CELL_VERT_DECL, CELL_VERT_PROJECT, CELL_VERT_SHAPE } from './cell-vertex';

/**
 * Shadow caster for the instanced cells. Three's default depth material would render the unit prism; this one runs the same vertex
 * chunks as the lit material (cell-vertex.ts), so each panel casts the shadow of its own Voronoi shape, curved top, chamfer and lift.
 * `shared` are the lit material's uniforms (the bevel ones), so the sliders move both.
 */
export function createCellDepthMaterial(shared: { uBevel: IUniform<number>; uCapBevel: IUniform<number>; uRadial: IUniform<number> }): MeshDepthMaterial {
  const mat = new MeshDepthMaterial();
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uBevel = shared.uBevel;
    shader.uniforms.uCapBevel = shared.uCapBevel;
    shader.uniforms.uRadial = shared.uRadial;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${CELL_VERT_DECL}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${CELL_VERT_SHAPE}`)
      .replace('#include <project_vertex>', CELL_VERT_PROJECT);
  };
  mat.customProgramCacheKey = () => 'cell-depth-r12';
  return mat;
}
