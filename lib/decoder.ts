/**
 * Streaming decoder: turns a sequence of (timestamp, light level) samples
 * from the camera into LaserLink frames.
 *
 * A phone camera runs at roughly 30 fps, so at the default 120 ms bit time
 * there are only about 3.6 samples per bit. That is barely above Nyquist, and
 * every decision has to be made carefully.
 *
 * Acquisition works in three stages:
 *
 *   HUNT    Watch run lengths for the preamble guard - an ON period longer
 *           than any that can occur inside a frame - preceded by the half
 *           second gap. This part is easy: the runs involved are long.
 *
 *   SEARCH  The hard part. Rather than trusting the single edge at the end of
 *           the guard to set the bit clock, the first two bytes of every
 *           frame are known to be 0xFF 0x7E, so they serve as a training
 *           sequence. The decoder sweeps clock phase AND clock rate, decodes
 *           the candidate header at each setting, and keeps the alignment
 *           that actually yields 0xFF 0x7E. A single edge can be off by half
 *           a video frame; sixteen known bits cannot lie.
 *
 *           Sweeping rate as well as phase means a bit time mismatch between
 *           the two ends is detected instead of silently failing, and the
 *           measured bit time is reported so it can be corrected.
 *
 *   BYTES   Decode the rest at the locked rate, resynchronising on each
 *           byte's start edge, with a watchdog that gives up promptly once
 *           the beam stops changing.
 */

import { SOF0, SOF1, MAX_PAYLOAD, guardMs, parseFrame, type ParsedFrame } from './protocol';

export type Sample = { t: number; v: 0 | 1 };

export type DecodeEvent =
  | { kind: 'sync'; t: number }
  | { kind: 'lock'; t: number; bitMs: number; score: number }
  | { kind: 'byte'; t: number; index: number; value: number }
  | { kind: 'frame'; t: number; frame: ParsedFrame }
  | { kind: 'abort'; t: number; reason: string };

const BUFFER_MS = 30000;

/** Clock phase offsets tried during SEARCH, in bits. */
const PHASE_MIN = -0.7;
const PHASE_MAX = 0.7;
const PHASE_STEP = 0.05;
/** Clock rate factors tried during SEARCH. Wide enough to catch a mismatch. */
const RATE_MIN = 0.9;
const RATE_MAX = 1.1;
const RATE_STEP = 0.02;

/** Expected line states of the two header bytes: start, 8 data LSB first, stop. */
function headerBits(): (0 | 1)[] {
  const out: (0 | 1)[] = [];
  for (const b of [SOF0, SOF1]) {
    out.push(0);
    for (let i = 0; i < 8; i++) out.push(((b >> i) & 1) as 0 | 1);
    out.push(1);
  }
  return out;
}
const HEADER_BITS = headerBits();

function hex(b: number) {
  return b.toString(16).padStart(2, '0').toUpperCase();
}

export class LaserDecoder {
  bitMs: number;
  onEvent?: (e: DecodeEvent) => void;
  /** Bytes whose start or stop bit was misread but which CRC-8 still judged. */
  framingErrors = 0;

  private buf: Sample[] = [];
  private curLevel: 0 | 1 | null = null;
  private curStart = 0;
  private lastOffMs = 0;
  private lastOffEndedAt = -1;
  private lastEdgeAt = 0;

  private mode: 'HUNT' | 'SEARCH' | 'BYTES' = 'HUNT';
  private syncAt = 0;
  /** Bit period actually in use, after the rate search. */
  private bitEff = 120;
  private nextStart = 0;
  private bytes: number[] = [];

  // Glitch filter: one mis-read video frame must not chop a run in two.
  private pendLevel: 0 | 1 | null = null;
  private pendSince = 0;
  private pendCount = 0;
  private lastSameT = 0;

  constructor(bitMs: number) {
    this.bitMs = bitMs;
    this.bitEff = bitMs;
  }

  setBitMs(ms: number) {
    this.bitMs = ms;
    this.bitEff = ms;
    this.reset();
  }

  reset() {
    this.mode = 'HUNT';
    this.bytes = [];
    this.framingErrors = 0;
    this.curLevel = null;
    this.lastOffMs = 0;
    this.lastOffEndedAt = -1;
    this.pendLevel = null;
    this.pendCount = 0;
    this.bitEff = this.bitMs;
  }

  get locked() {
    return this.mode !== 'HUNT';
  }

  get byteCount() {
    return this.bytes.length;
  }

  get expectedBytes(): number {
    return this.bytes.length >= 3 ? 3 + this.bytes[2] + 1 : -1;
  }

  /** Feed one camera sample. Call once per video frame. */
  push(t: number, v: 0 | 1) {
    this.buf.push({ t, v });
    const cutoff = t - BUFFER_MS;
    while (this.buf.length && this.buf[0].t < cutoff) this.buf.shift();

    if (this.curLevel === null) {
      this.curLevel = v;
      this.curStart = t;
      this.lastSameT = t;
      this.lastEdgeAt = t;
    } else if (v === this.curLevel) {
      this.lastSameT = t;
      this.pendLevel = null;
      this.pendCount = 0;
    } else {
      if (this.pendLevel === v) this.pendCount++;
      else {
        this.pendLevel = v;
        this.pendCount = 1;
        this.pendSince = t;
      }
      if (this.pendCount >= this.confirmSamples()) {
        // The true edge lies between the last sample at the old level and the
        // first at the new one; either end biases the clock by up to a frame.
        const edge = (this.lastSameT + this.pendSince) / 2;
        this.onRunEnd(this.curLevel, this.curStart, edge);
        this.curLevel = v;
        this.curStart = edge;
        this.lastEdgeAt = edge;
        this.lastSameT = t;
        this.pendLevel = null;
        this.pendCount = 0;
      }
    }

    if (this.mode === 'SEARCH') this.trySearch(t);
    if (this.mode === 'BYTES') this.drainBytes(t);
  }

  private sampleIntervalMs(): number {
    const n = this.buf.length;
    if (n < 6) return 33;
    const span = this.buf[n - 1].t - this.buf[n - 6].t;
    return span > 0 ? span / 5 : 33;
  }

  private confirmSamples(): number {
    return this.bitMs / this.sampleIntervalMs() >= 3 ? 2 : 1;
  }

  /* ------------------------------------------------------------- stage 1 */

  private onRunEnd(level: 0 | 1, start: number, end: number) {
    const dur = end - start;
    if (level === 0) {
      this.lastOffMs = dur;
      this.lastOffEndedAt = end;
      return;
    }
    if (this.mode !== 'HUNT') return;
    // The guard is always at least 1 s by protocol, whatever bit time the
    // sender uses, so threshold on that floor rather than on OUR configured
    // bit time. Scaling it by our own setting meant that a receiver set
    // slower than the sender never synchronised and reported nothing at all.
    const needed = 0.8 * Math.min(guardMs(this.bitMs), 1000);
    const gapRecent = this.lastOffEndedAt >= 0 && Math.abs(this.lastOffEndedAt - start) < 1;
    const gapRight = this.lastOffMs >= 250 && this.lastOffMs <= 1500;
    if (dur >= needed && gapRecent && gapRight) {
      this.mode = 'SEARCH';
      this.syncAt = end;
      this.bytes = [];
      this.framingErrors = 0;
      this.onEvent?.({ kind: 'sync', t: end });
    }
  }

  /* ------------------------------------------------------------- stage 2 */

  /** Once two bytes of samples exist past the guard, align the clock to them. */
  private trySearch(now: number) {
    const needUntil = this.syncAt + 20 * this.bitMs * 2.3 + this.bitMs;
    if (now < needUntil) return;

    const best = this.scanHeader(RATE_MIN, RATE_MAX);
    let bestScore = best.score;
    let bestPhase = best.phase;
    let bestRate = best.rate;
    let bestB0 = best.b0;
    let bestB1 = best.b1;

    // If the nominal rate finds nothing, sweep wide purely to report what the
    // sender is probably set to. Never lock to it: a wrong rate that happens
    // to fit the header will produce garbage for the rest of the frame.
    if (bestB0 !== SOF0 || bestB1 !== SOF1) {
      const wide = this.scanHeader(0.45, 2.2);
      if (wide.b0 === SOF0 && wide.b1 === SOF1) {
        this.abort(
          now,
          'bit time mismatch - the sender looks set to about ' +
            Math.round(this.bitMs * wide.rate) +
            ' ms per bit, this page is on ' +
            this.bitMs +
            ' ms. Set both the same.',
        );
        return;
      }
    }

    const bit = this.bitMs * bestRate;
    const t0 = this.syncAt + bestPhase * bit;

    if (bestB0 !== SOF0 || bestB1 !== SOF1) {
      this.abort(
        now,
        'no header found - best was 0x' +
          hex(bestB0) +
          ' 0x' +
          hex(bestB1) +
          ' (' +
          bestScore +
          '/20 bits), wanted 0xFF 0x7E',
      );
      return;
    }

    this.bitEff = bit;
    this.mode = 'BYTES';
    this.bytes = [];
    this.nextStart = t0;
    this.onEvent?.({ kind: 'lock', t: now, bitMs: Math.round(bit), score: bestScore });
    this.drainBytes(now);
  }

  /**
   * Sweep clock phase and rate, scoring each alignment against the known
   * header bits.
   *
   * Ties matter more than they look. The header is mostly ones, so a clock
   * running at the wrong rate can still match all twenty bits by luck. Among
   * equal scores the alignment closest to the nominal rate wins, and then the
   * one closest to the edge the guard gave us - both are strong priors, and
   * taking whichever happened to be tried first is how this went wrong.
   */
  private scanHeader(rateMin: number, rateMax: number) {
    let bestScore = -1;
    let bestRate = 1;
    let bestPhase = 0;
    let bestB0 = 0;
    let bestB1 = 0;

    for (let rate = rateMin; rate <= rateMax + 1e-9; rate += RATE_STEP) {
      const bit = this.bitMs * rate;
      for (let ph = PHASE_MIN; ph <= PHASE_MAX + 1e-9; ph += PHASE_STEP) {
        const t0 = this.syncAt + ph * bit;
        let score = 0;
        for (let i = 0; i < 20; i++) {
          if (this.levelAt(t0 + (i + 0.5) * bit, bit) === HEADER_BITS[i]) score++;
        }
        const better =
          score > bestScore ||
          (score === bestScore &&
            (Math.abs(rate - 1) < Math.abs(bestRate - 1) - 1e-9 ||
              (Math.abs(Math.abs(rate - 1) - Math.abs(bestRate - 1)) < 1e-9 &&
                Math.abs(ph) < Math.abs(bestPhase))));
        if (better) {
          bestScore = score;
          bestRate = rate;
          bestPhase = ph;
        }
      }
    }
    const bit = this.bitMs * bestRate;
    const t0 = this.syncAt + bestPhase * bit;
    bestB0 = this.byteAt(t0, bit).value;
    bestB1 = this.byteAt(t0 + 10 * bit, bit).value;
    return { score: bestScore, rate: bestRate, phase: bestPhase, b0: bestB0, b1: bestB1 };
  }

  /* ------------------------------------------------------------- stage 3 */

  private byteAt(ts: number, bit: number) {
    const startOk = this.levelAt(ts + 0.5 * bit, bit) === 0;
    let value = 0;
    for (let i = 0; i < 8; i++) {
      if (this.levelAt(ts + (1.5 + i) * bit, bit) === 1) value |= 1 << i;
    }
    const stopOk = this.levelAt(ts + 9.5 * bit, bit) === 1;
    return { value, startOk, stopOk };
  }

  private drainBytes(now: number) {
    const bit = this.bitEff;
    const margin = Math.max(bit * 0.45, 8);

    // Watchdog: the longest run a frame can contain is nine bit times, so if
    // the beam has not changed in appreciably longer than that, the sender
    // has stopped and there is nothing left to wait for.
    if (this.bytes.length > 0 && now - this.lastEdgeAt > 14 * bit) {
      this.abort(now, 'signal stopped after ' + this.bytes.length + ' bytes');
      return;
    }

    while (this.mode === 'BYTES' && now >= this.nextStart + 9.5 * bit + margin) {
      const ts = this.nextStart;
      const { value, startOk, stopOk } = this.byteAt(ts, bit);

      if ((!startOk || !stopOk) && this.bytes.length < 2) {
        this.abort(now, startOk ? 'lost framing on the header' : 'no start bit on the header');
        return;
      }
      if (!startOk || !stopOk) this.framingErrors++;

      if (!this.acceptByte(value, now)) return;

      const expected = ts + 10 * bit;
      const edge = this.fallingEdgeNear(expected - 0.45 * bit, expected + 0.45 * bit);
      this.nextStart = edge ?? expected;
    }
  }

  private acceptByte(byte: number, now: number): boolean {
    const i = this.bytes.length;
    if (i === 0 && byte !== SOF0) {
      this.abort(now, 'header byte 1 was 0x' + hex(byte) + ', wanted 0xFF');
      return false;
    }
    if (i === 1 && byte !== SOF1) {
      this.abort(now, 'header byte 2 was 0x' + hex(byte) + ', wanted 0x7E');
      return false;
    }
    if (i === 2 && (byte < 1 || byte > MAX_PAYLOAD)) {
      this.abort(now, 'length byte was ' + byte + ', outside 1..' + MAX_PAYLOAD);
      return false;
    }
    this.bytes.push(byte);
    this.onEvent?.({ kind: 'byte', t: now, index: i, value: byte });

    const len = this.bytes[2];
    if (this.bytes.length >= 3 && this.bytes.length === 3 + len + 1) {
      const frame = parseFrame(this.bytes);
      this.onEvent?.({ kind: 'frame', t: now, frame });
      this.toHunt();
      return false;
    }
    return true;
  }

  private toHunt() {
    this.mode = 'HUNT';
    this.bytes = [];
    this.lastOffMs = 0;
    this.lastOffEndedAt = -1;
  }

  private abort(now: number, reason: string) {
    this.onEvent?.({ kind: 'abort', t: now, reason });
    this.toHunt();
  }

  /* --------------------------------------------------------------- utils */

  /** First buffer index at or after time t. The buffer is time ordered. */
  private indexAtOrAfter(t: number): number {
    let lo = 0;
    let hi = this.buf.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.buf[mid].t < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /**
   * Triangular-weighted vote across one bit: a sample on the bit centre counts
   * fully, one out at the bit edge counts for almost nothing. Uses every
   * sample the bit received rather than just the nearest, which matters a
   * great deal at three samples per bit.
   */
  private levelAt(t: number, bit: number): 0 | 1 {
    const reach = Math.max(bit * 0.6, 12);
    let ones = 0;
    let zeros = 0;
    for (let i = this.indexAtOrAfter(t - reach); i < this.buf.length; i++) {
      const s = this.buf[i];
      const dt = s.t - t;
      if (dt > reach) break;
      const w = 1 - Math.abs(dt) / reach;
      if (s.v) ones += w;
      else zeros += w;
    }
    if (ones + zeros === 0) {
      const i = Math.min(this.buf.length - 1, Math.max(0, this.indexAtOrAfter(t)));
      return this.buf[i] ? this.buf[i].v : 1;
    }
    return ones >= zeros ? 1 : 0;
  }

  private fallingEdgeNear(lo: number, hi: number): number | null {
    for (let i = Math.max(1, this.indexAtOrAfter(lo) - 1); i < this.buf.length; i++) {
      const a = this.buf[i - 1];
      const c = this.buf[i];
      if (!a || !c) break;
      if (c.t > hi + 50) break;
      if (a.v === 1 && c.v === 0) {
        const t = (a.t + c.t) / 2;
        if (t >= lo && t <= hi) return t;
      }
    }
    return null;
  }
}
