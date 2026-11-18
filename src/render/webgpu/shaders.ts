import { ATLAS_PAGE_SIZE, CANVAS_HEIGHT, CANVAS_WIDTH, MAX_ATLAS_PAGES } from '../../config';
import { COMPOSITE_UNIFORM_VEC4S, SHADER_CONSTANTS as C } from '../compositePacking';

// WGSL shaders for the WebGPU backend.
//
// Orientation: WebGPU maps clip y = +1 to texel row 0, so every pass that
// renders into a texture flips y into clip space. Texel row N then holds
// canvas (or atlas) row N, and @builtin(position) in the fragment shader is
// the pixel coordinate directly.

/** Clip position for pixel `p` of a render target of size `size`. */
const TO_CLIP = /* wgsl */ `
fn toClip(p: vec2f, size: vec2f) -> vec4f {
  return vec4f(p.x / size.x * 2.0 - 1.0, 1.0 - p.y / size.y * 2.0, 0.0, 1.0);
}
`;

/** Unit-quad corner for vertex `vi` of a 4-vertex triangle strip. */
const QUAD = /* wgsl */ `
fn quad(vi: u32) -> vec2f {
  var corners = array<vec2f, 4>(vec2f(0, 0), vec2f(1, 0), vec2f(0, 1), vec2f(1, 1));
  return corners[vi];
}
`;

/** Page texture bindings plus `fetchSlot`, which reads one texel of a tile slot. */
function pageBindings(firstBinding: number): string {
  const decls = Array.from(
    { length: MAX_ATLAS_PAGES },
    (_, i) => `@group(0) @binding(${firstBinding + i}) var page${i}: texture_2d<f32>;`,
  ).join('\n');
  const cases = Array.from(
    { length: MAX_ATLAS_PAGES },
    (_, i) => `    case ${i}u: { return textureLoad(page${i}, p, 0); }`,
  ).join('\n');
  return /* wgsl */ `
${decls}

fn fetchSlot(slot: u32, local: vec2i) -> vec4f {
  let page = slot / ${C.SLOTS_PER_PAGE}u;
  let index = slot % ${C.SLOTS_PER_PAGE}u;
  let p = vec2i(i32(index % ${C.PAGE_SIDE_TILES}u), i32(index / ${C.PAGE_SIDE_TILES}u)) * ${C.TILE_SIZE} + local;
  switch page {
${cases}
    default: { return vec4f(0.0); }
  }
}
`;
}

/** Stamps one round dab per instance into a canvas-sized mask (MAX blending). */
export const DAB_WGSL = /* wgsl */ `
${TO_CLIP}
struct DabUniforms { canvasSize: vec2f, hardness: f32, _pad: f32 };
@group(0) @binding(0) var<uniform> u: DabUniforms;

struct VOut {
  @builtin(position) position: vec4f,
  @location(0) local: vec2f,
  @location(1) radius: f32,
  @location(2) opacity: f32,
};

@vertex
fn vs(@builtin(vertex_index) vi: u32, @location(0) dab: vec4f) -> VOut {
  var corners = array<vec2f, 4>(vec2f(-1, -1), vec2f(1, -1), vec2f(-1, 1), vec2f(1, 1));
  let extent = dab.z + 1.0;                 // +1 px so the anti-aliased edge fits
  let local = corners[vi] * extent;
  var out: VOut;
  out.position = toClip(dab.xy + local, u.canvasSize);
  out.local = local;
  out.radius = dab.z;
  out.opacity = dab.w;
  return out;
}

@fragment
fn fs(in: VOut) -> @location(0) vec4f {
  let d = length(in.local);
  let softEdge = max(in.radius * (1.0 - u.hardness), 1.0);
  let coverage = clamp((in.radius - d) / softEdge, 0.0, 1.0);
  return vec4f(coverage * in.opacity);
}
`;

/**
 * Merge: blends the stroke mask over tile slots that already hold a copy of
 * the tile from before the stroke. Uses fixed-function blending
 * (ONE, ONE_MINUS_SRC_ALPHA), which is exactly premultiplied paint/erase:
 *   paint: out = color·m + dst·(1 − m)      erase: out = 0 + dst·(1 − m)
 */
export const MERGE_WGSL = /* wgsl */ `
${TO_CLIP}
${QUAD}
@group(0) @binding(0) var strokeMask: texture_2d<f32>;

struct VOut {
  @builtin(position) position: vec4f,
  @location(0) @interpolate(flat) dstOrigin: vec2f,
  @location(1) @interpolate(flat) tileOrigin: vec2f,
  @location(2) @interpolate(flat) colorOpacity: vec4f,
  @location(3) @interpolate(flat) mode: f32,
};

@vertex
fn vs(@builtin(vertex_index) vi: u32,
      @location(0) origins: vec4f, @location(1) colorOpacity: vec4f, @location(2) mode: vec4f) -> VOut {
  var out: VOut;
  out.position = toClip(origins.xy + quad(vi) * ${C.TILE_SIZE}.0, vec2f(${ATLAS_PAGE_SIZE}.0));
  out.dstOrigin = origins.xy;
  out.tileOrigin = origins.zw;
  out.colorOpacity = colorOpacity;
  out.mode = mode.x;
  return out;
}

@fragment
fn fs(in: VOut) -> @location(0) vec4f {
  let local = vec2i(in.position.xy) - vec2i(in.dstOrigin);
  let m = textureLoad(strokeMask, vec2i(in.tileOrigin) + local, 0).r * in.colorOpacity.a;
  if (in.mode > 0.5) { return vec4f(0.0, 0.0, 0.0, m); }
  return vec4f(in.colorOpacity.rgb * m, m);
}
`;

/**
 * Compositor: for each pixel of the dirty tiles, start from the paper colour
 * and blend every source bottom to top. Raster sources find their tile slot in
 * the lookup texture. The live stroke is applied to its layer first, so the
 * preview matches the merged result exactly (including erasing).
 */
export const COMPOSITE_WGSL = /* wgsl */ `
${TO_CLIP}
${QUAD}
struct CompositeUniforms { v: array<vec4f, ${COMPOSITE_UNIFORM_VEC4S}> };
@group(0) @binding(0) var<uniform> u: CompositeUniforms;
@group(0) @binding(1) var lookup: texture_2d<u32>;
@group(0) @binding(2) var strokeMask: texture_2d<f32>;
@group(0) @binding(3) var predictionMask: texture_2d<f32>;
${pageBindings(4)}

@vertex
fn vs(@builtin(vertex_index) vi: u32, @location(0) tileOrigin: vec2f) -> @builtin(position) vec4f {
  return toClip(tileOrigin + quad(vi) * ${C.TILE_SIZE}.0, vec2f(${CANVAS_WIDTH}.0, ${CANVAS_HEIGHT}.0));
}

fn blendOnto(dst: vec4f, src: vec4f, mode: i32) -> vec4f {
  let outA = src.a + dst.a * (1.0 - src.a);
  if (mode == 1) { // multiply (premultiplied W3C formula)
    let rgb = src.rgb * dst.rgb + src.rgb * (1.0 - dst.a) + dst.rgb * (1.0 - src.a);
    return vec4f(rgb, outA);
  }
  return vec4f(src.rgb + dst.rgb * (1.0 - src.a), outA); // normal
}

@fragment
fn fs(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let p = vec2i(position.xy);
  let tile = vec2i(p.x / ${C.TILE_SIZE}, p.y / ${C.TILE_SIZE});
  let key = tile.y * ${C.TILES_X} + tile.x;
  let local = p - tile * ${C.TILE_SIZE};

  let info = u.v[2];
  let count = i32(info.x);
  let strokeSource = i32(info.y);
  var acc = vec4f(u.v[0].rgb, 1.0);

  for (var i = 0; i < count; i++) {
    let slot1 = textureLoad(lookup, vec2i(key, i), 0).r;
    var layer = vec4f(0.0);
    if (slot1 > 0u) { layer = fetchSlot(slot1 - 1u, local); }
    if (i == strokeSource) {
      let mask = max(textureLoad(strokeMask, p, 0).r, textureLoad(predictionMask, p, 0).r);
      let m = mask * u.v[1].a;
      if (info.z > 0.5) { layer = layer * (1.0 - m); }
      else { layer = vec4f(u.v[1].rgb * m, m) + layer * (1.0 - m); }
    }
    let source = u.v[3 + i];
    acc = blendOnto(acc, layer * source.x, i32(source.y));
  }
  return acc;
}
`;

/** Draws the composite cache through the view, box-filtering when zoomed out. */
export const DISPLAY_WGSL = /* wgsl */ `
struct DisplayUniforms {
  docToClip0: vec4f, docToClip1: vec4f, docToClip2: vec4f,
  params: vec4f,                           // canvas w, h, texels per device pixel, 0
};
@group(0) @binding(0) var<uniform> u: DisplayUniforms;
@group(0) @binding(1) var linearSampler: sampler;
@group(0) @binding(2) var composite: texture_2d<f32>;

struct VOut { @builtin(position) position: vec4f, @location(0) uv: vec2f };

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VOut {
  var corners = array<vec2f, 4>(vec2f(0, 0), vec2f(1, 0), vec2f(0, 1), vec2f(1, 1));
  let m = mat3x3f(u.docToClip0.xyz, u.docToClip1.xyz, u.docToClip2.xyz);
  let clip = m * vec3f(corners[vi] * u.params.xy, 1.0);
  var out: VOut;
  out.position = vec4f(clip.xy, 0.0, 1.0);
  out.uv = corners[vi];
  return out;
}

@fragment
fn fs(in: VOut) -> @location(0) vec4f {
  let footprint = u.params.z;
  if (footprint <= 1.5) {
    return vec4f(textureSample(composite, linearSampler, in.uv).rgb, 1.0);
  }
  // Zoomed out: average a 3×3 grid of bilinear taps spread over the pixel's footprint.
  let step = footprint / 3.0 / u.params.xy;
  var sum = vec3f(0.0);
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      sum += textureSample(composite, linearSampler, in.uv + vec2f(f32(x), f32(y)) * step).rgb;
    }
  }
  return vec4f(sum / 9.0, 1.0);
}
`;

/** Reduces each tile to a 16 × 16 block of max alpha, to find fully erased tiles. */
export const EMPTY_CHECK_WGSL = /* wgsl */ `
${TO_CLIP}
${QUAD}
struct CheckUniforms { targetSize: vec2f, _pad: vec2f };
@group(0) @binding(0) var<uniform> u: CheckUniforms;
${pageBindings(1)}

struct VOut { @builtin(position) position: vec4f, @location(0) @interpolate(flat) slotAndIndex: vec2u };

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32, @location(0) slot: f32) -> VOut {
  var out: VOut;
  let origin = vec2f(f32(ii) * ${C.EMPTY_CHECK_BLOCK}.0, 0.0);
  out.position = toClip(origin + quad(vi) * ${C.EMPTY_CHECK_BLOCK}.0, u.targetSize);
  out.slotAndIndex = vec2u(u32(slot), ii);
  return out;
}

@fragment
fn fs(in: VOut) -> @location(0) vec4f {
  let block = vec2i(in.position.xy) - vec2i(i32(in.slotAndIndex.y) * ${C.EMPTY_CHECK_BLOCK}, 0);
  let cell = ${C.TILE_SIZE / C.EMPTY_CHECK_BLOCK};
  var maxA = 0.0;
  for (var y = 0; y < cell; y++) {
    for (var x = 0; x < cell; x++) {
      maxA = max(maxA, fetchSlot(in.slotAndIndex.x, block * cell + vec2i(x, y)).a);
    }
  }
  return vec4f(maxA);
}
`;

/** Cheap layer thumbnail: each thumbnail pixel averages a 4 × 4 grid of texels from its tile area. */
export const THUMBNAIL_WGSL = /* wgsl */ `
${TO_CLIP}
${QUAD}
struct ThumbUniforms { targetSize: vec2f, _pad: vec2f };
@group(0) @binding(0) var<uniform> u: ThumbUniforms;
${pageBindings(1)}

struct VOut { @builtin(position) position: vec4f, @location(0) @interpolate(flat) slotAndTile: vec4f };

@vertex
fn vs(@builtin(vertex_index) vi: u32, @location(0) slotAndTile: vec4f) -> VOut {
  var out: VOut;
  let ppt = ${C.THUMBNAIL_PIXELS_PER_TILE}.0;
  out.position = toClip((slotAndTile.yz + quad(vi)) * ppt, u.targetSize);
  out.slotAndTile = slotAndTile;
  return out;
}

@fragment
fn fs(in: VOut) -> @location(0) vec4f {
  let ppt = ${C.THUMBNAIL_PIXELS_PER_TILE};
  let texelsPerPixel = ${C.TILE_SIZE / C.THUMBNAIL_PIXELS_PER_TILE};
  let q = vec2i(in.position.xy) - vec2i(in.slotAndTile.yz) * ppt;
  let stride = texelsPerPixel / 4;
  var sum = vec4f(0.0);
  for (var y = 0; y < 4; y++) {
    for (var x = 0; x < 4; x++) {
      sum += fetchSlot(u32(in.slotAndTile.x), q * texelsPerPixel + vec2i(x, y) * stride + stride / 2);
    }
  }
  return sum / 16.0;
}
`;
