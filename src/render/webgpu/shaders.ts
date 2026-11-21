import { ATLAS_PAGE_SIZE, COMPOSITE_LEVEL0_PAGES, MAX_ATLAS_PAGES, MAX_CANVAS_SIZE } from '../../config';
import { COMPOSITE_UNIFORM_VEC4S, SHADER_CONSTANTS as C } from '../compositePacking';

// WGSL shaders for the WebGPU backend.
//
// Orientation: WebGPU maps clip y = +1 to texel row 0, so every pass that
// renders into a texture flips y into clip space. Texel row N then holds
// canvas (or atlas) row N, and @builtin(position) in the fragment shader is
// the pixel coordinate directly.

const PAGE = `${ATLAS_PAGE_SIZE}.0`;

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

/** `count` page textures named `<name>0…` plus `load_<name>(page, pixel)`. */
function pageTextures(name: string, firstBinding: number, count: number): string {
  const decls = Array.from(
    { length: count },
    (_, i) => `@group(0) @binding(${firstBinding + i}) var ${name}${i}: texture_2d<f32>;`,
  ).join('\n');
  const cases = Array.from({ length: count }, (_, i) => `    case ${i}u: { return textureLoad(${name}${i}, p, 0); }`).join('\n');
  return /* wgsl */ `
${decls}

fn load_${name}(page: u32, p: vec2i) -> vec4f {
  switch page {
${cases}
    default: { return vec4f(0.0); }
  }
}
`;
}

/** Layer tile pages plus `fetchSlot`, which reads one texel of a layer tile slot. */
function layerPages(firstBinding: number): string {
  return /* wgsl */ `
${pageTextures('page', firstBinding, MAX_ATLAS_PAGES)}

fn fetchSlot(slot: u32, local: vec2i) -> vec4f {
  let index = slot % ${C.SLOTS_PER_PAGE}u;
  let p = vec2i(i32(index % ${C.PAGE_SIDE_TILES}u), i32(index / ${C.PAGE_SIDE_TILES}u)) * ${C.TILE_SIZE} + local;
  return load_page(slot / ${C.SLOTS_PER_PAGE}u, p);
}
`;
}

/** First binding of the inherited block's inputs in the composite pass. */
export const BLOCK_BINDING = 4 + MAX_ATLAS_PAGES;

/** Composite page textures a block samples, plus `sampleBlockPage(texture, uv)` (bilinear). */
function blockPages(firstBinding: number): string {
  const decls = Array.from({ length: C.BLOCK_PAGES }, (_, i) => `@group(0) @binding(${firstBinding + i}) var blockPage${i}: texture_2d<f32>;`).join('\n');
  const cases = Array.from({ length: C.BLOCK_PAGES }, (_, i) => `    case ${i}u: { return textureSampleLevel(blockPage${i}, blockSampler, uv, 0.0); }`).join('\n');
  return /* wgsl */ `
${decls}

fn sampleBlockPage(page: u32, uv: vec2f) -> vec4f {
  switch page {
${cases}
    default: { return vec4f(0.0); }
  }
}
`;
}

/**
 * Premultiplied blending of `src` onto `dst` (W3C compositing formulas).
 * Layers use normal (0) and multiply (1); blocks can also use screen (2)
 * and overlay (3).
 */
const BLEND_WGSL = /* wgsl */ `
fn blendOnto(dst: vec4f, src: vec4f, mode: i32) -> vec4f {
  let outA = src.a + dst.a * (1.0 - src.a);
  if (mode == 1) { // multiply
    return vec4f(src.rgb * dst.rgb + src.rgb * (1.0 - dst.a) + dst.rgb * (1.0 - src.a), outA);
  }
  if (mode == 2) { // screen
    return vec4f(src.rgb + dst.rgb - src.rgb * dst.rgb, outA);
  }
  if (mode == 3) { // overlay: multiply the darks, screen the lights (of the backdrop)
    let cs = src.rgb / max(src.a, 1e-6);
    let cb = dst.rgb / max(dst.a, 1e-6);
    let mixed = select(1.0 - 2.0 * (1.0 - cs) * (1.0 - cb), 2.0 * cs * cb, cb <= vec3f(0.5));
    return vec4f(src.rgb * (1.0 - dst.a) + dst.rgb * (1.0 - src.a) + src.a * dst.a * mixed, outA);
  }
  return vec4f(src.rgb + dst.rgb * (1.0 - src.a), outA); // normal
}
`;

/**
 * The inherited block (see blockPacking.ts for the uniforms and lookup):
 * map the pixel into the source, look up which cached composite tile holds
 * that spot, and sample it bilinearly, staying inside the tile.
 */
const BLOCK_WGSL = /* wgsl */ `
fn blockColor(p: vec2f) -> vec4f {
  let m = u.v[${C.BLOCK_UNIFORM_BASE}];
  let t = u.v[${C.BLOCK_UNIFORM_BASE} + 1];
  let crop = u.v[${C.BLOCK_UNIFORM_BASE} + 2];
  let s = vec2f(m.x * p.x + m.z * p.y + t.x, m.y * p.x + m.w * p.y + t.y); // source pixel
  if (any(s < crop.xy) || any(s >= crop.zw)) { return vec4f(0.0); }
  let cell = vec2i(floor(s / t.z));
  let index = cell.y * ${C.TILES_X} + cell.x;
  let e0 = textureLoad(blockLookup, vec2i(index * 2, 0), 0);
  let e1 = textureLoad(blockLookup, vec2i(index * 2 + 1, 0), 0);
  if (e0.x == 0u) { return vec4f(vec3f(e1.rgb) / 255.0, 1.0); } // nothing cached: plain paper
  let texel = vec2f(e0.yz) + (s - vec2f(cell) * t.z) * exp2(-f32(e0.w));
  let tileOrigin = vec2f(e1.xy);
  let uv = clamp(texel, tileOrigin + 0.5, tileOrigin + ${C.TILE_SIZE}.0 - 0.5) / ${PAGE};
  return sampleBlockPage(e0.x - 1u, uv);
}

fn applyEffects(c: vec4f) -> vec4f {
  if (c.a <= 0.0) { return c; }
  var rgb = c.rgb / c.a;
  let count = i32(u.v[${C.BLOCK_UNIFORM_BASE} + 3].z);
  for (var i = 0; i < count; i++) {
    let e = u.v[${C.BLOCK_UNIFORM_BASE} + 4 + i];
    if (e.x == 1.0) { rgb = vec3f(dot(rgb, vec3f(0.2126, 0.7152, 0.0722))); } // grayscale
    else if (e.x == 2.0) { rgb = 1.0 - rgb; } // invert
    else if (e.x == 3.0) { let n = max(e.y, 2.0) - 1.0; rgb = floor(rgb * n + 0.5) / n; } // posterize to e.y levels
  }
  return vec4f(rgb * c.a, c.a);
}
`;

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
 * the tile from before the stroke. The fragment outputs (color·m, m) for
 * paint and (0, 0, 0, m) for erase; the pipeline's fixed-function blending
 * does the rest:
 *   paint (ONE, ONE_MINUS_SRC_ALPHA):  out = color·m + dst·(1 − m)
 *   erase (ZERO, ONE_MINUS_SRC_ALPHA): out = dst·(1 − m)
 * (Erase can't use the paint blending: its alpha would be m + dst.a·(1 − m),
 * turning erased pixels opaque black.)
 * Pixels outside the canvas output 0, which leaves the tile unchanged.
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
  @location(3) @interpolate(flat) modeCanvas: vec4f,
};

@vertex
fn vs(@builtin(vertex_index) vi: u32,
      @location(0) origins: vec4f, @location(1) colorOpacity: vec4f, @location(2) modeCanvas: vec4f) -> VOut {
  var out: VOut;
  out.position = toClip(origins.xy + quad(vi) * ${C.TILE_SIZE}.0, vec2f(${PAGE}));
  out.dstOrigin = origins.xy;
  out.tileOrigin = origins.zw;
  out.colorOpacity = colorOpacity;
  out.modeCanvas = modeCanvas;
  return out;
}

@fragment
fn fs(in: VOut) -> @location(0) vec4f {
  let local = vec2i(in.position.xy) - vec2i(in.dstOrigin);
  let p = vec2i(in.tileOrigin) + local;
  if (f32(p.x) >= in.modeCanvas.y || f32(p.y) >= in.modeCanvas.z) { return vec4f(0.0); }
  let m = textureLoad(strokeMask, p, 0).r * in.colorOpacity.a;
  if (in.modeCanvas.x > 0.5) { return vec4f(0.0, 0.0, 0.0, m); }
  return vec4f(in.colorOpacity.rgb * m, m);
}
`;

/**
 * Compositor: writes level-0 composite tiles of one canvas into a level-0
 * page. For each pixel, start from the paper colour and blend every source
 * bottom to top; raster sources find their tile slot in the canvas's lookup
 * texture. The live stroke is applied to its layer first, so the preview
 * matches the merged result exactly (including erasing).
 */
export const COMPOSITE_WGSL = /* wgsl */ `
${TO_CLIP}
${QUAD}
struct CompositeUniforms { v: array<vec4f, ${COMPOSITE_UNIFORM_VEC4S}> };
@group(0) @binding(0) var<uniform> u: CompositeUniforms;
@group(0) @binding(1) var lookup: texture_2d<u32>;
@group(0) @binding(2) var strokeMask: texture_2d<f32>;
@group(0) @binding(3) var predictionMask: texture_2d<f32>;
${layerPages(4)}
@group(0) @binding(${BLOCK_BINDING}) var blockLookup: texture_2d<u32>;
@group(0) @binding(${BLOCK_BINDING + 1}) var blockSampler: sampler;
${blockPages(BLOCK_BINDING + 2)}

struct VOut { @builtin(position) position: vec4f, @location(0) @interpolate(flat) origins: vec4f };

@vertex
fn vs(@builtin(vertex_index) vi: u32, @location(0) origins: vec4f) -> VOut {
  var out: VOut;
  out.position = toClip(origins.xy + quad(vi) * ${C.TILE_SIZE}.0, vec2f(u.v[2].w)); // page or staging target
  out.origins = origins;
  return out;
}

${BLEND_WGSL}

${BLOCK_WGSL}

@fragment
fn fs(in: VOut) -> @location(0) vec4f {
  let local = vec2i(in.position.xy) - vec2i(in.origins.xy);
  let p = vec2i(in.origins.zw) + local;          // canvas pixel
  let tile = vec2i(in.origins.zw) / ${C.TILE_SIZE};
  let key = tile.y * ${C.TILES_X} + tile.x;

  let info = u.v[2];
  let count = i32(info.x);
  let strokeSource = i32(info.y);
  var acc = vec4f(u.v[0].rgb, 1.0);

  // The inherited block, below every layer.
  let block = u.v[${C.BLOCK_UNIFORM_BASE} + 3];
  if (u.v[${C.BLOCK_UNIFORM_BASE} + 1].w > 0.5) {
    acc = blendOnto(acc, applyEffects(blockColor(vec2f(p) + 0.5)) * block.x, i32(block.y));
  }

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

/**
 * Downsample: each output pixel of a preview region at level ℓ is the exact
 * average of the 2^ℓ × 2^ℓ level-0 texels it covers (or plain paper).
 */
export const DOWNSAMPLE_WGSL = /* wgsl */ `
${TO_CLIP}
${QUAD}
${pageTextures('level0', 0, COMPOSITE_LEVEL0_PAGES)}

struct VOut {
  @builtin(position) position: vec4f,
  @location(0) @interpolate(flat) dst: vec4f,     // x, y, size, level
  @location(1) @interpolate(flat) src: vec4f,     // x, y, has source, page
  @location(2) @interpolate(flat) paper: vec4f,
};

@vertex
fn vs(@builtin(vertex_index) vi: u32, @location(0) dst: vec4f, @location(1) src: vec4f, @location(2) paper: vec4f) -> VOut {
  var out: VOut;
  out.position = toClip(dst.xy + quad(vi) * dst.z, vec2f(${PAGE}));
  out.dst = dst;
  out.src = src;
  out.paper = paper;
  return out;
}

@fragment
fn fs(in: VOut) -> @location(0) vec4f {
  if (in.src.z < 0.5) { return vec4f(in.paper.rgb, 1.0); }
  let n = 1 << u32(in.dst.w);
  let o = vec2i(in.position.xy) - vec2i(in.dst.xy);
  let base = vec2i(in.src.xy) + o * i32(n);
  var sum = vec4f(0.0);
  for (var y = 0; y < i32(n); y++) {
    for (var x = 0; x < i32(n); x++) {
      sum += load_level0(u32(in.src.w), base + vec2i(x, y));
    }
  }
  return sum / f32(n * n);
}
`;

/** Draws part of a composite tile as a parallelogram on screen (positions are already in clip space). */
export const DISPLAY_WGSL = /* wgsl */ `
${QUAD}
@group(0) @binding(0) var linearSampler: sampler;
@group(0) @binding(1) var tiles: texture_2d<f32>;

struct VOut {
  @builtin(position) position: vec4f,
  @location(0) texel: vec2f,
  @location(1) @interpolate(flat) clampRect: vec4f,
};

@vertex
fn vs(@builtin(vertex_index) vi: u32,
      @location(0) a: vec4f, @location(1) b: vec4f, @location(2) c: vec4f, @location(3) d: vec4f) -> VOut {
  let q = quad(vi);
  var out: VOut;
  out.position = vec4f(a.xy + q.x * a.zw + q.y * b.xy, 0.0, 1.0);
  out.texel = mix(b.zw, c.xy, q);
  out.clampRect = vec4f(c.zw, d.xy);
  return out;
}

@fragment
fn fs(in: VOut) -> @location(0) vec4f {
  // Stay inside the tile so bilinear filtering never reads a neighbouring atlas tile.
  let t = clamp(in.texel, in.clampRect.xy, in.clampRect.zw);
  return textureSampleLevel(tiles, linearSampler, t / ${PAGE}, 0.0);
}
`;

/** Flat-coloured parallelogram (premultiplied colour): shadows, paper placeholders, overlays. */
export const SOLID_WGSL = /* wgsl */ `
${QUAD}
struct VOut { @builtin(position) position: vec4f, @location(0) @interpolate(flat) color: vec4f };

@vertex
fn vs(@builtin(vertex_index) vi: u32, @location(0) a: vec4f, @location(1) b: vec4f, @location(2) c: vec4f) -> VOut {
  let q = quad(vi);
  var out: VOut;
  out.position = vec4f(a.xy + q.x * a.zw + q.y * b.xy, 0.0, 1.0);
  out.color = vec4f(b.zw, c.xy);
  return out;
}

@fragment
fn fs(in: VOut) -> @location(0) vec4f {
  return in.color;
}
`;

/** Reduces each tile to a 16 × 16 block of max alpha, to find fully erased tiles. */
export const EMPTY_CHECK_WGSL = /* wgsl */ `
${TO_CLIP}
${QUAD}
struct CheckUniforms { targetSize: vec2f, _pad: vec2f };
@group(0) @binding(0) var<uniform> u: CheckUniforms;
${layerPages(1)}

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
${layerPages(1)}

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

/** Stroke masks cover the largest canvas. */
export const MASK_SIZE = MAX_CANVAS_SIZE;
