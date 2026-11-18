/**
 * No-hardware self test: replay a frame's light waveform as camera-rate
 * samples so the decoder can be exercised without the laser.
 */

import { buildFrame, frameToSegments, type Segment } from './protocol';
import { LaserDecoder, type DecodeEvent } from './decoder';

export type SimOptions = {
  fps?: number;
  /** +/- jitter on each sample time, in ms. Models an unsteady camera clock. */
  jitterMs?: number;
  /** Probability that a single sample reads the wrong level. */
  noise?: number;
};

export function segmentsToSamples(
  segs: Segment[],
  opts: SimOptions = {},
): { t: number; v: 0 | 1 }[] {
  const fps = opts.fps ?? 30;
  const jitter = opts.jitterMs ?? 4;
  const noise = opts.noise ?? 0;
  const step = 1000 / fps;
  const total = segs.reduce((a, s) => a + s.ms, 0);

  const out: { t: number; v: 0 | 1 }[] = [];
  for (let t = 0; t < total; t += step) {
    const jittered = t + (Math.random() * 2 - 1) * jitter;
    let acc = 0;
    let v: 0 | 1 = 1;
    for (const s of segs) {
      if (jittered < acc + s.ms) {
        v = s.v;
        break;
      }
      acc += s.ms;
    }
    if (noise > 0 && Math.random() < noise) v = (1 - v) as 0 | 1;
    out.push({ t, v });
  }
  return out;
}

/** Encode `text`, replay it through a fresh decoder, return what came out. */
export function selfTest(
  text: string,
  bitMs: number,
  opts: SimOptions & { beaconMs?: number } = {},
): DecodeEvent[] {
  const segs = frameToSegments(buildFrame(text), bitMs, opts.beaconMs ?? 0);
  const samples = segmentsToSamples(segs, opts);
  const dec = new LaserDecoder(bitMs);
  const events: DecodeEvent[] = [];
  dec.onEvent = (e) => events.push(e);
  for (const s of samples) dec.push(s.t, s.v);
  return events;
}
