"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Controls from "./Controls";
import ExportPanel from "./ExportPanel";
import Overlay from "./hud/Overlay";
import { About, Hint, Strip, ToolRail, TopBar, type StripSlot } from "./hud/Chrome";
import { DepthEstimator, type DepthStatus } from "@/lib/depth/client";
import { DEFAULT_PARAMS, PointCloudRenderer, type RenderParams } from "@/lib/gl/renderer";
import type { DrawFlags } from "@/lib/hud/trackers";
import { MatteEstimator, type MatteStatus } from "@/lib/matte/client";
import type { Matte } from "@/lib/matte/process";
import { brightnessDepth, buildSceneData, hasOwnBackdrop } from "@/lib/scene/build";
import { makeDemoPictures } from "@/lib/scene/demos";
import { POINT_COUNT, type DepthMap, type SceneData } from "@/lib/scene/types";

const MAX_PICTURES = 4;
const WORK_LONG_SIDE = 1024;
const HINT = "Drop up to four pictures here · Space for the next one · S for a flash of light";

interface Slot extends StripSlot {
  data: SceneData;
  /** photos keep their source and cached model results so they can be dealt again at once */
  source?: { canvas: HTMLCanvasElement; depth: DepthMap; matte: Matte | null; matteDone: boolean };
  /** a photo whose backdrop can be removed (null: nothing to remove) */
  removeBg: boolean | null;
}

const tick = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

function thumbOf(src: HTMLCanvasElement): string {
  const c = document.createElement("canvas");
  c.width = c.height = 84;
  const s = Math.min(src.width, src.height);
  c.getContext("2d")!.drawImage(src, (src.width - s) / 2, (src.height - s) / 2, s, s, 0, 0, 84, 84);
  return c.toDataURL("image/jpeg", 0.8);
}

/** Decode a File, scale it to fit the working size, return the canvas. */
async function fileToCanvas(file: File): Promise<HTMLCanvasElement> {
  const bmp = await createImageBitmap(file);
  const s = Math.min(1, WORK_LONG_SIDE / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.max(8, Math.round(bmp.width * s));
  c.height = Math.max(8, Math.round(bmp.height * s));
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  return c;
}

function matteLabel(s: MatteStatus, everUploaded: boolean, fallback: boolean): string {
  if (!everUploaded && s.mode === "idle") return "not needed yet";
  switch (s.mode) {
    case "idle":
      return "ready";
    case "loading":
      return `fetching MODNet ${s.bytes ? (s.bytes / 1048576).toFixed(0) + " MB" : ""}`.trim();
    case "model":
      return "MODNet" + (fallback ? " · depth cut for this one" : "");
    case "off":
      return "unavailable, cutting by depth";
  }
}

function statusLabel(s: DepthStatus, everUploaded: boolean, reading: boolean): string {
  if (!everUploaded && s.mode === "idle") return "loads with your first photo";
  switch (s.mode) {
    case "idle":
      return "ready";
    case "loading":
      return `fetching Depth Anything ${Math.round(s.progress * 100)}%`;
    case "model":
      return "Depth Anything V2" + (reading ? " · reading" : "");
    case "fallback":
      return "unavailable, using luminance";
  }
}

export default function Studio() {
  const stageRef = useRef<HTMLDivElement>(null);
  const [renderer, setRenderer] = useState<PointCloudRenderer | null>(null);
  const rendererRef = useRef<PointCloudRenderer | null>(null);
  const [glError, setGlError] = useState<string | null>(null);
  const [params, setParams] = useState<RenderParams>(DEFAULT_PARAMS);
  const [flags, setFlags] = useState<DrawFlags>({ tags: true, web: true, sweep: false, streaks: false, labels: true });
  const [many, setMany] = useState(false);
  const [cycling, setCycling] = useState(false);
  const [matteStatus, setMatteStatus] = useState<MatteStatus>({ mode: "idle", progress: 0, bytes: 0 });
  const matter = useRef<MatteEstimator | null>(null);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [depthStatus, setDepthStatus] = useState<DepthStatus>({ mode: "idle", progress: 0 });
  const [reading, setReading] = useState(0);
  const [everUploaded, setEverUploaded] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [hint, setHint] = useState<string | null>(HINT);
  const [hideUi, setHideUi] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [resetToken, setResetToken] = useState({ n: 0, flightSec: 0 });
  const estimator = useRef<DepthEstimator | null>(null);
  const nextId = useRef(1);
  const clock0 = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const touched = useRef(false);
  const slotsRef = useRef<Slot[]>([]);
  useEffect(() => {
    slotsRef.current = slots;
  }, [slots]);

  const now = () => performance.now() - clock0.current;

  // ---- renderer lifecycle + frame loop ----
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    let r: PointCloudRenderer;
    try {
      r = new PointCloudRenderer();
    } catch (e) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setGlError(String((e as Error).message ?? e));
      return;
    }
    const canvas = r.getCanvas();
    canvas.className = "stage-canvas";
    stage.appendChild(canvas);
    rendererRef.current = r;
    clock0.current = performance.now();
    setRenderer(r);

    const fit = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = stage.clientWidth;
      const h = stage.clientHeight;
      r.resize(w * dpr, h * dpr, dpr);
      const narrow = w < 760;
      r.setInset(narrow ? { top: 120, bottom: 230, left: 8, right: 8 } : { top: 60, bottom: 150, left: 90, right: 90 });
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(stage);

    let raf = 0;
    const loop = () => {
      r.render(performance.now() - clock0.current);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.remove();
      r.dispose();
      rendererRef.current = null;
      setRenderer(null);
    };
  }, []);

  useEffect(() => {
    renderer?.setParams(params);
  }, [renderer, params]);

  // development hook: lets a script build an offline renderer from the live scenes (loop seam checks)
  const paramsRef = useRef(params);
  useEffect(() => {
    paramsRef.current = params;
    if (process.env.NODE_ENV === "production") return;
    (window as unknown as { __motefieldDebug?: unknown }).__motefieldDebug = {
      PointCloudRenderer,
      scenes: () => slotsRef.current.map((s) => s.data),
      slots: () => slotsRef.current,
      matter: () => matter.current,
      params: () => paramsRef.current,
    };
  }, [params]);

  // hint fades by itself
  useEffect(() => {
    if (!hint) return;
    const id = setTimeout(() => setHint(null), 14000);
    return () => clearTimeout(id);
  }, [hint]);

  // ---- scenes -> renderer ----
  const seek = useCallback(() => {
    const r = rendererRef.current;
    setResetToken((t) => ({ n: t.n + 1, flightSec: r ? r.flightSeconds() : 0 }));
  }, []);

  useEffect(() => {
    if (!renderer) return;
    renderer.setScenes(slots.map((s) => s.data));
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIndex(0);
    seek();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renderer, slots.length, slots.map((s) => s.id).join(",")]);

  // ---- demo pictures on first load ----
  const buildDemos = useCallback(async () => {
    setBusy("Drawing the sample pictures");
    await tick();
    const built: Slot[] = [];
    for (const d of makeDemoPictures()) {
      built.push({ id: nextId.current++, name: d.name, thumb: thumbOf(d.canvas), demo: true, removeBg: null, data: buildSceneData(d.canvas, d.depth, { seed: 100 + built.length }) });
      await tick();
    }
    setSlots(built);
    setBusy(null);
  }, []);

  useEffect(() => {
    if (!renderer) return;
    let cancelled = false;
    (async () => {
      if (cancelled) return;
      await buildDemos();
    })();
    return () => {
      cancelled = true;
    };
  }, [renderer, buildDemos]);

  // ---- actions ----
  const patch = useCallback((p: Partial<RenderParams>) => setParams((prev) => ({ ...prev, ...p })), []);

  const goTo = useCallback(
    (i: number) => {
      const r = rendererRef.current;
      const n = r?.getSceneCount() ?? 0;
      if (!r || !n) return;
      r.goTo(i, now());
      setCycling(false);
      setIndex(((i % n) + n) % n);
      seek();
    },
    [seek],
  );

  const next = useCallback(() => {
    const r = rendererRef.current;
    if (!r || !r.getSceneCount()) return;
    goTo(r.currentSceneIndex() + 1);
  }, [goTo]);

  const light = useCallback(() => rendererRef.current?.fireLamp(now()), []);

  const toggleCycle = useCallback(() => {
    const r = rendererRef.current;
    if (!r) return;
    touched.current = true;
    setCycling((on) => {
      r.setAuto(!on, now());
      return !on;
    });
  }, []);
  useEffect(() => {
    if (!cycling) return;
    const id = setInterval(() => {
      const r = rendererRef.current;
      if (r) setIndex((i) => (i === r.currentSceneIndex() ? i : r.currentSceneIndex()));
    }, 200);
    return () => clearInterval(id);
  }, [cycling]);

  // idle on the demos: turn the page by itself until the visitor does
  useEffect(() => {
    if (!slots.length || !slots.every((s) => s.demo)) return;
    const id = setInterval(() => {
      if (!touched.current && document.visibilityState === "visible") next();
    }, 6500);
    return () => clearInterval(id);
  }, [slots, next]);

  /** Place a photo's motes again from its cached source (no model runs); the field flows across. */
  const rebuilt = useCallback((s: Slot): Slot => {
    if (!s.source) return s;
    const remove = s.removeBg === true;
    const data = buildSceneData(s.source.canvas, s.source.depth, {
      photo: s.removeBg !== null,
      keepBackground: !remove,
      matte: remove ? (s.source.matte ?? undefined) : undefined,
      seed: s.id + (remove ? 7 : 13),
    });
    return { ...s, data, waiting: remove && !s.source.matteDone };
  }, []);

  const updateSource = useCallback(
    (id: number, patch: Partial<NonNullable<Slot["source"]>>) => {
      const r = rendererRef.current;
      setSlots((prev) =>
        prev.map((s, i) => {
          if (s.id !== id || !s.source) return s;
          const next = rebuilt({ ...s, source: { ...s.source, ...patch } });
          r?.replaceScene(i, next.data);
          return next;
        }),
      );
    },
    [rebuilt],
  );

  const addFiles = useCallback(async (files: File[]) => {
    const images = files.filter((f) => f.type.startsWith("image/") || /\.(png|jpe?g|webp|gif|avif|bmp)$/i.test(f.name));
    if (!images.length) return;
    setEverUploaded(true);
    touched.current = true;
    if (!estimator.current) {
      estimator.current = new DepthEstimator();
      estimator.current.onStatus = (s) => setDepthStatus({ ...s });
      void estimator.current.init();
    }
    const est = estimator.current;
    const room = MAX_PICTURES - slotsRef.current.filter((s) => !s.demo).length;
    if (room <= 0) {
      setHint("Four pictures is the limit. Take one out with × to add another");
      return;
    }
    const batch = images.slice(0, room);
    for (const file of batch) {
      let canvas: HTMLCanvasElement;
      try {
        canvas = await fileToCanvas(file);
      } catch {
        setHint(`"${file.name}" is not a picture the browser can read`);
        continue;
      }
      // show it at once with brightness depth, then let the models refine it
      setBusy(`Placing ${POINT_COUNT.toLocaleString("en-US")} motes`);
      await tick();
      const raw = canvas.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, canvas.width, canvas.height).data;
      const ownBackdrop = hasOwnBackdrop(raw, canvas.width, canvas.height);
      const px = canvas.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, canvas.width, canvas.height).data;
      const quick = brightnessDepth(px, canvas.width, canvas.height);
      const id = nextId.current++;
      const name = file.name.replace(/\.[^.]+$/, "").slice(0, 24) || "Picture";
      const slot: Slot = {
        id,
        name,
        thumb: thumbOf(canvas),
        demo: false,
        waiting: true,
        removeBg: ownBackdrop ? null : true,
        source: { canvas, depth: quick, matte: null, matteDone: ownBackdrop },
        data: buildSceneData(canvas, quick, { photo: !ownBackdrop, keepBackground: false, seed: id }),
      };
      setSlots((prev) => [...prev.filter((s) => !s.demo), slot].slice(-MAX_PICTURES));
      setBusy(null);
      setReading((n) => n + 1);
      // depth and matte run side by side; each result is cached on the slot and the motes are placed again
      void (async () => {
        try {
          const depth = await est.estimate(canvas);
          updateSource(id, { depth });
        } finally {
          setReading((n) => n - 1);
        }
      })();
      if (!ownBackdrop) {
        if (!matter.current) {
          matter.current = new MatteEstimator();
          matter.current.onStatus = (s) => setMatteStatus({ ...s });
        }
        void (async () => {
          let matte: Matte | null = null;
          try {
            matte = await matter.current!.estimate(canvas);
          } catch (e) {
            console.warn("[matte]", e);
          }
          updateSource(id, { matte, matteDone: true });
        })();
      }
      await tick();
    }
    if (images.length > room) setHint(`Only the first ${room} fit. Four pictures is the limit`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // REMOVE BACKGROUND, per picture (or all): live, from the cache
  const setRemoveBg = useCallback(
    (on: boolean, all: boolean) => {
      const r = rendererRef.current;
      const cur = Math.max(0, index);
      setSlots((prev) =>
        prev.map((s, i) => {
          if (s.removeBg === null || (!all && i !== cur) || s.removeBg === on) return s;
          const next = rebuilt({ ...s, removeBg: on });
          r?.replaceScene(i, next.data);
          return next;
        }),
      );
    },
    [index, rebuilt],
  );

  const removeSlot = useCallback(
    (id: number) => {
      setSlots((prev) => prev.filter((s) => s.id !== id));
      if (slotsRef.current.length <= 1) void buildDemos();
    },
    [buildDemos],
  );

  const toggleFullscreen = useCallback(() => {
    const el = document.documentElement;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el.requestFullscreen?.().catch(() => setHint("This page is not allowed to go full screen here"));
  }, []);

  useEffect(() => {
    const onFs = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  // ---- keyboard ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      const typing = el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA") && (el as HTMLInputElement).type !== "range";
      if (typing) return;
      if (el && el.tagName === "svg") return; // the line pad handles its own arrows
      const key = e.key.toLowerCase();
      touched.current = true;
      if (e.code === "Space") {
        e.preventDefault();
        next();
      } else if (key === "s") light();
      else if (key >= "1" && key <= "4") goTo(Number(key) - 1);
      else if (key === "arrowright") next();
      else if (key === "arrowleft") goTo((rendererRef.current?.currentSceneIndex() ?? 0) - 1);
      else if (key === "m") patch({ motion: rendererRef.current?.getParams().motion === "flock" ? "flow" : "flock" });
      else if (key === "b") patch({ paper: !rendererRef.current?.getParams().paper });
      else if (key === "h") setHideUi((v) => !v);
      else if (key === "f") toggleFullscreen();
      else if (key === "escape") {
        setAboutOpen(false);
        setExportOpen(false);
      }
    };
    // Space already turned the page on keydown: do not let it also click a focused button
    const onKeyUp = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (e.key === " " && el?.closest?.("button,label")) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyUp, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKeyUp, true);
    };
  }, [next, light, goTo, patch, toggleFullscreen]);

  // ---- drag & drop ----
  useEffect(() => {
    const over = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes("Files")) {
        e.preventDefault();
        setDragging(true);
      }
    };
    const leave = (e: DragEvent) => {
      if (e.relatedTarget === null) setDragging(false);
    };
    const drop = (e: DragEvent) => {
      e.preventDefault();
      setDragging(false);
      if (e.dataTransfer?.files.length) void addFiles(Array.from(e.dataTransfer.files));
    };
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  }, [addFiles]);

  // ---- pointer: a hand through the motes, or a drag to turn the field ----
  const drag = useRef<{ x: number; y: number } | null>(null);
  const trail = useRef<{ x: number; y: number; t: number } | null>(null);
  const mark = useRef<{ x: number; y: number; t: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    touched.current = true;
    drag.current = { x: e.clientX, y: e.clientY };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = rendererRef.current;
    if (!r) return;
    if (drag.current) {
      r.orbitBy(e.clientX - drag.current.x, e.clientY - drag.current.y);
      drag.current = { x: e.clientX, y: e.clientY };
      return;
    }
    if (e.pointerType !== "mouse") return;
    const rect = e.currentTarget.getBoundingClientRect();
    const t = now() / 1000;
    const x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const y = 1 - ((e.clientY - rect.top) / rect.height) * 2;
    const prev = trail.current;
    trail.current = { x, y, t };
    if (!prev || t - prev.t > 0.2 || t <= prev.t) {
      mark.current = { x, y, t };
      return;
    }
    const aspect = rect.width / rect.height;
    const vx = ((x - prev.x) * aspect) / (t - prev.t);
    const vy = (y - prev.y) / (t - prev.t);
    const speed = Math.hypot(vx, vy);
    const m = mark.current ?? prev;
    if (speed < 0.12 || (Math.hypot((x - m.x) * aspect, y - m.y) < 0.045 && t - m.t < 0.09)) return;
    mark.current = { x, y, t };
    r.addWake(x, y, vx / speed, vy / speed, speed, now());
  };
  const onPointerUp = () => {
    drag.current = null;
  };
  const onWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    rendererRef.current?.zoomBy(Math.exp(0.0022 * Math.max(-60, Math.min(60, e.deltaY))));
  };

  const current = slots[Math.min(index, Math.max(0, slots.length - 1))];
  const feats = current?.data.feats ?? [];
  const full = slots.filter((s) => !s.demo).length >= MAX_PICTURES;

  return (
    <main className={"studio" + (hideUi ? " hide-ui" : "") + (params.paper ? " paper" : "")}>
      <div
        className="stage"
        ref={stageRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
        onDoubleClick={() => rendererRef.current?.resetView()}
        onContextMenu={(e) => e.preventDefault()}
      >
        {glError ? <p className="gl-error">WebGL2 is required: {glError}</p> : null}
      </div>
      <Overlay
        renderer={renderer}
        feats={feats}
        flags={flags}
        dense={many}
        info={{ index: Math.max(0, index), count: slots.length, name: current?.name ?? "", points: POINT_COUNT }}
        resetToken={resetToken}
      />

      <div className="hud">
        <TopBar
          depth={statusLabel(depthStatus, everUploaded, reading > 0)}
          background={matteLabel(matteStatus, everUploaded, !!(current?.removeBg && current.source?.matteDone && !current.source.matte))}
          points={POINT_COUNT}
          exportOpen={exportOpen}
          onExport={() => setExportOpen((v) => !v)}
          fullscreen={fullscreen}
          onFullscreen={toggleFullscreen}
          paper={params.paper}
          onPaper={() => patch({ paper: !params.paper })}
          onAbout={() => setAboutOpen(true)}
        />
        <Hint text={hint} />
        <ToolRail onNext={next} onFlash={light} onAdd={() => fileInput.current?.click()} cycling={cycling} onCycle={toggleCycle} />
        <Strip slots={slots} index={index} onSelect={goTo} onRemove={removeSlot} onAdd={() => fileInput.current?.click()} full={full} />
        <Controls
          params={params}
          onChange={patch}
          flags={flags}
          onFlags={(f) => setFlags((p) => ({ ...p, ...f }))}
          many={many}
          onMany={setMany}
          removeBg={current?.removeBg ?? null}
          onRemoveBg={setRemoveBg}
        />
      </div>

      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        multiple
        hidden
        aria-label="Add pictures"
        onChange={(e) => {
          if (e.target.files) void addFiles(Array.from(e.target.files));
          e.target.value = "";
        }}
      />

      {busy ? <div className="busy">{busy}…</div> : null}
      {dragging ? <div className="dropveil">Drop up to four pictures</div> : null}

      <aside className={"panel" + (exportOpen ? " open" : "")} aria-hidden={!exportOpen}>
        {exportOpen ? <ExportPanel scenes={slots.map((s) => s.data)} sceneIndex={index} params={params} /> : null}
      </aside>

      {aboutOpen ? <About onClose={() => setAboutOpen(false)} /> : null}
    </main>
  );
}
