/**
 * Streaming decoder: turns a sequence of (timestamp, light level) samples
 * from the camera into LaserLink frames.
 *
 * The camera runs at roughly 30 fps, so at the default 120 ms bit time there
 * are only about 3.6 samples per bit. Every decision therefore votes over a
 * window of samples instead of trusting a single frame, and the decoder
 * re-syncs on the falling edge at the start of every byte so clock drift
 * cannot accumulate across a message.
 */

import { SOF0, SOF1, MAX_PAYLOAD, guardMs, parseFrame, type ParsedFrame } from './protocol';

export type Sample = { t: number; v: 0 | 1 };

export type DecodeEvent =
  | { kind: 'sync'; t: number }
  | { kind: 'frame'; t: number; frame: ParsedFrame }
  | { kind: 'abort'; t: number; reason: string };

const BUFFER_MS = 20000;

export class LaserDecoder {
  bitMs: number;
  onEvent?: (e: DecodeEvent) => void;

  private buf: Sample[] = [];
  private curLevel: 0 | 1 | null = null;
  private curStart = 0;
  private lastOffMs = 0;
  private lastOffEndedAt = -1;

  private mode: 'HUNT' | 'BYTES' = 'HUNT';
  private nextStart = 0;
  private bytes: number[] = [];

  // Glitch filter. A single mis-read video frame would otherwise chop a run
  // in half, and the preamble guard would never be recognised. A level change
  // is only believed once `confirmSamples` samples in a row agree, but the
  // edge is timestamped at the FIRST of them so the bit clock stays aligned.
  private pendLevel: 0 | 1 | null = null;
  private pendSince = 0;
  private pendCount = 0;

  /** Bytes whose start or stop bit was misread but which CRC-8 still judged. */
  framingErrors = 0;

  constructor(bitMs: number) {
    this.bitMs = bitMs;
  }

  /** Change bit time mid-run (the dropdown in the UI). Resets sync. */
  setBitMs(ms: number) {
    this.bitMs = ms;
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
  }

  get locked() {
    return this.mode === 'BYTES';
  }

  /** Bytes of the current frame recovered so far. */
  get byteCount(): number {
    return this.bytes.length;
  }

  /**
   * Total bytes this frame will have, once the length byte has arrived.
   * -1 while that is still unknown, so the UI can show an indeterminate bar.
   */
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
    } else if (v === this.curLevel) {
      this.pendLevel = null;
      this.pendCount = 0;
    } else {
      if (this.pendLevel === v) {
        this.pendCount++;
      } else {
        this.pendLevel = v;
        this.pendCount = 1;
        this.pendSince = t;
      }
      if (this.pendCount >= this.confirmSamples()) {
        this.onRunEnd(this.curLevel, this.curStart, this.pendSince);
        this.curLevel = v;
        this.curStart = this.pendSince;
        this.pendLevel = null;
        this.pendCount = 0;
      }
    }
    this.drainBytes(t);
  }

  /** Mean gap between the most recent samples, i.e. one over the frame rate. */
  private sampleIntervalMs(): number {
    const n = this.buf.length;
    if (n < 6) return 33;
    const span = this.buf[n - 1].t - this.buf[n - 6].t;
    return span > 0 ? span / 5 : 33;
  }

  /**
   * Require two agreeing samples when the camera gives us enough of them,
   * otherwise fall back to one - below three samples per bit a two-sample
   * filter would swallow real bits.
   */
  private confirmSamples(): number {
    return this.bitMs / this.sampleIntervalMs() >= 3 ? 2 : 1;
  }

  /** Samples per bit the camera is currently delivering. */
  get samplesPerBit(): number {
    return this.bitMs / this.sampleIntervalMs();
  }

  /** A run of constant level just finished: [start, end) at level `level`. */
  private onRunEnd(level: 0 | 1, start: number, end: number) {
    const dur = end - start;
    if (level === 0) {
      this.lastOffMs = dur;
      this.lastOffEndedAt = end;
      return;
    }
    // A long ON run is the preamble guard. It is deliberately longer than the
    // longest ON run possible inside a frame (9 bit times, from byte 0xFF).
    const needed = guardMs(this.bitMs) * 0.8;
    const gapWasRecent = this.lastOffEndedAt >= 0 && Math.abs(this.lastOffEndedAt - start) < 1;
    const gapLookedRight = this.lastOffMs >= 250 && this.lastOffMs <= 1500;
    if (dur >= needed && gapWasRecent && gapLookedRight) {
      this.mode = 'BYTES';
      this.bytes = [];
      this.nextStart = end; // this falling edge is the first start bit
      this.onEvent?.({ kind: 'sync', t: end });
    }
  }

  private lastT(): number {
    return this.buf.length ? this.buf[this.buf.length - 1].t : 0;
  }

  /** Decode as many whole bytes as the buffered samples allow. */
  private drainBytes(now: number) {
    const b = this.bitMs;
    const margin = Math.max(b * 0.45, 8);
    while (this.mode === 'BYTES' && now >= this.nextStart + 9.5 * b + margin) {
      const ts = this.nextStart;

      const startOk = this.levelAt(ts + 0.5 * b) === 0;
      let byte = 0;
      for (let i = 0; i < 8; i++) {
        if (this.levelAt(ts + (1.5 + i) * b) === 1) byte |= 1 << i;
      }
      const stopOk = this.levelAt(ts + 9.5 * b) === 1;

      // While still reading the two header bytes a framing error means we
      // never really had a frame, so give up and hunt again. Once the header
      // has matched we keep going and let CRC-8 be the judge: a stop bit
      // misread by one video frame should not throw away a good message.
      if (!startOk || !stopOk) {
        if (this.bytes.length < 2) {
          this.abort(now, startOk ? 'no stop bit' : 'no start bit');
          return;
        }
        this.framingErrors++;
      }

      if (!this.acceptByte(byte, now)) return;

      // Re-sync on the real falling edge of the next start bit if we can see
      // one near where we expect it; otherwise fall back to the nominal clock.
      const expected = ts + 10 * b;
      const edge = this.fallingEdgeNear(expected - 0.5 * b, expected + 0.5 * b);
      this.nextStart = edge ?? expected;
    }
  }

  /** Returns false if the frame was aborted. */
  private acceptByte(byte: number, now: number): boolean {
    const i = this.bytes.length;
    if (i === 0 && byte !== SOF0) {
      this.abort(now, 'bad header byte 1');
      return false;
    }
    if (i === 1 && byte !== SOF1) {
      this.abort(now, 'bad header byte 2');
      return false;
    }
    if (i === 2 && (byte < 1 || byte > MAX_PAYLOAD)) {
      this.abort(now, 'bad length ' + byte);
      return false;
    }
    this.bytes.push(byte);

    const len = this.bytes[2];
    if (this.bytes.length >= 3 && this.bytes.length === 3 + len + 1) {
      const frame = parseFrame(this.bytes);
      this.onEvent?.({ kind: 'frame', t: now, frame });
      this.mode = 'HUNT';
      this.bytes = [];
      this.lastOffMs = 0;
      this.lastOffEndedAt = -1;
      return false; // stop draining; hunt for the next preamble
    }
    return true;
  }

  private abort(now: number, reason: string) {
    if (this.bytes.length > 0) this.onEvent?.({ kind: 'abort', t: now, reason });
    this.mode = 'HUNT';
    this.bytes = [];
    this.lastOffMs = 0;
    this.lastOffEndedAt = -1;
  }

  /**
   * Majority vote of every sample within +/- 0.4 bit of time `t`. Wide enough
   * that three samples usually fall inside it, so one bad frame is outvoted,
   * but still short of the neighbouring bit centres.
   */
  private levelAt(t: number): 0 | 1 {
    // Triangular weighting across the whole bit: a sample sitting on the bit
    // centre counts fully, one out at the bit boundary counts for almost
    // nothing. This uses every sample the bit got instead of just the one or
    // two nearest the centre, which matters a lot at 3 samples per bit.
    const reach = Math.max(this.bitMs * 0.6, 12);
    let ones = 0;
    let zeros = 0;
    let nearest: Sample | null = null;
    let nearestD = Infinity;
    for (const s of this.buf) {
      const d = Math.abs(s.t - t);
      if (d < reach) {
        const weight = 1 - d / reach;
        if (s.v) ones += weight;
        else zeros += weight;
      }
      if (d < nearestD) {
        nearestD = d;
        nearest = s;
      }
    }
    if (ones + zeros === 0) return nearest ? nearest.v : 1;
    return ones >= zeros ? 1 : 0;
  }

  private fallingEdgeNear(lo: number, hi: number): number | null {
    for (let i = 1; i < this.buf.length; i++) {
      const a = this.buf[i - 1];
      const c = this.buf[i];
      if (a.v === 1 && c.v === 0) {
        const t = (a.t + c.t) / 2;
        if (t >= lo && t <= hi) return t;
      }
    }
    return null;
  }
}
