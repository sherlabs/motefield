import type { DepthMap } from "./types";

export interface DemoPicture {
  name: string;
  canvas: HTMLCanvasElement;
  /** analytic depth, so demos work without the neural model */
  depth: DepthMap;
}

const SIDE = 768;

/** r,g,b in 0..1 and near in 0..1 for the pixel at (x, y) in -1..1 (y up). */
type Pix = (x: number, y: number, out: number[]) => void;

function hash2(x: number, y: number): number {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function vnoise(x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash2(xi, yi);
  const b = hash2(xi + 1, yi);
  const c = hash2(xi, yi + 1);
  const d = hash2(xi + 1, yi + 1);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

function fbm(x: number, y: number, octaves = 4): number {
  let v = 0;
  let amp = 0.5;
  for (let o = 0; o < octaves; o++) {
    v += amp * vnoise(x, y);
    x *= 2.03;
    y *= 2.03;
    amp *= 0.5;
  }
  return v;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const smooth = (a: number, b: number, v: number) => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/** a rare speck of dust in the black, as on an old plate */
function speck(px: number, py: number, out: number[], level = 0.6) {
  const s = hash2(px * 7 + 2, py * 13 + 9) > 0.9997 ? level : 0;
  out[0] = out[1] = out[2] = s;
  out[3] = s ? 0.05 : 0.02;
}

function paint(name: string, fn: Pix): DemoPicture {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = SIDE;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(SIDE, SIDE);
  const depth = new Float32Array(SIDE * SIDE);
  const out = [0, 0, 0, 0];
  for (let py = 0; py < SIDE; py++) {
    const y = 1 - ((py + 0.5) / SIDE) * 2;
    for (let px = 0; px < SIDE; px++) {
      const x = ((px + 0.5) / SIDE) * 2 - 1;
      fn(x, y, out);
      // keep pixel coordinates available to the speck hash through closure-free args
      const o = (py * SIDE + px) * 4;
      img.data[o] = 255 * clamp01(out[0]);
      img.data[o + 1] = 255 * clamp01(out[1]);
      img.data[o + 2] = 255 * clamp01(out[2]);
      img.data[o + 3] = 255;
      depth[py * SIDE + px] = clamp01(out[3]);
    }
  }
  ctx.putImageData(img, 0, 0);
  return { name, canvas, depth: { w: SIDE, h: SIDE, data: depth } };
}

const toPx = (v: number) => Math.round(((v + 1) / 2) * SIDE);

/**
 * Four procedurally drawn pictures, bright shapes on black:
 * a comet, a cratered moon, a turning eddy, a dotted lattice sphere.
 */
export function makeDemoPictures(): DemoPicture[] {
  // (a) COMET: a bright head with a long curved tail of dust, a few stars
  const comet = paint("Comet", (x, y, out) => {
    const hx = 0.28;
    const hy = 0.22;
    const dx = x - hx;
    const dy = y - hy;
    const r = Math.hypot(dx, dy);
    // the tail curves down-left from the head; distance to its spine
    let best = 1;
    for (let i = 0; i <= 40; i++) {
      const t = i / 40;
      const sx = hx - 1.25 * t;
      const sy = hy - 0.55 * t * t;
      const d = Math.hypot(x - sx, y - sy) / (0.045 + 0.26 * t);
      if (d < best) best = d;
    }
    const tail = (1 - smooth(0.55, 1, best)) * (0.9 + 0.6 * fbm(9 * x, 9 * y, 3)) * 0.8;
    const halo = Math.exp(-r * r * 60);
    const core = smooth(0.09, 0.04, r);
    const c = Math.min(1, core + 0.9 * halo + tail);
    if (c < 0.02) {
      speck(toPx(x), toPx(y), out, 0.9);
      return;
    }
    out[0] = c * (0.92 + 0.08 * core);
    out[1] = c * (0.95 - 0.1 * tail);
    out[2] = c * (1 - 0.35 * tail);
    out[3] = 0.25 + 0.7 * core + 0.4 * halo + 0.15 * tail * (1 - best);
  });

  // (b) MOON: a sphere lit from the upper left, seas and craters
  const craters = [
    [-0.18, 0.22, 0.17],
    [0.25, -0.1, 0.12],
    [0.05, 0.42, 0.08],
    [-0.35, -0.25, 0.1],
    [0.3, 0.3, 0.06],
    [-0.05, -0.4, 0.09],
    [0.42, 0.08, 0.05],
  ];
  const moon = paint("Moon", (x, y, out) => {
    const R = 0.64;
    const r = Math.hypot(x, y) / R;
    if (r >= 1) {
      speck(toPx(x), toPx(y), out, 0.9);
      const halo = 0.09 * Math.exp(-7 * (r - 1));
      out[0] += 0.9 * halo;
      out[1] += 0.95 * halo;
      out[2] += halo;
      return;
    }
    const z = Math.sqrt(1 - r * r);
    const nx = x / R;
    const ny = y / R;
    const lit = Math.max(0, -0.55 * nx + 0.45 * ny + 0.7 * z);
    const seas = fbm(2.4 * nx + 1.5 * fbm(3 * nx + 5, 3 * ny, 3), 2.4 * ny + 3, 4);
    const fine = fbm(9 * nx + 20, 9 * ny + 7, 3);
    let albedo = (0.55 + 0.8 * seas) * (0.75 + 0.5 * fine);
    let relief = 0;
    for (const [cx, cy, cr] of craters) {
      const d = Math.hypot(nx - cx, ny - cy) / cr;
      if (d < 1.25) {
        const rim = smooth(0.8, 1.0, d) * (1 - smooth(1.0, 1.25, d));
        const floor = 1 - smooth(0.6, 0.95, d);
        albedo *= 1 - 0.35 * floor + 0.55 * rim;
        relief -= 0.04 * floor;
      }
    }
    const c = Math.min(1, Math.pow(lit, 0.75) * albedo * 1.2) + 0.03 * (1 - z);
    out[0] = c;
    out[1] = 0.95 * c;
    out[2] = 0.84 * c;
    out[3] = 0.12 + 0.88 * z + relief;
  });

  // (c) EDDY: two halves chasing each other round a turned disc
  const eddy = paint("Eddy", (x, y, out) => {
    const R = 0.7;
    const a = 0.55;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const u = x * ca - y * sa;
    const v = x * sa + y * ca;
    const r = Math.hypot(u, v);
    if (r >= R) return speck(toPx(x), toPx(y), out, 0.5);
    let bright = u > 0;
    if (Math.hypot(u, v + R / 2) < R / 2) bright = true;
    else if (Math.hypot(u, v - R / 2) < R / 2) bright = false;
    if (Math.hypot(u, v + R / 2) < R / 7) bright = false;
    else if (Math.hypot(u, v - R / 2) < R / 7) bright = true;
    const dome = Math.sqrt(1 - (r / R) * (r / R));
    const grain = 0.8 + 0.4 * fbm(20 * x, 20 * y, 2);
    let c = bright ? (0.7 + 0.3 * dome) * grain : 0.06 * grain;
    let near = bright ? 0.5 + 0.5 * dome : 0.16 + 0.16 * dome;
    if (r > R * 0.975) {
      c = 0.85;
      near = 0.3;
    }
    out[0] = c;
    out[1] = 0.985 * c;
    out[2] = 0.955 * c;
    out[3] = near;
  });

  // (d) LATTICE: a lattice of dots on a sphere, the far side showing faintly through
  const lattice = paint("Lattice", (x, y, out) => {
    const R = 0.68;
    const r = Math.hypot(x, y) / R;
    if (r >= 1) return speck(toPx(x), toPx(y), out, 0.5);
    const z = Math.sqrt(1 - r * r);
    const tilt = 0.4;
    const nx = x / R;
    const ny = (y / R) * Math.cos(tilt) - z * Math.sin(tilt);
    const nz = (y / R) * Math.sin(tilt) + z * Math.cos(tilt);
    const latStep = Math.PI / 14;
    const lonStep = Math.PI / 14;
    const dots = (px: number, py: number, pz: number) => {
      const lat = Math.asin(Math.max(-1, Math.min(1, py)));
      const lon = Math.atan2(px, pz);
      const dl = Math.abs(lat / latStep - Math.round(lat / latStep)) * latStep;
      const ring = Math.round(lat / latStep);
      const lonCount = Math.max(1, Math.round((2 * Math.PI * Math.cos(ring * latStep)) / lonStep));
      const ls = (2 * Math.PI) / lonCount;
      const dn = Math.abs(lon / ls - Math.round(lon / ls)) * ls * Math.cos(lat);
      const d = Math.hypot(dl, dn);
      return 1 - smooth(0.018, 0.036, d);
    };
    const front = dots(nx, ny, nz);
    const back = dots(nx, ny, -nz) * 0.22;
    const rim = 0.25 * Math.exp(-((1 - r) * 9));
    const c = Math.min(1, front * (0.8 + 0.4 * z) + back + rim);
    out[0] = 0.86 * c;
    out[1] = 0.94 * c;
    out[2] = c;
    out[3] = front > 0.05 ? 0.3 + 0.7 * z : back > 0.01 ? 0.08 : 0.2 + 0.2 * z;
  });

  return [comet, moon, eddy, lattice];
}
