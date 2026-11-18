// GLSL ES 3.00 shaders for the WebGL2 backend.
//
// Texture orientation: when rendering into the document/mask textures we map
// document y straight to clip y (no flip), so texel row N holds document row N.
// Sampling with v = docY / docHeight then reads the same row back.

/** Stamps one round dab per instance into a mask texture (MAX blending). */
export const DAB_VS = /* glsl */ `#version 300 es
layout(location = 0) in vec2 a_corner;   // quad corner, -1..1
layout(location = 1) in vec4 a_dab;      // x, y, radius, opacity (document px)
uniform vec2 u_docSize;
out vec2 v_local;
out float v_radius;
out float v_opacity;
void main() {
  float extent = a_dab.z + 1.0;          // +1 px so the anti-aliased edge fits
  v_local = a_corner * extent;
  v_radius = a_dab.z;
  v_opacity = a_dab.w;
  vec2 doc = a_dab.xy + v_local;
  gl_Position = vec4(doc / u_docSize * 2.0 - 1.0, 0.0, 1.0);
}`;

export const DAB_FS = /* glsl */ `#version 300 es
precision highp float;
uniform float u_hardness;
in vec2 v_local;
in float v_radius;
in float v_opacity;
out vec4 o_color;
void main() {
  float d = length(v_local);
  float softEdge = max(v_radius * (1.0 - u_hardness), 1.0);
  float coverage = clamp((v_radius - d) / softEdge, 0.0, 1.0);
  o_color = vec4(coverage * v_opacity);
}`;

/** Full-screen triangle used by the merge pass. */
export const FULLSCREEN_VS = /* glsl */ `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

/** Composites the stroke mask onto the document (source-over blending). */
export const MERGE_FS = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D u_mask;
uniform vec3 u_color;
uniform float u_opacity;
out vec4 o_color;
void main() {
  float mask = texelFetch(u_mask, ivec2(gl_FragCoord.xy), 0).r;
  o_color = vec4(u_color, mask * u_opacity);
}`;

/** Draws the document rectangle through the view matrix, with the live stroke on top. */
export const DISPLAY_VS = /* glsl */ `#version 300 es
layout(location = 0) in vec2 a_corner;   // 0..1
uniform mat3 u_docToClip;
uniform vec2 u_docSize;
out vec2 v_uv;
void main() {
  v_uv = a_corner;
  vec3 clip = u_docToClip * vec3(a_corner * u_docSize, 1.0);
  gl_Position = vec4(clip.xy, 0.0, 1.0);
}`;

export const DISPLAY_FS = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D u_document;
uniform sampler2D u_stroke;
uniform sampler2D u_prediction;
uniform vec3 u_strokeColor;
uniform float u_strokeOpacity;           // 0 when no stroke is active
in vec2 v_uv;
out vec4 o_color;
void main() {
  vec3 doc = texture(u_document, v_uv).rgb;
  float mask = max(texture(u_stroke, v_uv).r, texture(u_prediction, v_uv).r);
  o_color = vec4(mix(doc, u_strokeColor, mask * u_strokeOpacity), 1.0);
}`;
