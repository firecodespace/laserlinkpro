/**
 * Camera front end.
 *
 * Two jobs, both automatic:
 *
 *  1. Find the laser spot. The naive way is "brightest pixel", which happily
 *     locks onto a ceiling lamp or a reflection and never recovers. Instead
 *     every block of the picture carries a slowly decaying min/max envelope,
 *     and the spot is taken to be the block that is *changing* the most. A
 *     lamp is bright but constant, so its envelope collapses and it scores
 *     near zero. The laser blinks, so it wins. The beacon sent before each
 *     message exists partly to make this unambiguous.
 *
 *  2. Turn each video frame into one ON/OFF decision, with an adaptive
 *     threshold and hysteresis so slow drift in the room does not matter.
 *
 * Camera controls are tuned automatically where the browser exposes them:
 * a short exposure keeps the room dark while the laser stays bright, which
 * is exactly the contrast the decoder wants.
 */

const W = 160;
const H = 120;
const BLOCK = 8;
const COLS = W / BLOCK; // 20
const ROWS = H / BLOCK; // 15

/** How fast a block's min/max envelope relaxes back, per frame. */
const LEAK = 0.7;
/** A block must swing at least this much to count as "blinking". */
const MIN_BLINK_AMP = 16;
/** A rival block must beat the locked one by this factor to steal the lock. */
const STEAL_FACTOR = 1.4;
const HISTORY = 150;

export type Roi = { cx: number; cy: number; r: number };

export type SampleInfo = {
  level: 0 | 1;
  peak: number;
  low: number;
  high: number;
  range: number;
  /** Blink amplitude of the tracked block - the confidence of the lock. */
  lockScore: number;
  locked: boolean;
  saturated: boolean;
};

type Range = { min: number; max: number; step?: number };
type ExtendedCaps = MediaTrackCapabilities & {
  exposureMode?: string[];
  exposureTime?: Range;
  exposureCompensation?: Range;
  whiteBalanceMode?: string[];
  focusMode?: string[];
};

/* ------------------------------------------------------------------ tuner */

/**
 * Drives whatever manual camera controls the browser exposes, then keeps
 * nudging exposure so the laser spot stays bright without saturating.
 */
export class CameraTuner {
  private track: MediaStreamTrack | null = null;
  private caps: ExtendedCaps | null = null;
  private exposureFrac = 0.12;
  private lastNudge = 0;
  notes: string[] = [];

  async attach(track: MediaStreamTrack) {
    this.track = track;
    try {
      this.caps = (track.getCapabilities?.() ?? null) as ExtendedCaps | null;
    } catch {
      this.caps = null;
    }
    await this.applyBaseline();
  }

  private async tryApply(c: Record<string, unknown>, label: string) {
    if (!this.track) return false;
    try {
      await this.track.applyConstraints({
        advanced: [c],
      } as unknown as MediaTrackConstraints);
      this.notes.push(label);
      return true;
    } catch {
      return false;
    }
  }

  private async applyBaseline() {
    const caps = this.caps;
    this.notes = [];
    if (!caps) {
      this.notes.push('no manual controls, using software threshold');
      return;
    }

    // Stop the camera chasing the scene: a hunting auto-exposure turns a
    // steady laser dot into a slowly fading one and ruins the bit decisions.
    if (caps.exposureMode?.includes('manual') && caps.exposureTime) {
      await this.setExposureFrac(this.exposureFrac);
    } else if (caps.exposureCompensation) {
      await this.tryApply(
        { exposureCompensation: caps.exposureCompensation.min },
        'exposure darkened',
      );
    }
    if (caps.whiteBalanceMode?.includes('manual')) {
      await this.tryApply({ whiteBalanceMode: 'manual' }, 'white balance locked');
    }
    if (caps.focusMode?.includes('continuous')) {
      await this.tryApply({ focusMode: 'continuous' }, 'autofocus');
    }
    if (this.notes.length === 0) this.notes.push('software threshold only');
  }

  private async setExposureFrac(frac: number) {
    const et = this.caps?.exposureTime;
    if (!et) return false;
    this.exposureFrac = Math.min(0.9, Math.max(0.02, frac));
    const value = et.min + (et.max - et.min) * this.exposureFrac;
    return this.tryApply({ exposureMode: 'manual', exposureTime: value }, 'exposure fixed');
  }

  get canAdjustExposure() {
    return Boolean(this.caps?.exposureTime && this.caps?.exposureMode?.includes('manual'));
  }

  /**
   * Called once per frame with the current peak. Acts at most twice a second
   * and only at the extremes, so it never fights the decoder.
   */
  nudge(peak: number, now: number) {
    if (!this.canAdjustExposure) return;
    if (now - this.lastNudge < 1500) return;
    if (peak > 250) {
      this.lastNudge = now;
      void this.setExposureFrac(this.exposureFrac * 0.7);
    } else if (peak < 70) {
      this.lastNudge = now;
      void this.setExposureFrac(this.exposureFrac * 1.4);
    }
  }
}

/* ---------------------------------------------------------------- tracker */

export class SpotTracker {
  roi: Roi = { cx: 0.5, cy: 0.5, r: 0.07 };
  lockScore = 0;

  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private bmin = new Float32Array(COLS * ROWS).fill(255);
  private bmax = new Float32Array(COLS * ROWS).fill(0);
  private peaks = new Float32Array(COLS * ROWS);
  private seeded = false;
  private history: number[] = [];
  private level: 0 | 1 = 1;
  private cx = W / 2;
  private cy = H / 2;

  private ensure() {
    if (!this.canvas) {
      this.canvas = document.createElement('canvas');
      this.canvas.width = W;
      this.canvas.height = H;
      this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    }
    return this.ctx;
  }

  /** Forget everything and re-acquire from scratch. */
  reset() {
    this.bmin.fill(255);
    this.bmax.fill(0);
    this.history = [];
    this.seeded = false;
    this.lockScore = 0;
  }

  resetHistory() {
    this.history = [];
  }

  sample(video: HTMLVideoElement): SampleInfo | null {
    const ctx = this.ensure();
    if (!ctx || video.videoWidth === 0) return null;
    ctx.drawImage(video, 0, 0, W, H);
    const d = ctx.getImageData(0, 0, W, H).data;

    // ---- per block peak brightness, red weighted for a red laser ----------
    this.peaks.fill(0);
    for (let y = 0; y < H; y++) {
      const brow = (y >> 3) * COLS;
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) << 2;
        const v = d[i] * 0.6 + d[i + 1] * 0.2 + d[i + 2] * 0.2;
        const b = brow + (x >> 3);
        if (v > this.peaks[b]) this.peaks[b] = v;
      }
    }

    // ---- update the blink envelopes --------------------------------------
    if (!this.seeded) {
      this.bmin.set(this.peaks);
      this.bmax.set(this.peaks);
      this.seeded = true;
    } else {
      for (let b = 0; b < this.peaks.length; b++) {
        const v = this.peaks[b];
        this.bmin[b] = Math.min(v, this.bmin[b] + LEAK);
        this.bmax[b] = Math.max(v, this.bmax[b] - LEAK);
      }
    }

    // ---- pick the block that is changing the most ------------------------
    let best = -1;
    let bestAmp = 0;
    for (let b = 0; b < this.peaks.length; b++) {
      const amp = this.bmax[b] - this.bmin[b];
      if (amp > bestAmp) {
        bestAmp = amp;
        best = b;
      }
    }

    const curBlock = (Math.floor(this.cy) >> 3) * COLS + (Math.floor(this.cx) >> 3);
    const curAmp = this.bmax[curBlock] - this.bmin[curBlock];
    const haveLock = curAmp >= MIN_BLINK_AMP;

    if (best >= 0 && bestAmp >= MIN_BLINK_AMP) {
      if (!haveLock || bestAmp > curAmp * STEAL_FACTOR) {
        this.cx = ((best % COLS) + 0.5) * BLOCK;
        this.cy = (Math.floor(best / COLS) + 0.5) * BLOCK;
        this.history = [];
      }
    }
    this.lockScore = Math.max(curAmp, haveLock ? curAmp : bestAmp);

    // ---- measure: brightest pixel near the tracked centre -----------------
    const R = 7;
    let peak = 0;
    let px = this.cx;
    let py = this.cy;
    const x0 = Math.max(0, Math.round(this.cx) - R);
    const x1 = Math.min(W - 1, Math.round(this.cx) + R);
    const y0 = Math.max(0, Math.round(this.cy) - R);
    const y1 = Math.min(H - 1, Math.round(this.cy) + R);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = (y * W + x) << 2;
        const v = d[i] * 0.6 + d[i + 1] * 0.2 + d[i + 2] * 0.2;
        if (v > peak) {
          peak = v;
          px = x;
          py = y;
        }
      }
    }

    this.history.push(peak);
    if (this.history.length > HISTORY) this.history.shift();
    const sorted = [...this.history].sort((a, b) => a - b);
    const low = sorted[Math.floor(sorted.length * 0.1)] ?? 0;
    const high = sorted[Math.floor(sorted.length * 0.9)] ?? 0;
    const range = high - low;

    if (range >= 12) {
      const hi = low + range * 0.6;
      const lo = low + range * 0.4;
      if (peak >= hi) this.level = 1;
      else if (peak <= lo) this.level = 0;
      // Creep the centre toward the hot pixel only while the beam is on,
      // so a dim frame cannot drag the window onto background noise.
      if (this.level === 1) {
        this.cx += (px - this.cx) * 0.15;
        this.cy += (py - this.cy) * 0.15;
      }
    }

    this.roi = { cx: this.cx / W, cy: this.cy / H, r: 0.075 };

    return {
      level: this.level,
      peak,
      low,
      high,
      range,
      lockScore: this.lockScore,
      locked: this.lockScore >= MIN_BLINK_AMP && range >= 12,
      saturated: peak > 250,
    };
  }
}
