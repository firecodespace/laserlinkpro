'use client';

/**
 * Everything the camera side needs, in one hook: open the camera, find the
 * laser spot, sample it once per video frame, and hand decoded frames back.
 * Shared by the Receive page and the Chat receiver window.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { LaserDecoder, type DecodeEvent } from './decoder';
import { SpotSampler } from './camera';
import { selfTest } from './simulate';

export type ReceivedMessage = {
  id: number;
  at: number;
  text: string;
  ok: boolean;
  len: number;
  crcReceived: number;
  crcComputed: number;
  source: 'laser' | 'self test';
};

type VideoWithCallback = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: () => void) => number;
};

export function useLaserReceiver(bitMs: number) {
  const videoRef = useRef<VideoWithCallback | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const scopeRef = useRef<HTMLCanvasElement | null>(null);
  const samplerRef = useRef<SpotSampler>(new SpotSampler());
  const decoderRef = useRef<LaserDecoder>(new LaserDecoder(bitMs));
  const streamRef = useRef<MediaStream | null>(null);
  const runningRef = useRef(false);
  const traceRef = useRef<{ t: number; v: 0 | 1 }[]>([]);
  const fpsRef = useRef<number[]>([]);
  const idRef = useRef(1);

  const [cameraOn, setCameraOn] = useState(false);
  const [fps, setFps] = useState(0);
  const [range, setRange] = useState(0);
  const [locked, setLocked] = useState(false);
  const [progress, setProgress] = useState({ got: 0, total: -1 });
  const [aborts, setAborts] = useState(0);
  const [error, setError] = useState('');
  const [exposureNote, setExposureNote] = useState('');
  const [messages, setMessages] = useState<ReceivedMessage[]>([]);

  const addMessage = useCallback((m: Omit<ReceivedMessage, 'id'>) => {
    setMessages((prev) => [...prev, { ...m, id: idRef.current++ }].slice(-60));
  }, []);

  useEffect(() => {
    const dec = decoderRef.current;
    dec.onEvent = (e: DecodeEvent) => {
      if (e.kind === 'sync') setLocked(true);
      if (e.kind === 'abort') {
        setLocked(false);
        setAborts((n) => n + 1);
      }
      if (e.kind === 'frame') {
        setLocked(false);
        addMessage({
          at: Date.now(),
          text: e.frame.text,
          ok: e.frame.ok,
          len: e.frame.len,
          crcReceived: e.frame.crcReceived,
          crcComputed: e.frame.crcComputed,
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
    if (w === 0 || h === 0) return;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(w * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const roi = samplerRef.current.roi;
    const x = roi.cx * w;
    const y = roi.cy * h;
    const r = Math.max(14, roi.r * w);
    ctx.strokeStyle = '#34d07f';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.stroke();
  }, []);

  const drawScope = useCallback(() => {
    const canvas = scopeRef.current;
    if (!canvas) return;
    const w = canvas.clientWidth;
    const h = 72;
    if (w === 0) return;
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
    if (trace.length < 2) return;
    const n = Math.min(trace.length, 260);
    const slice = trace.slice(-n);
    const bw = w / n;
    ctx.fillStyle = 'rgba(255, 59, 48, 0.8)';
    slice.forEach((s, i) => {
      if (s.v === 1) ctx.fillRect(i * bw, 8, Math.max(bw, 1), h - 16);
    });
  }, []);

  const loop = useCallback(() => {
    if (!runningRef.current) return;
    const video = videoRef.current;
    if (video && video.readyState >= 2) {
      const now = performance.now();
      const info = samplerRef.current.sample(video);
      if (info) {
        const dec = decoderRef.current;
        dec.push(now, info.level);
        traceRef.current.push({ t: now, v: info.level });
        if (traceRef.current.length > 600) traceRef.current.shift();
        fpsRef.current.push(now);
        while (fpsRef.current.length && now - fpsRef.current[0] > 1000) fpsRef.current.shift();
        setFps(fpsRef.current.length);
        setRange(Math.round(info.range));
        setProgress({ got: dec.byteCount, total: dec.expectedBytes });
      }
      drawOverlay();
      drawScope();
    }
    if (video?.requestVideoFrameCallback) video.requestVideoFrameCallback(loop);
    else requestAnimationFrame(loop);
  }, [drawOverlay, drawScope]);

  const startCamera = useCallback(async () => {
    setError('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 640 },
          height: { ideal: 480 },
          frameRate: { ideal: 30, max: 60 },
        },
        audio: false,
      });
      streamRef.current = stream;
      const video = videoRef.current;
      if (!video) return;
      video.srcObject = stream;
      await video.play();
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

  const stopCamera = useCallback(() => {
    runningRef.current = false;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setCameraOn(false);
    setLocked(false);
  }, []);

  useEffect(() => () => stopCamera(), [stopCamera]);

  const findDot = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    const roi = samplerRef.current.findDot(video);
    decoderRef.current.reset();
    setError(roi ? '' : 'No bright spot found. Dim the room, or send #ON so the laser is lit.');
  }, []);

  const lockExposure = useCallback(async () => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    const applied: string[] = [];
    for (const c of [
      { exposureMode: 'manual' },
      { whiteBalanceMode: 'manual' },
      { focusMode: 'manual' },
    ]) {
      try {
        await track.applyConstraints({ advanced: [c] } as MediaTrackConstraints);
        applied.push(Object.keys(c)[0]);
      } catch {
        /* this camera does not expose that control */
      }
    }
    samplerRef.current.resetHistory();
    setExposureNote(
      applied.length ? 'locked: ' + applied.join(', ') : 'this camera exposes no manual controls',
    );
  }, []);

  const runSelfTest = useCallback(
    (texts: string[] = ['HELLO IOT', 'LASERLINK OK', 'SENSOR ALERT']) => {
      for (const text of texts) {
        const events = selfTest(text, bitMs, { fps: 30, jitterMs: 5, noise: 0 });
        const f = events.find((e) => e.kind === 'frame');
        if (f && f.kind === 'frame') {
          addMessage({
            at: Date.now(),
            text: f.frame.text,
            ok: f.frame.ok,
            len: f.frame.len,
            crcReceived: f.frame.crcReceived,
            crcComputed: f.frame.crcComputed,
            source: 'self test',
          });
        } else {
          addMessage({
            at: Date.now(),
            text: '(no frame decoded for "' + text + '")',
            ok: false,
            len: 0,
            crcReceived: -1,
            crcComputed: -1,
            source: 'self test',
          });
        }
      }
    },
    [addMessage, bitMs],
  );

  const clear = useCallback(() => setMessages([]), []);

  return {
    videoRef,
    overlayRef,
    scopeRef,
    cameraOn,
    fps,
    range,
    locked,
    progress,
    aborts,
    error,
    exposureNote,
    messages,
    startCamera,
    stopCamera,
    findDot,
    lockExposure,
    runSelfTest,
    clear,
  };
}
