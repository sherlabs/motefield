import { GRID_H, GRID_W, POINT_COUNT, type SceneData } from "../scene/types";
import { CORE_FRAG, GRAIN_FRAG, GRAIN_VERT, QUAD_VERT } from "./shaders";

export type MotionMode = "flock" | "flow";
export type ToneMode = "invert" | "true";

/** The wind line in picture units: a point on it, its angle, and which side blows away. */
export interface WindLine {
  x: number;
  y: number;
  ang: number;
  side: 1 | -1;
}

export interface RenderParams {
  /** 0..1 how hard the wind blows the far side of the line away */
  wind: number;
  /** 0..1 how fast a splash opens when a picture is kicked */
  scatter: number;
  /** 0..1 how quickly motes cohere into the next picture */
  cohesion: number;
  /** 0..1.5 relief: z scale */
  relief: number;
  /** 0..1 how deep the picture breathes */
  breath: number;
  /** draw streaks behind the motes that are leaving */
  streaks: boolean;
  /** a plane sweeping through the depth, lighting the motes it passes */
  sweep: boolean;
  motion: MotionMode;
  /** ink on paper instead of light on black */
  paper: boolean;
  /** "true": motes carry the picture's exact colours. "invert": glowing dust on black, its negative in ink on paper. */
  tone: ToneMode;
  /** lamps flare on their own, on a schedule (so exports can have light) */
  light: boolean;
  /** lamp colour, 0..1 rgb */
  lightColor: [number, number, number];
  line: WindLine;
  /**
   * Length of one seamless loop in ms. In auto mode all pictures cycle inside
   * one loop; breath, scan and the wind cycles are quantised to it.
   */
  loopDurationMs: number;
}

export const DEFAULT_PARAMS: RenderParams = {
  wind: 0.45,
  scatter: 0.7,
  cohesion: 0.33,
  relief: 0.8,
  breath: 0.5,
  streaks: false,
  sweep: false,
  motion: "flock",
  paper: false,
  tone: "true",
  light: false,
  lightColor: [1, 0.914, 0.769],
  line: { x: 0.45, y: 0, ang: 1.72, side: -1 },
  loopDurationMs: 24000,
};

const TAU = Math.PI * 2;
const TAN_HALF_FOV = Math.tan((17 * Math.PI) / 180);
const BREATH_PERIOD = 5.6;
const SCAN_PERIOD = 8;
const LAMP_ATTACK = 0.018;
const LAMP_DECAY = 0.45;
const DEPTH_SWAP_FLIGHT = 1.2;

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const smooth = (x: number) => {
  const t = clamp(x, 0, 1);
  return t * t * (3 - 2 * t);
};

function hash32(x: number): number {
  let h = Math.imul(x | 0, 0x9e3779b1) ^ 0x7f4a7c15;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** (multiplier, offset) of an index shuffle; the multiplier is odd so it is a bijection. */
function dealFor(seed: number): [number, number] {
  return [(hash32(seed) | 1) >>> 0, hash32(seed + 977)];
}

/** peak of the lamp envelope exp(-t/decay) - exp(-t/attack), to normalise it */
function envelopePeak(decay: number, attack: number): number {
  return Math.pow(attack / decay, attack / (decay - attack)) - Math.pow(attack / decay, decay / (decay - attack));
}

interface Form {
  pos: WebGLTexture;
  col: WebGLTexture;
  ink: boolean;
  photo: boolean;
  dead: boolean;
}

interface Slot {
  form: Form;
  deal: [number, number];
}

interface Flight {
  t0: number;
  dur: number;
  /** flock flag, seed, wait, throw */
  way: [number, number, number, number];
}

interface Lamp {
  x: number;
  y: number;
  z: number;
  t0: number;
}

interface Wake {
  x: number;
  y: number;
  dx: number;
  dy: number;
  m: number;
  t: number;
}

export interface Projected {
  nx: number;
  ny: number;
  w: number;
  /** css px inside the canvas */
  x: number;
  y: number;
}

/** Everything the HUD needs to follow the motes for one frame. */
export interface FrameState {
  time: number;
  vp: Float32Array;
  cssW: number;
  cssH: number;
  breath: number;
  depth: number;
  line: WindLine;
  wind: { nx: number; ny: number; strength: number };
  scanZ: number | null;
  ink: boolean;
  lamps: { x: number; y: number; z: number; strength: number }[];
  /** the WIND setting, 0..1 */
  windLevel: number;
}

interface Camera {
  m: Float32Array;
  dist: number;
  eye: [number, number, number];
  aspect: number;
}

export class PointCloudRenderer {
  private canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext;
  private prog!: WebGLProgram;
  private coreProg!: WebGLProgram;
  private u: Record<string, WebGLUniformLocation | null> = {};
  private cu: Record<string, WebGLUniformLocation | null> = {};
  private vao: WebGLVertexArrayObject | null = null;
  private params: RenderParams = { ...DEFAULT_PARAMS };
  private timeMs = 0;
  private dpr = 1;

  private scenes: Form[] = [];
  private sceneSource: SceneData[] = [];
  private sceneSeeds: number[] = [];
  private dust: Form | null = null;
  private graveyard: Form[] = [];

  // manual timeline: three homes and two flights between them
  private slots: [Slot | null, Slot | null, Slot | null] = [null, null, null];
  private flights: [Flight, Flight] = [
    { t0: -1e9, dur: 1, way: [1, 1, 0, 0] },
    { t0: -1e9, dur: 1, way: [1, 1, 0, 0] },
  ];
  private current = -1;
  private dealCount = 1;
  private auto = false;
  private autoOrigin = 0;

  // paper flip
  private paperFlip = { t0: -1e9, from: 0, to: 0 };

  // interactive state, never used by exports
  private orbit = { yaw: 0, pitch: 0, zoom: 1 };
  private inset = { top: 0, bottom: 0, left: 0, right: 0 };
  private lamps: Lamp[] = [];
  private lampNext = 0;
  private wakes: Wake[] = [];
  private cam: Camera | null = null;
  private frame: FrameState | null = null;

  private lost = false;
  private disposed = false;

  constructor(canvas?: HTMLCanvasElement) {
    this.canvas = canvas ?? document.createElement("canvas");
    const gl = this.canvas.getContext("webgl2", {
      antialias: false,
      alpha: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
      powerPreference: "high-performance",
    });
    if (!gl) throw new Error("WebGL2 is not available");
    this.gl = gl;
    this.buildPrograms();
    this.canvas.addEventListener("webglcontextlost", this.onLost);
    this.canvas.addEventListener("webglcontextrestored", this.onRestored);
    this.resize(this.canvas.width || 300, this.canvas.height || 150);
  }

  private buildPrograms() {
    const gl = this.gl;
    this.u = {};
    this.cu = {};
    this.prog = this.link(GRAIN_VERT, GRAIN_FRAG, this.u);
    this.coreProg = this.link(QUAD_VERT, CORE_FRAG, this.cu);
    this.vao = gl.createVertexArray();
    gl.useProgram(this.prog);
    ["uHome0", "uHome1", "uHome2", "uTint0", "uTint1", "uTint2"].forEach((n, i) => gl.uniform1i(this.u[n], i));
    this.dust = this.makeDust();
  }

  private onLost = (e: Event) => {
    e.preventDefault();
    this.lost = true;
  };

  private onRestored = () => {
    this.scenes = [];
    this.graveyard = [];
    this.buildPrograms();
    this.lost = false;
    const keep = this.sceneSource;
    const cur = this.current;
    this.setScenes(keep);
    if (cur >= 0 && cur < this.scenes.length) this.slots = [null, null, { form: this.scenes[cur], deal: dealFor(cur) }];
    this.current = cur;
  };

  // ---------------------------------------------------------------- public api

  getCanvas(): HTMLCanvasElement {
    return this.canvas;
  }

  getParams(): RenderParams {
    return { ...this.params };
  }

  getSceneCount(): number {
    return this.scenes.length;
  }

  /** Set the drawing buffer size in device pixels; dpr maps it to css px for the HUD. */
  resize(width: number, height: number, dpr = 1) {
    const w = Math.max(2, Math.floor(width));
    const h = Math.max(2, Math.floor(height));
    this.dpr = dpr;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.gl.viewport(0, 0, w, h);
  }

  /** css px of the stage that the HUD covers; the cloud is fitted into what is left. */
  setInset(inset: { top: number; bottom: number; left: number; right: number }) {
    this.inset = { ...inset };
  }

  setParams(p: Partial<RenderParams>) {
    const prev = this.params;
    this.params = { ...prev, ...p };
    if (p.paper !== undefined && p.paper !== prev.paper) {
      this.paperFlip = { t0: this.timeMs / 1000 + 0.2, from: prev.paper ? 1 : 0, to: p.paper ? 1 : 0 };
      // the picture is dealt again for the other paper: kick it so the change reads
      const cur = this.current;
      if (!this.auto && cur >= 0 && this.scenes[cur]) this.reform(cur, "flock", this.timeMs, true, 2, 0.2);
    }
  }

  /** Upload scenes (max 4). Replaces and frees previous GPU textures. */
  setScenes(list: SceneData[]) {
    for (const s of this.scenes) this.bury(s);
    this.scenes = [];
    this.sceneSource = list.slice(0, 4);
    this.sceneSeeds = this.sceneSource.map((_, i) => i);
    for (const s of this.sceneSource) this.scenes.push(this.makeForm(s));
    this.current = -1;
    this.slots = [null, null, null];
    this.flights[0].t0 = this.flights[1].t0 = -1e9;
    if (this.scenes.length) this.reform(0, "flock", this.timeMs, false, 2.2);
  }

  /** Swap one picture's motes in place (e.g. when the depth model finishes). The motes flow across. */
  replaceScene(i: number, data: SceneData) {
    if (i < 0 || i >= this.scenes.length) return;
    const old = this.scenes[i];
    const form = this.makeForm(data);
    this.scenes[i] = form;
    this.sceneSource[i] = data;
    this.sceneSeeds[i] = (this.sceneSeeds[i] ?? i) + 101;
    if (!this.auto && this.slots[2]?.form === old) this.push(form, "flow", this.timeMs / 1000, DEPTH_SWAP_FLIGHT, null);
    this.bury(old);
  }

  getSceneData(i: number): SceneData | undefined {
    return this.sceneSource[i];
  }

  /** Deterministically set the render clock (ms). */
  setTime(ms: number) {
    this.timeMs = ms;
  }

  /**
   * Automatic loop timeline: every scene gets L/n ms inside one loop and the
   * flights start at the segment boundaries. With `atMs` the timeline is
   * aligned so the current scene starts then; without it the origin is t = 0.
   */
  setAuto(on: boolean, atMs?: number) {
    if (on) {
      const n = Math.max(1, this.scenes.length);
      const seg = this.params.loopDurationMs / n;
      const cur = Math.max(0, this.currentSceneIndex());
      this.autoOrigin = atMs === undefined ? 0 : atMs - cur * seg;
    } else if (this.auto) {
      const idx = this.autoIndex(atMs ?? this.timeMs);
      this.auto = false;
      this.slots = [null, null, this.scenes[idx] ? { form: this.scenes[idx], deal: dealFor(idx) } : null];
      this.flights[0].t0 = this.flights[1].t0 = -1e9;
      this.current = idx;
      return;
    }
    this.auto = on;
  }

  isAuto() {
    return this.auto;
  }

  /** Travel to scene `i` (manual mode) starting at `atMs`. */
  goTo(i: number, atMs: number = this.timeMs, motion: MotionMode = this.params.motion) {
    const n = this.scenes.length;
    if (n === 0) return;
    const target = ((i % n) + n) % n;
    if (this.auto) this.setAuto(false, atMs);
    this.reform(target, target === this.current ? "flock" : motion, atMs, true);
  }

  next(atMs: number = this.timeMs) {
    if (!this.scenes.length) return;
    this.goTo(this.currentSceneIndex() + 1, atMs);
  }

  currentSceneIndex(): number {
    if (this.auto) return this.autoIndex(this.timeMs);
    return this.current;
  }

  /** How long the next flight will take at the current COHESION setting, in seconds. */
  flightSeconds(): number {
    return clamp(8 * 0.6 * Math.pow(0.5 / 8, this.params.cohesion), 0.25, 5);
  }

  // ---- interactive only ----

  /** Light a lamp somewhere in the cloud, away from the last one. */
  fireLamp(atMs: number = this.timeMs) {
    const prev = this.lamps[(this.lampNext + 2) % 3];
    let l: Lamp = { x: 0, y: 0, z: 0, t0: atMs / 1000 };
    for (let tries = 0; tries < 8; tries++) {
      l = { x: 0.85 * (Math.random() * 2 - 1), y: 1.25 * Math.random() - 0.6, z: 1.5 * Math.random() - 0.8, t0: atMs / 1000 };
      if (!prev || Math.hypot(l.x - prev.x, l.y - prev.y, l.z - prev.z) >= 0.6) break;
    }
    this.lamps[this.lampNext] = l;
    this.lampNext = (this.lampNext + 1) % 3;
  }

  orbitBy(dx: number, dy: number) {
    this.orbit.yaw -= dx * 0.006;
    this.orbit.pitch = clamp(this.orbit.pitch + dy * 0.006, -1.3, 1.3);
  }

  zoomBy(factor: number) {
    this.orbit.zoom = clamp(this.orbit.zoom * factor, 0.3, 3);
  }

  resetView() {
    this.orbit = { yaw: 0, pitch: 0, zoom: 1 };
  }

  /** A stroke of the pointer, in ndc, with its direction and speed. */
  addWake(x: number, y: number, dx: number, dy: number, speed: number, atMs: number = this.timeMs) {
    this.wakes.push({ x, y, dx, dy, m: clamp(0.03 * speed, 0.015, 0.1), t: atMs / 1000 });
    if (this.wakes.length > 6) this.wakes.shift();
  }

  /** Project a picture-space point to the canvas (css px), or null if behind the camera. */
  project(x: number, y: number, z: number): Projected | null {
    const c = this.cam;
    if (!c) return null;
    const m = c.m;
    const w = m[3] * x + m[7] * y + m[11] * z + m[15];
    if (w < 0.01) return null;
    const nx = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w;
    const ny = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w;
    const cssW = this.canvas.width / this.dpr;
    const cssH = this.canvas.height / this.dpr;
    return { nx, ny, w, x: (0.5 * nx + 0.5) * cssW, y: (0.5 - 0.5 * ny) * cssH };
  }

  getFrameState(): FrameState | null {
    return this.frame;
  }

  /** Set the clock to timeMs and draw. Pure function of (params, scenes, timeline, time) except the interactive state. */
  render(timeMs: number) {
    this.timeMs = timeMs;
    this.draw();
  }

  draw() {
    if (this.lost || this.disposed || this.gl.isContextLost()) return;
    const gl = this.gl;
    const P = this.params;
    const t = this.timeMs / 1000;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const loopS = this.auto ? Math.max(1, P.loopDurationMs) / 1000 : 0;
    const quant = (period: number) => (loopS > 0 ? loopS / Math.max(1, Math.round(loopS / period)) : period);

    this.sweepGraveyard();

    gl.viewport(0, 0, W, H);

    // ---- paper ----
    const flip = clamp((t - this.paperFlip.t0) / 0.8, 0, 1);
    const inkMix = lerp(this.paperFlip.from, this.paperFlip.to, smooth(flip));
    const ink = flip >= 0.5 ? this.paperFlip.to : this.paperFlip.from;
    const dip = Math.abs(2 * flip - 1);
    const fade = this.paperFlip.t0 > -1e8 ? dip * dip * (3 - 2 * dip) : 1;
    const bgR = lerp(5, 244, inkMix) / 255;
    const bgG = lerp(5, 244, inkMix) / 255;
    const bgB = lerp(6, 241, inkMix) / 255;
    gl.clearColor(bgR, bgG, bgB, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    const exact = P.tone === "true";
    const grainBlend = () => {
      if (ink) gl.blendFunc(gl.ZERO, gl.SRC_COLOR);
      else if (exact) gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      else gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_COLOR);
    };
    grainBlend();

    // ---- timeline ----
    const tl = this.resolveTimeline(t);
    if (!tl) return;

    // ---- camera ----
    const cam = this.camera(t, loopS);
    this.cam = cam;
    const depthScale = lerp(0.05, 1.5, P.relief / 1.5);

    // ---- breath, scan ----
    const bp = ((t / quant(BREATH_PERIOD)) % 1 + 1) % 1;
    const breath = 2 * (bp < 0.42 ? -Math.cos((Math.PI * bp) / 0.42) : Math.cos((Math.PI * (bp - 0.42)) / 0.58)) * P.breath;
    const sp = ((t / quant(SCAN_PERIOD)) % 1 + 1) % 1;
    const span = 0.55 * depthScale + 0.06;
    const scanning = P.sweep && sp < 0.7;
    const scanZ = scanning ? lerp(span, -span, sp / 0.7) : 0;
    const scanStrength = scanning ? Math.pow(Math.sin((Math.PI * sp) / 0.7), 0.6) : 0;

    // ---- lamps ----
    const lampArr = new Float32Array(12);
    const coreArr = new Float32Array(12);
    const lampList: FrameState["lamps"] = [];
    let lampSum = 0;
    let anyCore = false;
    const peak = envelopePeak(LAMP_DECAY, LAMP_ATTACK);
    const lampsNow = this.lampsAt(t, loopS);
    lampsNow.forEach((l, k) => {
      const age = t - l.t0;
      const L = age < 0 ? 0 : Math.min(1.1, Math.max(0, Math.exp(-age / LAMP_DECAY) - Math.exp(-age / LAMP_ATTACK)) / peak);
      lampArr.set([l.x, l.y, l.z, L], k * 4);
      lampSum += L;
      if (L > 0.004) {
        const pr = this.project(l.x, l.y, l.z);
        if (pr) {
          anyCore = true;
          coreArr.set([pr.nx, pr.ny, L * fade, 0.3 / (pr.w * TAN_HALF_FOV)], k * 4);
        }
        lampList.push({ x: l.x, y: l.y, z: l.z, strength: L });
      }
    });
    lampSum = Math.min(1, lampSum);

    gl.bindVertexArray(this.vao);
    if (anyCore) {
      gl.useProgram(this.coreProg);
      gl.uniform1f(this.cu.uPaper, ink);
      gl.uniform4fv(this.cu.uBloom, coreArr);
      gl.uniform3fv(this.cu.uGlowTint, P.lightColor);
      gl.uniform1f(this.cu.uAspectRatio, cam.aspect);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    // ---- motes ----
    gl.useProgram(this.prog);
    const u = this.u;
    const forms = [tl.s0, tl.s1, tl.s2];
    forms.forEach((s, i) => {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, s.form.pos);
      gl.activeTexture(gl.TEXTURE3 + i);
      gl.bindTexture(gl.TEXTURE_2D, s.form.col);
    });
    gl.uniform2ui(u.uDeal0, tl.s0.deal[0], tl.s0.deal[1]);
    gl.uniform2ui(u.uDeal1, tl.s1.deal[0], tl.s1.deal[1]);
    gl.uniform2ui(u.uDeal2, tl.s2.deal[0], tl.s2.deal[1]);
    gl.uniform1ui(u.uIndexMask, POINT_COUNT - 1);
    gl.uniform1ui(u.uColumnMask, GRID_W - 1);
    gl.uniform1ui(u.uRowShift, Math.round(Math.log2(GRID_W)));
    gl.uniform1f(u.uGo01, tl.go01);
    gl.uniform1f(u.uGo12, tl.go12);
    gl.uniform4fv(u.uWay01, tl.way01);
    gl.uniform4fv(u.uWay12, tl.way12);
    gl.uniform1f(u.uPaper, ink);
    gl.uniform1f(u.uExact, exact ? 1 : 0);
    gl.uniform1f(u.uDip, fade);
    gl.uniform3f(u.uHomePaper, tl.s0.form.ink ? 1 : 0, tl.s1.form.ink ? 1 : 0, tl.s2.form.ink ? 1 : 0);
    gl.uniform3f(u.uHomePhoto, tl.s0.form.photo ? 1 : 0, tl.s1.form.photo ? 1 : 0, tl.s2.form.photo ? 1 : 0);
    gl.uniformMatrix4fv(u.uViewProj, false, cam.m);

    // mote size from the on-screen density: a 1.3..3.6 px dot, and a gain so
    // the picture reads the same whether the dots overlap a little or a lot
    const b = H / (cam.dist * TAN_HALF_FOV);
    const px = this.dpr;
    // true colour lays motes over each other, so they must tile the surface without pinholes: a larger, steadier dot
    const size = clamp(b * Math.sqrt(0.6 / POINT_COUNT) * (exact ? 2.5 : 1.9), (exact ? 1.9 : 1.3) * px, 3.8 * px);
    const overlap = (POINT_COUNT * (0.35 * size * size)) / (0.6 * b * b);
    const gain = clamp(0.62 / (overlap + 0.12), 0.08, 1) * 0.98;
    gl.uniform1f(u.uClock, t);
    gl.uniform1f(u.uLoop, loopS);
    gl.uniform1f(u.uRelief, depthScale);
    gl.uniform1f(u.uCamDist, cam.dist);
    gl.uniform1f(u.uGrain, size);
    gl.uniform1f(u.uFloorPx, 1);
    gl.uniform1f(u.uLevel, gain);
    gl.uniform1f(u.uAspectRatio, cam.aspect);
    gl.uniform1f(u.uSwell, breath);
    gl.uniform2f(u.uSweep, scanZ, scanStrength);
    gl.uniform1f(u.uStreakAge, 0.26);
    gl.uniform1f(u.uStreaks, P.streaks ? 1 : 0);

    const wind = this.windOf(P.line);
    gl.uniform4f(u.uShore, P.line.x, P.line.y, wind.nx, wind.ny);
    gl.uniform3f(u.uGust, wind.nx, wind.ny, 1.5 * P.wind);
    gl.uniform4fv(u.uGlow, lampArr);
    gl.uniform3fv(u.uGlowTint, P.lightColor);
    gl.uniform1f(u.uGlowSum, lampSum);
    gl.uniform4fv(u.uWake, this.wakeArray(t));

    gl.uniform1f(u.uLayer, 0);
    gl.uniform1ui(u.uStep, 1);
    gl.drawArrays(gl.POINTS, 0, POINT_COUNT);
    if (lampSum > 0.004) {
      if (exact && !ink) gl.blendFunc(gl.ONE, gl.ONE);
      gl.uniform1f(u.uLayer, 1);
      gl.uniform1ui(u.uStep, 8);
      gl.drawArrays(gl.POINTS, 0, POINT_COUNT >> 3);
      grainBlend();
    }
    if (P.streaks && P.wind > 0.003) {
      gl.uniform1f(u.uLayer, 2);
      gl.uniform1ui(u.uStep, 3);
      gl.drawArrays(gl.LINES, 0, 2 * Math.floor(POINT_COUNT / 3));
    }

    this.frame = {
      time: t,
      vp: cam.m,
      cssW: W / this.dpr,
      cssH: H / this.dpr,
      breath,
      depth: depthScale,
      line: { ...P.line },
      wind: { nx: wind.nx, ny: wind.ny, strength: 1.5 * P.wind },
      scanZ: scanning ? scanZ : null,
      ink: ink > 0.5,
      lamps: lampList,
      windLevel: P.wind,
    };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.canvas.removeEventListener("webglcontextlost", this.onLost);
    this.canvas.removeEventListener("webglcontextrestored", this.onRestored);
    for (const s of this.scenes) this.freeForm(s);
    for (const s of this.graveyard) this.freeForm(s);
    if (this.dust) this.freeForm(this.dust);
    this.scenes = [];
    this.graveyard = [];
    this.sceneSource = [];
    const gl = this.gl;
    gl.deleteProgram(this.prog);
    gl.deleteProgram(this.coreProg);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }

  // ---------------------------------------------------------------- timeline

  private windOf(line: WindLine) {
    const c = Math.cos(line.ang);
    const s = Math.sin(line.ang);
    return { tx: c, ty: s, nx: -s * line.side, ny: c * line.side };
  }

  private openSeconds(): number {
    return 0.4 * Math.pow(0.01 / 0.4, this.params.scatter);
  }

  private waitFraction(): number {
    return 0.22 * clamp(1 - this.params.cohesion / 0.5, 0, 1);
  }

  /** Start a flight to scene `i`. */
  private reform(i: number, motion: MotionMode, atMs: number, kick: boolean, dur = this.flightSeconds(), wait?: number) {
    const form = this.scenes[i];
    if (!form) return;
    this.current = i;
    this.push(form, motion, atMs / 1000, dur, kick ? (wait ?? this.waitFraction()) : null);
  }

  private push(form: Form, motion: MotionMode, t0: number, dur: number, wait: number | null) {
    if (!this.slots[2]) {
      this.slots[2] = { form, deal: [1, 0] };
      return;
    }
    this.slots[0] = this.slots[1];
    this.flights[0] = this.flights[1];
    this.slots[1] = this.slots[2];
    const flock = motion === "flock";
    const deal: [number, number] = flock ? dealFor(1000 + this.dealCount++) : [...this.slots[1].deal];
    this.slots[2] = { form, deal };
    const seed = 1 + (hash32(this.dealCount * 31 + 7) % 60000);
    this.flights[1] = {
      t0,
      dur,
      way: [flock ? 1 : 0, seed, wait ?? 0, wait === null ? 0 : Math.max(1, dur / this.openSeconds())],
    };
  }

  private autoIndex(atMs: number): number {
    const n = this.scenes.length;
    if (n <= 1) return Math.max(0, n - 1);
    const L = Math.max(1000, this.params.loopDurationMs);
    const seg = L / n;
    const lt = (((atMs - this.autoOrigin) % L) + L) % L;
    return Math.min(n - 1, Math.floor(lt / seg));
  }

  private resolveTimeline(t: number) {
    const dust = this.dust!;
    const dustSlot: Slot = { form: dust, deal: [1, 0] };
    const none: Flight["way"] = [1, 1, 0, 0];
    if (this.auto && this.scenes.length) {
      const n = this.scenes.length;
      const L = Math.max(1000, this.params.loopDurationMs) / 1000;
      const seg = L / n;
      const lt = (((t - this.autoOrigin / 1000) % L) + L) % L;
      const s = Math.min(n - 1, Math.floor(lt / seg));
      const prev = (s - 1 + n) % n;
      const dur = Math.min(this.flightSeconds(), seg * 0.9);
      const go = n > 1 ? clamp((lt - s * seg) / dur, 0, 1) : 1;
      const flock = this.params.motion === "flock";
      const s2: Slot = { form: this.scenes[s], deal: flock ? dealFor(5000 + s * 7) : [1, 0] };
      const s1: Slot = { form: this.scenes[prev], deal: flock ? dealFor(5000 + prev * 7) : [1, 0] };
      const wait = this.waitFraction();
      const way: Flight["way"] = [flock ? 1 : 0, 1 + ((s * 7919) % 60000), wait, Math.max(1, dur / this.openSeconds())];
      return { s0: s1, s1, s2, go01: 1, go12: go, way01: none, way12: way };
    }
    const s2 = this.slots[2] ?? dustSlot;
    const f1 = this.flights[1];
    const f0 = this.flights[0];
    const go12 = this.slots[1] ? clamp((t - f1.t0) / f1.dur, 0, 1) : 1;
    const go01 = this.slots[0] ? clamp((t - f0.t0) / f0.dur, 0, 1) : 1;
    const s1 = go12 < 1 && this.slots[1] ? this.slots[1] : s2;
    const s0 = go12 < 1 && go01 < 1 && this.slots[0] ? this.slots[0] : s1;
    return { s0, s1, s2, go01: s0 === s1 ? 1 : go01, go12, way01: f0.way, way12: f1.way };
  }

  /** Lamps burning at time t: fired by hand, plus the scheduled ones when LIGHT is on. */
  private lampsAt(t: number, loopS: number): Lamp[] {
    const out: Lamp[] = [];
    if (this.params.light) {
      // three lamps on a rota, each flaring every `period` seconds at a seeded spot
      const period = loopS > 0 ? loopS / Math.max(1, Math.round(loopS / 6)) : 6;
      for (let k = 0; k < 3; k++) {
        const slot = period / 3;
        const nth = Math.floor((t - k * slot) / period);
        const t0 = nth * period + k * slot;
        const seed = loopS > 0 ? k * 17 : nth * 3 + k;
        const h = (n: number) => hash32(seed * 97 + n) / 4294967296;
        out.push({ x: 0.85 * (h(1) * 2 - 1), y: 1.25 * h(2) - 0.6, z: 1.5 * h(3) - 0.8, t0 });
      }
    }
    for (const l of this.lamps) {
      if (out.length >= 3) break;
      if (t - l.t0 < 4) out.push(l);
    }
    return out.slice(0, 3);
  }

  private wakeArray(t: number): Float32Array {
    const arr = new Float32Array(24);
    this.wakes = this.wakes.filter((w) => t - w.t < 3);
    this.wakes.forEach((w, i) => {
      const age = Math.max(0, t - w.t);
      const k = (1 - Math.exp(-age / 0.05)) * Math.exp(-age / 0.75);
      arr.set([w.x, w.y, w.dx * w.m * k, w.dy * w.m * k], i * 4);
    });
    return arr;
  }

  // ---------------------------------------------------------------- camera

  private camera(t: number, loopS: number): Camera {
    const W = this.canvas.width;
    const H = this.canvas.height;
    const cssW = W / this.dpr;
    const cssH = H / this.dpr;
    const { top, bottom, left, right } = this.inset;
    const availH = Math.max(160, cssH - top - bottom);
    const availW = Math.max(160, cssW - left - right);
    const fit = cssW < 760 ? 0.96 : 0.8;
    const frac = (Math.min(availH, availW) * fit) / cssH; // fraction of the viewport height the frame spans
    const shiftY = (bottom - top) / cssH;
    const shiftX = (left - right) / cssW;
    const dist = this.orbit.zoom / (TAN_HALF_FOV * frac);
    const wy = loopS > 0 ? (TAU / loopS) * Math.max(1, Math.round((0.23 * loopS) / TAU)) : 0.23;
    const wp = loopS > 0 ? (TAU / loopS) * Math.max(1, Math.round((0.17 * loopS) / TAU)) : 0.17;
    const yaw = this.orbit.yaw + 0.16 * Math.sin(wy * t);
    const pitch = clamp(this.orbit.pitch + 0.05 * Math.sin(wp * t + 1), -1.35, 1.35);
    const cy = Math.cos(pitch);
    const sy = Math.sin(pitch);
    const eye: [number, number, number] = [dist * cy * Math.sin(yaw), dist * sy, dist * cy * Math.cos(yaw)];
    // look at the origin
    let fx = -eye[0], fy = -eye[1], fz = -eye[2];
    const fl = Math.hypot(fx, fy, fz);
    fx /= fl; fy /= fl; fz /= fl;
    let rx = -fz, rz = fx;
    const rl = Math.hypot(rx, rz) || 1;
    rx /= rl; rz /= rl;
    const ux = -rz * fy;
    const uy = rz * fx - rx * fz;
    const uz = rx * fy;
    const near = Math.max(0.01, 0.05 * dist);
    const far = 6 * dist + 20;
    const aspect = W / H;
    const px = 1 / (TAN_HALF_FOV * aspect);
    const py = 1 / TAN_HALF_FOV;
    const pz = (far + near) / (near - far);
    const pw = (2 * far * near) / (near - far);
    const view = [
      rx, ux, -fx, 0,
      0, uy, -fy, 0,
      rz, uz, -fz, 0,
      -(rx * eye[0] + rz * eye[2]), -(ux * eye[0] + uy * eye[1] + uz * eye[2]), fx * eye[0] + fy * eye[1] + fz * eye[2], 1,
    ];
    const m = new Float32Array(16);
    for (let c = 0; c < 4; c++) {
      const x = view[c * 4], y = view[c * 4 + 1], z = view[c * 4 + 2], w = view[c * 4 + 3];
      m[c * 4] = px * x + shiftX * -z;
      m[c * 4 + 1] = py * y + shiftY * -z;
      m[c * 4 + 2] = pz * z + pw * w;
      m[c * 4 + 3] = -z;
    }
    return { m, dist, eye, aspect };
  }

  // ---------------------------------------------------------------- gpu objects

  private makeForm(s: SceneData): Form {
    const gl = this.gl;
    return {
      pos: this.makeTexture(gl.RGBA32F, gl.FLOAT, s.pos),
      col: this.makeTexture(gl.RGBA8, gl.UNSIGNED_BYTE, s.col),
      ink: false,
      photo: s.photo,
      dead: false,
    };
  }

  /** A faint cloud of dust for when there is no picture. */
  private makeDust(): Form {
    const pos = new Float32Array(POINT_COUNT * 4);
    const col = new Uint8Array(POINT_COUNT * 4);
    let s = 12345;
    const rnd = () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 4294967296;
    };
    for (let i = 0; i < POINT_COUNT; i++) {
      let x: number, y: number, z: number, d: number;
      do {
        x = rnd() * 2 - 1;
        y = rnd() * 2 - 1;
        z = rnd() * 2 - 1;
        d = x * x + y * y + z * z;
      } while (d > 1 || d < 1e-4);
      const r = (0.35 + 1.25 * Math.cbrt(rnd())) / Math.sqrt(d);
      const c = 70 + 110 * rnd();
      pos.set([x * r, y * r * 0.8, z * r * 0.5, 0.3], i * 4);
      col.set([c, c, c * 1.04, 255], i * 4);
    }
    return this.makeForm({ pos, col, feats: [], photo: false });
  }

  private bury(f: Form) {
    if (f.dead) return;
    f.dead = true;
    this.graveyard.push(f);
  }

  private sweepGraveyard() {
    if (!this.graveyard.length) return;
    const live = new Set<Form>();
    for (const s of this.slots) if (s) live.add(s.form);
    this.graveyard = this.graveyard.filter((f) => {
      if (live.has(f)) return true;
      this.freeForm(f);
      return false;
    });
  }

  private freeForm(f: Form) {
    this.gl.deleteTexture(f.pos);
    this.gl.deleteTexture(f.col);
  }

  private makeTexture(internal: number, type: number, data: ArrayBufferView): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, GRID_W, GRID_H, 0, gl.RGBA, type, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  private link(vs: string, fs: string, into: Record<string, WebGLUniformLocation | null>): WebGLProgram {
    const gl = this.gl;
    const mk = (type: number, src: string) => {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        throw new Error("shader compile: " + gl.getShaderInfoLog(sh));
      }
      return sh;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, mk(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error("program link: " + gl.getProgramInfoLog(p));
    const count = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS) as number;
    for (let i = 0; i < count; i++) {
      const info = gl.getActiveUniform(p, i);
      if (info) into[info.name.replace(/\[0\]$/, "")] = gl.getUniformLocation(p, info.name);
    }
    return p;
  }
}
