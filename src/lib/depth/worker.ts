/// <reference lib="webworker" />
// Depth estimation worker. Runs onnxruntime-web (wasm EP, 1 thread) with the
// Depth Anything V2 small quantized model fetched from Hugging Face.
// The runtime script is self-hosted in /ort and evaluated via a CommonJS shim, so
// the bundler never has to understand onnxruntime's internals.

/* eslint-disable @typescript-eslint/no-explicit-any */
declare const self: DedicatedWorkerGlobalScope;

const MODEL_URL =
  "https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/main/onnx/model_quantized.onnx";
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

let ort: any = null;
let session: any = null;

async function loadRuntime(base: string) {
  const res = await fetch(base + "ort.wasm.min.js");
  if (!res.ok) throw new Error("runtime HTTP " + res.status);
  const code = await res.text();
  // The bundle is a strict-mode IIFE (`var ort=(()=>{...})()`), so its `var`
  // never reaches the global scope; run it inside a function and return it.
  ort = new Function(code + "\n;return ort;")();
  if (!ort) throw new Error("onnxruntime did not initialise");
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  ort.env.wasm.wasmPaths = base;
  ort.env.logLevel = "error";
}

async function fetchModel(): Promise<Uint8Array> {
  const res = await fetch(MODEL_URL);
  if (!res.ok || !res.body) throw new Error("model HTTP " + res.status);
  const total = Number(res.headers.get("content-length")) || 0;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    self.postMessage({ type: "progress", got, total });
  }
  const out = new Uint8Array(got);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

async function init(base: string) {
  try {
    await loadRuntime(base);
    const bytes = await fetchModel();
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

async function run(id: number, w: number, h: number, rgba: Uint8ClampedArray) {
  try {
    if (!session) throw new Error("model not loaded");
    const n = w * h;
    const input = new Float32Array(3 * n);
    for (let i = 0; i < n; i++) {
      input[i] = (rgba[i * 4] / 255 - MEAN[0]) / STD[0];
      input[n + i] = (rgba[i * 4 + 1] / 255 - MEAN[1]) / STD[1];
      input[2 * n + i] = (rgba[i * 4 + 2] / 255 - MEAN[2]) / STD[2];
    }
    const feeds: Record<string, unknown> = {};
    feeds[session.inputNames[0]] = new ort.Tensor("float32", input, [1, 3, h, w]);
    const out = (await session.run(feeds))[session.outputNames[0]];
    const dims: number[] = out.dims;
    const oh = dims[dims.length - 2];
    const ow = dims[dims.length - 1];
    const depth = new Float32Array(ow * oh);
    depth.set(out.data as Float32Array);
    self.postMessage({ type: "depth", id, w: ow, h: oh, depth }, [depth.buffer]);
  } catch (e: any) {
    self.postMessage({ type: "runfail", id, error: String(e?.message ?? e) });
  }
}

// Serialise messages so a slow run never interleaves with the next one.
let chain: Promise<void> = Promise.resolve();
self.onmessage = (ev: MessageEvent) => {
  const m = ev.data;
  chain = chain.then(async () => {
    if (m.type === "init") await init(m.base);
    else if (m.type === "run") await run(m.id, m.w, m.h, m.rgba);
  });
};

export {};
