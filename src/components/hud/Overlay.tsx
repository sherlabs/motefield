"use client";

import { useEffect, useRef } from "react";
import type { PointCloudRenderer } from "@/lib/gl/renderer";
import { TrackerLayer, type DrawFlags, type MarksInfo } from "@/lib/hud/trackers";
import type { Feature } from "@/lib/scene/types";

interface Props {
  renderer: PointCloudRenderer | null;
  feats: Feature[];
  flags: DrawFlags;
  dense: boolean;
  info: MarksInfo;
  /** bump to make the trackers seek again; value = seconds until they may lock */
  resetToken: { n: number; flightSec: number };
}

const HZ = 30;

/** 2D canvas over the stage: trackers, links, ruler marks. Redrawn at ~30 Hz. */
export default function Overlay({ renderer, feats, flags, dense, info, resetToken }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const layer = useRef<TrackerLayer | null>(null);
  const live = useRef({ feats, flags, dense, info });
  useEffect(() => {
    live.current = { feats, flags, dense, info };
  }, [feats, flags, dense, info]);

  useEffect(() => {
    layer.current ??= new TrackerLayer(dense);
    const st = renderer?.getFrameState();
    layer.current.reset(st?.time ?? 0, resetToken.flightSec);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetToken.n]);

  useEffect(() => {
    const st = renderer?.getFrameState();
    layer.current?.setDense(dense, st?.time ?? 0);
  }, [dense, renderer]);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !renderer) return;
    let raf = 0;
    let last = 0;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      if (now - last < 1000 / HZ) return;
      last = now;
      const st = renderer.getFrameState();
      const ctx = canvas.getContext("2d");
      if (!st || !ctx) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = Math.floor(st.cssW * dpr);
      const h = Math.floor(st.cssH * dpr);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const { feats, flags, dense, info } = live.current;
      layer.current ??= new TrackerLayer(dense);
      layer.current.draw(ctx, st, (x, y, z) => renderer.project(x, y, z), feats, flags, info);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [renderer]);

  return <canvas ref={ref} className="overlay" aria-hidden="true" />;
}
