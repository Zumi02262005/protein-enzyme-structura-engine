/** GLSL ES 3.00 sources for the WebGL2 renderer. */

const LIGHTING = /* glsl */ `
vec3 shade(vec3 albedo, vec3 n, vec3 viewPos) {
  vec3 v = normalize(-viewPos);
  if (dot(n, v) < 0.0) n = -n;
  vec3 base = pow(albedo, vec3(2.2));
  // key light from the upper left, a cool fill from the right, soft sky/ground ambient
  vec3 keyDir = normalize(vec3(-0.45, 0.7, 0.62));
  vec3 fillDir = normalize(vec3(0.7, -0.15, 0.5));
  float key = clamp((dot(n, keyDir) + 0.3) / 1.3, 0.0, 1.0);
  float fill = clamp(dot(n, fillDir), 0.0, 1.0);
  vec3 ambient = mix(vec3(0.10, 0.16, 0.14), vec3(0.42, 0.50, 0.50), n.y * 0.5 + 0.5);
  vec3 color = base * (ambient + vec3(1.0, 0.98, 0.92) * key * 0.86 + vec3(0.55, 0.70, 0.72) * fill * 0.22);
  float spec = pow(max(dot(n, normalize(keyDir + v)), 0.0), 56.0);
  float rim = pow(1.0 - max(dot(n, v), 0.0), 3.0);
  color += vec3(1.0, 1.0, 0.96) * spec * 0.22 + vec3(0.72, 0.86, 0.84) * rim * 0.16;
  return pow(color, vec3(1.0 / 2.2));
}
`;

export const MESH_VS = /* glsl */ `#version 300 es
layout(location = 0) in vec3 aPosition;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec4 aColor;
uniform mat4 uView;
uniform mat4 uProjection;
out vec3 vNormal;
out vec3 vViewPos;
out vec3 vColor;
void main() {
  vec4 viewPos = uView * vec4(aPosition, 1.0);
  vViewPos = viewPos.xyz;
  vNormal = mat3(uView) * aNormal;
  vColor = aColor.rgb;
  gl_Position = uProjection * viewPos;
}`;

export const SPHERE_VS = /* glsl */ `#version 300 es
layout(location = 0) in vec3 aPosition;      // unit sphere
layout(location = 1) in vec4 aSphere;        // centre xyz, radius
layout(location = 2) in vec4 aColor;
uniform mat4 uView;
uniform mat4 uProjection;
uniform float uRadiusScale;
out vec3 vNormal;
out vec3 vViewPos;
out vec3 vColor;
void main() {
  vec4 viewPos = uView * vec4(aSphere.xyz + aPosition * aSphere.w * uRadiusScale, 1.0);
  vViewPos = viewPos.xyz;
  vNormal = mat3(uView) * aPosition;
  vColor = aColor.rgb;
  gl_Position = uProjection * viewPos;
}`;

export const CYLINDER_VS = /* glsl */ `#version 300 es
layout(location = 0) in vec3 aPosition;      // unit cylinder along +z
layout(location = 1) in vec3 aStart;
layout(location = 2) in vec4 aEnd;           // end xyz, radius
layout(location = 3) in vec4 aColor;
uniform mat4 uView;
uniform mat4 uProjection;
out vec3 vNormal;
out vec3 vViewPos;
out vec3 vColor;
void main() {
  vec3 axis = aEnd.xyz - aStart;
  float len = max(length(axis), 1e-5);
  vec3 w = axis / len;
  vec3 helper = abs(w.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 u = normalize(cross(helper, w));
  vec3 v = cross(w, u);
  vec3 radial = u * aPosition.x + v * aPosition.y;
  vec4 viewPos = uView * vec4(aStart + radial * aEnd.w + axis * aPosition.z, 1.0);
  vViewPos = viewPos.xyz;
  vNormal = mat3(uView) * radial;
  vColor = aColor.rgb;
  gl_Position = uProjection * viewPos;
}`;

export const SURFACE_FS = /* glsl */ `#version 300 es
precision highp float;
in vec3 vNormal;
in vec3 vViewPos;
in vec3 vColor;
out vec4 outColor;
${LIGHTING}
void main() {
  outColor = vec4(shade(vColor, normalize(vNormal), vViewPos), 1.0);
}`;

/** Soft glowing shell used to mark the hovered / selected residue. */
export const HALO_FS = /* glsl */ `#version 300 es
precision highp float;
in vec3 vNormal;
in vec3 vViewPos;
in vec3 vColor;
out vec4 outColor;
void main() {
  vec3 n = normalize(vNormal);
  vec3 v = normalize(-vViewPos);
  float edge = pow(1.0 - abs(dot(n, v)), 1.6);
  float alpha = 0.16 + 0.74 * edge;
  outColor = vec4(vColor * alpha, alpha);
}`;

export const POST_VS = /* glsl */ `#version 300 es
out vec2 vUv;
void main() {
  // one triangle that covers the screen
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

/**
 * Screen-space finishing: contact shadows (ambient occlusion from the depth buffer), a thin dark
 * outline at depth edges, and depth fog. Output is premultiplied so the page shows through.
 */
export const POST_FS = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uColor;
uniform highp sampler2D uDepth;
uniform vec2 uTexel;          // 1 / framebuffer size
uniform float uNear;
uniform float uFar;
uniform float uPixelsPerUnit; // screen pixels covered by 1 Å at depth 1
uniform vec2 uFog;            // start, end (view-space depth)
uniform vec3 uFogColor;
uniform float uOutline;       // outline width in pixels
uniform float uAo;            // ambient occlusion strength
in vec2 vUv;
out vec4 outColor;

float viewDepth(vec2 uv) {
  float d = texture(uDepth, uv).r;
  float ndc = d * 2.0 - 1.0;
  return (2.0 * uNear * uFar) / (uFar + uNear - ndc * (uFar - uNear));
}

void main() {
  vec4 color = texture(uColor, vUv);
  float z = viewDepth(vUv);
  bool background = texture(uDepth, vUv).r >= 0.999999;

  // outline: darken where a neighbour is clearly nearer to the camera
  float nearer = 0.0;
  vec2 o = uTexel * uOutline;
  nearer = max(nearer, z - viewDepth(vUv + vec2(o.x, 0.0)));
  nearer = max(nearer, z - viewDepth(vUv - vec2(o.x, 0.0)));
  nearer = max(nearer, z - viewDepth(vUv + vec2(0.0, o.y)));
  nearer = max(nearer, z - viewDepth(vUv - vec2(0.0, o.y)));
  nearer = max(nearer, z - viewDepth(vUv + o * 0.7071));
  nearer = max(nearer, z - viewDepth(vUv - o * 0.7071));
  nearer = max(nearer, z - viewDepth(vUv + vec2(o.x, -o.y) * 0.7071));
  nearer = max(nearer, z - viewDepth(vUv + vec2(-o.x, o.y) * 0.7071));
  float edge = smoothstep(0.7, 2.0, nearer) * 0.62;

  if (!background) {
    // ambient occlusion: how much of the neighbourhood sits in front of this pixel
    const int SAMPLES = 14;
    float radiusWorld = 3.2;
    float radiusPx = clamp(radiusWorld * uPixelsPerUnit / z, 3.0, 72.0);
    float seed = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
    float occlusion = 0.0;
    for (int i = 0; i < SAMPLES; i++) {
      float f = (float(i) + 0.5) / float(SAMPLES);
      float angle = 6.2831853 * (seed + f * 5.236);
      vec2 offset = vec2(cos(angle), sin(angle)) * radiusPx * sqrt(f) * uTexel;
      float diff = z - viewDepth(vUv + offset);
      occlusion += smoothstep(0.15, 1.6, diff) * (1.0 - smoothstep(4.0, 9.0, diff));
    }
    occlusion /= float(SAMPLES);
    // a flat, tilted surface occludes half of its own samples: only count the excess
    float ao = 1.0 - uAo * clamp((occlusion - 0.32) * 1.9, 0.0, 1.0);
    color.rgb *= ao;

    float fog = smoothstep(uFog.x, uFog.y, z) * 0.62;
    color.rgb = mix(color.rgb, uFogColor * color.a, fog);
  }

  vec3 ink = vec3(0.035, 0.07, 0.06);
  color.rgb = mix(color.rgb, ink, edge);
  color.a = color.a + (1.0 - color.a) * edge;
  outColor = color;
}`;
