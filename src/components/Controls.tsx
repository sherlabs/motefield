"use client";

import { useRef } from "react";
import type { MotionMode, RenderParams, ToneMode, WindLine } from "@/lib/gl/renderer";
import type { DrawFlags } from "@/lib/hud/trackers";

export const FLASH_SWATCHES: { name: string; hex: string; rgb: [number, number, number] }[] = [
  { name: "Warm", hex: "#ffe9c4", rgb: [1, 0.914, 0.769] },
  { name: "Mint", hex: "#62e6c4", rgb: [0.384, 0.902, 0.769] },
  { name: "Ice", hex: "#bfe0ff", rgb: [0.75, 0.878, 1] },
  { name: "Gold", hex: "#ffb63a", rgb: [1, 0.714, 0.227] },
  { name: "Ember", hex: "#ff5a3c", rgb: [1, 0.353, 0.235] },
  { name: "Violet", hex: "#9c6bff", rgb: [0.612, 0.42, 1] },
];

interface Props {
  params: RenderParams;
  onChange: (p: Partial<RenderParams>) => void;
  flags: DrawFlags;
  onFlags: (f: Partial<DrawFlags>) => void;
  many: boolean;
  onMany: (m: boolean) => void;
  /** the current picture's setting; null when it has no backdrop to remove */
  removeBg: boolean | null;
  onRemoveBg: (on: boolean, all: boolean) => void;
}

function Slider(props: { id: string; label: string; value: number; max?: number; onChange: (v: number) => void }) {
  const { id, label, value, max = 1, onChange } = props;
  const pct = Math.round((value / max) * 100);
  return (
    <label className="slider" htmlFor={id}>
      <span className="slider-head">
        <span>{label}</span>
        <em>{pct}</em>
      </span>
      <input id={id} type="range" min={0} max={100} step={1} value={pct} aria-label={label} onChange={(e) => onChange((parseInt(e.target.value, 10) / 100) * max)} />
    </label>
  );
}

function Chips<T extends string>(props: { label: string; value: T; options: { v: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="group" role="group" aria-label={props.label}>
      <span className="group-label">{props.label}</span>
      <div className="chips">
        {props.options.map((o) => (
          <button key={o.v} type="button" className={"chip" + (props.value === o.v ? " on" : "")} aria-pressed={props.value === o.v} onClick={() => props.onChange(o.v)}>
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * The SHORE widget: a small pad showing the line where the field frays into
 * the wind. Drag the middle to move it, drag an end to turn it, click a side
 * to choose which side blows away.
 */
function ShorePad({ line, onChange }: { line: WindLine; onChange: (l: WindLine) => void }) {
  const ref = useRef<SVGSVGElement>(null);
  const drag = useRef<{ kind: "move" | "turn"; flip: boolean; px: number; py: number; x: number; y: number } | null>(null);
  const toPad = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * 2.6 - 1.3, y: -(((e.clientY - r.top) / r.height) * 2.6 - 1.3) };
  };
  const clamp = (v: number) => Math.max(-1.1, Math.min(1.1, v));
  const onDown = (e: React.PointerEvent) => {
    const p = toPad(e);
    const c = Math.cos(line.ang);
    const s = Math.sin(line.ang);
    const dx = p.x - line.x;
    const dy = p.y - line.y;
    const alongL = dx * c + dy * s;
    const across = -dx * s + dy * c;
    if (Math.abs(across) > 0.24) {
      onChange({ ...line, side: across < 0 ? -1 : 1 });
      return;
    }
    drag.current = { kind: Math.abs(alongL) > 0.42 ? "turn" : "move", flip: alongL < 0, px: p.x, py: p.y, x: line.x, y: line.y };
    ref.current!.setPointerCapture(e.pointerId);
    e.preventDefault();
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const p = toPad(e);
    if (d.kind === "move") onChange({ ...line, x: clamp(d.x + p.x - d.px), y: clamp(d.y + p.y - d.py) });
    else {
      const dx = p.x - line.x;
      const dy = p.y - line.y;
      if (Math.hypot(dx, dy) > 0.08) onChange({ ...line, ang: Math.atan2(dy, dx) + (d.flip ? Math.PI : 0) });
    }
  };
  const onUp = () => {
    drag.current = null;
  };
  const onKey = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 3 : 1;
    if (e.key === "ArrowLeft") onChange({ ...line, ang: line.ang + 0.05 * step });
    else if (e.key === "ArrowRight") onChange({ ...line, ang: line.ang - 0.05 * step });
    else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      const d = (e.key === "ArrowUp" ? 0.04 : -0.04) * step * line.side;
      onChange({ ...line, x: clamp(line.x - Math.sin(line.ang) * d), y: clamp(line.y + Math.cos(line.ang) * d) });
    } else if (e.key.toLowerCase() === "f") onChange({ ...line, side: line.side === 1 ? -1 : 1 });
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  const tx = Math.cos(line.ang);
  const ty = Math.sin(line.ang);
  const nx = -ty * line.side;
  const ny = tx * line.side;
  const stem = 0.45;
  return (
    <div className="group shore">
      <span className="group-label">Shore</span>
      <svg
        ref={ref}
        viewBox="-1.3 -1.3 2.6 2.6"
        tabIndex={0}
        role="slider"
        aria-label="Shore line: drag to move, drag an end to turn, click a side to choose which side blows away"
        aria-valuetext={`angle ${Math.round((line.ang * 180) / Math.PI)} degrees`}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onKeyDown={onKey}
      >
        <rect x="-1" y="-1" width="2" height="2" className="pad-frame" />
        <g transform={`matrix(${tx} ${-ty} ${nx} ${-ny} ${line.x} ${-line.y})`}>
          <rect x="-3" y="0" width="6" height="3" className="pad-side" />
        </g>
        <line x1={line.x - 4 * tx} y1={-(line.y - 4 * ty)} x2={line.x + 4 * tx} y2={-(line.y + 4 * ty)} className="pad-line" />
        <line x1={line.x} y1={-line.y} x2={line.x + nx * stem} y2={-(line.y + ny * stem)} className="pad-stem" />
        <circle cx={line.x + nx * stem} cy={-(line.y + ny * stem)} r="0.07" className="pad-tip" />
        <circle cx={line.x + 0.72 * tx} cy={-(line.y + 0.72 * ty)} r="0.05" className="pad-end" />
        <circle cx={line.x - 0.72 * tx} cy={-(line.y - 0.72 * ty)} r="0.05" className="pad-end" />
      </svg>
    </div>
  );
}

/** The dock along the bottom: sliders, overlay toggles, motion, paper, flash colour, backdrop. */
export default function Controls({ params, onChange, flags, onFlags, many, onMany, removeBg, onRemoveBg }: Props) {
  const toggle = (k: keyof DrawFlags) => {
    const on = !flags[k];
    onFlags({ [k]: on });
    if (k === "sweep") onChange({ sweep: on });
    if (k === "streaks") onChange({ streaks: on });
  };
  return (
    <div className="dock">
      <div className="dock-col sliders">
        <Slider id="wind" label="Wind" value={params.wind} onChange={(wind) => onChange({ wind })} />
        <Slider id="scatter" label="Scatter" value={params.scatter} onChange={(scatter) => onChange({ scatter })} />
        <Slider id="cohesion" label="Cohesion" value={params.cohesion} onChange={(cohesion) => onChange({ cohesion })} />
        <Slider id="relief" label="Relief" value={params.relief} max={1.5} onChange={(relief) => onChange({ relief })} />
      </div>

      <ShorePad line={params.line} onChange={(line) => onChange({ line })} />

      <div className="dock-col">
        <div className="group" role="group" aria-label="Overlay">
          <span className="group-label">Overlay</span>
          <div className="chips">
            {(["tags", "web", "sweep", "streaks", "labels"] as const).map((k) => (
              <button key={k} type="button" className={"chip" + (flags[k] ? " on" : "")} aria-pressed={flags[k]} onClick={() => toggle(k)}>
                {k}
              </button>
            ))}
          </div>
        </div>
        <Chips
          label="Tags"
          value={many ? "many" : "few"}
          options={[
            { v: "few", label: "Few" },
            { v: "many", label: "Many" },
          ]}
          onChange={(v) => onMany(v === "many")}
        />
        <Chips<MotionMode>
          label="Motion"
          value={params.motion}
          options={[
            { v: "flock", label: "Flock" },
            { v: "flow", label: "Flow" },
          ]}
          onChange={(motion) => onChange({ motion })}
        />
      </div>

      <div className="dock-col">
        <div className="group" role="group" aria-label="Paper">
          <span className="group-label">Paper</span>
          <div className="chips">
            <button type="button" className={"chip" + (params.paper ? " on" : "")} aria-pressed={params.paper} onClick={() => onChange({ paper: !params.paper })}>
              {params.paper ? "On" : "Off"}
            </button>
            {(["true", "invert"] as ToneMode[]).map((m) => (
              <button key={m} type="button" className={"chip" + (params.tone === m ? " on" : "")} aria-pressed={params.tone === m} onClick={() => onChange({ tone: m })}>
                {m}
              </button>
            ))}
          </div>
        </div>
        <div className="group" role="group" aria-label="Flash colour">
          <span className="group-label">Flash</span>
          <div className="chips">
            <button type="button" className={"chip" + (params.light ? " on" : "")} aria-pressed={params.light} title="Flashes go off by themselves (also in exports)" onClick={() => onChange({ light: !params.light })}>
              Auto
            </button>
            {FLASH_SWATCHES.map((s) => {
              const active = s.rgb.every((c, i) => Math.abs(c - params.lightColor[i]) < 1e-3);
              return (
                <button
                  key={s.name}
                  type="button"
                  title={s.name}
                  aria-label={`Flash colour ${s.name}`}
                  aria-pressed={active}
                  className={"sw" + (active ? " on" : "")}
                  style={{ background: s.hex }}
                  onClick={() => onChange({ lightColor: s.rgb })}
                />
              );
            })}
            <label className="sw pick" title="Any colour">
              <input type="color" aria-label="Flash colour, any" value={rgbToHex(params.lightColor)} onChange={(e) => onChange({ lightColor: hexToRgb(e.target.value) })} />
            </label>
          </div>
        </div>
        <div className={"group" + (removeBg === null ? " off" : "")} role="group" aria-label="Remove background" title={removeBg === null ? "No background to remove in this picture" : "Shift-click to apply to all pictures"}>
          <span className="group-label">Remove background</span>
          {removeBg === null ? (
            <span className="group-note">no background to remove</span>
          ) : (
            <div className="chips">
              {[true, false].map((on) => (
                <button key={String(on)} type="button" className={"chip" + (removeBg === on ? " on" : "")} aria-pressed={removeBg === on} onClick={(e) => onRemoveBg(on, e.shiftKey)}>
                  {on ? "On" : "Off"}
                </button>
              ))}
              <button type="button" className="chip dim" title="Apply this picture's setting to all pictures" onClick={() => onRemoveBg(removeBg, true)}>
                All
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function rgbToHex(c: [number, number, number]): string {
  return "#" + c.map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("");
}

function hexToRgb(h: string): [number, number, number] {
  const n = parseInt(h.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
