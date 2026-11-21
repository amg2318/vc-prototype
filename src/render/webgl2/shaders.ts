import { ATLAS_PAGE_SIZE, COMPOSITE_LEVEL0_PAGES, MAX_ATLAS_PAGES, MAX_CANVAS_SIZE } from '../../config';
import { COMPOSITE_UNIFORM_VEC4S, SHADER_CONSTANTS as C } from '../compositePacking';

/** Stroke masks cover the largest canvas. */
export const MASK_SIZE = MAX_CANVAS_SIZE;

// GLSL ES 3.00 shaders for the WebGL2 backend. Same passes and arithmetic as
// the WGSL shaders in ../webgpu/shaders.ts.
//
// Orientation: when rendering into textures we map pixel y straight to clip y
// (no flip), so gl_FragCoord.y is the texel row, and texel row N holds canvas
// (or atlas) row N. Sampling with v = y / height reads the same row back.
// Display quads arrive already in clip space, so the screen needs no special case.

const HEADER = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
`;

const PAGE = `${ATLAS_PAGE_SIZE}.0`;

/** Clip position for pixel `p` in a target of `size` (no y flip, see above). */
const TO_CLIP = `
vec4 toClip(vec2 p, vec2 size) { return vec4(p / size * 2.0 - 1.0, 0.0, 1.0); }
vec2 quadCorner() { return vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1)); }
`;

/** Sampler uniform names `<prefix>0…` for a set of page textures. */
function pageUniforms(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix}${i}`);
}

/** Declares the samplers plus `load_<name>(page, pixel)`. */
function pageLoader(name: string, uniforms: string[]): string {
  return `
${uniforms.map((u) => `uniform sampler2D ${u};`).join('\n')}

vec4 load_${name}(uint page, ivec2 p) {
${uniforms.map((u, i) => `  if (page == ${i}u) return texelFetch(${u}, p, 0);`).join('\n')}
  return vec4(0.0);
}
`;
}

/** Layer tile page samplers. */
export const PAGE_UNIFORMS = pageUniforms('u_page', MAX_ATLAS_PAGES);
/** Level-0 composite page samplers (read by the downsample pass). */
export const LEVEL0_UNIFORMS = pageUniforms('u_level0_', COMPOSITE_LEVEL0_PAGES);

/** Layer page samplers plus `fetchSlot`, which reads one texel of a layer tile slot. */
const FETCH_SLOT = `
${pageLoader('page', PAGE_UNIFORMS)}

vec4 fetchSlot(uint slot, ivec2 local) {
  uint index = slot % ${C.SLOTS_PER_PAGE}u;
  ivec2 p = ivec2(int(index % ${C.PAGE_SIDE_TILES}u), int(index / ${C.PAGE_SIDE_TILES}u)) * ${C.TILE_SIZE} + local;
  return load_page(slot / ${C.SLOTS_PER_PAGE}u, p);
}
`;

// --- dabs ---------------------------------------------------------------------

export const DAB_VS = `${HEADER}${TO_CLIP}
layout(location = 0) in vec4 a_dab;      // x, y, radius, opacity (canvas px)
out vec2 v_local;
out float v_radius;
out float v_opacity;
void main() {
  float extent = a_dab.z + 1.0;          // +1 px so the anti-aliased edge fits
  v_local = (quadCorner() * 2.0 - 1.0) * extent;
  v_radius = a_dab.z;
  v_opacity = a_dab.w;
  gl_Position = toClip(a_dab.xy + v_local, vec2(${MASK_SIZE}.0));
}`;

export const DAB_FS = `${HEADER}
uniform float u_hardness;
in vec2 v_local;
in float v_radius;
in float v_opacity;
out vec4 o_color;
void main() {
  float d = length(v_local);
  float softEdge = max(v_radius * (1.0 - u_hardness), 1.0);
  o_color = vec4(clamp((v_radius - d) / softEdge, 0.0, 1.0) * v_opacity);
}`;

// --- merge (stroke mask → tile slots; blending ONE, ONE_MINUS_SRC_ALPHA) ----------

export const MERGE_VS = `${HEADER}${TO_CLIP}
layout(location = 0) in vec4 a_origins;       // dst slot x, y in page · tile origin x, y in canvas
layout(location = 1) in vec4 a_colorOpacity;
layout(location = 2) in vec4 a_modeCanvas;    // mode, canvas width, height, 0
flat out vec4 v_origins;
flat out vec4 v_colorOpacity;
flat out vec4 v_modeCanvas;
void main() {
  v_origins = a_origins;
  v_colorOpacity = a_colorOpacity;
  v_modeCanvas = a_modeCanvas;
  gl_Position = toClip(a_origins.xy + quadCorner() * ${C.TILE_SIZE}.0, vec2(${PAGE}));
}`;

export const MERGE_FS = `${HEADER}
uniform sampler2D u_strokeMask;
flat in vec4 v_origins;
flat in vec4 v_colorOpacity;
flat in vec4 v_modeCanvas;
out vec4 o_color;
void main() {
  ivec2 local = ivec2(gl_FragCoord.xy) - ivec2(v_origins.xy);
  ivec2 p = ivec2(v_origins.zw) + local;
  // Outside the canvas: output 0, which leaves the tile unchanged (stays transparent).
  if (float(p.x) >= v_modeCanvas.y || float(p.y) >= v_modeCanvas.z) { o_color = vec4(0.0); return; }
  float m = texelFetch(u_strokeMask, p, 0).r * v_colorOpacity.a;
  o_color = v_modeCanvas.x > 0.5 ? vec4(0.0, 0.0, 0.0, m) : vec4(v_colorOpacity.rgb * m, m);
}`;

// --- compositor (layer tiles → level-0 composite tiles) ---------------------------

export const COMPOSITE_VS = `${HEADER}${TO_CLIP}
uniform vec4 u_v[${COMPOSITE_UNIFORM_VEC4S}];
layout(location = 0) in vec4 a_origins;   // dst x, y in the target · tile origin x, y in the canvas
flat out vec4 v_origins;
void main() {
  v_origins = a_origins;
  // The target is a level-0 page, or the staging target for canvases with a block (u_v[2].w is its size).
  gl_Position = toClip(a_origins.xy + quadCorner() * ${C.TILE_SIZE}.0, vec2(u_v[2].w));
}`;

/** Composite page samplers a block can read (level-0 pages, then preview pages). */
export const BLOCK_PAGE_UNIFORMS = pageUniforms('u_blockPage', C.BLOCK_PAGES);

const B = C.BLOCK_UNIFORM_BASE;

export const COMPOSITE_FS = `${HEADER}
uniform vec4 u_v[${COMPOSITE_UNIFORM_VEC4S}];
uniform usampler2D u_lookup;
uniform sampler2D u_strokeMask;
uniform sampler2D u_predictionMask;
uniform usampler2D u_blockLookup;
${BLOCK_PAGE_UNIFORMS.map((u) => `uniform sampler2D ${u};`).join('\n')}
${FETCH_SLOT}
flat in vec4 v_origins;
out vec4 o_color;

// Premultiplied blending (W3C formulas). Layers: normal 0, multiply 1; blocks also screen 2, overlay 3.
vec4 blendOnto(vec4 dst, vec4 src, int mode) {
  float outA = src.a + dst.a * (1.0 - src.a);
  if (mode == 1) return vec4(src.rgb * dst.rgb + src.rgb * (1.0 - dst.a) + dst.rgb * (1.0 - src.a), outA);
  if (mode == 2) return vec4(src.rgb + dst.rgb - src.rgb * dst.rgb, outA);
  if (mode == 3) {
    vec3 cs = src.rgb / max(src.a, 1e-6);
    vec3 cb = dst.rgb / max(dst.a, 1e-6);
    vec3 mixed = mix(1.0 - 2.0 * (1.0 - cs) * (1.0 - cb), 2.0 * cs * cb, vec3(lessThanEqual(cb, vec3(0.5))));
    return vec4(src.rgb * (1.0 - dst.a) + dst.rgb * (1.0 - src.a) + src.a * dst.a * mixed, outA);
  }
  return vec4(src.rgb + dst.rgb * (1.0 - src.a), outA);
}

vec4 sampleBlockPage(uint page, vec2 uv) {
${BLOCK_PAGE_UNIFORMS.map((u, i) => `  if (page == ${i}u) return textureLod(${u}, uv, 0.0);`).join('\n')}
  return vec4(0.0);
}

// The inherited block: map the pixel into the source, find the cached tile, sample it (bilinear, inside the tile).
vec4 blockColor(vec2 p) {
  vec4 m = u_v[${B}];
  vec4 t = u_v[${B} + 1];
  vec4 crop = u_v[${B} + 2];
  vec2 s = vec2(m.x * p.x + m.z * p.y + t.x, m.y * p.x + m.w * p.y + t.y);
  if (any(lessThan(s, crop.xy)) || any(greaterThanEqual(s, crop.zw))) return vec4(0.0);
  ivec2 cell = ivec2(floor(s / t.z));
  int index = cell.y * ${C.TILES_X} + cell.x;
  uvec4 e0 = texelFetch(u_blockLookup, ivec2(index * 2, 0), 0);
  uvec4 e1 = texelFetch(u_blockLookup, ivec2(index * 2 + 1, 0), 0);
  if (e0.x == 0u) return vec4(vec3(e1.rgb) / 255.0, 1.0);
  vec2 texel = vec2(e0.yz) + (s - vec2(cell) * t.z) * exp2(-float(e0.w));
  vec2 tileOrigin = vec2(e1.xy);
  vec2 uv = clamp(texel, tileOrigin + 0.5, tileOrigin + ${C.TILE_SIZE}.0 - 0.5) / ${PAGE};
  return sampleBlockPage(e0.x - 1u, uv);
}

vec4 applyEffects(vec4 c) {
  if (c.a <= 0.0) return c;
  vec3 rgb = c.rgb / c.a;
  int count = int(u_v[${B} + 3].z);
  for (int i = 0; i < 3; i++) {
    if (i >= count) break;
    vec4 e = u_v[${B} + 4 + i];
    if (e.x == 1.0) rgb = vec3(dot(rgb, vec3(0.2126, 0.7152, 0.0722)));
    else if (e.x == 2.0) rgb = 1.0 - rgb;
    else if (e.x == 3.0) { float n = max(e.y, 2.0) - 1.0; rgb = floor(rgb * n + 0.5) / n; }
  }
  return vec4(rgb * c.a, c.a);
}

void main() {
  ivec2 local = ivec2(gl_FragCoord.xy) - ivec2(v_origins.xy);
  ivec2 p = ivec2(v_origins.zw) + local;          // canvas pixel
  ivec2 tile = ivec2(v_origins.zw) / ${C.TILE_SIZE};
  int key = tile.y * ${C.TILES_X} + tile.x;

  vec4 info = u_v[2];
  int count = int(info.x);
  int strokeSource = int(info.y);
  vec4 acc = vec4(u_v[0].rgb, 1.0);

  vec4 block = u_v[${B} + 3];
  if (u_v[${B} + 1].w > 0.5) acc = blendOnto(acc, applyEffects(blockColor(vec2(p) + 0.5)) * block.x, int(block.y));

  for (int i = 0; i < ${C.MAX_SOURCES}; i++) {
    if (i >= count) break;
    uint slot1 = texelFetch(u_lookup, ivec2(key, i), 0).r;
    vec4 layer = slot1 > 0u ? fetchSlot(slot1 - 1u, local) : vec4(0.0);
    if (i == strokeSource) {
      float mask = max(texelFetch(u_strokeMask, p, 0).r, texelFetch(u_predictionMask, p, 0).r);
      float m = mask * u_v[1].a;
      layer = info.z > 0.5 ? layer * (1.0 - m) : vec4(u_v[1].rgb * m, m) + layer * (1.0 - m);
    }
    vec4 source = u_v[3 + i];
    acc = blendOnto(acc, layer * source.x, int(source.y));
  }
  o_color = acc;
}`;

// --- downsample (level-0 tile → region of a coarser preview tile) ---------------------

export const DOWNSAMPLE_VS = `${HEADER}${TO_CLIP}
layout(location = 0) in vec4 a_dst;     // x, y, size, level
layout(location = 1) in vec4 a_src;     // x, y, has source, page
layout(location = 2) in vec4 a_paper;
flat out vec4 v_dst;
flat out vec4 v_src;
flat out vec4 v_paper;
void main() {
  v_dst = a_dst;
  v_src = a_src;
  v_paper = a_paper;
  gl_Position = toClip(a_dst.xy + quadCorner() * a_dst.z, vec2(${PAGE}));
}`;

export const DOWNSAMPLE_FS = `${HEADER}
${pageLoader('level0', LEVEL0_UNIFORMS)}
flat in vec4 v_dst;
flat in vec4 v_src;
flat in vec4 v_paper;
out vec4 o_color;
void main() {
  if (v_src.z < 0.5) { o_color = vec4(v_paper.rgb, 1.0); return; }
  int n = 1 << int(v_dst.w);
  ivec2 o = ivec2(gl_FragCoord.xy) - ivec2(v_dst.xy);
  ivec2 base = ivec2(v_src.xy) + o * n;
  vec4 sum = vec4(0.0);
  for (int y = 0; y < 16; y++) {
    if (y >= n) break;
    for (int x = 0; x < 16; x++) {
      if (x >= n) break;
      sum += load_level0(uint(v_src.w), base + ivec2(x, y));
    }
  }
  o_color = sum / float(n * n);
}`;

// --- display (composite tiles and flat quads, already in clip space) -------------------

export const DISPLAY_VS = `${HEADER}${TO_CLIP}
layout(location = 0) in vec4 a_a;   // clip origin, x axis
layout(location = 1) in vec4 a_b;   // y axis, texel rect start
layout(location = 2) in vec4 a_c;   // texel rect end, clamp min
layout(location = 3) in vec4 a_d;   // clamp max, 0, 0
out vec2 v_texel;
flat out vec4 v_clamp;
void main() {
  vec2 q = quadCorner();
  v_texel = mix(a_b.zw, a_c.xy, q);
  v_clamp = vec4(a_c.zw, a_d.xy);
  gl_Position = vec4(a_a.xy + q.x * a_a.zw + q.y * a_b.xy, 0.0, 1.0);
}`;

export const DISPLAY_FS = `${HEADER}
uniform sampler2D u_tiles;
in vec2 v_texel;
flat in vec4 v_clamp;
out vec4 o_color;
void main() {
  // Stay inside the tile so bilinear filtering never reads a neighbouring atlas tile.
  vec2 t = clamp(v_texel, v_clamp.xy, v_clamp.zw);
  o_color = texture(u_tiles, t / ${PAGE});
}`;

export const SOLID_VS = `${HEADER}${TO_CLIP}
layout(location = 0) in vec4 a_a;   // clip origin, x axis
layout(location = 1) in vec4 a_b;   // y axis, rgba.rg
layout(location = 2) in vec4 a_c;   // rgba.ba, 0, 0
flat out vec4 v_color;
void main() {
  vec2 q = quadCorner();
  v_color = vec4(a_b.zw, a_c.xy);
  gl_Position = vec4(a_a.xy + q.x * a_a.zw + q.y * a_b.xy, 0.0, 1.0);
}`;

export const SOLID_FS = `${HEADER}
flat in vec4 v_color;
out vec4 o_color;
void main() { o_color = v_color; }`;

// --- readback helpers -----------------------------------------------------------

export const EMPTY_CHECK_VS = `${HEADER}${TO_CLIP}
uniform vec2 u_targetSize;
layout(location = 0) in float a_slot;
flat out uint v_slot;
flat out int v_index;
void main() {
  v_slot = uint(a_slot);
  v_index = gl_InstanceID;
  vec2 origin = vec2(float(gl_InstanceID) * ${C.EMPTY_CHECK_BLOCK}.0, 0.0);
  gl_Position = toClip(origin + quadCorner() * ${C.EMPTY_CHECK_BLOCK}.0, u_targetSize);
}`;

export const EMPTY_CHECK_FS = `${HEADER}
${FETCH_SLOT}
flat in uint v_slot;
flat in int v_index;
out vec4 o_color;
void main() {
  ivec2 block = ivec2(gl_FragCoord.xy) - ivec2(v_index * ${C.EMPTY_CHECK_BLOCK}, 0);
  const int cell = ${C.TILE_SIZE / C.EMPTY_CHECK_BLOCK};
  float maxA = 0.0;
  for (int y = 0; y < cell; y++) {
    for (int x = 0; x < cell; x++) maxA = max(maxA, fetchSlot(v_slot, block * cell + ivec2(x, y)).a);
  }
  o_color = vec4(maxA);
}`;

export const THUMBNAIL_VS = `${HEADER}${TO_CLIP}
uniform vec2 u_targetSize;
layout(location = 0) in vec4 a_slotAndTile;   // slot, tile x, tile y, 0
flat out vec4 v_slotAndTile;
void main() {
  v_slotAndTile = a_slotAndTile;
  gl_Position = toClip((a_slotAndTile.yz + quadCorner()) * ${C.THUMBNAIL_PIXELS_PER_TILE}.0, u_targetSize);
}`;

export const THUMBNAIL_FS = `${HEADER}
${FETCH_SLOT}
flat in vec4 v_slotAndTile;
out vec4 o_color;
void main() {
  const int ppt = ${C.THUMBNAIL_PIXELS_PER_TILE};
  const int texelsPerPixel = ${C.TILE_SIZE / C.THUMBNAIL_PIXELS_PER_TILE};
  const int stride = texelsPerPixel / 4;
  ivec2 q = ivec2(gl_FragCoord.xy) - ivec2(v_slotAndTile.yz) * ppt;
  vec4 sum = vec4(0.0);
  for (int y = 0; y < 4; y++) {
    for (int x = 0; x < 4; x++) {
      sum += fetchSlot(uint(v_slotAndTile.x), q * texelsPerPixel + ivec2(x, y) * stride + stride / 2);
    }
  }
  o_color = sum / 16.0;
}`;
