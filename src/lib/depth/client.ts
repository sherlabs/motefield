import { brightnessDepth, normalizeDepth } from "../scene/build";
import type { DepthMap } from "../scene/types";

export type DepthMode = "idle" | "loading" | "model" | "fallback";

export interface DepthStatus {
  mode: DepthMode;
  /** 0..1 download progress while loading */
  progress: number;
  detail?: string;
}

const LONG_SIDE = 448;
const MULTIPLE = 14;

/**
 * Main-thread wrapper around the depth worker. If the model or runtime fails
 * to load, estimate() transparently falls back to brightness depth.
 */
export class DepthEstimator {
  private worker: Worker | null = null;
  private ready: Promise<boolean> | null = null;
  private nextId = 1;
  private pending = new Map<number, (r: { w: number; h: number; depth: Float32Array } | null) => void>();
  status: DepthStatus = { mode: "idle", progress: 0 };
  onStatus?: (s: DepthStatus) => void;

  private set(s: Partial<DepthStatus>) {
    this.status = { ...this.status, ...s };
    this.onStatus?.(this.status);
  }

  /** Start loading the model (idempotent). Resolves true when the model works. */
  init(): Promise<boolean> {
    if (this.ready) return this.ready;
    this.set({ mode: "loading", progress: 0 });
    this.ready = new Promise<boolean>((resolve) => {
      try {
        const worker = new Worker(new URL("./worker.ts", import.meta.url));
        this.worker = worker;
        worker.onmessage = (ev: MessageEvent) => {
          const m = ev.data;
          if (m.type === "progress") {
            this.set({ progress: m.total ? Math.min(1, m.got / m.total) : 0 });
          } else if (m.type === "ready") {
            this.set({ mode: "model", progress: 1 });
            resolve(true);
          } else if (m.type === "fail") {
            console.warn("[depth] model unavailable, using brightness fallback:", m.error);
            this.set({ mode: "fallback", detail: m.error });
            resolve(false);
          } else if (m.type === "depth") {
            this.pending.get(m.id)?.({ w: m.w, h: m.h, depth: m.depth });
            this.pending.delete(m.id);
          } else if (m.type === "runfail") {
            this.pending.get(m.id)?.(null);
            this.pending.delete(m.id);
          }
        };
        worker.onerror = (e) => {
          console.warn("[depth] worker error:", e.message || e);
          this.set({ mode: "fallback", detail: e.message || "worker error" });
          resolve(false);
          this.pending.forEach((cb) => cb(null));
          this.pending.clear();
        };
        worker.postMessage({ type: "init", base: new URL("/ort/", location.href).href });
      } catch (e) {
        this.set({ mode: "fallback", detail: String(e) });
        resolve(false);
      }
    });
    return this.ready;
  }

  /** Estimate depth for a canvas picture. Returns a 0 (far)..1 (near) map. */
  async estimate(canvas: HTMLCanvasElement): Promise<DepthMap> {
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    const full = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const fallback = () => brightnessDepth(full.data, canvas.width, canvas.height);

    const ok = await this.init();
    if (!ok || !this.worker) return fallback();

    // Resize to the model input: long side 448, both sides multiples of 14.
    const scale = LONG_SIDE / Math.max(canvas.width, canvas.height);
    const mw = Math.max(MULTIPLE, Math.round((canvas.width * scale) / MULTIPLE) * MULTIPLE);
    const mh = Math.max(MULTIPLE, Math.round((canvas.height * scale) / MULTIPLE) * MULTIPLE);
    const small = document.createElement("canvas");
    small.width = mw;
    small.height = mh;
    const sctx = small.getContext("2d", { willReadFrequently: true })!;
    sctx.drawImage(canvas, 0, 0, mw, mh);
    const rgba = sctx.getImageData(0, 0, mw, mh).data;

    const id = this.nextId++;
    const result = await new Promise<{ w: number; h: number; depth: Float32Array } | null>((resolve) => {
      this.pending.set(id, resolve);
      this.worker!.postMessage({ type: "run", id, w: mw, h: mh, rgba }, [rgba.buffer]);
    });
    if (!result) return fallback();
    return { w: result.w, h: result.h, data: normalizeDepth(result.depth) };
  }

  dispose() {
    this.worker?.terminate();
    this.worker = null;
    this.ready = null;
  }
}
