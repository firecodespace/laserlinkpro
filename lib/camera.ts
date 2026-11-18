/**
 * Camera front end.
 *
 * The thing being looked for is a RED laser dot on WHITE paper, and that
 * detail drives the whole design.
 *
 * Brightness is useless here: white paper under any room light has high red,
 * green and blue, so a "find the brightest pixel" search scores the paper
 * almost as highly as the dot and ends up chasing noise. What separates the
 * dot from the paper is not how bright it is but how RED it is. So every
 * measurement below is red excess, R - max(G, B), which is about zero for
 * white, grey or black regardless of exposure, and large only where the
 * laser is.
 *
 * Acquisition uses two cues together:
 *   static   how red the reddest pixel in a block is - works while the
 *            laser sits idle and steady, which is most of the time
 *   blinking how much that redness swings - only the laser does this, so it
 *            breaks ties decisively once the beacon starts
 *
 * The tracked block only changes when a rival beats it convincingly for
 * several frames in a row. Without that the circle twitches every frame.
 *
 * A tap on the video overrides all of it and pins the spot by hand.
 */

const W = 160;
const H = 120;
const BLOCK = 8;
const COLS = W / BLOCK; // 20
const ROWS = H / BLOCK; // 15

/** How fast a block's red envelope relaxes back, per frame. */
const LEAK = 0.6;
/** Red excess below this is treated as "no laser here". */
const MIN_RED = 20;
/** A rival must beat the held block by this much, for SWITCH_FRAMES frames. */
const STEAL = 1.3;
const SWITCH_FRAMES = 6;
/** Blink counts this much more than steady redness when scoring. */
const BLINK_WEIGHT = 2;
const HISTORY = 150;

export type Roi = { cx: number; cy: number; r: number };

export type SampleInfo = {
  level: 0 | 1;
  /** Red excess at the tracked spot, 0-255. */
  red: number;
  low: number;
  high: number;
  range: number;
  /** Combined confidence of the current lock. */
  lockScore: number;
  /** A red spot is actually visible. */
  spotFound: boolean;
  manual: boolean;
  saturated: boolean;
};

type Range = { min: number; max: number; step?: number };
type ExtendedCaps = MediaTrackCapabilities & {
  exposureMode?: string[];
  exposureTime?: Range;
  exposureCompensation?: Range;
  whiteBalanceMode?: string[];
  focusMode?: string[];
  focusDistance?: Range;
  pointsOfInterest?: unknown;
  zoom?: Range;
};

/* ------------------------------------------------------------------ tuner */

export type CamCaps = {
  exposure: boolean;
  exposureCompensation: boolean;
  focus: boolean;
  focusDistance: boolean;
  pointsOfInterest: boolean;
  zoom: boolean;
};

/**
 * Wraps the camera controls the browser exposes. Everything here is optional:
 * phones differ wildly in what they allow, so each control is probed first
 * and the UI only offers what actually exists.
 *
 * `auto` is the master switch. While it is on the exposure creeps toward a
 * usable dot by itself; the moment the user moves a slider it turns off and
 * nothing is changed behind their back again.
 */
export class CameraTuner {
  private track: MediaStreamTrack | null = null;
  private caps: ExtendedCaps | null = null;
  private lastNudge = 0;

  auto = true;
  exposureFrac = 0.12;
  zoomFrac = 0;
  focusFrac = 0;
  notes: string[] = [];
  supports: CamCaps = {
    exposure: false,
    exposureCompensation: false,
    focus: false,
    focusDistance: false,
    pointsOfInterest: false,
    zoom: false,
  };

  async attach(track: MediaStreamTrack) {
    this.track = track;
    try {
      this.caps = (track.getCapabilities?.() ?? null) as ExtendedCaps | null;
    } catch {
      this.caps = null;
    }
    const c = this.caps;
    this.supports = {
      exposure: Boolean(c?.exposureTime && c?.exposureMode?.includes('manual')),
      exposureCompensation: Boolean(c?.exposureCompensation),
      focus: Boolean(c?.focusMode && c.focusMode.length > 0),
      focusDistance: Boolean(c?.focusDistance),
      pointsOfInterest: Boolean(c?.pointsOfInterest),
      zoom: Boolean(c?.zoom),
    };
    await this.applyBaseline();
  }

  private async tryApply(c: Record<string, unknown>, label?: string) {
    if (!this.track) return false;
    try {
      await this.track.applyConstraints({ advanced: [c] } as unknown as MediaTrackConstraints);
      if (label) this.notes.push(label);
      return true;
    } catch {
      return false;
    }
  }

  private async applyBaseline() {
    this.notes = [];
    const c = this.caps;
    if (!c) {
      this.notes.push('no manual camera controls on this device');
      return;
    }
    if (this.supports.exposure) await this.setExposureFrac(this.exposureFrac, true);
    else if (this.supports.exposureCompensation && c.exposureCompensation)
      await this.tryApply({ exposureCompensation: c.exposureCompensation.min }, 'exposure down');
    if (c.whiteBalanceMode?.includes('manual'))
      await this.tryApply({ whiteBalanceMode: 'manual' }, 'white balance locked');
    if (c.focusMode?.includes('continuous'))
      await this.tryApply({ focusMode: 'continuous' }, 'autofocus');
    if (this.notes.length === 0) this.notes.push('software detection only');
  }

  private lerp(r: Range | undefined, frac: number) {
    if (!r) return 0;
    return r.min + (r.max - r.min) * Math.min(1, Math.max(0, frac));
  }

  /** 0 = darkest the camera allows, 1 = brightest. */
  async setExposureFrac(frac: number, keepAuto = false) {
    if (!keepAuto) this.auto = false;
    this.exposureFrac = Math.min(1, Math.max(0, frac));
    const c = this.caps;
    if (this.supports.exposure && c?.exposureTime) {
      return this.tryApply({
        exposureMode: 'manual',
        exposureTime: this.lerp(c.exposureTime, this.exposureFrac),
      });
    }
    if (this.supports.exposureCompensation && c?.exposureCompensation) {
      return this.tryApply({
        exposureCompensation: this.lerp(c.exposureCompensation, this.exposureFrac),
      });
    }
    return false;
  }

  async setZoomFrac(frac: number) {
    this.zoomFrac = Math.min(1, Math.max(0, frac));
    const c = this.caps;
    if (!this.supports.zoom || !c?.zoom) return false;
    return this.tryApply({ zoom: this.lerp(c.zoom, this.zoomFrac) });
  }

  async setFocusFrac(frac: number) {
    this.focusFrac = Math.min(1, Math.max(0, frac));
    const c = this.caps;
    if (!this.supports.focusDistance || !c?.focusDistance) return false;
    return this.tryApply({ focusMode: 'manual', focusDistance: this.lerp(c.focusDistance, this.focusFrac) });
  }

  /** Tap to focus. Normalised coordinates, as the tap arrived. */
  async focusAt(nx: number, ny: number) {
    const c = this.caps;
    let ok = false;
    if (this.supports.pointsOfInterest) {
      ok = await this.tryApply({ pointsOfInterest: [{ x: nx, y: ny }] });
    }
    if (c?.focusMode?.includes('single-shot')) {
      ok = (await this.tryApply({ focusMode: 'single-shot' })) || ok;
    } else if (c?.focusMode?.includes('continuous')) {
      ok = (await this.tryApply({ focusMode: 'continuous' })) || ok;
    }
    return ok;
  }

  async restoreAuto() {
    this.auto = true;
    const c = this.caps;
    if (c?.exposureMode?.includes('continuous'))
      await this.tryApply({ exposureMode: 'continuous' });
    if (c?.focusMode?.includes('continuous')) await this.tryApply({ focusMode: 'continuous' });
  }

  /** Only ever runs while auto is on. */
  nudge(red: number, saturated: boolean, now: number) {
    if (!this.auto || !this.supports.exposure) return;
    if (now - this.lastNudge < 1500) return;
    if (saturated) {
      this.lastNudge = now;
      void this.setExposureFrac(this.exposureFrac * 0.7, true);
    } else if (red < MIN_RED) {
      this.lastNudge = now;
      void this.setExposureFrac(Math.min(1, this.exposureFrac * 1.3 + 0.01), true);
    }
  }
}

/* ---------------------------------------------------------------- tracker */

export class SpotTracker {
  roi: Roi = { cx: 0.5, cy: 0.5, r: 0.075 };
  lockScore = 0;
  manual = false;

  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private bmin = new Float32Array(COLS * ROWS);
  private bmax = new Float32Array(COLS * ROWS);
  private reds = new Float32Array(COLS * ROWS);
  // Luminance envelopes run alongside the red ones. A real laser dot is often
  // so bright that its core clips to pure white, and R=G=B=255 has no red
  // excess at all. Only the BLINK of luminance is ever scored, never its
  // steady level, otherwise bright white paper would win every time.
  private lmin = new Float32Array(COLS * ROWS);
  private lmax = new Float32Array(COLS * ROWS);
  private lums = new Float32Array(COLS * ROWS);
  private seeded = false;
  private history: number[] = [];
  private lumHistory: number[] = [];
  private level: 0 | 1 = 1;
  private cx = W / 2;
  private cy = H / 2;
  private rivalBlock = -1;
  private rivalFrames = 0;

  private ensure() {
    if (!this.canvas) {
      this.canvas = document.createElement('canvas');
      this.canvas.width = W;
      this.canvas.height = H;
      this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    }
    return this.ctx;
  }

  reset() {
    this.bmin.fill(0);
    this.bmax.fill(0);
    this.lmin.fill(0);
    this.lmax.fill(0);
    this.history = [];
    this.lumHistory = [];
    this.seeded = false;
    this.lockScore = 0;
    this.manual = false;
    this.rivalBlock = -1;
    this.rivalFrames = 0;
  }

  resetHistory() {
    this.history = [];
    this.lumHistory = [];
  }

  /** Pin the spot by hand. Normalised 0..1 coordinates from a tap. */
  pinTo(nx: number, ny: number) {
    this.cx = Math.min(W - 1, Math.max(0, nx * W));
    this.cy = Math.min(H - 1, Math.max(0, ny * H));
    this.manual = true;
    this.history = [];
    this.lumHistory = [];
    this.rivalBlock = -1;
    this.rivalFrames = 0;
  }

  resumeAuto() {
    this.manual = false;
    this.history = [];
    this.lumHistory = [];
  }

  sample(video: HTMLVideoElement): SampleInfo | null {
    const ctx = this.ensure();
    if (!ctx || video.videoWidth === 0) return null;
    ctx.drawImage(video, 0, 0, W, H);
    const d = ctx.getImageData(0, 0, W, H).data;

    // ---- per block peak red excess AND peak luminance ---------------------
    this.reds.fill(0);
    this.lums.fill(0);
    let anySat = false;
    for (let y = 0; y < H; y++) {
      const brow = (y >> 3) * COLS;
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) << 2;
        const r = d[i];
        const g = d[i + 1];
        const b = d[i + 2];
        const bi = brow + (x >> 3);
        const excess = r - (g > b ? g : b);
        if (excess > this.reds[bi]) this.reds[bi] = excess;
        const lum = r > g ? (r > b ? r : b) : g > b ? g : b;
        if (lum > this.lums[bi]) this.lums[bi] = lum;
        if (r > 250 && g > 250 && b > 250) anySat = true;
      }
    }

    // ---- envelopes --------------------------------------------------------
    if (!this.seeded) {
      this.bmin.set(this.reds);
      this.bmax.set(this.reds);
      this.lmin.set(this.lums);
      this.lmax.set(this.lums);
      this.seeded = true;
    } else {
      for (let b = 0; b < this.reds.length; b++) {
        const v = this.reds[b];
        this.bmin[b] = Math.min(v, this.bmin[b] + LEAK);
        this.bmax[b] = Math.max(v, this.bmax[b] - LEAK);
        const l = this.lums[b];
        this.lmin[b] = Math.min(l, this.lmin[b] + LEAK);
        this.lmax[b] = Math.max(l, this.lmax[b] - LEAK);
      }
    }

    // Steady redness counts, and so does blinking of either signal. Steady
    // brightness never does - that was the original mistake.
    const scoreOf = (b: number) => {
      const redScore = this.bmax[b] + BLINK_WEIGHT * (this.bmax[b] - this.bmin[b]);
      const lumBlink = (this.lmax[b] - this.lmin[b]) * BLINK_WEIGHT;
      return redScore > lumBlink ? redScore : lumBlink;
    };

    const curBlock = (Math.floor(this.cy) >> 3) * COLS + (Math.floor(this.cx) >> 3);
    const curScore = scoreOf(curBlock);

    if (!this.manual) {
      let best = -1;
      let bestScore = 0;
      for (let b = 0; b < this.reds.length; b++) {
        const sc = scoreOf(b);
        if (sc > bestScore) {
          bestScore = sc;
          best = b;
        }
      }
      // Only move for a candidate that is both genuinely red and convincingly
      // better, and that keeps winning. One good frame is not enough; that is
      // what made the circle jump around.
      const credible = (b: number) =>
        this.bmax[b] >= MIN_RED || this.lmax[b] - this.lmin[b] >= MIN_RED;

      const worthMoving =
        best >= 0 &&
        best !== curBlock &&
        credible(best) &&
        bestScore > Math.max(curScore * STEAL, MIN_RED);

      if (worthMoving) {
        if (this.rivalBlock === best) this.rivalFrames++;
        else {
          this.rivalBlock = best;
          this.rivalFrames = 1;
        }
        // If we hold nothing at all, take the first credible candidate at once.
        const holdingNothing = !credible(curBlock);
        if (this.rivalFrames >= (holdingNothing ? 2 : SWITCH_FRAMES)) {
          this.cx = ((best % COLS) + 0.5) * BLOCK;
          this.cy = (Math.floor(best / COLS) + 0.5) * BLOCK;
          this.history = [];
          this.lumHistory = [];
          this.rivalBlock = -1;
          this.rivalFrames = 0;
        }
      } else {
        this.rivalFrames = 0;
        this.rivalBlock = -1;
      }
    }

    // ---- measure at the tracked point -------------------------------------
    const R = 7;
    let red = 0;
    let lum = 0;
    let px = this.cx;
    let py = this.cy;
    const x0 = Math.max(0, Math.round(this.cx) - R);
    const x1 = Math.min(W - 1, Math.round(this.cx) + R);
    const y0 = Math.max(0, Math.round(this.cy) - R);
    const y1 = Math.min(H - 1, Math.round(this.cy) + R);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = (y * W + x) << 2;
        const r = d[i];
        const g = d[i + 1];
        const b = d[i + 2];
        const excess = r - (g > b ? g : b);
        if (excess > red) {
          red = excess;
          px = x;
          py = y;
        }
        const l = r > g ? (r > b ? r : b) : g > b ? g : b;
        if (l > lum) lum = l;
      }
    }

    const band = (h: number[]) => {
      const s = [...h].sort((a, b) => a - b);
      const lo = s[Math.floor(s.length * 0.1)] ?? 0;
      const hi = s[Math.floor(s.length * 0.9)] ?? 0;
      return { lo, hi, range: hi - lo };
    };

    this.history.push(red);
    if (this.history.length > HISTORY) this.history.shift();
    this.lumHistory.push(lum);
    if (this.lumHistory.length > HISTORY) this.lumHistory.shift();

    const redBand = band(this.history);
    const lumBand = band(this.lumHistory);

    // Decide bits on whichever signal is actually swinging. Redness is the
    // better discriminator and wins ties, but a clipped white-hot dot only
    // shows up in luminance, and then that is what has to be used.
    const useLum = lumBand.range > redBand.range * 1.5 && redBand.range < 10;
    const value = useLum ? lum : red;
    const chosen = useLum ? lumBand : redBand;
    const low = chosen.lo;
    const high = chosen.hi;
    const range = chosen.range;

    if (range >= 10) {
      const hi = low + range * 0.6;
      const lo = low + range * 0.4;
      if (value >= hi) this.level = 1;
      else if (value <= lo) this.level = 0;
    } else {
      // Not blinking yet: steady red means the beam is simply sitting on.
      this.level = red >= MIN_RED ? 1 : this.level;
    }

    // Creep onto the hot pixel while the beam is lit, so slow drift of the
    // phone or the spot is followed without the circle hunting.
    if (red >= MIN_RED && this.level === 1) {
      this.cx += (px - this.cx) * 0.2;
      this.cy += (py - this.cy) * 0.2;
    }

    const spotFound =
      this.bmax[curBlock] >= MIN_RED ||
      red >= MIN_RED ||
      this.lmax[curBlock] - this.lmin[curBlock] >= MIN_RED;
    this.lockScore = Math.round(Math.max(curScore, red));
    this.roi = { cx: this.cx / W, cy: this.cy / H, r: 0.075 };

    return {
      level: this.level,
      red,
      low,
      high,
      range,
      lockScore: this.lockScore,
      spotFound,
      manual: this.manual,
      saturated: anySat && red < MIN_RED,
    };
  }
}
