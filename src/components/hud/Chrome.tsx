"use client";

/** The still parts of the interface: top bar, tool rail, picture strip, notices. */

export interface StripSlot {
  id: number;
  name: string;
  thumb: string;
  demo: boolean;
  waiting?: boolean;
}

/** A small field of motes: the Motefield glyph. */
export function Glyph({ size = 18 }: { size?: number }) {
  const dots: [number, number, number][] = [
    [4, 5, 1.6],
    [9, 3, 1.1],
    [14, 6, 1.9],
    [6, 11, 1.2],
    [11, 10, 2.2],
    [16, 12, 1.0],
    [3, 15, 1.0],
    [9, 16, 1.5],
    [14, 15, 1.2],
  ];
  return (
    <svg className="glyph" width={size} height={size} viewBox="0 0 20 20" aria-hidden="true">
      {dots.map(([x, y, r], i) => (
        <circle key={i} cx={x} cy={y} r={r} fill="currentColor" opacity={0.55 + (i % 3) * 0.2} />
      ))}
    </svg>
  );
}

export function TopBar(props: {
  depth: string;
  background: string;
  points: number;
  exportOpen: boolean;
  onExport: () => void;
  fullscreen: boolean;
  onFullscreen: () => void;
  paper: boolean;
  onPaper: () => void;
  onAbout: () => void;
}) {
  return (
    <header className="topbar">
      <div className="wordmark">
        <Glyph />
        <span className="name">motefield</span>
      </div>
      <div className="readout" aria-live="polite">
        <span>
          <b>Depth</b> {props.depth}
        </span>
        <span>
          <b>Backdrop</b> {props.background}
        </span>
        <span>
          <b>Motes</b> {props.points.toLocaleString("en-US")}
        </span>
      </div>
      <div className="topbar-actions">
        <button type="button" className={"icon" + (props.paper ? " on" : "")} title="Paper or dark (B)" aria-pressed={props.paper} onClick={props.onPaper}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
            <path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill="currentColor" />
          </svg>
        </button>
        <button type="button" className={"icon" + (props.fullscreen ? " on" : "")} title="Full screen (F)" aria-pressed={props.fullscreen} onClick={props.onFullscreen}>
          <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.3">
            <path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" />
          </svg>
        </button>
        <button type="button" className="textbtn" onClick={props.onAbout}>
          About
        </button>
        <button type="button" className={"cta" + (props.exportOpen ? " on" : "")} aria-expanded={props.exportOpen} onClick={props.onExport}>
          Export
        </button>
      </div>
    </header>
  );
}

export function Hint({ text }: { text: string | null }) {
  return (
    <div className={"hint" + (text ? " show" : "")} aria-live="polite">
      {text ?? ""}
    </div>
  );
}

export function ToolRail(props: { onNext: () => void; onFlash: () => void; onAdd: () => void; cycling: boolean; onCycle: () => void }) {
  return (
    <nav className="toolrail" aria-label="Actions">
      <button type="button" className="tool" onClick={props.onNext} title="Next picture (Space)">
        <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4">
          <path d="M6 5l10 7-10 7z" />
          <path d="M19 5v14" />
        </svg>
        <span>Next</span>
        <kbd>Space</kbd>
      </button>
      <button type="button" className="tool" onClick={props.onFlash} title="Flash a light (S)">
        <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4">
          <circle cx="12" cy="12" r="3.5" fill="currentColor" stroke="none" />
          <path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2" />
        </svg>
        <span>Flash</span>
        <kbd>S</kbd>
      </button>
      <button type="button" className={"tool" + (props.cycling ? " on" : "")} aria-pressed={props.cycling} onClick={props.onCycle} title="Cycle through all pictures">
        <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4">
          <path d="M20 12a8 8 0 1 1-2.3-5.7" />
          <path d="M20 4v5h-5" />
        </svg>
        <span>Cycle</span>
      </button>
      <button type="button" className="tool" onClick={props.onAdd} title="Add pictures">
        <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4">
          <path d="M12 5v14M5 12h14" />
        </svg>
        <span>Add</span>
      </button>
    </nav>
  );
}

export function Strip(props: { slots: StripSlot[]; index: number; onSelect: (i: number) => void; onRemove: (id: number) => void; onAdd: () => void; full: boolean }) {
  return (
    <nav className="strip" aria-label="Pictures">
      {props.slots.map((s, i) => (
        <div key={s.id} className={"pic" + (i === props.index ? " on" : "") + (s.waiting ? " wait" : "")}>
          <button type="button" className="face" title={`${s.name} (${i + 1})`} aria-label={`Picture ${i + 1}, ${s.name}`} aria-pressed={i === props.index} onClick={() => props.onSelect(i)}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={s.thumb} alt="" />
          </button>
          <span className="num">{i + 1}</span>
          {!s.demo ? (
            <button type="button" className="x" title="Remove this picture" aria-label={`Remove picture ${i + 1}`} onClick={() => props.onRemove(s.id)}>
              ×
            </button>
          ) : null}
        </div>
      ))}
      <button type="button" className="add" title="Add pictures, up to four" aria-label="Add pictures" aria-disabled={props.full} onClick={props.onAdd}>
        +
      </button>
    </nav>
  );
}

export function About({ onClose }: { onClose: () => void }) {
  return (
    <div className="sheet-veil" role="dialog" aria-modal="true" aria-label="About Motefield" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="wordmark big">
          <Glyph size={26} />
          <span className="name">motefield</span>
        </div>
        <p>Turn pictures into living particle fields. Export loops for the web.</p>
        <p className="muted">Up to four pictures become fields of 524,288 motes with relief read from depth. Everything runs in your browser; no picture is ever uploaded.</p>
        <p className="muted">Depth: Depth Anything V2 Small (Apache-2.0). Background removal: MODNet, ONNX export by Xenova (Apache-2.0). Runtime: onnxruntime-web (MIT). Models are fetched from Hugging Face on first use.</p>
        <p className="muted">Keys: Space next · S flash · 1–4 pictures · M flock/flow · B paper · F full screen · H hide the interface · drag to turn, wheel to zoom, double-click to reset.</p>
        <p className="muted">Motefield is open source (MIT). The idea of depth-driven particle portraits is shared with other interactive web pieces, including Gather by DAO; Motefield is an independent codebase and is not affiliated with them.</p>
        <button type="button" className="chip on" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
