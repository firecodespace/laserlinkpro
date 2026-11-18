/**
 * LaserLink light protocol - shared by the transmitter console and the
 * camera receiver. Must stay byte-for-byte identical to the Arduino sketch
 * in LaserLink_TX_Uno/LaserLink_TX_Uno.ino.
 *
 * Line coding
 *   idle          = laser ON
 *   byte on wire  = start bit OFF, 8 data bits LSB first (ON = 1), stop bit ON
 *
 * Frame
 *   0xFF 0x7E LEN payload[LEN] CRC8
 *   CRC-8, polynomial 0x07, init 0x00, computed over LEN + payload.
 *
 * Preamble sent before every frame
 *   ON  500 ms
 *   OFF 500 ms
 *   ON  max(1000 ms, 12 bit times)      <- guard, longer than any run inside
 *                                          a frame, so the receiver can lock
 */

export const SOF0 = 0xff;
export const SOF1 = 0x7e;
export const MAX_PAYLOAD = 60;

export const PREAMBLE_ON_MS = 500;
export const PREAMBLE_OFF_MS = 500;

/**
 * Beacon: a slow, obvious blink sent before the preamble.
 *
 * It buys the person holding the phone a few seconds to aim at the spot, and
 * it is also what makes automatic dot detection work - the receiver looks for
 * the part of the picture that is *blinking*, which a lamp or a reflection
 * never does. 200 ms half cycles give about six video frames per state at
 * 30 fps, which is plenty to measure.
 *
 * Each blink is far shorter than the preamble guard, so the decoder can never
 * mistake the beacon for the start of a frame.
 */
export const BEACON_BLINK_MS = 200;
export const DEFAULT_BEACON_MS = 4000;
export const MAX_BEACON_MS = 15000;

/** Length of the guard ON period that ends the preamble. */
export function guardMs(bitMs: number): number {
  return Math.max(1000, 12 * bitMs);
}

/** CRC-8, poly 0x07, init 0x00 - same loop as the Arduino sketch. */
export function crc8(bytes: ArrayLike<number>): number {
  let crc = 0;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i] & 0xff;
    for (let b = 0; b < 8; b++) {
      crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
    }
  }
  return crc & 0xff;
}

/** ASCII bytes of `text`, clipped to MAX_PAYLOAD. Non-ASCII becomes '?'. */
export function textToPayload(text: string): number[] {
  const out: number[] = [];
  for (const ch of text.slice(0, MAX_PAYLOAD)) {
    const c = ch.charCodeAt(0);
    out.push(c >= 32 && c <= 126 ? c : 63);
  }
  return out;
}

export function payloadToText(bytes: ArrayLike<number>): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i] & 0xff);
  return s;
}

/** Build the full on-wire frame for a message. */
export function buildFrame(text: string): number[] {
  const payload = textToPayload(text);
  const body = [payload.length, ...payload];
  return [SOF0, SOF1, ...body, crc8(body)];
}

export type Segment = { v: 0 | 1; ms: number };

/** The 10 line states of one byte: start, 8 data bits LSB first, stop. */
export function byteToBits(b: number): (0 | 1)[] {
  const bits: (0 | 1)[] = [0];
  for (let i = 0; i < 8; i++) bits.push(((b >> i) & 1) as 0 | 1);
  bits.push(1);
  return bits;
}

/**
 * Full light waveform for one frame, preamble included, as timed segments.
 * Used for the waveform preview and the no-hardware self test.
 */
export function frameToSegments(frame: number[], bitMs: number, beaconMs = 0): Segment[] {
  const segs: Segment[] = [];

  // Beacon first, ending on OFF so it cannot merge into the preamble's ON.
  const cycles = Math.floor(beaconMs / (2 * BEACON_BLINK_MS));
  for (let i = 0; i < cycles; i++) {
    segs.push({ v: 1, ms: BEACON_BLINK_MS });
    segs.push({ v: 0, ms: BEACON_BLINK_MS });
  }

  segs.push({ v: 1, ms: PREAMBLE_ON_MS });
  segs.push({ v: 0, ms: PREAMBLE_OFF_MS });
  segs.push({ v: 1, ms: guardMs(bitMs) });
  for (const b of frame) {
    for (const bit of byteToBits(b)) segs.push({ v: bit, ms: bitMs });
  }
  segs.push({ v: 1, ms: bitMs * 4 }); // return to idle
  // merge touching segments of the same level
  const merged: Segment[] = [];
  for (const s of segs) {
    const last = merged[merged.length - 1];
    if (last && last.v === s.v) last.ms += s.ms;
    else merged.push({ ...s });
  }
  return merged;
}

/** Wall-clock duration of one message, so the UI can show a countdown. */
export function frameDurationMs(frame: number[], bitMs: number, beaconMs = 0): number {
  return frameToSegments(frame, bitMs, beaconMs).reduce((a, s) => a + s.ms, 0);
}

/** Whole beacon cycles actually sent, rounded the same way the Uno rounds. */
export function effectiveBeaconMs(beaconMs: number): number {
  return Math.floor(beaconMs / (2 * BEACON_BLINK_MS)) * 2 * BEACON_BLINK_MS;
}

export type ParsedFrame = {
  ok: boolean;
  len: number;
  text: string;
  crcReceived: number;
  crcComputed: number;
  raw: number[];
};

/** Validate a collected frame (header already matched). */
export function parseFrame(raw: number[]): ParsedFrame {
  const len = raw[2] ?? 0;
  const payload = raw.slice(3, 3 + len);
  const crcReceived = raw[3 + len] ?? -1;
  const crcComputed = crc8([len, ...payload]);
  return {
    ok: crcReceived === crcComputed && payload.length === len,
    len,
    text: payloadToText(payload),
    crcReceived,
    crcComputed,
    raw,
  };
}

export const BIT_TIME_OPTIONS = [66, 80, 100, 120, 150, 200, 250, 300];
