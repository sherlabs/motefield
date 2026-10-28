"use client";

import { useEffect, useRef, useState } from "react";
import type { RenderParams } from "@/lib/gl/renderer";
import type { SceneData } from "@/lib/scene/types";
import {
  MAX_DURATION,
  MIN_DURATION,
  RESOLUTIONS,
  ExportCancelled,
  detectCapability,
  embedSnippet,
  exportPoster,
  exportVideo,
  timestampName,
  type Capability,
  type ExportResult,
  type ResolutionId,
} from "@/lib/export/exporter";

interface Props {
  scenes: SceneData[];
  sceneIndex: number;
  params: RenderParams;
}

type Fps = 24 | 30 | 60;

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export default function ExportPanel({ scenes, sceneIndex, params }: Props) {
  const [duration, setDuration] = useState(8);
  const [fps, setFps] = useState<Fps>(30);
  const [resolution, setResolution] = useState<ResolutionId>("1080p");
  const [seamless, setSeamless] = useState(true);
  const [cycleAll, setCycleAll] = useState(false);
  const [cap, setCap] = useState<Capability | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [result, setResult] = useState<{ res: ExportResult; url: string; name: string } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const urlRef = useRef<string | null>(null);

  useEffect(() => {
    let live = true;
    detectCapability(resolution, fps).then((c) => {
      if (live) setCap(c);
    });
    return () => {
      live = false;
    };
  }, [resolution, fps]);

  useEffect(
    () => () => {
      abortRef.current?.abort();
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    },
    [],
  );

  const options = () => ({
    scenes,
    params,
    sceneIndex,
    cycleAll: cycleAll && scenes.length > 1,
    durationSec: duration,
    fps,
    resolution,
    seamless,
  });

  const start = async () => {
    if (running || !scenes.length) return;
    const ac = new AbortController();
    abortRef.current = ac;
    setRunning(true);
    setProgress(0);
    setMessage(null);
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = null;
    setResult(null);
    try {
      const res = await exportVideo({
        ...options(),
        signal: ac.signal,
        onProgress: (p) => setProgress(p.fraction),
      });
      const url = URL.createObjectURL(res.blob);
      urlRef.current = url;
      const name = timestampName(res.ext);
      setResult({ res, url, name });
      setMessage(`Done: ${res.label}, ${(res.blob.size / 1048576).toFixed(1)} MB`);
    } catch (e) {
      setMessage(e instanceof ExportCancelled ? "Cancelled" : `Export failed: ${(e as Error).message}`);
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  };

  const cancel = () => abortRef.current?.abort();

  const poster = async () => {
    try {
      const blob = await exportPoster(options());
      download(blob, timestampName("png").replace("motefield-", "motefield-poster-"));
    } catch (e) {
      setMessage(`Poster failed: ${(e as Error).message}`);
    }
  };

  const copyEmbed = async () => {
    const ext = result?.res.ext ?? cap?.ext ?? "mp4";
    try {
      await navigator.clipboard.writeText(embedSnippet(ext));
      setMessage(`Embed code copied. Host the file as motefield.${ext}.`);
    } catch {
      setMessage("Clipboard blocked by the browser. Select and copy manually.");
    }
  };

  const noScenes = scenes.length === 0;

  return (
    <div className="controls export">
      <h2>Export video</h2>
      <div className="ctl seg">
        <span className="lbl">Size</span>
        <div className="segbtns wrap">
          {(Object.keys(RESOLUTIONS) as ResolutionId[]).map((id) => (
            <button key={id} type="button" className={resolution === id ? "on" : ""} disabled={running} onClick={() => setResolution(id)}>
              {RESOLUTIONS[id].label}
            </button>
          ))}
        </div>
      </div>
      <div className="ctl seg">
        <span className="lbl">FPS</span>
        <div className="segbtns">
          {([24, 30, 60] as Fps[]).map((f) => (
            <button key={f} type="button" className={fps === f ? "on" : ""} disabled={running} onClick={() => setFps(f)}>
              {f}
            </button>
          ))}
        </div>
      </div>
      <label className="ctl">
        <span className="lbl">Length</span>
        <input type="range" min={MIN_DURATION} max={MAX_DURATION} step={1} value={duration} disabled={running} onChange={(e) => setDuration(parseInt(e.target.value, 10))} />
        <span className="val">{duration}s</span>
      </label>
      <div className="row">
        <button type="button" className={"tog" + (seamless ? " on" : "")} aria-pressed={seamless} disabled={running} onClick={() => setSeamless((v) => !v)}>
          Seamless loop
        </button>
        {scenes.length > 1 ? (
          <button type="button" className={"tog" + (cycleAll ? " on" : "")} aria-pressed={cycleAll} disabled={running} onClick={() => setCycleAll((v) => !v)}>
            All pictures
          </button>
        ) : null}
      </div>
      <p className="note">
        {cap ? `You will get: ${cap.label}` : "Checking browser support"}. The interface is not part of the video. Pointer wakes and hand-fired flashes are left out; FLASH AUTO keeps the scheduled ones.
        {cap?.engine === "recorder" ? ` Realtime capture takes about ${duration}s; keep this tab visible.` : ""}
      </p>
      <div className="row">
        {running ? (
          <button type="button" className="btn" onClick={cancel}>
            Cancel
          </button>
        ) : (
          <button type="button" className="btn on" disabled={noScenes || !cap?.engine} onClick={start}>
            Render video
          </button>
        )}
        <button type="button" className="btn ghost" disabled={noScenes || running} onClick={poster}>
          Download poster (PNG)
        </button>
      </div>
      {running || progress > 0 ? (
        <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}>
          <div style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
      ) : null}
      {message ? <p className="note" role="status">{message}</p> : null}
      {result ? (
        <>
          <video className="preview" src={result.url} autoPlay muted loop playsInline controls />
          <div className="row">
            <button type="button" className="btn on" onClick={() => download(result.res.blob, result.name)}>
              Download .{result.res.ext}
            </button>
            <button type="button" className="btn" onClick={copyEmbed}>
              Copy embed code
            </button>
          </div>
        </>
      ) : (
        <div className="row">
          <button type="button" className="btn ghost" onClick={copyEmbed}>
            Copy embed code
          </button>
        </div>
      )}
      <p className="note">Tip: add the poster PNG as the video&apos;s poster attribute so a still shows while it loads.</p>
    </div>
  );
}
