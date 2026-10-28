/// <reference lib="webworker" />
// Portrait matting worker. Runs onnxruntime-web (wasm EP, 1 thread) with the
// MODNet ONNX export (Apache-2.0) fetched from Hugging Face, and returns a soft
// alpha matte: 1 = subject, 0 = backdrop.

/* eslint-disable @typescript-eslint/no-explicit-any */
declare const self: DedicatedWorkerGlobalScope;

export const MATTE_MODEL_URL = "https://huggingface.co/Xenova/modnet/resolve/main/onnx/model.onnx";
const MEAN = 0.5;
const STD = 0.5;
/** abort the download when no bytes arrive for this long */
const STALL_MS = 20000;

let ort: any = null;
let session: any = null;

async function loadRuntime(base: string) {
  const res = await fetch(base + "ort.wasm.min.js");
  if (!res.ok) throw new Error("runtime HTTP " + res.status);
  const code = await res.text();
  ort = new Function(code + "\n;return ort;")();
  if (!ort) throw new Error("onnxruntime did not initialise");
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  ort.env.wasm.wasmPaths = base;
  ort.env.logLevel = "error";
}

async function fetchModel(url: string): Promise<Uint8Array> {
  const ac = new AbortController();
  let stall = setTimeout(() => ac.abort(), STALL_MS);
  const res = await fetch(url, { signal: ac.signal });
  if (!res.ok || !res.body) throw new Error("model HTTP " + res.status);
  const total = Number(res.headers.get("content-length")) || 0;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let got = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      clearTimeout(stall);
      stall = setTimeout(() => ac.abort(), STALL_MS);
      chunks.push(value);
      got += value.length;
      self.postMessage({ type: "progress", got, total });
    }
  } catch (e: any) {
    if (ac.signal.aborted) throw new Error("download stalled");
    throw e;
  } finally {
    clearTimeout(stall);
  }
  const out = new Uint8Array(got);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

async function init(base: string, url: string) {
  try {
    await loadRuntime(base);
    const bytes = await fetchModel(url);
    session = await ort.InferenceSession.create(bytes, {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all",
      logSeverityLevel: 3,
    });
    self.postMessage({ type: "ready" });
  } catch (e: any) {
    self.postMessage({ type: "fail", error: String(e?.message ?? e) });
  }
}

/** rgba is already letterboxed to w x h (multiples of 32). */
async function run(id: number, w: number, h: number, rgba: Uint8ClampedArray) {
  try {
    if (!session) throw new Error("model not loaded");
    const n = w * h;
    const input = new Float32Array(3 * n);
    for (let i = 0; i < n; i++) {
      input[i] = (rgba[i * 4] / 255 - MEAN) / STD;
      input[n + i] = (rgba[i * 4 + 1] / 255 - MEAN) / STD;
      input[2 * n + i] = (rgba[i * 4 + 2] / 255 - MEAN) / STD;
    }
    const feeds: Record<string, unknown> = {};
    feeds[session.inputNames[0]] = new ort.Tensor("float32", input, [1, 3, h, w]);
    const t0 = performance.now();
    const out = (await session.run(feeds))[session.outputNames[0]];
    const dims: number[] = out.dims;
    const oh = dims[dims.length - 2];
    const ow = dims[dims.length - 1];
    const alpha = new Float32Array(ow * oh);
    const data = out.data as Float32Array;
    for (let i = 0; i < alpha.length; i++) alpha[i] = Math.max(0, Math.min(1, data[i]));
    self.postMessage({ type: "matte", id, w: ow, h: oh, alpha, ms: performance.now() - t0 }, [alpha.buffer]);
  } catch (e: any) {
    self.postMessage({ type: "runfail", id, error: String(e?.message ?? e) });
  }
}

let chain: Promise<void> = Promise.resolve();
self.onmessage = (ev: MessageEvent) => {
  const m = ev.data;
  chain = chain.then(async () => {
    if (m.type === "init") await init(m.base, m.url ?? MATTE_MODEL_URL);
    else if (m.type === "run") await run(m.id, m.w, m.h, m.rgba);
  });
};
