/**
 * Camera front end: find the laser spot in the video, then turn each video
 * frame into a single ON/OFF decision for the decoder.
 *
 * The spot is small and the room is dim, so brightness is measured as the
 * mean of the brightest few pixels inside a small region of interest rather
 * than the mean of the whole region, which would wash the signal out.
 */

export type Roi = { cx: number; cy: number; r: number };

export type SampleInfo = {
  bright: number;
  level: 0 | 1;
  low: number;
  high: number;
  range: number;
};

const ANALYSIS_W = 192;
const ANALYSIS_H = 144;
const HISTORY = 150; // about 5 s at 30 fps

export class SpotSampler {
  roi: Roi = { cx: 0.5, cy: 0.5, r: 0.06 };
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private history: number[] = [];
  private level: 0 | 1 = 1;

  private ensure() {
    if (!this.canvas) {
      this.canvas = document.createElement('canvas');
      this.canvas.width = ANALYSIS_W;
      this.canvas.height = ANALYSIS_H;
      this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    }
    return this.ctx;
  }

  private grab(video: HTMLVideoElement): ImageData | null {
    const ctx = this.ensure();
    if (!ctx || video.videoWidth === 0) return null;
    ctx.drawImage(video, 0, 0, ANALYSIS_W, ANALYSIS_H);
    return ctx.getImageData(0, 0, ANALYSIS_W, ANALYSIS_H);
  }

  /** Point the region of interest at the brightest blob in the frame. */
  findDot(video: HTMLVideoElement): Roi | null {
    const img = this.grab(video);
    if (!img) return null;
    const d = img.data;
    let best = -1;
    let bestI = 0;
    for (let i = 0; i < d.length; i += 4) {
      // The KY-008 is red, so weight red but keep the others for a blown-out
      // white core.
      const v = d[i] * 0.6 + d[i + 1] * 0.2 + d[i + 2] * 0.2;
      if (v > best) {
        best = v;
        bestI = i >> 2;
      }
    }
    if (best < 40) return null;

    // Centroid of everything near that peak, so a slightly smeared dot still
    // lands the region of interest in the middle.
    const thr = best - 35;
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      const v = d[i] * 0.6 + d[i + 1] * 0.2 + d[i + 2] * 0.2;
      if (v >= thr) {
        const p = i >> 2;
        sx += p % ANALYSIS_W;
        sy += Math.floor(p / ANALYSIS_W);
        n++;
      }
    }
    if (n === 0) {
      sx = bestI % ANALYSIS_W;
      sy = Math.floor(bestI / ANALYSIS_W);
      n = 1;
    }
    this.roi = { cx: sx / n / ANALYSIS_W, cy: sy / n / ANALYSIS_H, r: 0.07 };
    this.history = [];
    return this.roi;
  }

  /** One frame -> one ON/OFF decision, with hysteresis around the midpoint. */
  sample(video: HTMLVideoElement): SampleInfo | null {
    const img = this.grab(video);
    if (!img) return null;
    const d = img.data;

    const cx = Math.round(this.roi.cx * ANALYSIS_W);
    const cy = Math.round(this.roi.cy * ANALYSIS_H);
    const rad = Math.max(2, Math.round(this.roi.r * ANALYSIS_W));
    const vals: number[] = [];
    for (let y = cy - rad; y <= cy + rad; y++) {
      if (y < 0 || y >= ANALYSIS_H) continue;
      for (let x = cx - rad; x <= cx + rad; x++) {
        if (x < 0 || x >= ANALYSIS_W) continue;
        const i = (y * ANALYSIS_W + x) * 4;
        vals.push(d[i] * 0.6 + d[i + 1] * 0.2 + d[i + 2] * 0.2);
      }
    }
    if (vals.length === 0) return null;
    vals.sort((a, b) => b - a);
    const topN = Math.max(3, Math.round(vals.length * 0.08));
    let sum = 0;
    for (let i = 0; i < topN; i++) sum += vals[i];
    const bright = sum / topN;

    this.history.push(bright);
    if (this.history.length > HISTORY) this.history.shift();

    const sorted = [...this.history].sort((a, b) => a - b);
    const low = sorted[Math.floor(sorted.length * 0.1)];
    const high = sorted[Math.floor(sorted.length * 0.9)];
    const range = high - low;

    if (range >= 12) {
      const hi = low + range * 0.6;
      const lo = low + range * 0.4;
      if (bright >= hi) this.level = 1;
      else if (bright <= lo) this.level = 0;
    } else {
      // Not enough contrast yet to call it - hold at idle.
      this.level = bright > (low + high) / 2 ? 1 : this.level;
    }

    return { bright, level: this.level, low, high, range };
  }

  resetHistory() {
    this.history = [];
  }
}
