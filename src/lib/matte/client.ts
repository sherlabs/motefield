import { cleanMatte, matteConfidence, resample, type Matte } from "./process";

export type MatteMode = "idle" | "loading" | "model" | "off";

export interface MatteStatus {
  mode: MatteMode;
  /** 0..1 download progress while loading */
  progress: number;
  /** bytes so far */
  bytes: number;
  detail?: string;
}

const SHORT_EDGE = 512;
const MULTIPLE = 32;

/**
 * Main-thread wrapper around the matting worker. estimate() returns null when
 * the model is unavailable or unsure, so the caller can fall back.
 */
export class MatteEstimator {
  private worker: Worker | null = null;
  private ready: Promise<boolean> | null = null;
  private nextId = 1;
  private pending = new Map<number, (r: { w: number; h: number; alpha: Float32Array; ms: number } | null) => void>();
  status: MatteStatus = { mode: "idle", progress: 0, bytes: 0 };
  onStatus?: (s: MatteStatus) => void;
  /** override the model location (tests) */
  modelUrl?: string;
  loadMs = 0;

  private set(s: Partial<MatteStatus>) {
    this.status = { ...this.status, ...s };
    this.onStatus?.(this.status);
  }

  init(): Promise<boolean> {
    if (this.ready) return this.ready;
    this.set({ mode: "loading", progress: 0 });
    const t0 = performance.now();
    this.ready = new Promise<boolean>((resolve) => {
      try {
        const worker = new Worker(new URL("./worker.ts", import.meta.url));
        this.worker = worker;
        worker.onmessage = (ev: MessageEvent) => {
          const m = ev.data;
          if (m.type === "progress") {
            this.set({ progress: m.total ? Math.min(1, m.got / m.total) : 0, bytes: m.got });
          } else if (m.type === "ready") {
            this.loadMs = performance.now() - t0;
            this.set({ mode: "model", progress: 1 });
            resolve(true);
          } else if (m.type === "fail") {
            console.warn("[matte] model unavailable, background stays by depth:", m.error);
            this.set({ mode: "off", detail: m.error });
            resolve(false);
          } else if (m.type === "matte") {
            this.pending.get(m.id)?.({ w: m.w, h: m.h, alpha: m.alpha, ms: m.ms });
            this.pending.delete(m.id);
          } else if (m.type === "runfail") {
            this.pending.get(m.id)?.(null);
            this.pending.delete(m.id);
          }
        };
        worker.onerror = (e) => {
          console.warn("[matte] worker error:", e.message || e);
          this.set({ mode: "off", detail: e.message || "worker error" });
          resolve(false);
          this.pending.forEach((cb) => cb(null));
          this.pending.clear();
        };
        worker.postMessage({ type: "init", base: new URL("/ort/", location.href).href, url: this.modelUrl });
      } catch (e) {
        this.set({ mode: "off", detail: String(e) });
        resolve(false);
      }
    });
    return this.ready;
  }

  /**
   * Soft alpha for a picture at the picture's own resolution, or null when the
   * model is unavailable or not confident about this picture.
   */
  async estimate(canvas: HTMLCanvasElement): Promise<Matte | null> {
    const ok = await this.init();
    if (!ok || !this.worker) return null;

    // aspect-preserving resize so the short edge is 512, padded to multiples of 32
    const sw = canvas.width;
    const sh = canvas.height;
    const scale = SHORT_EDGE / Math.min(sw, sh);
    const iw = Math.max(MULTIPLE, Math.round(sw * scale));
    const ih = Math.max(MULTIPLE, Math.round(sh * scale));
    const mw = Math.ceil(iw / MULTIPLE) * MULTIPLE;
    const mh = Math.ceil(ih / MULTIPLE) * MULTIPLE;
    const ox = (mw - iw) >> 1;
    const oy = (mh - ih) >> 1;
    const small = document.createElement("canvas");
    small.width = mw;
    small.height = mh;
    const ctx = small.getContext("2d", { willReadFrequently: true })!;
    ctx.fillStyle = "#808080"; // zero after normalisation
    ctx.fillRect(0, 0, mw, mh);
    ctx.drawImage(canvas, ox, oy, iw, ih);
    const rgba = ctx.getImageData(0, 0, mw, mh).data;

    const id = this.nextId++;
    const result = await new Promise<{ w: number; h: number; alpha: Float32Array; ms: number } | null>((resolve) => {
      this.pending.set(id, resolve);
      this.worker!.postMessage({ type: "run", id, w: mw, h: mh, rgba }, [rgba.buffer]);
    });
    if (!result) return null;

    // crop the padding away, tidy, then bring it back to the picture's size
    const crop = new Float32Array(iw * ih);
    const fx = result.w / mw;
    const fy = result.h / mh;
    for (let y = 0; y < ih; y++) {
      const ry = Math.min(result.h - 1, Math.floor((y + oy) * fy));
      for (let x = 0; x < iw; x++) crop[y * iw + x] = result.alpha[ry * result.w + Math.min(result.w - 1, Math.floor((x + ox) * fx))];
    }
    const raw: Matte = { w: iw, h: ih, data: crop };
    if (matteConfidence(raw) < 0.6) return null;
    const tidy = cleanMatte(raw);
    return { w: sw, h: sh, data: resample(tidy.data, iw, ih, sw, sh) };
  }

  dispose() {
    this.worker?.terminate();
    this.worker = null;
    this.ready = null;
  }
}
