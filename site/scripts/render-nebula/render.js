// Page side of the offline nebula renderer (scripts/render-nebula.mjs drives it). Raw WebGL2, no libraries.
// bake: the field into a 512^3 RGBA8 3D texture (one slice per draw). march: tiled, jittered frames accumulated in RGBA32F,
// one MRT output per depth slab. post (CPU, float): contrast, stars, composite, ACES, per-pixel gain split back onto the
// layers (so over-compositing the layers reproduces the tonemapped frame), dither, 8-bit straight alpha, POST to the server.
import { bakeFrag, fullscreenVert, marchFrag } from './shaders.js';

const log = (...a) => console.log(...a);
const canvas = document.createElement('canvas');
canvas.width = canvas.height = 4;
const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
if (!gl) throw new Error('no webgl2');
gl.getExtension('EXT_color_buffer_float');
gl.getExtension('EXT_float_blend');
const dbg = gl.getExtension('WEBGL_debug_renderer_info');
let CFG = null;
let bakeProg = null;
let marchProg = null;
let vol = null;
let warp = null;
let volKey = '';

function compile(src, type) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) + '\n' + src.split('\n').map((l, i) => `${i + 1}: ${l}`).join('\n'));
  return s;
}
function program(fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(fullscreenVert, gl.VERTEX_SHADER));
  gl.attachShader(p, compile(fs, gl.FRAGMENT_SHADER));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const u = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(p, i);
    u[info.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(p, info.name);
  }
  return { p, u };
}
const vao = gl.createVertexArray();

// ---- bake ---------------------------------------------------------------------------------------------------------------------
function ensureVolume(key, N, params) {
  ensureWarp(256);
  if (vol && volKey === key) return;
  if (vol) gl.deleteTexture(vol);
  const t0 = performance.now();
  if (!bakeProg) bakeProg = program(bakeFrag(CFG));
  vol = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_3D, vol);
  gl.texStorage3D(gl.TEXTURE_3D, 1, gl.RGBA8, N, N, N);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  for (const k of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, k, gl.CLAMP_TO_EDGE);
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  canvas.width = canvas.height = N;
  gl.useProgram(bakeProg.p);
  gl.bindVertexArray(vao);
  gl.viewport(0, 0, N, N);
  gl.disable(gl.BLEND);
  const u = bakeProg.u;
  gl.uniform1f(u.uN, N);
  gl.uniform1f(u.uVH, params.vh);
  gl.uniform1i(u.uMode, params.mode);
  gl.uniform1f(u.uRC, params.rc ?? 0);
  gl.uniform1f(u.uW, params.w ?? 1);
  gl.uniform1f(u.uRS0, params.rs0 ?? 0);
  gl.uniform1f(u.uRS1, params.rs1 ?? 1);
  gl.uniform1f(u.uBias, params.bias ?? 0);
  gl.uniform1i(u.uOut, 0);
  gl.uniform1i(u.uSS, params.ss ?? 2);
  for (let z = 0; z < N; z++) {
    gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, vol, 0, z);
    gl.uniform1f(u.uZ, (z + 0.5) / N);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (z % 16 === 15) gl.finish();
  }
  gl.finish();
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fb);
  volKey = key;
  log(`bake ${key} ${N}^3 in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
}

function ensureWarp(N) {
  if (warp) return;
  const t0 = performance.now();
  if (!bakeProg) bakeProg = program(bakeFrag(CFG));
  warp = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_3D, warp);
  gl.texStorage3D(gl.TEXTURE_3D, 1, gl.RGBA16F, N, N, N);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  for (const k of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, k, gl.CLAMP_TO_EDGE);
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.useProgram(bakeProg.p);
  gl.bindVertexArray(vao);
  gl.viewport(0, 0, N, N);
  gl.disable(gl.BLEND);
  const u = bakeProg.u;
  gl.uniform1f(u.uN, N);
  gl.uniform1f(u.uVH, CFG.vh + 0.5);
  gl.uniform1i(u.uMode, 0);
  gl.uniform1i(u.uOut, 1);
  for (let z = 0; z < N; z++) {
    gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, warp, 0, z);
    gl.uniform1f(u.uZ, (z + 0.5) / N);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (z % 16 === 15) gl.finish();
  }
  gl.finish();
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fb);
  gl.uniform1i(u.uOut, 0);
  log(`warp ${N}^3 in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
}

// ---- march --------------------------------------------------------------------------------------------------------------------
const halton = (i, b) => { let f = 1, r = 0; while (i > 0) { f /= b; r += f * (i % b); i = Math.floor(i / b); } return r; };
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(...a); return [a[0] / l, a[1] / l, a[2] / l]; };
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Marches W x H (or one cube face) in tiles. Returns one Float32Array (W*H*4, rgb premult + alpha) per slab, nearest first. */
function marchImage(j, vh) {
  if (!marchProg) marchProg = program(marchFrag(CFG));
  const { W, H } = j;
  const TW = j.tile || 256;
  const TH = j.tileH || 160;
  const nOut = j.nSlab;
  const out = Array.from({ length: nOut }, () => new Float32Array(W * H * 4));
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  const texs = [];
  const bufs = [];
  for (let m = 0; m < 5; m++) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, TW, TH);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + m, gl.TEXTURE_2D, t, 0);
    texs.push(t);
    bufs.push(gl.COLOR_ATTACHMENT0 + m);
  }
  gl.drawBuffers(bufs);
  gl.useProgram(marchProg.p);
  gl.bindVertexArray(vao);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_3D, vol);
  const u = marchProg.u;
  gl.uniform1i(u.uVol, 0);
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_3D, warp);
  gl.activeTexture(gl.TEXTURE0);
  gl.uniform1i(u.uWarp, 1);
  gl.uniform1f(u.uWH, CFG.vh + 0.5);
  gl.uniform4f(u.uMap, CFG.bubble.rc, CFG.bubble.w, CFG.bubble.rs0, CFG.bubble.rs1);
  gl.uniform1f(u.uVH, vh);
  const cam = j.cam;
  let fwd = [0, 0, 0];
  let right = [1, 0, 0];
  let up = [0, 1, 0];
  if (j.face === undefined || j.face < 0) {
    fwd = norm(sub(j.target, cam));
    right = norm(cross(fwd, [0, 1, 0]));
    up = cross(right, fwd);
    if (j.roll) { // debug: roll the image about the view axis (a streak that stays vertical on screen belongs to the renderer)
      const c = Math.cos(j.roll), s = Math.sin(j.roll);
      const r2 = right.map((v, i) => v * c + up[i] * s);
      const u2 = up.map((v, i) => v * c - right[i] * s);
      right = r2; up = u2;
    }
  }
  gl.uniform3f(u.uCamPos, cam[0], cam[1], cam[2]);
  gl.uniform3f(u.uRight, ...right);
  gl.uniform3f(u.uUp, ...up);
  gl.uniform3f(u.uFwd, ...(j.fwdSlab || fwd));
  gl.uniform1f(u.uTanY, j.tanY || 1);
  gl.uniform1f(u.uAspect, W / H);
  gl.uniform2f(u.uFull, W, H);
  gl.uniform1i(u.uFace, j.face ?? -1);
  gl.uniform1f(u.uPixAng, j.face >= 0 ? 2 / W : (2 * (j.tanY || 1)) / H);
  gl.uniform1i(u.uSteps, j.steps);
  gl.uniform1i(u.uNSlab, nOut);
  gl.uniform1i(u.uSlabMode, j.slabMode);
  gl.uniform1fv(u.uB, new Float32Array([...j.bounds, 0, 0, 0, 0].slice(0, 4)));
  gl.uniform1f(u.uTMin, j.tMin || 0);
  gl.uniform1f(u.uGain, j.gain);
  gl.uniform1f(u.uCavR, j.cavR || 0);
  gl.uniform1f(u.uWall, j.wall || 0);
  gl.uniform1f(u.uCollapse, j.collapse || 0);
  gl.uniform1f(u.uKnot, j.knot ?? 1);
  gl.uniform1i(u.uBubble, j.bubble ? 1 : 0);
  gl.uniform1f(u.uDet, j.detail ?? 1);
  gl.uniform1i(u.uMoment, j.moment ? 1 : 0);
  gl.uniform1f(u.uDust, j.dust ?? 2.0);
  gl.uniform1f(u.uRim, j.rim ?? 1.0);
  gl.uniform3f(u.uTeal, ...CFG.teal);
  gl.uniform3f(u.uAmber, ...CFG.amber);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE);
  const tile = new Float32Array(TW * TH * 4);
  const t0 = performance.now();
  const nTiles = Math.ceil(W / TW) * Math.ceil(H / TH);
  let done = 0;
  for (let ty = 0; ty < H; ty += TH) {
    for (let tx = 0; tx < W; tx += TW) {
      const tw = Math.min(TW, W - tx);
      const th = Math.min(TH, H - ty);
      gl.viewport(0, 0, tw, th);
      gl.uniform2f(u.uTile, tx, ty);
      gl.clearBufferfv(gl.COLOR, 0, [0, 0, 0, 0]);
      for (let m = 1; m < 5; m++) gl.clearBufferfv(gl.COLOR, m, [0, 0, 0, 0]);
      for (let f = 0; f < j.frames; f++) {
        gl.uniform2f(u.uJit, halton(f + 1, 2) - 0.5, halton(f + 1, 3) - 0.5);
        gl.uniform1ui(u.uFrame, f);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        if (f % 4 === 3) gl.finish();
      }
      for (let m = 0; m < nOut; m++) {
        gl.readBuffer(gl.COLOR_ATTACHMENT0 + m);
        gl.readPixels(0, 0, tw, th, gl.RGBA, gl.FLOAT, tile);
        const dst = out[m];
        for (let y = 0; y < th; y++) {
          const so = y * tw * 4;
          const d0 = ((ty + y) * W + tx) * 4;
          for (let i = 0; i < tw * 4; i++) dst[d0 + i] = tile[so + i] / j.frames;
        }
      }
      done++;
      if (done % 8 === 0 || done === nTiles) log(`  tiles ${done}/${nTiles}  ${((performance.now() - t0) / 1000).toFixed(0)} s`);
    }
  }
  gl.disable(gl.BLEND);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fb);
  texs.forEach((t) => gl.deleteTexture(t));
  log(`march ${W}x${H} ${j.frames} frames x ${j.steps} steps: ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  return out;
}

// ---- post (CPU, float) --------------------------------------------------------------------------------------------------------
function aces(v, expo) { // three.js ACESFilmicToneMapping, per pixel rgb in -> out (linear display)
  const x = (v[0] * expo) / 0.6, y = (v[1] * expo) / 0.6, z = (v[2] * expo) / 0.6;
  let a = 0.59719 * x + 0.35458 * y + 0.04823 * z;
  let b = 0.0760 * x + 0.90834 * y + 0.01566 * z;
  let c = 0.0284 * x + 0.13383 * y + 0.83777 * z;
  const f = (q) => (q * (q + 0.0245786) - 0.000090537) / (q * (0.983729 * q + 0.432951) + 0.238081);
  a = f(a); b = f(b); c = f(c);
  const r = 1.60475 * a - 0.53108 * b - 0.07367 * c;
  const g = -0.10208 * a + 1.10813 * b - 0.00605 * c;
  const bb = -0.00327 * a - 0.07276 * b + 1.07602 * c;
  return [Math.min(1, Math.max(0, r)), Math.min(1, Math.max(0, g)), Math.min(1, Math.max(0, bb))];
}
const oetf = (x) => (x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055);
const lum = (r, g, b) => r * 0.3 + g * 0.55 + b * 0.15;
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/** Add a star to one layer's premult buffer. s: x, y (px), rgb (linear peak), sigma (px), spike: {len, amp, ang} | null,
 *  att: 0..1 how much of the layer's own alpha hides it. */
function drawStar(buf, W, H, s, att) {
  const hr = Math.max(4, s.sigma * 3.2 * 6 + 3);
  const R = Math.ceil(Math.max(s.spike ? s.spike.len : 0, hr));
  const x0 = Math.max(0, Math.floor(s.x - R)), x1 = Math.min(W - 1, Math.ceil(s.x + R));
  const y0 = Math.max(0, Math.floor(s.y - R)), y1 = Math.min(H - 1, Math.ceil(s.y + R));
  const inv2s = 1 / (2 * s.sigma * s.sigma);
  const halo = s.sigma * 3.2;
  const sp = s.spike;
  const dirs = sp ? [0, 1, 2].map((k) => { const a = sp.ang + (k * Math.PI) / 3; return [Math.cos(a), Math.sin(a)]; }) : null;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - s.x, dy = y + 0.5 - s.y;
      const d2 = dx * dx + dy * dy;
      const dd = Math.sqrt(d2);
      let v = Math.exp(-d2 * inv2s) + (s.halo ?? 0.05) * Math.exp(-dd / halo) * (1 - smooth(hr * 0.5, hr, dd));
      if (sp) {
        for (const [cx, cy] of dirs) {
          const al = Math.abs(dx * cx + dy * cy);
          const pe = -dx * cy + dy * cx;
          v += sp.amp * Math.exp(-(pe * pe) / (2 * 0.55 * 0.55 * (1 + al * 0.012))) * Math.exp(-al / (sp.len * 0.28)) * (1 - smooth(0.6, 1, al / sp.len));
        }
      }
      if (v < 1e-4) continue;
      const i = (y * W + x) * 4;
      const k = v * (1 - att * buf[i + 3]);
      buf[i] += s.rgb[0] * k; buf[i + 1] += s.rgb[1] * k; buf[i + 2] += s.rgb[2] * k;
    }
  }
}

function hash2(x, y, k) {
  let h = (Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(k, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39) >>> 0;
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** layers: far -> near Float32Array(W*H*4) premult HDR (gas only). opts: { stars: [{layer, s, att}], expo, contrast }.
 *  Returns display-referred premult layers (linear, alpha adjusted so rgb <= alpha) far -> near, plus the composite. */
function post(layers, W, H, opts) {
  const n = layers.length;
  const P = W * H;
  if (opts.contrast) { // the live composite's filmic contrast, on the gas composite
    for (let p = 0; p < P; p++) {
      let r = 0, g = 0, b = 0;
      for (let k = 0; k < n; k++) { const L = layers[k]; const i = p * 4; const a = L[i + 3]; r = L[i] + (1 - a) * r; g = L[i + 1] + (1 - a) * g; b = L[i + 2] + (1 - a) * b; }
      const f = 0.8 + (1.22 - 0.8) * smooth(0.015, 0.5, lum(r, g, b));
      for (let k = 0; k < n; k++) { const L = layers[k]; const i = p * 4; L[i] *= f; L[i + 1] *= f; L[i + 2] *= f; }
    }
  }
  for (const st of opts.stars) drawStar(layers[st.layer], W, H, st.s, st.att);
  const out = layers.map(() => new Float32Array(P * 4));
  const comp = new Float32Array(P * 4);
  for (let p = 0; p < P; p++) {
    const i = p * 4;
    let r = 0, g = 0, b = 0;
    for (let k = 0; k < n; k++) { const L = layers[k]; const a = L[i + 3]; r = L[i] + (1 - a) * r; g = L[i + 1] + (1 - a) * g; b = L[i + 2] + (1 - a) * b; }
    const t = aces([r, g, b], opts.expo);
    // per-channel ratio (display / linear); tiny values keep the slope of the curve
    const rr = r < 1e-5 ? 1.5 : t[0] / r, g2 = g < 1e-5 ? 1.5 : t[1] / g, b2 = b < 1e-5 ? 1.5 : t[2] / b;
    comp[i] = t[0]; comp[i + 1] = t[1]; comp[i + 2] = t[2];
    for (let k = 0; k < n; k++) {
      const L = layers[k]; const O = out[k];
      const cr = L[i] * rr, cg = L[i + 1] * g2, cb = L[i + 2] * b2;
      O[i] = cr; O[i + 1] = cg; O[i + 2] = cb;
      O[i + 3] = Math.min(1, Math.max(L[i + 3], cr, cg, cb)); // premult rgb must not exceed alpha (straight 8-bit)
    }
  }
  return { out, comp };
}

function downscale2(buf, W, H) {
  const w = W >> 1, h = H >> 1;
  const o = new Float32Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = (y * w + x) * 4;
      for (let c = 0; c < 4; c++) {
        o[d + c] = 0.25 * (buf[((2 * y) * W + 2 * x) * 4 + c] + buf[((2 * y) * W + 2 * x + 1) * 4 + c] + buf[((2 * y + 1) * W + 2 * x) * 4 + c] + buf[((2 * y + 1) * W + 2 * x + 1) * 4 + c]);
      }
    }
  }
  return { buf: o, W: w, H: h };
}

/** Premult display layer -> 8-bit straight-alpha sRGB with triangular dither. opaque: rgb only over black (alpha dropped). */
function encode(buf, W, H, seed, opaque) {
  const o = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      let a = opaque ? 1 : Math.min(1, buf[i + 3]);
      const n1 = hash2(x, y, seed), n2 = hash2(x, y, seed + 101), n3 = hash2(x, y, seed + 211);
      const dth = (n1 + n2 - 1) * (CFG.dither / 0.9); // triangular, CFG.dither = amplitude in LSB
      if (a < 0.5 / 255 && !opaque) { o[i + 3] = 0; continue; }
      let r = buf[i] / a, g = buf[i + 1] / a, b = buf[i + 2] / a;
      r = oetf(Math.min(1, r)); g = oetf(Math.min(1, g)); b = oetf(Math.min(1, b));
      o[i] = Math.max(0, Math.min(255, Math.floor(r * 255 + 0.5 + dth * 0.9)));
      o[i + 1] = Math.max(0, Math.min(255, Math.floor(g * 255 + 0.5 + (hash2(x, y, seed + 7) + n3 - 1) * CFG.dither)));
      o[i + 2] = Math.max(0, Math.min(255, Math.floor(b * 255 + 0.5 + (hash2(x, y, seed + 13) + n2 - 1) * CFG.dither)));
      o[i + 3] = opaque ? 255 : Math.max(0, Math.min(255, CFG.alphaDither ? Math.floor(a * 255 + n3) : Math.round(a * 255)));
    }
  }
  return o;
}

async function put(name, bytes, W, H) {
  const CH = 1 << 24;
  const r = await fetch(`/begin?name=${encodeURIComponent(name)}&w=${W}&h=${H}`, { method: 'POST' });
  if (!r.ok) throw new Error('begin failed');
  for (let o = 0; o < bytes.length; o += CH) {
    const rr = await fetch(`/chunk?name=${encodeURIComponent(name)}`, { method: 'POST', body: bytes.subarray(o, Math.min(bytes.length, o + CH)) });
    if (!rr.ok) throw new Error('chunk failed');
  }
  const e = await fetch(`/end?name=${encodeURIComponent(name)}`, { method: 'POST' });
  if (!e.ok) throw new Error('end failed');
}

// ---- stars --------------------------------------------------------------------------------------------------------------------
const TAN = (deg) => Math.tan((deg * Math.PI) / 360);
function projectHero(j, p) {
  const f = norm(sub(j.target, j.cam));
  const r = norm(cross(f, [0, 1, 0]));
  const u = cross(r, f);
  const d = sub(p, j.cam);
  const z = dot(d, f);
  if (z < 0.2) return null;
  const tanY = j.tanY;
  const nx = dot(d, r) / z / (tanY * (j.W / j.H));
  const ny = dot(d, u) / z / tanY;
  return { x: (nx * 0.5 + 0.5) * j.W, y: (0.5 - ny * 0.5) * j.H, z };
}
// world direction -> cube face pixel (same table as faceDir in the shader, three's x flip applied)
function dirToFace(face, d, N) {
  const q = [-d[0], d[1], d[2]]; // GL-space direction
  const faces = [
    (v) => [v[0], -v[2] / v[0], -v[1] / v[0]],
    (v) => [-v[0], v[2] / -v[0], -v[1] / -v[0]],
    (v) => [v[1], v[0] / v[1], v[2] / v[1]],
    (v) => [-v[1], v[0] / -v[1], -v[2] / -v[1]],
    (v) => [v[2], v[0] / v[2], -v[1] / v[2]],
    (v) => [-v[2], -v[0] / -v[2], -v[1] / -v[2]],
  ];
  const [ma, u, v] = faces[face](q);
  if (ma <= 0.05) return null;
  return { x: (u * 0.5 + 0.5) * N, y: (v * 0.5 + 0.5) * N, k: 1 + u * u + v * v };
}

// ---- jobs ---------------------------------------------------------------------------------------------------------------------
const api = {
  async init(cfg) {
    CFG = cfg;
    const gpu = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown';
    log('GPU:', gpu);
    return gpu;
  },

  /** Hero approach layers: 5 slabs on view depth. */
  async hero(j) {
    const t0 = performance.now();
    ensureVolume(`hero${j.bakeN}`, j.bakeN, { vh: CFG.vh, mode: 0 });
    j.tanY = TAN(j.fov);
    const slabs = marchImage({ ...j, nSlab: j.bounds.length + 1, slabMode: 0, steps: j.steps, gain: j.gain, knot: j.knot ?? 1, bubble: 0 }, CFG.vh);
    const layers = slabs.slice().reverse(); // far -> near
    const n = layers.length;
    // stars: background in the far layer; the embedded ones in the layer whose depth slab holds them
    const stars = [];
    const zEdges = [Infinity, ...j.bounds.slice().reverse(), -Infinity]; // far -> near edges
    const sc = j.W / 1440;
    for (const s of CFG.heroStars) {
      let layer = 0;
      let pr;
      if (s.p) {
        pr = projectHero(j, s.p);
        if (!pr) continue;
        layer = 0;
        for (let k = 0; k < n; k++) if (pr.z <= zEdges[k] && pr.z > zEdges[k + 1]) layer = k;
      } else {
        const far = [j.cam[0] + s.d[0] * 1000, j.cam[1] + s.d[1] * 1000, j.cam[2] + s.d[2] * 1000];
        pr = projectHero(j, far);
        if (!pr) continue;
      }
      if (pr.x < -60 || pr.y < -60 || pr.x > j.W + 60 || pr.y > j.H + 60) continue;
      stars.push({ layer, att: s.p ? 0.5 : 1, s: { x: pr.x, y: pr.y, rgb: s.rgb, sigma: s.sigma * Math.max(1, sc * 0.9), halo: s.halo, spike: s.spike ? { len: s.spike.len * sc, amp: s.spike.amp, ang: s.spike.ang } : null } });
    }
    const { out, comp } = post(layers, j.W, j.H, { stars, expo: j.expo ?? 1, contrast: true });
    log(`hero march+post ${((performance.now() - t0) / 1000).toFixed(0)} s`);
    // centroid of each layer's emission along the view depth is computed on the node side from the manifest request below
    const res = { depthStats: [] };
    for (let k = 0; k < n; k++) {
      let ew = 0;
      const L = layers[k];
      for (let p = 0; p < j.W * j.H; p++) ew += L[p * 4] * 0.3 + L[p * 4 + 1] * 0.55 + L[p * 4 + 2] * 0.15;
      res.depthStats.push({ k, emission: ew / (j.W * j.H), alphaMean: out[k].reduce((a, v, i) => (i % 4 === 3 ? a + v : a), 0) / (j.W * j.H) });
    }
    if (j.emit) {
      if (CFG.comp) await put(`${j.name}-comp-${j.W}`, encode(comp, j.W, j.H, 3, true), j.W, j.H);
      for (let k = 0; k < n; k++) await put(`${j.name}-L${k}-${j.W}`, encode(out[k], j.W, j.H, 11 + k, false), j.W, j.H);
      if (j.low) {
        const lw = j.W >> 1, lh = j.H >> 1;
        for (let k = 0; k < n; k++) { const d = downscale2(out[k], j.W, j.H); await put(`${j.name}-L${k}-${lw}`, encode(d.buf, d.W, d.H, 31 + k, false), d.W, d.H); }
      }
    }
    return res;
  },

  /** Emission-weighted centroids (view depth for the hero slabs, radius for the bubble slabs) at low resolution. */
  async moments(j) {
    const res = {};
    if (j.kind === 'hero') {
      ensureVolume(`hero${j.bakeN}`, j.bakeN, { vh: CFG.vh, mode: 0 });
      j.tanY = TAN(j.fov);
      const slabs = marchImage({ ...j, nSlab: j.bounds.length + 1, slabMode: 0, gain: 1, knot: 1, bubble: 0, moment: true }, CFG.vh).reverse();
      res.slabs = slabs.map((L) => { let a = 0, b = 0; for (let p = 0; p < j.W * j.H; p++) { a += L[p * 4]; b += L[p * 4 + 1]; } return { centroid: a / Math.max(b, 1e-9), weight: b / (j.W * j.H) }; });
    } else {
      const b = CFG.bubble;
      ensureVolume('bubble' + j.bakeN, j.bakeN, { vh: b.vh, mode: 1, rc: b.rc, w: b.w, rs0: b.rs0, rs1: b.rs1, bias: b.bias });
      const acc = [{ a: 0, b: 0 }, { a: 0, b: 0 }];
      for (const face of [0, 1, 2, 3, 4, 5]) {
        const sl = marchImage({ W: j.W, H: j.W, face, cam: [0, 0, 0], frames: j.frames, steps: j.steps, nSlab: 2, slabMode: 1, bounds: [b.split], gain: 1, bubble: 1, cavR: b.rc, wall: 1, collapse: 1, knot: 0, tMin: b.rc - 0.6, moment: true, fwdSlab: [0, 0, 1] }, b.vh).reverse();
        sl.forEach((L, k) => { for (let p = 0; p < j.W * j.W; p++) { acc[k].a += L[p * 4]; acc[k].b += L[p * 4 + 1]; } });
      }
      res.slabs = acc.map((q) => ({ centroid: q.a / Math.max(q.b, 1e-9), weight: q.b / (6 * j.W * j.W) }));
    }
    return res;
  },

  /** One bubble cube face (far, opaque) and its wall shell (RGBA). */
  async face(j) {
    const t0 = performance.now();
    const b = CFG.bubble;
    ensureVolume('bubble' + j.bakeN, j.bakeN, { vh: b.vh, mode: 1, rc: b.rc, w: b.w, rs0: b.rs0, rs1: b.rs1, bias: b.bias });
    const N = j.N;
    const slabs = marchImage({
      W: N, H: N, face: j.face, cam: [0, 0, 0], frames: j.frames, steps: j.steps, tile: j.tile, tileH: j.tileH, nSlab: 2, slabMode: 1, bounds: [b.split],
      gain: j.gain, rim: j.rim, bubble: 1, cavR: b.rc, wall: 1, collapse: 1, knot: 0, tMin: b.rc - 0.6, detail: j.detail, fwdSlab: [0, 0, 1],
    }, b.vh);
    const layers = slabs.slice().reverse(); // far, shell
    const stars = [];
    for (const s of CFG.cubeStars) {
      const pr = dirToFace(j.face, s.d, N);
      if (!pr) continue;
      if (pr.x < -80 || pr.y < -80 || pr.x > N + 80 || pr.y > N + 80) continue;
      const sc = N / 2048;
      stars.push({ layer: 0, att: 1, s: { x: pr.x, y: pr.y, rgb: s.rgb, sigma: s.sigma * Math.max(1, sc * 0.9) * pr.k, halo: s.halo, spike: s.spike ? { len: s.spike.len * sc, amp: s.spike.amp, ang: s.spike.ang } : null } });
    }
    const { out, comp } = post(layers, N, N, { stars, expo: j.expo ?? 1, contrast: true });
    log(`face ${j.face} ${((performance.now() - t0) / 1000).toFixed(0)} s`);
    const nm = ['px', 'nx', 'py', 'ny', 'pz', 'nz'][j.face];
    // far: opaque, g * c_far; shell: straight alpha
    const far = new Float32Array(out[0]);
    await put(`${j.name}-cube-${nm}-${N}`, encode(far, N, N, 5 + j.face, true), N, N);
    await put(`${j.name}-shell-${nm}-${N}`, encode(out[1], N, N, 41 + j.face, false), N, N);
    if (j.low) {
      const a = downscale2(out[0], N, N); await put(`${j.name}-cube-${nm}-${N >> 1}`, encode(a.buf, a.W, a.H, 55 + j.face, true), a.W, a.H);
      const c = downscale2(out[1], N, N); await put(`${j.name}-shell-${nm}-${N >> 1}`, encode(c.buf, c.W, c.H, 61 + j.face, false), c.W, c.H);
    }
    const sh = out[1];
    let ea = 0;
    for (let p = 0; p < N * N; p++) ea += sh[p * 4 + 3];
    return { face: j.face, shellAlpha: ea / (N * N) };
  },
};
window.nebula = api;
window.nebulaReady = true;
