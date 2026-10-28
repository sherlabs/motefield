import type { Matte } from "../matte/process";
import { FRAME, GRID_H, GRID_W, POINT_COUNT, type DepthMap, type Feature, type SceneData } from "./types";

/**
 * A small seeded PRNG so a picture always deals the same motes.
 */
function seeded(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let x = Math.imul(s ^ (s >>> 15), s | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function smoothstep(a: number, b: number, v: number): number {
  const t = Math.max(0, Math.min(1, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function bilinear(d: DepthMap, u: number, v: number): number {
  const fx = Math.min(Math.max(u * d.w - 0.5, 0), d.w - 1);
  const fy = Math.min(Math.max(v * d.h - 0.5, 0), d.h - 1);
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(x0 + 1, d.w - 1);
  const y1 = Math.min(y0 + 1, d.h - 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const a = d.data[y0 * d.w + x0] * (1 - tx) + d.data[y0 * d.w + x1] * tx;
  const b = d.data[y1 * d.w + x0] * (1 - tx) + d.data[y1 * d.w + x1] * tx;
  return a * (1 - ty) + b * ty;
}

/** Spread the low 16 bits of x so there is a zero between each pair. */
function spread(x: number): number {
  x &= 0xffff;
  x = (x | (x << 8)) & 0x00ff00ff;
  x = (x | (x << 4)) & 0x0f0f0f0f;
  x = (x | (x << 2)) & 0x33333333;
  x = (x | (x << 1)) & 0x55555555;
  return x;
}

let zOrder: Uint32Array | null = null;

/**
 * Pixel indices of the frame visited along a Z-order (Morton) curve, so that
 * motes with neighbouring indices sit near each other in the picture. That
 * keeps a stride through the point list evenly spread and makes the flights
 * between pictures coherent.
 */
function frameOrder(): Uint32Array {
  if (zOrder) return zOrder;
  const n = FRAME * FRAME;
  const order = new Uint32Array(n);
  for (let y = 0; y < FRAME; y++) {
    const sy = spread(y) << 1;
    for (let x = 0; x < FRAME; x++) order[sy | spread(x)] = y * FRAME + x;
  }
  zOrder = order;
  return order;
}

export interface BuildOptions {
  /**
   * photos: motes are spread by detail and subject rather than by light, so
   * the picture reads as itself (a dark shirt stays dark and dense)
   */
  photo?: boolean;
  /** photos: keep the far planes instead of thinning them out around the subject */
  keepBackground?: boolean;
  /**
   * photos: a soft alpha matte at the picture's own resolution. When given (and
   * the background is not kept) it decides where the motes go; depth is then
   * relief only. Without it the far planes are split off by depth.
   */
  matte?: Matte;
  seed?: number;
}

/** below this alpha a pixel is backdrop and gets no mote at all */
const MATTE_CUT = 0.08;

interface Fitted {
  rgba: Uint8ClampedArray;
  ox: number;
  oy: number;
  iw: number;
  ih: number;
}

/** Draw a picture centred into the square frame. */
function fitToFrame(src: CanvasImageSource & { width: number; height: number }): Fitted {
  const s = FRAME / Math.max(src.width, src.height);
  const iw = Math.max(8, Math.min(FRAME, Math.round(src.width * s)));
  const ih = Math.max(8, Math.min(FRAME, Math.round(src.height * s)));
  const ox = (FRAME - iw) >> 1;
  const oy = (FRAME - ih) >> 1;
  const c = document.createElement("canvas");
  c.width = c.height = FRAME;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(src, ox, oy, iw, ih);
  return { rgba: ctx.getImageData(0, 0, FRAME, FRAME).data, ox, oy, iw, ih };
}

/**
 * Deal the motes of one picture. Motes go where the picture has light and
 * edges: every pixel gets a weight, the frame is walked along a Z-order curve
 * and a mote is dropped each time the running weight crosses the next step.
 * Black background therefore stays empty, bright shapes become dense dust.
 */
export function buildSceneData(
  src: CanvasImageSource & { width: number; height: number },
  depth: DepthMap,
  opts: BuildOptions = {},
): SceneData {
  const n = FRAME;
  const { rgba, ox, oy, iw, ih } = fitToFrame(src);
  const rnd = seeded(opts.seed ?? 7);

  const luma = new Float32Array(n * n);
  const near = new Float32Array(n * n);
  const edge = new Float32Array(n * n);
  const weight = new Float32Array(n * n);

  for (let i = 0; i < n * n; i++) {
    const a = rgba[i * 4 + 3] / 255;
    luma[i] = (a * (0.2126 * rgba[i * 4] + 0.7152 * rgba[i * 4 + 1] + 0.0722 * rgba[i * 4 + 2])) / 255;
  }

  // photos: where does the subject end and the backdrop begin? Split the
  // depth histogram between its two modes; a picture with no clear far plane
  // keeps everything.
  let maskLo = 0;
  let maskHi = 0;
  const useMatte = !!(opts.photo && !opts.keepBackground && opts.matte);
  if (opts.photo && !opts.keepBackground && !useMatte) {
    const th = depthSplit(depth);
    if (th !== null) {
      maskLo = th - 0.04;
      maskHi = th + 0.08;
    }
  }

  // the matte, resampled into the frame, and the backdrop colour behind the
  // subject's edge so that the rim can be cleaned of it
  const alpha = useMatte ? new Float32Array(n * n) : null;
  const bgColor = [0, 0, 0];
  if (alpha && opts.matte) {
    const m = opts.matte;
    let bn = 0;
    for (let y = oy; y < oy + ih; y++) {
      const v = (y - oy + 0.5) / ih;
      for (let x = ox; x < ox + iw; x++) {
        const i = y * n + x;
        const a = bilinear({ w: m.w, h: m.h, data: m.data }, (x - ox + 0.5) / iw, v);
        alpha[i] = a;
        if (a < 0.02) {
          bgColor[0] += rgba[i * 4];
          bgColor[1] += rgba[i * 4 + 1];
          bgColor[2] += rgba[i * 4 + 2];
          bn++;
        }
      }
    }
    if (bn) for (let k = 0; k < 3; k++) bgColor[k] /= bn;
  }

  let total = 0;
  for (let y = oy; y < oy + ih; y++) {
    const v = (y - oy + 0.5) / ih;
    for (let x = ox; x < ox + iw; x++) {
      const i = y * n + x;
      if (rgba[i * 4 + 3] < 8) continue;
      const u = (x - ox + 0.5) / iw;
      const z = bilinear(depth, u, v);
      near[i] = z;
      const gx = luma[Math.min(n * n - 1, i + 1)] - luma[Math.max(0, i - 1)];
      const gy = luma[Math.min(n * n - 1, i + n)] - luma[Math.max(0, i - n)];
      const e = Math.min(1, 3.5 * Math.hypot(gx, gy));
      edge[i] = e;
      const l = luma[i];
      let w: number;
      if (opts.photo) {
        // every part of the subject gets motes, edges and detail get more;
        // the background is a far plane: thinned to a trace unless kept
        let subject: number;
        if (alpha) {
          const a = alpha[i];
          subject = a < MATTE_CUT ? 0 : smoothstep(MATTE_CUT, 0.5, a);
        } else subject = opts.keepBackground ? 0.45 + 0.55 * z : maskHi > maskLo ? smoothstep(maskLo, maskHi, z) : 1;
        w = subject > 0 ? (0.55 + 0.45 * l + 1.4 * e) * subject : 0;
      } else {
        w = (0.03 + 0.85 * Math.pow(l, 1.2) + 0.5 * e * (0.25 + l)) * (0.4 + 0.6 * z);
      }
      weight[i] = w;
      total += w;
    }
  }
  if (!(total > 0)) {
    for (let y = oy; y < oy + ih; y++)
      for (let x = ox; x < ox + iw; x++) {
        weight[y * n + x] = 1;
        total += 1;
      }
  }

  const pos = new Float32Array(GRID_W * GRID_H * 4);
  const col = new Uint8Array(GRID_W * GRID_H * 4);
  const step = total / POINT_COUNT;
  let count = 0;
  let threshold = rnd() * step;
  let acc = 0;
  let lastPixel = 0;

  const drop = (i: number) => {
    const px = i % n;
    const py = (i / n) | 0;
    const o = count * 4;
    const l = luma[i];
    pos[o] = ((px + rnd()) / n) * 2 - 1;
    pos[o + 1] = 1 - ((py + rnd()) / n) * 2;
    pos[o + 2] = near[i] - 0.5 + 0.014 * (rnd() - 0.5);
    pos[o + 3] = Math.min(1, 0.08 + Math.min(1, 1.6 * edge[i]) * (0.35 + 0.65 * l) + 0.12 * l);
    // the mote carries the pixel's own sRGB colour, untouched; the glowing
    // dust look lifts it in the shader when that mode is on
    const a = rgba[i * 4 + 3] / 255;
    let r = a * rgba[i * 4];
    let g = a * rgba[i * 4 + 1];
    let b = a * rgba[i * 4 + 2];
    if (alpha) {
      // on the soft rim the pixel is a blend of subject and backdrop: take the backdrop's share out
      const m = alpha[i];
      if (m < 0.95 && m > 0) {
        r = Math.max(0, Math.min(255, (r - (1 - m) * bgColor[0]) / m));
        g = Math.max(0, Math.min(255, (g - (1 - m) * bgColor[1]) / m));
        b = Math.max(0, Math.min(255, (b - (1 - m) * bgColor[2]) / m));
      }
    }
    col[o] = Math.round(r);
    col[o + 1] = Math.round(g);
    col[o + 2] = Math.round(b);
    col[o + 3] = 255;
    count++;
  };

  const order = frameOrder();
  for (let k = 0; k < n * n && count < POINT_COUNT; k++) {
    const i = order[k];
    const w = weight[i];
    if (w <= 0) continue;
    acc += w;
    lastPixel = i;
    while (acc > threshold && count < POINT_COUNT) {
      drop(i);
      threshold += step;
    }
  }
  while (count < POINT_COUNT) drop(lastPixel);

  return { pos, col, feats: findFeatures(luma, edge, near, weight, ox, oy, iw, ih), photo: !!opts.photo };
}

/**
 * Salient points for the trackers: the strongest edge in each cell of a
 * 28 x 28 grid, thinned so that no two sit too close. The first few are
 * spread wide, the rest fill in.
 */
function findFeatures(
  luma: Float32Array,
  edge: Float32Array,
  near: Float32Array,
  weight: Float32Array,
  ox: number,
  oy: number,
  iw: number,
  ih: number,
): Feature[] {
  const n = FRAME;
  const cells = 28;
  const cw = iw / cells;
  const ch = ih / cells;
  const stride = Math.max(1, Math.floor(cw / 6));
  // a tag belongs on the subject: only cells that carry a real share of the
  // picture's grains qualify, so specks and empty ground never get one
  const cellWeight: { cx: number; cy: number; mean: number }[] = [];
  let maxMean = 0;
  for (let cy = 1; cy < cells - 1; cy++)
    for (let cx = 1; cx < cells - 1; cx++) {
      let sum = 0;
      let count = 0;
      const x1 = ox + Math.floor((cx + 1) * cw);
      const y1 = oy + Math.floor((cy + 1) * ch);
      for (let y = oy + Math.floor(cy * ch); y < y1; y += stride)
        for (let x = ox + Math.floor(cx * cw); x < x1; x += stride) {
          sum += weight[y * n + x];
          count++;
        }
      const mean = count ? sum / count : 0;
      maxMean = Math.max(maxMean, mean);
      cellWeight.push({ cx, cy, mean });
    }
  const found: { i: number; v: number }[] = [];
  for (const { cx, cy, mean } of cellWeight) {
    if (mean < 0.3 * maxMean) continue;
    let best = 0;
    let bi = -1;
    const x1 = ox + Math.floor((cx + 1) * cw);
    const y1 = oy + Math.floor((cy + 1) * ch);
    for (let y = oy + Math.floor(cy * ch); y < y1; y += stride) {
      for (let x = ox + Math.floor(cx * cw); x < x1; x += stride) {
        const i = y * n + x;
        if (weight[i] < 0.3 * maxMean) continue;
        const l = luma[i];
        const s = edge[i] * (0.3 + l) + 0.35 * l * l + 0.05;
        if (s > best) {
          best = s;
          bi = i;
        }
      }
    }
    if (bi >= 0) found.push({ i: bi, v: best * (0.5 + near[bi]) });
  }
  found.sort((a, b) => b.v - a.v);
  const out: Feature[] = [];
  for (const [minDist, max] of [
    [0.52, 8],
    [0.2, 40],
  ] as const) {
    for (const f of found) {
      if (out.length >= max) break;
      const x = ((0.5 + (f.i % n)) / n) * 2 - 1;
      const y = 1 - ((0.5 + Math.floor(f.i / n)) / n) * 2;
      if (out.every((o) => Math.hypot(o.x - x, o.y - y) > minDist)) out.push({ x, y, z: near[f.i] - 0.5 });
    }
  }
  return out;
}

/**
 * Does the picture already come with its own empty backdrop? True for pictures
 * with transparency and for light shapes on a near-black ground (logos, the
 * demos): those need no matting model, luminance places the motes.
 */
export function hasOwnBackdrop(rgba: Uint8ClampedArray, w: number, h: number): boolean {
  let clear = 0;
  let dark = 0;
  let border = 0;
  const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 40000)));
  for (let y = 0; y < h; y += step)
    for (let x = 0; x < w; x += step) {
      const i = (y * w + x) * 4;
      if (rgba[i + 3] < 250) clear++;
      const edge = x < w * 0.04 || x >= w * 0.96 || y < h * 0.04 || y >= h * 0.96;
      if (edge) {
        border++;
        const l = (0.2126 * rgba[i] + 0.7152 * rgba[i + 1] + 0.0722 * rgba[i + 2]) / 255;
        if (l < 0.08 || rgba[i + 3] < 250) dark++;
      }
    }
  const samples = Math.ceil(w / step) * Math.ceil(h / step);
  return clear / samples > 0.01 || (border > 0 && dark / border > 0.6);
}

/**
 * Otsu's split of a depth map into far and near. Returns the threshold, or
 * null when the map is not clearly two-moded (then there is no backdrop to drop).
 */
export function depthSplit(d: DepthMap): number | null {
  const bins = 64;
  const hist = new Float64Array(bins);
  const n = d.data.length;
  const step = Math.max(1, Math.floor(n / 200000));
  let count = 0;
  for (let i = 0; i < n; i += step) {
    hist[Math.min(bins - 1, Math.floor(d.data[i] * bins))]++;
    count++;
  }
  let sumAll = 0;
  for (let b = 0; b < bins; b++) sumAll += b * hist[b];
  let wB = 0;
  let sumB = 0;
  let best = 0;
  let bestT = -1;
  for (let b = 0; b < bins - 1; b++) {
    wB += hist[b];
    if (!wB) continue;
    const wF = count - wB;
    if (!wF) break;
    sumB += b * hist[b];
    const mB = sumB / wB;
    const mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) {
      best = between;
      bestT = b;
    }
  }
  if (bestT < 0) return null;
  // there must be a real valley between two peaks: a flat ramp or a single
  // mound has no backdrop to drop
  const th = (bestT + 1) / bins;
  let far = 0;
  let peakFar = 0;
  let peakNear = 0;
  for (let b = 0; b < bins; b++) {
    if (b <= bestT) {
      far += hist[b];
      peakFar = Math.max(peakFar, hist[b]);
    } else peakNear = Math.max(peakNear, hist[b]);
  }
  const farFrac = far / count;
  const valley = Math.max(hist[bestT], hist[bestT + 1]) / Math.max(1, Math.min(peakFar, peakNear));
  if (farFrac < 0.08 || farFrac > 0.92 || valley > 0.35) return null;
  return th;
}

/** Rescale a depth array to 0..1 using robust percentiles. */
export function normalizeDepth(data: Float32Array): Float32Array {
  const n = data.length;
  const step = Math.max(1, Math.floor(n / 4096));
  const sample: number[] = [];
  for (let i = 0; i < n; i += step) sample.push(data[i]);
  sample.sort((a, b) => a - b);
  const lo = sample[Math.floor(sample.length * 0.01)];
  const hi = sample[Math.min(sample.length - 1, Math.floor(sample.length * 0.99))];
  const span = hi - lo || 1;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.min(1, Math.max(0, (data[i] - lo) / span));
  return out;
}

/** Separable box blur, radius r, in place on a copy. */
function boxBlur(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    let acc = 0;
    for (let x = -r; x <= r; x++) acc += src[y * w + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = acc / (2 * r + 1);
      acc += src[y * w + Math.min(w - 1, x + r + 1)] - src[y * w + Math.max(0, x - r)];
    }
  }
  const out = new Float32Array(w * h);
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc / (2 * r + 1);
      acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}

/** Cheap fallback depth: smoothed brightness (bright = near). */
export function brightnessDepth(rgba: Uint8ClampedArray, w: number, h: number): DepthMap {
  const luma = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    luma[i] = ((rgba[i * 4 + 3] / 255) * (0.2126 * rgba[i * 4] + 0.7152 * rgba[i * 4 + 1] + 0.0722 * rgba[i * 4 + 2])) / 255;
  }
  const r = Math.max(2, Math.round(Math.max(w, h) / 36));
  const soft = boxBlur(boxBlur(luma, w, h, r), w, h, r);
  for (let i = 0; i < soft.length; i++) soft[i] = 0.7 * soft[i] + 0.3 * luma[i];
  return { w, h, data: normalizeDepth(soft) };
}
