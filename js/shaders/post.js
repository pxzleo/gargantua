// Post-processing: dual-filter HDR bloom + cinematic composite
// (chromatic aberration, ACES fitted tonemap, vignette, film grain, dithering).

export const BLOOM_DOWN_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D tSrc;
uniform vec2 uTexel;        // texel size of the source
uniform int uPrefilter;
uniform float uThreshold;
uniform float uKnee;
uniform float uInScale;

vec3 s(vec2 o) { return texture(tSrc, vUv + o * uTexel).rgb * uInScale; }
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

void main() {
  vec3 a = s(vec2(-2, 2)), b = s(vec2(0, 2)), c = s(vec2(2, 2));
  vec3 d = s(vec2(-2, 0)), e = s(vec2(0, 0)), f = s(vec2(2, 0));
  vec3 g = s(vec2(-2, -2)), h = s(vec2(0, -2)), i = s(vec2(2, -2));
  vec3 j = s(vec2(-1, 1)), k = s(vec2(1, 1)), l = s(vec2(-1, -1)), m = s(vec2(1, -1));
  vec3 col;
  if (uPrefilter == 1) {
    // Karis average on the first mip to suppress fireflies (single bright stars)
    vec3 g0 = (a + b + d + e) * 0.25, g1 = (b + c + e + f) * 0.25;
    vec3 g2 = (d + e + g + h) * 0.25, g3 = (e + f + h + i) * 0.25, g4 = (j + k + l + m) * 0.25;
    float w0 = 1.0 / (1.0 + luma(g0)), w1 = 1.0 / (1.0 + luma(g1)), w2 = 1.0 / (1.0 + luma(g2));
    float w3 = 1.0 / (1.0 + luma(g3)), w4 = 1.0 / (1.0 + luma(g4));
    col = (g0 * w0 * 0.125 + g1 * w1 * 0.125 + g2 * w2 * 0.125 + g3 * w3 * 0.125 + g4 * w4 * 0.5)
        / (w0 * 0.125 + w1 * 0.125 + w2 * 0.125 + w3 * 0.125 + w4 * 0.5);
    float br = max(col.r, max(col.g, col.b));
    float rq = clamp(br - uThreshold + uKnee, 0.0, 2.0 * uKnee);
    rq = rq * rq / (4.0 * uKnee + 1e-4);
    col *= max(rq, br - uThreshold) / max(br, 1e-4);
  } else {
    col = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
  }
  fragColor = vec4(max(col, 0.0), 1.0);
}
`;

export const BLOOM_UP_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D tLow;     // previous (smaller) upsample result
uniform sampler2D tCur;     // downsample at this level
uniform vec2 uTexel;        // texel of tLow
uniform float uRadius;
void main() {
  vec2 t = uTexel * uRadius;
  vec3 c = texture(tLow, vUv).rgb * 4.0;
  c += (texture(tLow, vUv + vec2(-t.x, 0)).rgb + texture(tLow, vUv + vec2(t.x, 0)).rgb
      + texture(tLow, vUv + vec2(0, -t.y)).rgb + texture(tLow, vUv + vec2(0, t.y)).rgb) * 2.0;
  c += texture(tLow, vUv + vec2(-t.x, -t.y)).rgb + texture(tLow, vUv + vec2(t.x, -t.y)).rgb
     + texture(tLow, vUv + vec2(-t.x, t.y)).rgb + texture(tLow, vUv + vec2(t.x, t.y)).rgb;
  fragColor = vec4(texture(tCur, vUv).rgb + c / 16.0, 1.0);
}
`;

export const COMPOSITE_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D tHdr;
uniform sampler2D tBloom;
uniform sampler2D tLum;
uniform vec2 uRes;
uniform float uAutoKey, uAutoAmt;
uniform float uExposure, uBloom, uVignette, uGrain, uAberr, uTime, uInScale, uBloomNorm;
uniform int uMode;          // 0 beauty, 1 passthrough (debug), 2 bloom only

const mat3 ACESIn = mat3(vec3(0.59719, 0.07600, 0.02840), vec3(0.35458, 0.90834, 0.13383), vec3(0.04823, 0.01566, 0.83777));
const mat3 ACESOut = mat3(vec3(1.60475, -0.10208, -0.00327), vec3(-0.53108, 1.10813, -0.07276), vec3(-0.07367, -0.00605, 1.07602));
vec3 rrtOdt(vec3 v) {
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}
vec3 aces(vec3 c) { return clamp(ACESOut * rrtOdt(ACESIn * c), 0.0, 1.0); }
vec3 toSRGB(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(max(c, 0.0), vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  vec2 uv = vUv;
  if (uMode == 1) { fragColor = vec4(clamp(texture(tHdr, uv).rgb, 0.0, 1.0), 1.0); return; }

  vec2 dc = uv - 0.5;
  float aspect = uRes.x / uRes.y;
  float rr = length(dc * vec2(aspect, 1.0));
  vec2 off = dc * uAberr * 0.006 * (0.35 + 2.2 * rr * rr);
  vec3 hdr = vec3(texture(tHdr, uv - off).r, texture(tHdr, uv).g, texture(tHdr, uv + off).b) * uInScale;
  vec3 bl = vec3(texture(tBloom, uv - off * 1.6).r, texture(tBloom, uv).g, texture(tBloom, uv + off * 1.6).b) * uBloomNorm;

  vec3 c = uMode == 2 ? bl : hdr + bl * uBloom;
  float avg = max(texture(tLum, vec2(0.5)).r, 1e-4);
  c *= uExposure * mix(1.0, clamp(uAutoKey / avg, 0.5, 2.2), uAutoAmt);
  c = aces(c);

  float vig = smoothstep(1.05, 0.18, rr);
  c *= mix(1.0, vig, uVignette);

  c = toSRGB(c);
  // luminance-aware film grain (stronger in mid-tones), animated
  float t = fract(uTime * 0.37) * 911.0;
  float n = hash12(gl_FragCoord.xy + t) + hash12(gl_FragCoord.xy * 1.37 - t) - 1.0;
  float lum = dot(c, vec3(0.299, 0.587, 0.114));
  c += n * uGrain * 0.075 * (0.35 + lum * (1.0 - lum) * 2.6);
  // 8-bit dither
  c += (hash12(gl_FragCoord.xy + 17.0) - 0.5) / 255.0;
  fragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}
`;

// 1x1 centre-weighted average luminance (metering) of the HDR frame
export const LUM_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D tSrc;
uniform float uInScale;
void main() {
  float s = 0.0, w = 0.0;
  for (int j = 0; j < 14; j++) {
    for (int i = 0; i < 24; i++) {
      vec2 uv = (vec2(float(i), float(j)) + 0.5) / vec2(24.0, 14.0);
      float l = dot(texture(tSrc, uv).rgb * uInScale, vec3(0.2126, 0.7152, 0.0722));
      vec2 d = uv - 0.5;
      float wt = exp(-dot(d, d) * 5.0);
      s += min(l, 12.0) * wt;
      w += wt;
    }
  }
  fragColor = vec4(vec3(s / w), 1.0);
}
`;

// temporal adaptation (ping-pong 1x1)
export const ADAPT_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D tPrev;
uniform sampler2D tCur;
uniform float uRate;
void main() {
  float p = texture(tPrev, vec2(0.5)).r;
  float c = texture(tCur, vec2(0.5)).r;
  float v = (p <= 0.0 || p != p) ? c : mix(p, c, uRate);
  fragColor = vec4(vec3(v), 1.0);
}
`;

// Temporal accumulation: progressive refinement when still, clamped TAA blend in motion.
export const RESOLVE_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D tCur;
uniform sampler2D tPrev;
uniform vec2 uTexel;
uniform float uAlpha;
uniform float uClamp;      // 1 = neighbourhood clamp history (motion), 0 = pure accumulation
void main() {
  vec3 c = texture(tCur, vUv).rgb;
  if (uAlpha >= 0.999) { fragColor = vec4(c, 1.0); return; }
  vec3 h = texture(tPrev, vUv).rgb;
  if (uClamp > 0.5) {
    vec3 mn = c, mx = c;
    for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
      vec3 s = texture(tCur, vUv + vec2(float(i), float(j)) * uTexel).rgb;
      mn = min(mn, s); mx = max(mx, s);
    }
    h = clamp(h, mn, mx);
  }
  fragColor = vec4(mix(h, c, uAlpha), 1.0);
}
`;
