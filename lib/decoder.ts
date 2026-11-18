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
    this.curLevel = null;
    this.lastOffMs = 0;
    this.lastOffEndedAt = -1;
  }

  get locked() {
    return this.mode === 'BYTES';
  }

  /** Feed one camera sample. Call once per video frame. */
  push(t: number, v: 0 | 1) {
    this.buf.push({ t, v });
    const cutoff = t - BUFFER_MS;
    while (this.buf.length && this.buf[0].t < cutoff) this.buf.shift();

    if (this.curLevel === null) {
      this.curLevel = v;
      this.curStart = t;
    } else if (v !== this.curLevel) {
      this.onRunEnd(this.curLevel, this.curStart, t);
      this.curLevel = v;
      this.curStart = t;
    }
    this.drainBytes(t);
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
    const margin = Math.max(b * 0.3, 8);
    while (this.mode === 'BYTES' && now >= this.nextStart + 9.5 * b + margin) {
      const ts = this.nextStart;

      if (this.levelAt(ts + 0.5 * b) !== 0) {
        this.abort(now, 'no start bit');
        return;
      }
      let byte = 0;
      for (let i = 0; i < 8; i++) {
        if (this.levelAt(ts + (1.5 + i) * b) === 1) byte |= 1 << i;
      }
      if (this.levelAt(ts + 9.5 * b) !== 1) {
        this.abort(now, 'no stop bit');
        return;
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

  /** Majority vote of every sample within +/- 0.3 bit of time `t`. */
  private levelAt(t: number): 0 | 1 {
    const w = Math.max(this.bitMs * 0.3, 8);
    let ones = 0;
    let zeros = 0;
    let nearest: Sample | null = null;
    let nearestD = Infinity;
    for (const s of this.buf) {
      const d = Math.abs(s.t - t);
      if (d <= w) {
        if (s.v) ones++;
        else zeros++;
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
