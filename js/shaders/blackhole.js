// Full-screen Schwarzschild null-geodesic raytracer with a volumetric,
// turbulent, relativistically shifted accretion disk.
//
// Units: G = c = M = 1  ->  event horizon r_s = 2, photon sphere r = 3, ISCO r = 6.
//
// Geodesics: in Schwarzschild spacetime the spatial photon orbit obeys
//   d^2u/dphi^2 + u = 3 u^2         (u = 1/r)
// which is reproduced exactly by integrating the Cartesian ODE
//   x'' = -3/2 * h^2 * x / |x|^5,   h = |x  x'|  (conserved)
// We integrate it with an adaptive kick-drift-kick (symplectic leapfrog)
// scheme and march the emissive/absorbing disk volume along the bent ray.

import { HASH_NOISE } from './common.js';

export function blackholeFrag(defs) {
  return /* glsl */ `
precision highp float;
precision highp int;

#define MAX_STEPS ${defs.maxSteps}
#define DISK_OCT ${defs.octaves}
#define VOL_Q ${defs.volQ.toFixed(3)}
#define FLOW_PERIOD 48.0
#define NA 14.0

in vec2 vUv;
out vec4 fragColor;

uniform vec2  uRes;
uniform vec3  uCamPos;
uniform mat3  uCamBasis;      // columns: right, up, forward
uniform float uTanHalfFov;
uniform float uAspect;
uniform float uPixAngle;
uniform float uTime;          // disk dynamical time (M)
uniform float uSeed;          // per-frame jitter seed
uniform vec2  uJitter;        // sub-pixel camera jitter (pixels)
uniform int   uDebug;
uniform float uStepScale;

uniform float uRin, uRout, uThick, uDensity, uTurb, uNoiseScale;
uniform float uTempK, uDoppler, uRedshift, uDiskGain, uAbsorb;
uniform float uStarDensity, uStarGain, uGalaxyGain;
uniform float uOutScale;      // HDR storage scale (1 for float targets)

${HASH_NOISE}

// ---------------------------------------------------------------- disk ----
float diskHalfH(float r) { return uThick * r + 0.06; }

float fbmDisk(vec3 p, float per) {
  float s = 0.0, a = 0.5, n = 0.0;
  for (int i = 0; i < DISK_OCT; i++) {
    s += a * vnoiseP(p, per);
    n += a;
    p = p * 2.0 + vec3(0.0, 3.71, 1.93);
    per *= 2.0;
    a *= 0.52;
  }
  return s / n;
}

// Returns extinction density. Writes the local emitted temperature (K) and the
// emissivity weight (hot mid-plane layer) used for the emission term.
float diskDensity(vec3 p, float r, out float temp, out float emisW) {
  temp = 0.0; emisW = 0.0;
  if (r < uRin * 0.72 || r > uRout) return 0.0;
  float H = diskHalfH(r);
  float yn = p.y / H;
  if (abs(yn) > 3.2) return 0.0;

  float inner = smoothstep(uRin * 0.72, uRin * 1.06, r);
  float outer = 1.0 - smoothstep(uRout * 0.35, uRout, r);
  float radial = inner * outer;

  // Keplerian, differentially rotating flow; two phase-shifted samples
  // are cross-faded so the shear never winds up without bound.
  float phi = atan(p.z, p.x);
  float om  = pow(r, -1.5);
  float tt  = uTime / FLOW_PERIOD;
  float f1 = fract(tt), f2 = fract(tt + 0.5);
  float c1 = floor(tt), c2 = floor(tt + 0.5);
  float w1 = 1.0 - abs(2.0 * f1 - 1.0);

  float lr  = log(r) * 7.5 * uNoiseScale;
  float per = floor(NA * uNoiseScale + 0.5);
  float ys  = yn * 1.1;

  vec3 q1 = vec3((phi - om * f1 * FLOW_PERIOD) / TAU * per, lr, ys + c1 * 7.31);
  vec3 q2 = vec3((phi - om * f2 * FLOW_PERIOD) / TAU * per, lr + 0.5, ys + c2 * 7.31 + 3.7);
  // low-frequency domain warp -> billowing, cauliflower-like cloud shapes
  float wa = vnoiseP(q1 * vec3(0.5, 0.5, 0.6), per * 0.5);
  float wb = vnoiseP(q2 * vec3(0.5, 0.5, 0.6) + 5.3, per * 0.5);
  q1.yz += (wa - 0.5) * vec2(1.6, 1.3) * uTurb;
  q2.yz += (wb - 0.5) * vec2(1.6, 1.3) * uTurb;
  float n = mix(fbmDisk(q2, per), fbmDisk(q1, per), w1);
  float nl = mix(wb, wa, w1);

  // puffy vertical structure: the local scale height follows the large-scale noise
  float hs = mix(0.75, 0.35 + 1.25 * nl, uTurb);
  float vertical = exp(-yn * yn / (hs * hs));
  float ridge = 1.0 - abs(2.0 * fbmDisk(q1 * vec3(1.0, 1.7, 1.0) + 11.0, per) - 1.0);   // filaments
  float cloud = smoothstep(0.30, 0.74, n) * (0.55 + 0.7 * ridge * ridge);
  float dens = radial * vertical * mix(1.0, cloud * 2.4, uTurb);
  dens *= pow(uRin / max(r, 1.0), 1.5);

  float x = r / uRin;
  float prof = x >= 1.0 ? pow(x, -0.75) : pow(x, 3.0);
  temp = uTempK * prof * (0.8 + 0.45 * n);
  // emission is concentrated in the hot mid-plane; puffy cloud tops mostly absorb
  emisW = exp(-yn * yn * 0.25) * (0.5 + 0.75 * cloud);
  return dens * uDensity;
}

// ----------------------------------------------------------------- sky ----
vec3 sky(vec3 d) {
  vec3 c = vec3(0.0);
  vec3 gp = normalize(vec3(0.32, 0.88, 0.36));       // galactic pole
  vec3 gc = normalize(cross(gp, vec3(0.0, 0.0, 1.0))); // galactic centre
  float lat = dot(d, gp);
  float lonc = dot(d, gc);
  float n1 = fbm3(d * 3.5);
  float n2 = fbm3(d * 9.0 + n1 * 1.5);
  float band = exp(-lat * lat * 16.0);
  float bulge = exp(-(lat * lat * 9.0 + (1.0 - lonc) * 2.6));
  float dust = smoothstep(0.42, 0.72, n2) * exp(-lat * lat * 70.0);
  vec3 mw = vec3(0.55, 0.62, 0.85) * band * (0.35 + 0.9 * n1 * n1)
          + vec3(1.0, 0.78, 0.52) * bulge * (0.9 + 0.6 * n2);
  mw *= 1.0 - 0.8 * dust;
  c += mw * uGalaxyGain * 0.11;
  float neb = pow(fbm3(d * 2.2 + 7.0), 3.0);
  c += (vec3(0.42, 0.14, 0.38) * neb + vec3(0.1, 0.2, 0.42) * pow(n1, 4.0)) * 0.05 * uGalaxyGain;

  float sig = max(uPixAngle * 0.6, 0.0003);
  for (int L = 0; L < 3; L++) {
    float fl = float(L);
    float S = (L == 0 ? 42.0 : (L == 1 ? 105.0 : 230.0)) * uStarDensity;
    vec3 pp = d * S;
    vec3 id = floor(pp);
    vec3 f = pp - id;
    vec3 h = hash33(id + fl * 31.7);
    float prob = (L == 0 ? 0.20 : (L == 1 ? 0.075 : 0.035)) * (1.0 + 2.5 * band);
    if (hash13(id * 1.17 + fl * 7.0) < prob) {
      vec3 dd = f - (0.2 + 0.6 * h);
      dd -= d * dot(dd, d);                          // tangent-plane distance
      float ang = length(dd) / S;
      float br = (pow(h.y, 14.0) * 18.0 + 0.3 * h.y * h.y + 0.03) * (L == 0 ? 1.0 : 0.45);
      float tK = mix(2800.0, 14000.0, pow(h.z, 1.6));
      float k = (0.00045 * 0.00045) / (sig * sig);   // keep stars energy-stable vs resolution
      c += blackbody(tK) * br * exp(-ang * ang / (sig * sig)) * min(k * 4.0, 1.0) * uStarGain;
    }
  }
  return c;
}

// ---------------------------------------------------------------- main ----
vec3 accel(vec3 p, float h2) {
  float r2 = dot(p, p);
  return -1.5 * h2 * p / (r2 * r2 * sqrt(r2));
}

void main() {
  vec2 fc = gl_FragCoord.xy;
  vec2 ndc = (fc + uJitter) / uRes * 2.0 - 1.0;
  vec3 rd = normalize(uCamBasis * vec3(ndc.x * uTanHalfFov * uAspect, ndc.y * uTanHalfFov, 1.0));

  vec3 p = uCamPos;
  float rC = length(p);

  // Convert the static observer's local direction into the geodesic's
  // coordinate direction so that the impact parameter b is exact.
  vec3 rhat = p / rC;
  float cosT = dot(rd, rhat);
  vec3 tang = rd - rhat * cosT;
  float st = length(tang);
  tang = st > 1e-6 ? tang / st : normalize(cross(rhat, vec3(0.1, 1.0, 0.0)));
  float lapseC = sqrt(1.0 - 2.0 / rC);
  float bImp = rC * st / lapseC;
  float sc = clamp(bImp / sqrt(rC * rC + 2.0 * bImp * bImp / rC), 0.0, 1.0);
  vec3 v = rhat * sqrt(1.0 - sc * sc) * sign(cosT) + tang * sc;

  vec3 L = cross(p, v);
  float h2 = dot(L, L);
  vec3 a = accel(p, h2);

  float jit = hash12(fc + uSeed * 17.31);
  bool diskOn = uDebug != 7;

  vec3 col = vec3(0.0);
  float trans = 1.0;
  bool captured = false;
  int steps = 0;
  int crossings = 0;
  float gSum = 0.0, wSum = 0.0, tSum = 0.0;
  float rEsc = max(rC * 1.25, uRout * 2.2);

  for (int i = 0; i < MAX_STEPS; i++) {
    float r = length(p);
    // exact: a photon inside the photon sphere (r < 3M) moving inward can never turn around
    if (r < 2.02 || (r < 2.97 && dot(p, v) < 0.0)) { captured = true; break; }
    if (r > rEsc && dot(p, v) > 0.0) break;
    if (trans < 0.003) break;
    steps = i;

    // adaptive step length (in space), refined near the photon sphere & horizon
    float hd = uStepScale * clamp(0.15 * (r - 2.0), 0.03, 7.0);

    bool nearDisk = diskOn && r > uRin * 0.65 && r < uRout * 1.08;
    if (nearDisk) {
      float H = diskHalfH(r);
      float vlen = length(v);
      float vy = abs(v.y) / vlen;
      // vertical structure sets the step for steep rays, horizontal structure for grazing ones
      float vs = min(max(0.022, H * 0.42) / max(vy, 0.12), 0.05 * r + 0.1) / VOL_Q;
      float dy = abs(p.y) - H * 3.2;
      if (dy < 0.0) {
        hd = min(hd, vs);
      } else if (p.y * v.y < 0.0) {
        hd = min(hd, max(dy / max(vy, 1e-3), vs));
      }
    }

    float hpar = hd / length(v);
    vec3 pOld = p;
    v += 0.5 * hpar * a;
    p += hpar * v;
    a = accel(p, h2);
    v += 0.5 * hpar * a;

    float rn = length(p);
    if (pOld.y * p.y < 0.0 && rn > uRin * 0.7 && rn < uRout) crossings++;

    if (nearDisk) {
      vec3 sp = mix(pOld, p, jit);
      float sr = length(sp);
      float temp, emisW;
      float dens = diskDensity(sp, sr, temp, emisW);
      if (dens > 1e-4 && sr > 2.05) {
        float ds = length(p - pOld);
        vec3 dir = (p - pOld) / ds;
        // orbital velocity seen by a local static observer
        float beta = min(inversesqrt(max(sr - 2.0, 0.05)), 0.82);
        if (sr < uRin) beta = min(beta, inversesqrt(uRin - 2.0) * (1.0 + 0.25 * (uRin - sr) / uRin));
        vec3 vdir = normalize(vec3(-sp.z, 0.0, sp.x));
        float gam = inversesqrt(1.0 - beta * beta);
        float dop = 1.0 / (gam * (1.0 + beta * dot(vdir, dir)));
        float grav = sqrt(max(1.0 - 2.0 / sr, 1e-3)) / lapseC;
        float g = mix(1.0, dop, uDoppler) * mix(1.0, grav, uRedshift);

        float tObs = temp * g;
        float I = uDiskGain * emisW * pow(temp / uTempK, 3.6) * pow(g, 3.6);
        vec3 emis = blackbody(tObs) * I;

        float sigma = dens;
        float coolness = 1.0 - clamp(temp / uTempK, 0.0, 1.0);
        float kappa = sigma * uAbsorb * (0.85 + 1.1 * coolness * coolness);
        float att = exp(-kappa * ds);
        // emission-absorption integral over the segment
        float k = max(kappa, 1e-4);
        col += trans * emis * sigma * (1.0 - att) / k;
        float wgt = trans * sigma * ds;
        gSum += g * wgt; tSum += tObs * wgt; wSum += wgt;
        trans *= att;
      }
    }
  }

  float rF = length(p);
  if (!captured && steps >= MAX_STEPS - 1 && rF < 4.0) captured = true;
  vec3 dirOut = normalize(v);
  vec3 skyCol = captured ? vec3(0.0) : sky(dirOut);

  vec3 outc;
  if (uDebug == 0 || uDebug == 9) {
    outc = (col + trans * skyCol) * uOutScale;
  } else if (uDebug == 1) {
    outc = col * uOutScale;
  } else if (uDebug == 2) {
    if (wSum > 1e-4) {
      float g = gSum / wSum;
      float x = clamp((g - 1.0) * 1.4, -1.0, 1.0);
      outc = x > 0.0 ? mix(vec3(0.9), vec3(0.15, 0.4, 1.0), x) : mix(vec3(0.9), vec3(1.0, 0.18, 0.08), -x);
      outc *= 0.35 + 0.65 * (1.0 - trans);
    } else outc = captured ? vec3(0.0) : vec3(0.06);
  } else if (uDebug == 3) {
    outc = turbo(float(steps) / float(MAX_STEPS));
  } else if (uDebug == 4) {
    outc = captured ? vec3(0.0) : dirOut * 0.5 + 0.5;
  } else if (uDebug == 5) {
    float c = float(crossings);
    outc = captured && crossings == 0 ? vec3(0.0) : turbo(c / 5.0) * (crossings == 0 ? 0.25 : 1.0);
  } else if (uDebug == 6) {
    float op = 1.0 - trans;
    outc = wSum > 1e-4 ? turbo(clamp(tSum / wSum / (uTempK * 1.8), 0.0, 1.0)) * (0.25 + 0.75 * op) : (captured ? vec3(0.0) : vec3(0.05));
  } else if (uDebug == 7) {
    outc = skyCol * uOutScale;
  } else {
    float bc = 5.19615242;
    float rel = bImp / bc;
    outc = turbo(clamp((rel - 0.6) / 1.4, 0.0, 1.0));
    outc *= 1.0 - 0.85 * exp(-pow((rel - 1.0) * 60.0, 2.0));
    if (captured) outc *= 0.35;
  }
  fragColor = vec4(outc, 1.0);
}
`;
}
