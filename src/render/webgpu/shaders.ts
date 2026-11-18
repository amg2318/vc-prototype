// WGSL shaders for the WebGPU backend.
//
// Texture orientation: WebGPU maps clip y = +1 to texel row 0, so when
// rendering into document/mask textures we flip document y into clip space.
// Texel row N then holds document row N, and sampling with v = docY / height
// reads it back.

/** Stamps one round dab per instance into a mask texture (MAX blending). */
export const DAB_WGSL = /* wgsl */ `
struct DabUniforms {
  docSize: vec2f,
  hardness: f32,
  _pad: f32,
};
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
  let doc = dab.xy + local;
  var out: VOut;
  out.position = vec4f(doc.x / u.docSize.x * 2.0 - 1.0, 1.0 - doc.y / u.docSize.y * 2.0, 0.0, 1.0);
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

/** Composites the stroke mask onto the document (source-over blending). */
export const MERGE_WGSL = /* wgsl */ `
struct MergeUniforms {
  colorAndOpacity: vec4f,
};
@group(0) @binding(0) var<uniform> u: MergeUniforms;
@group(0) @binding(1) var mask: texture_2d<f32>;

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}

@fragment
fn fs(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let m = textureLoad(mask, vec2i(position.xy), 0).r;
  return vec4f(u.colorAndOpacity.rgb, m * u.colorAndOpacity.a);
}
`;

/** Draws the document rectangle through the view matrix, with the live stroke on top. */
export const DISPLAY_WGSL = /* wgsl */ `
struct DisplayUniforms {
  docToClip0: vec4f,                       // mat3 columns, padded to vec4
  docToClip1: vec4f,
  docToClip2: vec4f,
  strokeColorAndOpacity: vec4f,            // opacity 0 when no stroke is active
  docSize: vec4f,
};
@group(0) @binding(0) var<uniform> u: DisplayUniforms;
@group(0) @binding(1) var linearSampler: sampler;
@group(0) @binding(2) var documentTex: texture_2d<f32>;
@group(0) @binding(3) var strokeTex: texture_2d<f32>;
@group(0) @binding(4) var predictionTex: texture_2d<f32>;

struct VOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VOut {
  var corners = array<vec2f, 4>(vec2f(0, 0), vec2f(1, 0), vec2f(0, 1), vec2f(1, 1));
  let corner = corners[vi];
  let m = mat3x3f(u.docToClip0.xyz, u.docToClip1.xyz, u.docToClip2.xyz);
  let clip = m * vec3f(corner * u.docSize.xy, 1.0);
  var out: VOut;
  out.position = vec4f(clip.xy, 0.0, 1.0);
  out.uv = corner;
  return out;
}

@fragment
fn fs(in: VOut) -> @location(0) vec4f {
  let doc = textureSample(documentTex, linearSampler, in.uv).rgb;
  let mask = max(textureSample(strokeTex, linearSampler, in.uv).r,
                 textureSample(predictionTex, linearSampler, in.uv).r);
  let a = mask * u.strokeColorAndOpacity.a;
  return vec4f(mix(doc, u.strokeColorAndOpacity.rgb, a), 1.0);
}
`;
