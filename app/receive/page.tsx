'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { BIT_TIME_OPTIONS } from '../../lib/protocol';
import { LaserDecoder, type DecodeEvent } from '../../lib/decoder';
import { SpotSampler } from '../../lib/camera';
import { selfTest } from '../../lib/simulate';

type Received = {
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

export default function ReceivePage() {
  const videoRef = useRef<VideoWithCallback | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const scopeRef = useRef<HTMLCanvasElement | null>(null);
  const samplerRef = useRef<SpotSampler>(new SpotSampler());
  const decoderRef = useRef<LaserDecoder>(new LaserDecoder(120));
  const streamRef = useRef<MediaStream | null>(null);
  const runningRef = useRef(false);
  const traceRef = useRef<{ t: number; v: 0 | 1; b: number }[]>([]);
  const fpsRef = useRef<number[]>([]);
  const idRef = useRef(1);

  const [cameraOn, setCameraOn] = useState(false);
  const [bitMs, setBitMs] = useState(120);
  const [fps, setFps] = useState(0);
  const [range, setRange] = useState(0);
  const [locked, setLocked] = useState(false);
  const [exposureNote, setExposureNote] = useState('');
  const [error, setError] = useState('');
  const [messages, setMessages] = useState<Received[]>([]);
  const [aborts, setAborts] = useState(0);

  const addMessage = useCallback((m: Omit<Received, 'id'>) => {
    setMessages((prev) => [{ ...m, id: idRef.current++ }, ...prev].slice(0, 40));
  }, []);

  // Wire decoder events once.
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
    const video = videoRef.current;
    if (!canvas || !video) return;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
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
    ctx.beginPath();
    ctx.moveTo(x - r - 8, y);
    ctx.lineTo(x - r - 2, y);
    ctx.moveTo(x + r + 2, y);
    ctx.lineTo(x + r + 8, y);
    ctx.stroke();
  }, []);

  const drawScope = useCallback(() => {
    const canvas = scopeRef.current;
    if (!canvas) return;
    const w = canvas.clientWidth;
    const h = 72;
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
        decoderRef.current.push(now, info.level);
        traceRef.current.push({ t: now, v: info.level, b: info.bright });
        if (traceRef.current.length > 600) traceRef.current.shift();
        fpsRef.current.push(now);
        while (fpsRef.current.length && now - fpsRef.current[0] > 1000) fpsRef.current.shift();
        setFps(fpsRef.current.length);
        setRange(Math.round(info.range));
      }
      drawOverlay();
      drawScope();
    }
    if (video?.requestVideoFrameCallback) video.requestVideoFrameCallback(loop);
    else requestAnimationFrame(loop);
  }, [drawOverlay, drawScope]);

  async function startCamera() {
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
  }

  function stopCamera() {
    runningRef.current = false;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setCameraOn(false);
    setLocked(false);
  }

  useEffect(() => () => stopCamera(), []);

  function findDot() {
    const video = videoRef.current;
    if (!video) return;
    const roi = samplerRef.current.findDot(video);
    decoderRef.current.reset();
    setError(roi ? '' : 'No bright spot found. Dim the room, or send #ON so the laser is lit.');
  }

  async function lockExposure() {
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
  }

  function runSelfTest() {
    const samples = ['HELLO IOT', 'LASERLINK OK', 'SENSOR ALERT'];
    for (const text of samples) {
      const events = selfTest(text, bitMs, { fps: 30, jitterMs: 5, noise: 0 });
      const frameEvent = events.find((e) => e.kind === 'frame');
      if (frameEvent && frameEvent.kind === 'frame') {
        addMessage({
          at: Date.now(),
          text: frameEvent.frame.text,
          ok: frameEvent.frame.ok,
          len: frameEvent.frame.len,
          crcReceived: frameEvent.frame.crcReceived,
          crcComputed: frameEvent.frame.crcComputed,
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
  }

  const okCount = messages.filter((m) => m.ok).length;

  return (
    <>
      <h1 className="page">Receive</h1>
      <p className="lede">
        Point the camera at the laser spot on the paper. This page samples the spot once per video
        frame, recovers the bits, and checks the CRC-8 on every frame before showing a message.
      </p>

      <div className="grid cols-2">
        <div className="card">
          <h2>Camera</h2>
          <p className="sub">Rear camera, 640x480. Dim the room and keep the phone still.</p>
          <div className="videoWrap">
            <video ref={videoRef} playsInline muted />
            <canvas ref={overlayRef} className="overlay" />
          </div>
          <div className="row" style={{ marginTop: 12 }}>
            {cameraOn ? (
              <button onClick={stopCamera}>Stop camera</button>
            ) : (
              <button className="primary" onClick={startCamera}>
                Start camera
              </button>
            )}
            <button onClick={findDot} disabled={!cameraOn}>
              Find dot
            </button>
            <button onClick={lockExposure} disabled={!cameraOn}>
              Lock exposure
            </button>
            <button onClick={runSelfTest}>Test without hardware</button>
          </div>
          {exposureNote && (
            <p className="hint" style={{ marginTop: 8 }}>
              {exposureNote}
            </p>
          )}
          {error && (
            <p className="hint" style={{ marginTop: 8, color: 'var(--bad)' }}>
              {error}
            </p>
          )}

          <label className="field" style={{ marginTop: 16 }} htmlFor="rbit">
            Bit time - must match the Uno
          </label>
          <select id="rbit" value={bitMs} onChange={(e) => setBitMs(Number(e.target.value))}>
            {BIT_TIME_OPTIONS.map((ms) => (
              <option key={ms} value={ms}>
                {ms} ms per bit{ms === 120 ? '  (default)' : ''}
              </option>
            ))}
          </select>
        </div>

        <div className="card">
          <h2>Signal</h2>
          <p className="sub">Red means the decoder currently reads the spot as ON.</p>
          <canvas ref={scopeRef} className="scope" />
          <div className="grid cols-3" style={{ marginTop: 14 }}>
            <div className="stat">
              <div className="k">Camera fps</div>
              <div className="v" style={{ color: fps > 0 && fps < 24 ? 'var(--warn)' : undefined }}>
                {fps}
              </div>
            </div>
            <div className="stat">
              <div className="k">Contrast</div>
              <div className="v" style={{ color: range < 12 ? 'var(--warn)' : 'var(--ok)' }}>
                {range}
              </div>
            </div>
            <div className="stat">
              <div className="k">Frames ok</div>
              <div className="v">
                {okCount}/{messages.length}
              </div>
            </div>
          </div>
          <div className="row" style={{ marginTop: 12 }}>
            <span className={'pill ' + (locked ? 'on' : '')}>
              <span className="dot" />
              {locked ? 'locked on preamble' : 'hunting for preamble'}
            </span>
            {aborts > 0 && <span className="pill warn"><span className="dot" />{aborts} aborted</span>}
          </div>
          <p className="hint" style={{ marginTop: 12 }}>
            Under 24 fps, or contrast under 12, means the link will drop bits. Raise the bit time
            to 150 ms on both sides, dim the room further, or move the phone closer.
          </p>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h2>Decoded messages</h2>
        <p className="sub">
          Newest first. CRC is checked over the length byte plus the payload, so a corrupted
          message is reported rather than shown as text.
        </p>
        {messages.length === 0 && (
          <p className="hint">
            Nothing yet. Press &quot;Test without hardware&quot; to prove the decoder works before
            you set the optics up.
          </p>
        )}
        {messages.map((m) => (
          <div key={m.id} className={'msg ' + (m.ok ? 'ok' : 'bad')}>
            <div className="text">{m.text}</div>
            <div className="meta">
              {m.ok ? 'CRC ok' : 'CRC FAILED'} &middot; len {m.len} &middot; crc recv 0x
              {m.crcReceived >= 0 ? m.crcReceived.toString(16).padStart(2, '0') : '--'} / calc 0x
              {m.crcComputed >= 0 ? m.crcComputed.toString(16).padStart(2, '0') : '--'} &middot;{' '}
              {m.source} &middot; {new Date(m.at).toLocaleTimeString()}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
