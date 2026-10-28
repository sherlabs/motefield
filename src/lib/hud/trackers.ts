import type { FrameState, Projected } from "../gl/renderer";
import type { Feature } from "../scene/types";

export interface DrawFlags {
  /** corner-bracket tags on salient points */
  tags: boolean;
  /** thin web between neighbouring tags */
  web: boolean;
  /** a plane sweeping through the relief */
  sweep: boolean;
  /** streaks behind motes on the wind */
  streaks: boolean;
  /** ruler frame and corner labels */
  labels: boolean;
}

export interface MarksInfo {
  index: number;
  count: number;
  name: string;
  points: number;
}

interface Tracker {
  /** rides the wind: picks a new home each cycle and blows away with it */
  ride: boolean;
  f: number;
  id: number;
  sx: number | null;
  sy: number | null;
  hx: number;
  hy: number;
  hopAt: number;
  lockAt: number;
  r1: number;
  r2: number;
  r3: number;
  r4: number;
  cyc: number;
  home: Feature | null;
}

interface Placed {
  t?: Tracker;
  lamp?: boolean;
  x: number;
  y: number;
  wx: number;
  wy: number;
  wz: number;
  locked: boolean;
  alpha: number;
  since: number;
  id: string;
}

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const ramp = (a: number, b: number, v: number) => {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const fmt = (v: number) => (v < 0 ? "−" : "+") + Math.abs(v).toFixed(2);

/**
 * Small corner-bracket trackers that sit on salient points of the cloud and
 * read out their coordinates, with thin links between neighbours and a ruler
 * frame around the picture. Drawn on a 2D canvas over the WebGL stage.
 */
export class TrackerLayer {
  private list: Tracker[] = [];
  private dense = false;
  private last = 0;

  constructor(dense = false) {
    this.dense = dense;
    this.reset(0, 0);
  }

  setDense(dense: boolean, now: number) {
    if (dense === this.dense) return;
    this.dense = dense;
    this.reset(now, 0.5);
  }

  /** New picture: every tracker seeks again and locks after a share of the flight. */
  reset(now: number, flightSec: number) {
    const fixed = this.dense ? 30 : 8;
    const riders = this.dense ? 8 : 3;
    const prev = this.list;
    this.list = [];
    for (let i = 0; i < fixed + riders; i++) {
      const p = prev[i];
      this.list.push({
        ride: i >= fixed,
        f: i,
        id: i + 1,
        sx: p?.sx ?? null,
        sy: p?.sy ?? null,
        hx: p?.sx ?? 0,
        hy: p?.sy ?? 0,
        hopAt: 0,
        lockAt: now + (flightSec ? flightSec * (0.5 + 0.45 * Math.random()) : 0),
        r1: Math.random(),
        r2: Math.random(),
        r3: Math.random(),
        r4: Math.random(),
        cyc: -1,
        home: null,
      });
    }
  }

  draw(
    ctx: CanvasRenderingContext2D,
    state: FrameState,
    project: (x: number, y: number, z: number) => Projected | null,
    feats: Feature[],
    flags: DrawFlags,
    info: MarksInfo,
  ) {
    const t = state.time;
    const dt = this.last ? clamp(t - this.last, 0, 0.1) : 0.016;
    this.last = t;
    if (!flags.tags && !flags.web && !flags.labels) return;

    const rgb = state.ink ? "16,16,18," : "255,255,255,";
    const inkDim = state.ink ? 0.75 : 1;
    ctx.lineWidth = 1;
    ctx.lineJoin = "round";
    ctx.font = '500 9px Manrope, "Helvetica Neue", Arial, sans-serif';
    try {
      ctx.letterSpacing = "1.5px";
    } catch {
      /* older browsers */
    }
    const stroke = (a: number, path: () => void) => {
      ctx.strokeStyle = `rgba(${rgb}${a.toFixed(3)})`;
      ctx.beginPath();
      path();
      ctx.stroke();
    };
    const text = (a: number, s: string, x: number, y: number) => {
      ctx.fillStyle = `rgba(${rgb}${a.toFixed(3)})`;
      ctx.fillText(s, x, y);
    };

    const breath = state.breath;
    const grow = 1 + 0.011 * breath;
    const zScale = state.depth * (1 + 0.1 * breath);
    const zLift = 0.014 * breath;
    const line = state.line;
    const wind = state.wind;
    const placed: Placed[] = [];

    if ((flags.tags || flags.web) && feats.length) {
      for (const tr of this.list) {
        let wx: number, wy: number, wz: number;
        let alpha = 1;
        if (tr.ride) {
          const per = 3.5 + 5.5 * tr.r1;
          const cycle = t / per + tr.r2;
          const n = Math.floor(cycle);
          const ph = cycle - n;
          if (n !== tr.cyc || !tr.home) {
            tr.cyc = n;
            const past = feats.filter((f) => (f.x - line.x) * wind.nx + (f.y - line.y) * wind.ny > 0.35);
            const pool = past.length ? past : feats;
            tr.home = pool[Math.floor(Math.random() * pool.length)] ?? { x: 0, y: 0, z: 0 };
          }
          const h = tr.home;
          wx = h.x * grow;
          wy = h.y * grow;
          wz = h.z * zScale + zLift;
          const away = wind.strength > 0.004 ? ramp(0, 1.15, (wx - line.x) * wind.nx + (wy - line.y) * wind.ny) : 0;
          if (away > 0) {
            const hold = lerp(0.82, 0.06, away);
            const gone = Math.max(0, (ph - hold) / (1 - hold));
            const tr3 = gone * Math.sqrt(gone);
            const reach = 1.8 * wind.strength * away * (0.55 + 0.9 * tr.r3);
            wx += wind.nx * reach * tr3;
            wy += wind.ny * reach * tr3;
            wz += (tr.r4 - 0.5) * tr3 * reach * 0.6;
            alpha = ramp(0, 0.07, ph) * (1 - ramp(0.3, 1, gone));
          }
        } else {
          const f = feats[tr.f % feats.length];
          wx = f.x * grow;
          wy = f.y * grow;
          wz = f.z * zScale + zLift;
        }
        const pr = project(wx, wy, wz);
        if (!pr) continue;
        if (tr.sx === null || tr.sy === null) {
          tr.sx = tr.hx = pr.x;
          tr.sy = tr.hy = pr.y;
        }
        const locked = t >= tr.lockAt;
        if (locked) {
          const k = Math.min(1, 16 * dt);
          tr.sx += (pr.x - tr.sx) * k;
          tr.sy += (pr.y - tr.sy) * k;
        } else {
          if (t >= tr.hopAt) {
            tr.hopAt = t + 0.06 + 0.13 * Math.random();
            tr.hx = tr.sx + 110 * (Math.random() - 0.5);
            tr.hy = tr.sy + 110 * (Math.random() - 0.5);
          }
          const k = Math.min(1, 11 * dt);
          tr.sx += (tr.hx - tr.sx) * k;
          tr.sy += (tr.hy - tr.sy) * k;
        }
        placed.push({ t: tr, x: tr.sx, y: tr.sy, wx, wy, wz, locked, alpha, since: t - tr.lockAt, id: String(tr.id).padStart(2, "0") });
      }
      for (const l of state.lamps) {
        if (l.strength <= 0.05) continue;
        const pr = project(l.x, l.y, l.z);
        if (pr) placed.push({ lamp: true, x: pr.x, y: pr.y, wx: l.x, wy: l.y, wz: l.z, locked: true, alpha: Math.min(1, l.strength), since: 9, id: "FLASH" });
      }
    }

    if (flags.web) {
      const maxD = this.dense ? 0.46 : 1.05;
      for (let i = 0; i < placed.length; i++) {
        const a = placed[i];
        if (!a.locked) continue;
        if (a.lamp) {
          const near = placed
            .filter((p) => !p.lamp && p.locked)
            .map((p) => ({ p, d: Math.hypot(p.wx - a.wx, p.wy - a.wy, p.wz - a.wz) }))
            .sort((p, q) => p.d - q.d)
            .slice(0, 3);
          for (const n of near) stroke(0.85 * a.alpha, () => {
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(n.p.x, n.p.y);
          });
          continue;
        }
        for (let j = i + 1; j < placed.length; j++) {
          const b = placed[j];
          if (!b.locked || b.lamp) continue;
          const d = Math.hypot(b.wx - a.wx, b.wy - a.wy, b.wz - a.wz);
          if (d > maxD) continue;
          stroke(0.6 * (1 - d / maxD) * Math.min(a.alpha, b.alpha), () => {
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
          });
        }
      }
      if (!flags.tags) {
        ctx.fillStyle = `rgba(${rgb}0.7)`;
        for (const p of placed) if (p.locked) ctx.fillRect(p.x - 1, p.y - 1, 2, 2);
      }
    }

    if (flags.tags) {
      for (const p of placed) {
        const pop = p.since < 0.25 && p.since >= 0 ? 1 + 1.6 * (1 - p.since / 0.25) : 1;
        const size = (p.lamp ? 17 : clamp(10 + 11 * (p.wz / Math.max(0.2, state.depth) + 0.5), 9, 21)) * (this.dense ? 0.72 : 1) * pop;
        const arm = 0.42 * size;
        const a = p.locked ? 0.8 * p.alpha : 0.3 + 0.25 * Math.sin(40 * t + (p.t?.id ?? 0));
        if (a < 0.02) continue;
        stroke(a, () => {
          for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
            const cx = Math.round(p.x + sx * size) + 0.5;
            const cy = Math.round(p.y + sy * size) + 0.5;
            ctx.moveTo(cx - sx * arm, cy);
            ctx.lineTo(cx, cy);
            ctx.lineTo(cx, cy - sy * arm);
          }
          ctx.moveTo(p.x - 2.5, p.y);
          ctx.lineTo(p.x + 2.5, p.y);
          ctx.moveTo(p.x, p.y - 2.5);
          ctx.lineTo(p.x, p.y + 2.5);
        });
        const label = !p.locked
          ? `${p.id}  LOCKING`
          : this.dense && !p.lamp
            ? `${p.id}  ${fmt(p.wz)}`
            : `${p.id}  ${fmt(p.wx)} ${fmt(p.wy)} ${fmt(p.wz)}`;
        text(a, label, p.x + size + 6, p.y - size + 7);
      }
    }

    if (flags.labels) {
      const R = 1.1;
      const seg = (x1: number, y1: number, x2: number, y2: number) => {
        const a = project(x1, y1, 0);
        const b = project(x2, y2, 0);
        if (a && b) {
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
        }
      };
      ctx.strokeStyle = `rgba(${rgb}${(0.11 * inkDim).toFixed(3)})`;
      ctx.beginPath();
      for (let n = 0; n <= 40; n++) {
        const v = n / 20 - 1;
        const len = n % 10 === 0 ? 0.07 : n % 5 === 0 ? 0.045 : 0.022;
        seg(v, R, v, R + len);
        seg(v, -R, v, -R - len);
        seg(-R, v, -R - len, v);
        seg(R, v, R + len, v);
      }
      for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        seg(sx * (R - 0.06), sy * R, sx * (R + 0.06), sy * R);
        seg(sx * R, sy * (R - 0.06), sx * R, sy * (R + 0.06));
      }
      ctx.stroke();
      const corner = (x: number, y: number, s: string, right: boolean) => {
        const p = project(x, y, 0);
        if (!p) return;
        ctx.textAlign = right ? "right" : "left";
        text(0.19 * inkDim, s, p.x, p.y);
      };
      corner(-R, R + 0.14, `${String(info.index + 1).padStart(2, "0")} / ${String(info.count).padStart(2, "0")}   ${info.name.toUpperCase().slice(0, 22)}`, false);
      corner(R, R + 0.14, `WIND ${Math.round(100 * state.windLevel)}`, true);
      corner(-R, -R - 0.17, `${info.points.toLocaleString("en-US")} PTS`, false);
      corner(R, -R - 0.17, state.scanZ !== null ? `SWEEP Z ${fmt(state.scanZ)}` : "", true);
      ctx.textAlign = "left";
    }
  }
}
