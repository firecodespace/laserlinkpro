'use client';

/**
 * The camera side, start to finish: open the camera, tune whatever controls
 * the browser exposes, track the blinking laser spot by itself, and hand
 * decoded frames back.
 *
 * There is deliberately nothing for the user to press. The old build had
 * "Find dot" and "Lock exposure" buttons; both are now continuous and
 * automatic, because during a demo nobody should be tapping buttons while
 * holding a phone steady.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { LaserDecoder, type DecodeEvent } from './decoder';
import { CameraTuner, SpotTracker } from './camera';
import { selfTest } from './simulate';

export type ReceivedMessage = {
  id: number;
  at: number;
  text: string;
  ok: boolean;
  len: number;
  source: 'laser' | 'self test';
};

type VideoWithCallback = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: () => void) => number;
};

export type LinkState = 'off' | 'searching' | 'tracking' | 'receiving';

export function useLaserReceiver(bitMs: number) {
  const videoRef = useRef<VideoWithCallback | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const scopeRef = useRef<HTMLCanvasElement | null>(null);
  const trackerRef = useRef<SpotTracker>(new SpotTracker());
  const tunerRef = useRef<CameraTuner>(new CameraTuner());
  const decoderRef = useRef<LaserDecoder>(new LaserDecoder(bitMs));
  const streamRef = useRef<MediaStream | null>(null);
  const runningRef = useRef(false);
  const traceRef = useRef<(0 | 1)[]>([]);
  const fpsRef = useRef<number[]>([]);
  const idRef = useRef(1);
  const lockedRef = useRef(false);

  const [cameraOn, setCameraOn] = useState(false);
  const [fps, setFps] = useState(0);
  const [range, setRange] = useState(0);
  const [lockScore, setLockScore] = useState(0);
  const [locked, setLocked] = useState(false);
  const [decoding, setDecoding] = useState(false);
  const [progress, setProgress] = useState({ got: 0, total: -1 });
  const [error, setError] = useState('');
  const [cameraNotes, setCameraNotes] = useState<string[]>([]);
  const [messages, setMessages] = useState<ReceivedMessage[]>([]);

  const addMessage = useCallback((m: Omit<ReceivedMessage, 'id'>) => {
    setMessages((prev) => [...prev, { ...m, id: idRef.current++ }].slice(-60));
  }, []);

  useEffect(() => {
    const dec = decoderRef.current;
    dec.onEvent = (e: DecodeEvent) => {
      if (e.kind === 'sync') setDecoding(true);
      if (e.kind === 'abort') setDecoding(false);
      if (e.kind === 'frame') {
        setDecoding(false);
        addMessage({
          at: Date.now(),
          text: e.frame.text,
          ok: e.frame.ok,
          len: e.frame.len,
          source: 'laser',
        });
      }
    };
  }, [addMessage]);

  useEffect(() => {
    decoderRef.current.setBitMs(bitMs);
  }, [bitMs]);

  const drawOverlay = useCallback(() => {
    const canvas = overlayRef.current;
    if (!canvas) return;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(w * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const roi = trackerRef.current.roi;
    const x = roi.cx * w;
    const y = roi.cy * h;
    const r = Math.max(16, roi.r * w);
    const on = lockedRef.current;
    ctx.strokeStyle = on ? '#34d07f' : '#8b99ae';
    ctx.lineWidth = on ? 2.5 : 1.5;
    ctx.setLineDash(on ? [] : [5, 5]);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    // crosshair ticks
    ctx.beginPath();
    ctx.moveTo(x - r - 9, y);
    ctx.lineTo(x - r - 3, y);
    ctx.moveTo(x + r + 3, y);
    ctx.lineTo(x + r + 9, y);
    ctx.moveTo(x, y - r - 9);
    ctx.lineTo(x, y - r - 3);
    ctx.moveTo(x, y + r + 3);
    ctx.lineTo(x, y + r + 9);
    ctx.stroke();
  }, []);

  const drawScope = useCallback(() => {
    const canvas = scopeRef.current;
    if (!canvas) return;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight || 56;
    if (!w) return;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(w * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const trace = traceRef.current;
    const n = Math.min(trace.length, 240);
    if (n < 2) return;
    const slice = trace.slice(-n);
    const bw = w / n;
    ctx.fillStyle = 'rgba(255, 59, 48, 0.85)';
    slice.forEach((v, i) => {
      if (v === 1) ctx.fillRect(i * bw, 6, Math.max(bw, 1), h - 12);
    });
  }, []);

  const loop = useCallback(() => {
    if (!runningRef.current) return;
    const video = videoRef.current;
    if (video && video.readyState >= 2) {
      const now = performance.now();
      const info = trackerRef.current.sample(video);
      if (info) {
        const dec = decoderRef.current;
        dec.push(now, info.level);
        tunerRef.current.nudge(info.peak, now);

        traceRef.current.push(info.level);
        if (traceRef.current.length > 400) traceRef.current.shift();

        fpsRef.current.push(now);
        while (fpsRef.current.length && now - fpsRef.current[0] > 1000) fpsRef.current.shift();

        lockedRef.current = info.locked;
        setFps(fpsRef.current.length);
        setRange(Math.round(info.range));
        setLockScore(Math.round(info.lockScore));
        setLocked(info.locked);
        setProgress({ got: dec.byteCount, total: dec.expectedBytes });
      }
      drawOverlay();
      drawScope();
    }
    if (video?.requestVideoFrameCallback) video.requestVideoFrameCallback(loop);
    else requestAnimationFrame(loop);
  }, [drawOverlay, drawScope]);

  const start = useCallback(async () => {
    setError('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 640 },
          height: { ideal: 480 },
          frameRate: { ideal: 60, min: 24 },
        },
        audio: false,
      });
      streamRef.current = stream;
      const video = videoRef.current;
      if (!video) return;
      video.srcObject = stream;
      await video.play();

      const track = stream.getVideoTracks()[0];
      if (track) {
        await tunerRef.current.attach(track);
        setCameraNotes(tunerRef.current.notes);
      }
      trackerRef.current.reset();
      decoderRef.current.reset();
      runningRef.current = true;
      setCameraOn(true);
      loop();
    } catch (err) {
      setError(
        'Could not open the camera: ' +
          String(err instanceof Error ? err.message : err) +
          '. The page must be on https or localhost, and the browser needs camera permission.',
      );
    }
  }, [loop]);

  const stop = useCallback(() => {
    runningRef.current = false;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setCameraOn(false);
    setLocked(false);
    setDecoding(false);
  }, []);

  useEffect(() => () => stop(), [stop]);

  /** Manual escape hatch if the tracker ever settles on the wrong thing. */
  const reacquire = useCallback(() => {
    trackerRef.current.reset();
    decoderRef.current.reset();
  }, []);

  const runSelfTest = useCallback(
    (texts: string[] = ['HELLO IOT', 'LASERLINK OK']) => {
      for (const text of texts) {
        const events = selfTest(text, bitMs, { fps: 30, jitterMs: 5, noise: 0 });
        const f = events.find((e) => e.kind === 'frame');
        addMessage({
          at: Date.now(),
          text: f && f.kind === 'frame' ? f.frame.text : '(no frame for "' + text + '")',
          ok: f?.kind === 'frame' ? f.frame.ok : false,
          len: f?.kind === 'frame' ? f.frame.len : 0,
          source: 'self test',
        });
      }
    },
    [addMessage, bitMs],
  );

  const clear = useCallback(() => setMessages([]), []);

  const state: LinkState = !cameraOn
    ? 'off'
    : decoding
      ? 'receiving'
      : locked
        ? 'tracking'
        : 'searching';

  return {
    videoRef,
    overlayRef,
    scopeRef,
    cameraOn,
    state,
    fps,
    range,
    lockScore,
    locked,
    decoding,
    progress,
    error,
    cameraNotes,
    messages,
    start,
    stop,
    reacquire,
    runSelfTest,
    clear,
  };
}
