import { ATLAS_PAGE_SIZE, CANVAS_HEIGHT, CANVAS_WIDTH, MAX_ATLAS_PAGES } from '../../config';
import { COMPOSITE_UNIFORM_VEC4S, SHADER_CONSTANTS as C } from '../compositePacking';

// GLSL ES 3.00 shaders for the WebGL2 backend. Same passes and arithmetic as
// the WGSL shaders in ../webgpu/shaders.ts.
//
// Orientation: when rendering into textures we map pixel y straight to clip y
// (no flip), so gl_FragCoord.y is the texel row, and texel row N holds canvas
// (or atlas) row N. Sampling with v = y / height reads the same row back.

const HEADER = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
`;

/** Clip position for pixel `p` in a target of `size` (no y flip, see above). */
const TO_CLIP = `
vec4 toClip(vec2 p, vec2 size) { return vec4(p / size * 2.0 - 1.0, 0.0, 1.0); }
vec2 quadCorner() { return vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1)); }
`;

/** Sampler uniforms for every atlas page plus `fetchSlot`, which reads one texel of a tile slot. */
export const PAGE_UNIFORMS = Array.from({ length: MAX_ATLAS_PAGES }, (_, i) => `u_page${i}`);

const FETCH_SLOT = `
${PAGE_UNIFORMS.map((name) => `uniform sampler2D ${name};`).join('\n')}

vec4 fetchSlot(uint slot, ivec2 local) {
  uint page = slot / ${C.SLOTS_PER_PAGE}u;
  uint index = slot % ${C.SLOTS_PER_PAGE}u;
  ivec2 p = ivec2(int(index % ${C.PAGE_SIDE_TILES}u), int(index / ${C.PAGE_SIDE_TILES}u)) * ${C.TILE_SIZE} + local;
${PAGE_UNIFORMS.map((name, i) => `  if (page == ${i}u) return texelFetch(${name}, p, 0);`).join('\n')}
  return vec4(0.0);
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
  gl_Position = toClip(a_dab.xy + v_local, vec2(${CANVAS_WIDTH}.0, ${CANVAS_HEIGHT}.0));
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
layout(location = 2) in vec4 a_mode;
flat out vec4 v_origins;
flat out vec4 v_colorOpacity;
flat out float v_mode;
void main() {
  v_origins = a_origins;
  v_colorOpacity = a_colorOpacity;
  v_mode = a_mode.x;
  gl_Position = toClip(a_origins.xy + quadCorner() * ${C.TILE_SIZE}.0, vec2(${ATLAS_PAGE_SIZE}.0));
}`;

export const MERGE_FS = `${HEADER}
uniform sampler2D u_strokeMask;
flat in vec4 v_origins;
flat in vec4 v_colorOpacity;
flat in float v_mode;
out vec4 o_color;
void main() {
  ivec2 local = ivec2(gl_FragCoord.xy) - ivec2(v_origins.xy);
  float m = texelFetch(u_strokeMask, ivec2(v_origins.zw) + local, 0).r * v_colorOpacity.a;
  o_color = v_mode > 0.5 ? vec4(0.0, 0.0, 0.0, m) : vec4(v_colorOpacity.rgb * m, m);
}`;

// --- compositor ---------------------------------------------------------------

export const COMPOSITE_VS = `${HEADER}${TO_CLIP}
layout(location = 0) in vec2 a_tileOrigin;
void main() {
  gl_Position = toClip(a_tileOrigin + quadCorner() * ${C.TILE_SIZE}.0, vec2(${CANVAS_WIDTH}.0, ${CANVAS_HEIGHT}.0));
}`;

export const COMPOSITE_FS = `${HEADER}
uniform vec4 u_v[${COMPOSITE_UNIFORM_VEC4S}];
uniform usampler2D u_lookup;
uniform sampler2D u_strokeMask;
uniform sampler2D u_predictionMask;
${FETCH_SLOT}
out vec4 o_color;

vec4 blendOnto(vec4 dst, vec4 src, int mode) {
  float outA = src.a + dst.a * (1.0 - src.a);
  if (mode == 1) { // multiply (premultiplied W3C formula)
    return vec4(src.rgb * dst.rgb + src.rgb * (1.0 - dst.a) + dst.rgb * (1.0 - src.a), outA);
  }
  return vec4(src.rgb + dst.rgb * (1.0 - src.a), outA); // normal
}

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 tile = p / ${C.TILE_SIZE};
  int key = tile.y * ${C.TILES_X} + tile.x;
  ivec2 local = p - tile * ${C.TILE_SIZE};

  vec4 info = u_v[2];
  int count = int(info.x);
  int strokeSource = int(info.y);
  vec4 acc = vec4(u_v[0].rgb, 1.0);
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

// --- display ------------------------------------------------------------------

export const DISPLAY_VS = `${HEADER}${TO_CLIP}
uniform mat3 u_docToClip;
uniform vec4 u_params;                   // canvas w, h, texels per device pixel, 0
out vec2 v_uv;
void main() {
  v_uv = quadCorner();
  vec3 clip = u_docToClip * vec3(v_uv * u_params.xy, 1.0);
  gl_Position = vec4(clip.xy, 0.0, 1.0);
}`;

export const DISPLAY_FS = `${HEADER}
uniform sampler2D u_composite;
uniform vec4 u_params;
in vec2 v_uv;
out vec4 o_color;
void main() {
  float footprint = u_params.z;
  if (footprint <= 1.5) {
    o_color = vec4(texture(u_composite, v_uv).rgb, 1.0);
    return;
  }
  // Zoomed out: average a 3×3 grid of bilinear taps spread over the pixel's footprint.
  vec2 stepUv = footprint / 3.0 / u_params.xy;
  vec3 sum = vec3(0.0);
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) sum += texture(u_composite, v_uv + vec2(x, y) * stepUv).rgb;
  }
  o_color = vec4(sum / 9.0, 1.0);
}`;

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
