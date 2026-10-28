import { Muxer as Mp4Muxer, ArrayBufferTarget as Mp4Target } from "mp4-muxer";
import { Muxer as WebmMuxer, ArrayBufferTarget as WebmTarget } from "webm-muxer";
import { PointCloudRenderer, type RenderParams } from "@/lib/gl/renderer";
import type { SceneData } from "@/lib/scene/types";

export type ResolutionId = "720p" | "1080p" | "square" | "vertical";
export type EngineId = "webcodecs" | "recorder";

export const RESOLUTIONS: Record<ResolutionId, { label: string; w: number; h: number }> = {
  "720p": { label: "720p", w: 1280, h: 720 },
  "1080p": { label: "1080p", w: 1920, h: 1080 },
  square: { label: "Square 1080", w: 1080, h: 1080 },
  vertical: { label: "Vertical 1080x1920", w: 1080, h: 1920 },
};

export const MIN_DURATION = 3;
export const MAX_DURATION = 30;

export interface ExportOptions {
  /** All scenes in the studio, in order. */
  scenes: SceneData[];
  /** Current on-screen render params (copied; the live renderer is never touched). */
  params: RenderParams;
  /** Scene shown when `cycleAll` is false. */
  sceneIndex: number;
  /** Cycle through every picture (auto timeline) instead of a single one. */
  cycleAll: boolean;
  durationSec: number;
  fps: 24 | 30 | 60;
  resolution: ResolutionId;
  /** Make the last frame flow into the first (loop length == duration). */
  seamless: boolean;
  signal?: AbortSignal;
  onProgress?: (p: ExportProgress) => void;
}

export interface ExportProgress {
  phase: "prepare" | "render" | "finish";
  done: number;
  total: number;
  /** 0..1 */
  fraction: number;
}

export interface ExportResult {
  blob: Blob;
  ext: "mp4" | "webm";
  mime: string;
  engine: EngineId;
  /** Human readable, e.g. "H.264 MP4 (WebCodecs)". */
  label: string;
}

export class ExportCancelled extends Error {
  constructor() {
    super("Export cancelled");
    this.name = "ExportCancelled";
  }
}

// ---------------------------------------------------------------- capability

interface CodecPick {
  kind: "mp4" | "webm";
  config: VideoEncoderConfig;
}

const H264_CANDIDATES = ["avc1.640034", "avc1.640033", "avc1.640028", "avc1.4d0028", "avc1.42001f"];
const VP9_CANDIDATES = ["vp09.00.50.08", "vp09.00.41.08", "vp09.00.31.08"];

function bitrateFor(w: number, h: number, fps: number): number {
  return Math.round(Math.min(40_000_000, Math.max(2_000_000, w * h * fps * 0.12)));
}

async function pickWebCodecs(w: number, h: number, fps: number): Promise<CodecPick | null> {
  if (typeof VideoEncoder === "undefined" || typeof VideoFrame === "undefined") return null;
  const bitrate = bitrateFor(w, h, fps);
  const tries: { kind: "mp4" | "webm"; codecs: string[]; extra?: Partial<VideoEncoderConfig> }[] = [
    { kind: "mp4", codecs: H264_CANDIDATES, extra: { avc: { format: "avc" } } as Partial<VideoEncoderConfig> },
    { kind: "webm", codecs: VP9_CANDIDATES },
  ];
  for (const t of tries) {
    for (const codec of t.codecs) {
      const config: VideoEncoderConfig = {
        codec,
        width: w,
        height: h,
        bitrate,
        framerate: fps,
        latencyMode: "quality",
        ...t.extra,
      };
      try {
        const res = await VideoEncoder.isConfigSupported(config);
        if (res.supported) return { kind: t.kind, config: res.config ?? config };
      } catch {
        /* try next */
      }
    }
  }
  return null;
}

function recorderMime(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  const list = ["video/mp4;codecs=avc1", "video/mp4", "video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
  return list.find((m) => MediaRecorder.isTypeSupported(m)) ?? null;
}

export interface Capability {
  engine: EngineId | null;
  ext: "mp4" | "webm" | null;
  label: string;
}

/** Which engine and container the browser will give us for these settings. */
export async function detectCapability(resolution: ResolutionId, fps: number): Promise<Capability> {
  const { w, h } = RESOLUTIONS[resolution];
  const pick = await pickWebCodecs(w, h, fps);
  if (pick) {
    return {
      engine: "webcodecs",
      ext: pick.kind,
      label: pick.kind === "mp4" ? "H.264 MP4 (WebCodecs, frame-exact)" : "VP9 WebM (WebCodecs, frame-exact)",
    };
  }
  const mime = recorderMime();
  if (mime) {
    const ext = mime.startsWith("video/mp4") ? "mp4" : "webm";
    return { engine: "recorder", ext, label: `${ext.toUpperCase()} (MediaRecorder, realtime capture)` };
  }
  return { engine: null, ext: null, label: "Video export is not supported in this browser" };
}

// ---------------------------------------------------------------- helpers

const yieldToUi = (() => {
  // MessageChannel yields without the 4ms clamp of nested setTimeout, and is not throttled as hard as rAF in background tabs.
  let ch: MessageChannel | null = null;
  return () =>
    new Promise<void>((resolve) => {
      if (typeof MessageChannel === "undefined") return void setTimeout(resolve, 0);
      ch ??= new MessageChannel();
      const c = ch;
      c.port1.onmessage = () => resolve();
      c.port2.postMessage(0);
    });
})();

function checkAbort(signal?: AbortSignal) {
  if (signal?.aborted) throw new ExportCancelled();
}

/**
 * Builds a private renderer on its own canvas. The on-screen renderer and its
 * canvas size are never touched, so the live view keeps running. The offline
 * renderer has no pointer, no orbit and no hand-fired lamps, so every frame is
 * a pure function of time. The HUD is a separate DOM layer and never exported.
 */
function makeOfflineRenderer(opts: ExportOptions, w: number, h: number, loopMs: number): PointCloudRenderer {
  const r = new PointCloudRenderer();
  r.resize(w, h, 1);
  const all = opts.scenes;
  const cycle = opts.cycleAll && all.length > 1;
  const scenes = cycle ? all : [all[Math.min(Math.max(0, opts.sceneIndex), all.length - 1)]];
  r.setScenes(scenes);
  r.setParams({ ...opts.params, loopDurationMs: loopMs });
  // the export always runs the loop timeline so the first frame flows from the last
  r.setAuto(true);
  return r;
}

function loopLengthMs(opts: ExportOptions, durationSec: number): number {
  return opts.seamless ? durationSec * 1000 : opts.params.loopDurationMs;
}

function clampOpts(opts: ExportOptions) {
  const durationSec = Math.min(MAX_DURATION, Math.max(MIN_DURATION, opts.durationSec));
  const { w, h } = RESOLUTIONS[opts.resolution];
  const total = Math.max(1, Math.round(durationSec * opts.fps));
  return { durationSec, w, h, total };
}

// ---------------------------------------------------------------- poster

/** Renders frame 0 at the chosen resolution (offscreen) and returns a PNG. */
export async function exportPoster(opts: ExportOptions): Promise<Blob> {
  if (!opts.scenes.length) throw new Error("No pictures loaded");
  const { durationSec, w, h } = clampOpts(opts);
  const r = makeOfflineRenderer(opts, w, h, loopLengthMs(opts, durationSec));
  try {
    r.render(0);
    const canvas = r.getCanvas();
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("PNG encoding failed"))), "image/png"),
    );
  } finally {
    r.dispose();
  }
}

// ---------------------------------------------------------------- main entry

export async function exportVideo(opts: ExportOptions): Promise<ExportResult> {
  if (!opts.scenes.length) throw new Error("No pictures loaded");
  const { w, h } = clampOpts(opts);
  const cap = await detectCapability(opts.resolution, opts.fps);
  if (cap.engine === "webcodecs") return exportWebCodecs(opts);
  if (cap.engine === "recorder") return exportRecorder(opts);
  throw new Error(cap.label + ` (${w}x${h})`);
}

async function exportWebCodecs(opts: ExportOptions): Promise<ExportResult> {
  const { durationSec, w, h, total } = clampOpts(opts);
  const fps = opts.fps;
  opts.onProgress?.({ phase: "prepare", done: 0, total, fraction: 0 });
  const pick = await pickWebCodecs(w, h, fps);
  if (!pick) throw new Error("No supported WebCodecs encoder");
  const renderer = makeOfflineRenderer(opts, w, h, loopLengthMs(opts, durationSec));

  let encoderError: Error | null = null;
  let encoder: VideoEncoder | null = null;
  let finish: () => ArrayBuffer;
  let add: (chunk: EncodedVideoChunk, meta?: EncodedVideoChunkMetadata) => void;

  if (pick.kind === "mp4") {
    const target = new Mp4Target();
    const mux = new Mp4Muxer({ target, video: { codec: "avc", width: w, height: h, frameRate: fps }, fastStart: "in-memory", firstTimestampBehavior: "offset" });
    add = (c, m) => mux.addVideoChunk(c, m);
    finish = () => {
      mux.finalize();
      return target.buffer;
    };
  } else {
    const target = new WebmTarget();
    const mux = new WebmMuxer({ target, video: { codec: "V_VP9", width: w, height: h, frameRate: fps }, firstTimestampBehavior: "offset" });
    add = (c, m) => mux.addVideoChunk(c, m);
    finish = () => {
      mux.finalize();
      return target.buffer;
    };
  }

  try {
    encoder = new VideoEncoder({
      output: (chunk, meta) => add(chunk, meta),
      error: (e) => {
        encoderError = e instanceof Error ? e : new Error(String(e));
      },
    });
    encoder.configure(pick.config);
    const canvas = renderer.getCanvas();
    const keyEvery = Math.max(1, fps * 2);

    for (let i = 0; i < total; i++) {
      checkAbort(opts.signal);
      if (encoderError) throw encoderError;
      // back-pressure: let the encoder drain before queueing more raw frames
      while (encoder.encodeQueueSize > 6) {
        await yieldToUi();
        checkAbort(opts.signal);
        if (encoderError) throw encoderError;
      }
      // Time is a pure function of the frame index, so the result never depends on how fast the machine is.
      renderer.render((i * 1000) / fps);
      const frame = new VideoFrame(canvas, { timestamp: Math.round((i * 1_000_000) / fps), duration: Math.round(1_000_000 / fps) });
      encoder.encode(frame, { keyFrame: i % keyEvery === 0 });
      frame.close();
      opts.onProgress?.({ phase: "render", done: i + 1, total, fraction: (i + 1) / total });
      await yieldToUi();
    }
    opts.onProgress?.({ phase: "finish", done: total, total, fraction: 1 });
    await encoder.flush();
    if (encoderError) throw encoderError;
    checkAbort(opts.signal);
    const buf = finish();
    const mime = pick.kind === "mp4" ? "video/mp4" : "video/webm";
    return {
      blob: new Blob([buf], { type: mime }),
      ext: pick.kind,
      mime,
      engine: "webcodecs",
      label: pick.kind === "mp4" ? "H.264 MP4" : "VP9 WebM",
    };
  } finally {
    try {
      if (encoder && encoder.state !== "closed") encoder.close();
    } catch {
      /* already closed */
    }
    renderer.dispose();
  }
}

/** Realtime fallback: frames are still rendered from deterministic time, but paced on the wall clock. */
async function exportRecorder(opts: ExportOptions): Promise<ExportResult> {
  const { durationSec, w, h, total } = clampOpts(opts);
  const fps = opts.fps;
  const mime = recorderMime();
  if (!mime) throw new Error("MediaRecorder is not available");
  const renderer = makeOfflineRenderer(opts, w, h, loopLengthMs(opts, durationSec));
  const canvas = renderer.getCanvas();
  const stream = canvas.captureStream(0);
  const track = stream.getVideoTracks()[0] as MediaStreamTrack & { requestFrame?: () => void };
  const chunks: Blob[] = [];
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: bitrateFor(w, h, fps) });
  rec.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data);
  };
  const stopped = new Promise<void>((resolve) => {
    rec.onstop = () => resolve();
  });

  try {
    opts.onProgress?.({ phase: "prepare", done: 0, total, fraction: 0 });
    renderer.render(0);
    rec.start(500);
    const t0 = performance.now();
    for (let i = 0; i < total; i++) {
      checkAbort(opts.signal);
      const due = t0 + (i * 1000) / fps;
      const wait = due - performance.now();
      if (wait > 1) await new Promise((r) => setTimeout(r, wait));
      renderer.render((i * 1000) / fps);
      if (track.requestFrame) track.requestFrame();
      opts.onProgress?.({ phase: "render", done: i + 1, total, fraction: (i + 1) / total });
    }
    // hold the last frame for one frame period so it is not cut off
    await new Promise((r) => setTimeout(r, 1000 / fps + 60));
    opts.onProgress?.({ phase: "finish", done: total, total, fraction: 1 });
    rec.stop();
    await stopped;
    const ext: "mp4" | "webm" = mime.startsWith("video/mp4") ? "mp4" : "webm";
    const type = ext === "mp4" ? "video/mp4" : "video/webm";
    return { blob: new Blob(chunks, { type }), ext, mime: type, engine: "recorder", label: `${ext.toUpperCase()} (realtime capture)` };
  } finally {
    if (rec.state !== "inactive") {
      try {
        rec.stop();
      } catch {
        /* ignore */
      }
    }
    stream.getTracks().forEach((t) => t.stop());
    renderer.dispose();
  }
}

export function timestampName(ext: string): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `motefield-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.${ext}`;
}

export function embedSnippet(ext: string): string {
  return `<!-- Optional: add poster="motefield-poster.png" (from "Download poster") so a still shows before the video loads. -->
<video src="motefield.${ext}" autoplay muted loop playsinline preload="metadata" style="width:100%;height:auto"></video>`;
}
