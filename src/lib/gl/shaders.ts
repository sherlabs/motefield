// Original shaders for the Motefield point-cloud renderer.
// Motes carry no vertex attributes: every vertex reads its home position and
// colour from float textures using gl_VertexID, through a per-picture index
// shuffle so a flock re-deals which mote goes where.

export const GRAIN_VERT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

// three homes: the one before last, the last, and the current picture
uniform sampler2D uHome0, uHome1, uHome2;
uniform sampler2D uTint0, uTint1, uTint2;
uniform uvec2 uDeal0, uDeal1, uDeal2;     // (multiplier, offset) index shuffle per home
uniform uint uIndexMask, uColumnMask, uRowShift, uStep;

uniform float uGo01, uGo12;               // progress of the two flights, 0..1
uniform vec4 uWay01, uWay12;              // x: 1 flock / 0 flow, y: seed, z: wait before cohering, w: throw speed (0 = none)

uniform mat4 uViewProj;
uniform float uClock, uLoop;               // seconds; loop length (0 = free running)
uniform float uRelief, uCamDist, uGrain, uFloorPx, uLevel, uAspectRatio;
uniform float uSwell;                    // -1..1 slow breath
uniform vec4 uShore;                       // wind line: a point on it (xy) and its normal (zw) toward the side that blows away
uniform vec3 uGust;                       // xy: where the dust goes, z: how hard
uniform vec4 uGlow[3];                    // xyz position, w strength
uniform vec3 uGlowTint;
uniform float uGlowSum;
uniform vec4 uWake[6];                    // pointer wake: xy ndc position, zw push
uniform float uLayer;                      // 0 motes, 1 haze around the lamps, 2 streaks of leaving motes
uniform vec2 uSweep;                       // x: depth of the scanning plane, y: brightness
uniform float uStreakAge, uStreaks;
uniform float uPaper, uDip;                // 0 light on black, 1 ink on paper; dip while the paper turns
uniform vec3 uHomePaper;                    // which homes were dealt for paper
uniform float uExact;                     // 1: motes show the picture's own colours, composited over each other
uniform vec3 uHomePhoto;                  // which homes are photographs (kept as they are on paper)

out vec3 vCol;
out float vA;

const float PI = 3.14159265359;
const float TAU = 6.28318530718;

uint mixbits(uint x) {
  x ^= x >> 17; x *= 0xed5ad4bbu;
  x ^= x >> 11; x *= 0xac4c1b51u;
  x ^= x >> 15; x *= 0x31848babu;
  x ^= x >> 14;
  return x;
}
float unit01(uint x) { return float(mixbits(x) >> 8) * (1.0 / 16777216.0); }
float ease(float s) { return s * s * s * (s * (s * 6.0 - 15.0) + 10.0); }

ivec2 cellOf(uvec2 deal, uint i) {
  uint s = (i * deal.x + deal.y) & uIndexMask;
  return ivec2(int(s & uColumnMask), int(s >> uRowShift));
}

// a mote dealt for the other paper shows as the ink its light would leave;
// a photograph keeps its own colours whatever the paper
vec3 inkOf(vec3 c, float slotInk, float photo) {
  return mix(c, max(1.0 - c, vec3(0.35)), abs(slotInk - uPaper) * (1.0 - photo * uExact));
}

// glowing dust: density already carries the brightness, so each mote shines
// near full, lifted toward its hue at full strength
vec3 lift(vec3 c) {
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float maxc = max(max(c.r, c.g), max(c.b, 1.0 / 255.0));
  float boost = 1.0 + 0.85 * (min(1.0 / (0.1 + 0.9 * l), 1.0 / maxc) - 1.0);
  return min(c * boost, vec3(1.0));
}

// an angular rate in rad/s, snapped to a whole number of turns per loop so
// that every motion comes back to its start when the loop does
float rate(float k) { return uLoop > 0.0 ? max(1.0, floor(k * uLoop / TAU + 0.5)) * TAU / uLoop : k; }

// a slowly turning air current; k is its rate, ph an extra phase
vec3 swirl(vec3 q, float k, float ph) {
  float t1 = uClock * rate(k) + ph;
  float t2 = uClock * rate(k * 0.7) + ph * 0.7;
  float t3 = uClock * rate(k * 0.8) + ph * 0.8;
  float t4 = uClock * rate(k * 0.6) + ph * 0.6;
  float t5 = uClock * rate(k * 0.5) + ph * 0.5;
  return 0.5 * vec3(
    sin(q.y * 2.3 + t1) + sin(q.z * 3.1 - t2 + q.x),
    sin(q.x * 2.7 - t3) + sin(q.z * 2.9 + t4 + q.y),
    sin(q.x * 3.3 + t5) + sin(q.y * 3.7 - t1));
}

// One flight from home a to home b. Returns how far the mote has settled
// (0..1) and writes its excursion off the straight path: a small arc for
// everyone, and for a splash a throw outward that slows and hangs.
float journey(float m, vec4 way, uint i, vec3 a, vec3 b, out vec3 off) {
  uint sd = uint(way.y);
  bool flock = way.x > 0.5;
  float rd = unit01(i * 2654435761u + sd);
  // flow: the near layers leave first. flock: anyone, any time.
  float delay = flock ? rd : clamp(0.5 - a.z, 0.0, 1.0) * 0.7 + rd * 0.3;
  float g = max(0.0, (m - way.z) / (1.0 - way.z));
  float spread = flock ? 0.6 : 0.9;
  float e = ease(clamp(g * (1.0 + spread) - delay * spread, 0.0, 1.0));
  float hump = sin(PI * e);
  vec3 rv = vec3(unit01(i ^ (sd * 3u + 11u)), unit01(i * 7u + sd + 5u), unit01(i * 13u + sd * 5u + 3u)) * 2.0 - 1.0;
  off = rv * hump * (flock ? 0.2 : 0.05) * (0.3 + length(b - a) * 0.5);
  float far = unit01(i * 29u + sd * 7u + 1u);
  far = 0.1 + 0.9 * far * far;                       // most motes go a little way, a few go far
  float thrown = (1.0 - exp(-m * way.w)) * (1.0 - e) * (0.72 + 0.5 * m * (2.0 - m)) * step(0.5, way.w);
  vec3 dir = normalize(vec3(a.xy * 0.9 + rv.xy * 0.85, 0.3 + 0.9 * abs(rv.z)));
  off += dir * thrown * 0.6 * far + swirl(a * 1.7 + rv * 0.25, 1.3, 0.0) * thrown * 0.1;
  return e;
}

void main() {
  bool streak = uLayer > 1.5;
  uint vid = uint(gl_VertexID);
  uint i = (streak ? vid >> 1 : vid) * uStep;
  float tail = streak ? float(vid & 1u) : 0.0;

  // ---- where the mote is between its homes ----
  ivec2 c2 = cellOf(uDeal2, i);
  vec4 H = texelFetch(uHome2, c2, 0);
  vec3 p = H.xyz;
  vec3 col = inkOf(texelFetch(uTint2, c2, 0).rgb, uHomePaper.z, uHomePhoto.z);
  float wgt = H.w;
  float air = 0.0;
  if (uGo12 < 1.0) {
    ivec2 c1 = cellOf(uDeal1, i);
    vec4 G = texelFetch(uHome1, c1, 0);
    vec3 q = G.xyz;
    vec3 cq = inkOf(texelFetch(uTint1, c1, 0).rgb, uHomePaper.y, uHomePhoto.y);
    float wq = G.w;
    if (uGo01 < 1.0) {
      ivec2 c0 = cellOf(uDeal0, i);
      vec4 F = texelFetch(uHome0, c0, 0);
      vec3 off0;
      float e0 = journey(uGo01, uWay01, i, F.xyz, q, off0);
      q = mix(F.xyz, q, e0) + off0;
      wq = mix(F.w, wq, e0);
      cq = mix(inkOf(texelFetch(uTint0, c0, 0).rgb, uHomePaper.x, uHomePhoto.x), cq, e0);
    }
    vec3 off;
    float e = journey(uGo12, uWay12, i, q, p, off);
    p = mix(q, p, e) + off;
    wgt = mix(wq, wgt, e);
    col = mix(cq, col, e);
    air = sin(PI * e);
  }
  float near = clamp(p.z + 0.5, 0.0, 1.0);

  float r1 = unit01(i * 3u + 17u), r2 = unit01(i * 5u + 29u), r3 = unit01(i * 11u + 71u), r4 = unit01(i * 17u + 113u);

  // ---- the picture breathes, shallow and slow ----
  p.xy *= 1.0 + 0.011 * uSwell;
  p.z = p.z * uRelief * (1.0 + 0.1 * uSwell) + 0.014 * uSwell;

  // the held side barely stirs
  p += swirl(p * 2.0 + r2 * 3.0, 0.2, 0.0) * 0.0035;

  // ---- past the wind line the dust blows away ----
  // Each mote lives its own short cycle: it sits at home, lets go, thins out
  // on the wind and forms again. The line is ragged and wavers, and the reach
  // grows from nothing at the line so the picture frays rather than tears.
  float r5 = unit01(i * 23u + 191u);
  vec2 rel = p.xy - uShore.xy;
  float along = dot(rel, vec2(-uShore.w, uShore.z));
  float ragged = 0.11 * sin(along * 3.1 + uClock * rate(0.13)) + 0.06 * sin(along * 7.7 - uClock * rate(0.09) + 1.7) + (r5 - 0.5) * 0.34;
  float away = smoothstep(0.0, 1.15, dot(rel, uShore.zw) + ragged) * step(0.004, uGust.z);
  float alive = 1.0, gone = 0.0, home = 1.0;
  if (away > 0.0) {
    float per = 3.5 + 5.5 * r1;
    if (uLoop > 0.0) per = uLoop / max(1.0, floor(uLoop / per + 0.5));
    float ph = fract((uClock - tail * uStreakAge) / per + r2);
    float hold = mix(0.82, 0.06, away);              // near the line it mostly stays; far out it is nearly always leaving
    gone = max(0.0, (ph - hold) / (1.0 - hold));
    float tr = gone * sqrt(gone);
    float reach = uGust.z * 1.8 * away * (0.55 + 0.9 * r3);
    vec3 tb = swirl(p * 1.7 + vec3(r4 * 7.0, r1 * 5.0, r3 * 3.0), 0.3, ph * 2.5);
    p.xy += uGust.xy * reach * tr;
    p += tb * tr * reach * 0.3;
    p.z += (r4 - 0.5) * tr * reach * 0.6;
    alive = mix(1.0, smoothstep(0.0, 0.07, ph) * (1.0 - smoothstep(0.3, 1.0, gone)), smoothstep(0.0, 0.3, away));
    // the motes still at home stand in for the ones away, so the fading side keeps its glow and only thins far out
    home = (1.0 + 0.6 * away * (1.0 - away) * (1.0 - min(1.0, gone * 6.0))) * (1.0 - 0.6 * away * away);
  }

  // ---- the lamps: every mote takes what reaches it ----
  float lit = 0.0;
  for (int k = 0; k < 3; k++) {
    vec3 d = p - uGlow[k].xyz;
    lit += uGlow[k].w / (1.0 + dot(d, d) * 3.2);
  }

  vec4 cp = uViewProj * vec4(p, 1.0);
  vec2 sp = cp.xy / max(cp.w, 0.05);
  vec2 asp = vec2(uAspectRatio, 1.0);

  // ---- the pointer: a hand through smoke, each stroke keeps pushing a moment ----
  vec2 push = vec2(0.0);
  for (int b = 0; b < 6; b++) {
    vec2 d = (sp - uWake[b].xy) * asp;
    vec2 w = uWake[b].zw;
    push += (w + vec2(-w.y, w.x) * (r2 - 0.5) * 1.3) * exp(-dot(d, d) * 22.0) * (0.45 + 1.1 * r1);
  }
  cp.xy += push / asp * cp.w;

  // ---- the scan: only the motes at this depth, as it passes ----
  float band = uSweep.y * exp(-pow((p.z - uSweep.x) / 0.02, 2.0));

  // a photograph in true colour must tile without pinholes: its motes are a little larger and steadier
  float photoHome = max(uHomePhoto.z, max(uHomePhoto.y * step(uGo12, 0.999), uHomePhoto.x * step(uGo01, 0.999)));
  float sz = uGrain * mix(0.6 + 0.9 * r3, 0.8 + 0.5 * r3, uExact) * (1.0 + 0.3 * photoHome * uExact) * uCamDist / max(cp.w, 0.05) * (1.0 - 0.45 * gone) * (1.0 + 0.5 * min(1.0, lit) + 0.7 * band);
  float fade = min(1.0, sz / uFloorPx);
  float base = uLevel * fade * fade * alive * uDip * home * (0.85 + 0.15 * wgt);

  vec3 c;
  float alpha = 1.0;
  if (uExact > 0.5) {
    // true colour: the mote is a fleck of the picture itself, laid over what is beneath
    c = col;
    alpha = 0.92 * fade * alive * uDip * min(1.0, home);
    if (uLayer < 0.5 || streak) {
      c += mix(col, uGlowTint, 0.7) * lit * 1.2 + mix(col, vec3(1.0), 0.65) * band * 1.6;
      if (streak) alpha *= step(0.002, gone) * (1.0 - tail) * 0.7;
    } else {
      sz *= 7.0;                                  // haze: added, not laid over
      c = (uPaper > 0.5 ? clamp(1.0 - uGlowTint, 0.0, 1.0) * 0.5 : uGlowTint) * base * lit * 0.1;
      alpha = 0.0;
    }
    if (uPaper > 0.5) c = clamp(c, 0.0, 1.0);
  } else if (uPaper < 0.5) {
    col = lift(col);
    // light on black: col is the light a mote gives
    c = col * base * mix(0.55, 1.15, near) * (1.0 - 0.3 * air);
    if (uLayer < 0.5 || streak) {
      c = c * (1.0 - 0.5 * uGlowSum) + mix(col, uGlowTint, 0.75) * base * lit * 2.7 + mix(col, vec3(1.0), 0.65) * base * band * 2.4;
    } else {
      // haze: a few motes drawn wide and faint so the light hangs in the dust
      sz *= 7.0;
      c = uGlowTint * base * lit * 0.1;
    }
  } else {
    // ink on paper: col is what a mote takes away. A lamp bleaches the ink near it.
    vec3 tint = clamp(1.0 - uGlowTint, 0.0, 1.0);
    float lt = min(1.0, lit);
    if (uLayer < 0.5 || streak) {
      c = mix(mix(col, tint, 0.55 * lt), vec3(0.85), 0.6 * band) * base * 1.45 * mix(0.6, 1.15, near) * (1.0 - 0.3 * air)
        * ((1.0 - 0.3 * uGlowSum) * (1.0 - 0.82 * lt) + 2.2 * band);
    } else {
      sz *= 7.0;
      c = tint * base * lit * 0.05;
    }
  }
  if (uExact < 0.5) {
    if (streak) c *= step(0.002, gone) * (1.0 - tail) * 0.9;       // only what is leaving; bright at the mote, gone at the tail
    else if (uLayer < 0.5) c *= 1.0 - 0.5 * uStreaks * min(1.0, gone * 5.0);
  }

  gl_PointSize = max(sz, uFloorPx);
  gl_Position = cp;
  vCol = c;
  vA = alpha;
}
`;

export const GRAIN_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec3 vCol;
in float vA;
uniform float uLayer, uPaper, uExact;
out vec4 outColor;
void main() {
  float a = uLayer > 1.5 ? 1.0 : smoothstep(1.0, mix(0.3, 0.55, uExact), length(gl_PointCoord * 2.0 - 1.0));
  if (uExact > 0.5) {
    if (uLayer > 0.5 && uLayer < 1.5) {                                              // haze adds (or inks)
      outColor = uPaper > 0.5 ? vec4(1.0 - min(vCol * a, vec3(1.0)), 1.0) : vec4(vCol * a, 0.0);
      return;
    }
    float cov = a * vA;
    // over: premultiplied on black; on paper the mote covers the paper with its own colour
    outColor = uPaper > 0.5 ? vec4(mix(vec3(1.0), vCol, cov), 1.0) : vec4(vCol * cov, cov);
    return;
  }
  // on black every mote adds its light; on paper it multiplies what is under it
  outColor = uPaper > 0.5 ? vec4(1.0 - min(vCol * a, vec3(1.0)), 1.0) : vec4(vCol * a, a);
}
`;

export const QUAD_VERT = /* glsl */ `#version 300 es
out vec2 vN;
void main() {
  vec2 q = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);
  vN = q;
  gl_Position = vec4(q, 0.0, 1.0);
}
`;

/** The soft core of each lamp, drawn under the motes. */
export const CORE_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 vN;
uniform vec4 uBloom[3];       // xy ndc, z strength, w radius
uniform vec3 uGlowTint;
uniform float uAspectRatio, uPaper;
out vec4 outColor;
void main() {
  float g = 0.0;
  for (int k = 0; k < 3; k++) {
    vec2 d = (vN - uBloom[k].xy) * vec2(uAspectRatio, 1.0);
    float q = dot(d, d) / (uBloom[k].w * uBloom[k].w);
    g += uBloom[k].z * (0.55 * exp(-q * 2.5) + 0.16 * exp(-sqrt(q) * 1.5));
  }
  // a mote of noise so the falloff does not band
  float n = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
  vec3 tint = clamp(1.0 - uGlowTint, 0.0, 1.0);
  outColor = uPaper > 0.5 ? vec4(1.0 - tint * min(1.0, g * 0.6) + n / 255.0, 1.0) : vec4(uGlowTint * g + n / 255.0, 1.0);
}
`;
