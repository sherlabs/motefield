/** A soft alpha matte, 0 (backdrop) .. 1 (subject), row-major. */
export interface Matte {
  w: number;
  h: number;
  data: Float32Array;
}

/** Bilinear resample of a single-channel map. */
export function resample(src: Float32Array, sw: number, sh: number, dw: number, dh: number): Float32Array {
  const out = new Float32Array(dw * dh);
  for (let y = 0; y < dh; y++) {
    const fy = Math.min(Math.max(((y + 0.5) * sh) / dh - 0.5, 0), sh - 1);
    const y0 = Math.floor(fy);
    const y1 = Math.min(sh - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < dw; x++) {
      const fx = Math.min(Math.max(((x + 0.5) * sw) / dw - 0.5, 0), sw - 1);
      const x0 = Math.floor(fx);
      const x1 = Math.min(sw - 1, x0 + 1);
      const tx = fx - x0;
      out[y * dw + x] = (src[y0 * sw + x0] * (1 - tx) + src[y0 * sw + x1] * tx) * (1 - ty) + (src[y1 * sw + x0] * (1 - tx) + src[y1 * sw + x1] * tx) * ty;
    }
  }
  return out;
}

function erode(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let v = 1;
      for (let dy = -r; dy <= r && v; dy++)
        for (let dx = -r; dx <= r; dx++) {
          const yy = y + dy;
          const xx = x + dx;
          if (yy < 0 || yy >= h || xx < 0 || xx >= w || !mask[yy * w + xx]) {
            v = 0;
            break;
          }
        }
      out[y * w + x] = v;
    }
  return out;
}

function dilate(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let dy = -r; dy <= r && !v; dy++)
        for (let dx = -r; dx <= r; dx++) {
          const yy = y + dy;
          const xx = x + dx;
          if (yy >= 0 && yy < h && xx >= 0 && xx < w && mask[yy * w + xx]) {
            v = 1;
            break;
          }
        }
      out[y * w + x] = v;
    }
  return out;
}

/**
 * Tidy a matte at model resolution: drop isolated specks (open), fill
 * pinholes (close), then pull the soft edge in by one pixel so the backdrop
 * colour on the very rim is not sampled. Soft values survive inside the mask.
 */
export function cleanMatte(m: Matte): Matte {
  const { w, h, data } = m;
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < mask.length; i++) mask[i] = data[i] > 0.08 ? 1 : 0;
  const opened = dilate(erode(mask, w, h, 1), w, h, 1);
  const closed = erode(dilate(opened, w, h, 2), w, h, 2);
  // keep thin wisps the opening removed if the raw alpha is strong there
  const keep = new Uint8Array(w * h);
  for (let i = 0; i < keep.length; i++) keep[i] = closed[i] || data[i] > 0.6 ? 1 : 0;
  const rim = erode(keep, w, h, 1);
  const out = new Float32Array(w * h);
  for (let i = 0; i < out.length; i++) {
    if (!keep[i]) continue;
    // the outermost ring fades rather than cuts
    out[i] = rim[i] ? data[i] : data[i] * 0.5;
  }
  return { w, h, data: out };
}

/** How sure the matte is: share of pixels that are clearly in or out. */
export function matteConfidence(m: Matte): number {
  let sure = 0;
  let fg = 0;
  let soft = 0;
  let softSum = 0;
  for (let i = 0; i < m.data.length; i++) {
    const a = m.data[i];
    if (a < 0.05 || a > 0.95) sure++;
    if (a > 0.5) fg++;
    if (a > 0.08) {
      soft++;
      softSum += a;
    }
  }
  const n = m.data.length;
  const fgFrac = fg / n;
  if (fgFrac < 0.03 || fgFrac > 0.98) return 0;
  // the subject must be solid: a matte that is faint everywhere has found nothing
  if (!soft || softSum / soft < 0.6) return 0;
  // a subject sits in the middle and the backdrop shows in the upper corners;
  // a matte the other way round has mistaken the backdrop for the subject
  const mean = (x0: number, x1: number, y0: number, y1: number) => {
    let s = 0;
    let c = 0;
    for (let y = Math.floor(y0 * m.h); y < Math.floor(y1 * m.h); y++)
      for (let x = Math.floor(x0 * m.w); x < Math.floor(x1 * m.w); x++) {
        s += m.data[y * m.w + x];
        c++;
      }
    return c ? s / c : 0;
  };
  const corners = (mean(0, 0.15, 0, 0.12) + mean(0.85, 1, 0, 0.12)) / 2;
  const centre = mean(0.35, 0.65, 0.3, 0.7);
  if (corners > centre || centre < 0.25) return 0;
  return sure / n;
}
