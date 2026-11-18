'use client';

import { useEffect, useRef, useState } from 'react';
import { BIT_TIME_OPTIONS } from '../../lib/protocol';
import { useLaserReceiver } from '../../lib/useLaserReceiver';

const STATE_TEXT: Record<string, { label: string; cls: string }> = {
  off: { label: 'camera off', cls: 'off' },
  searching: { label: 'no spot - tap it', cls: 'warn live' },
  tracking: { label: 'locked on the beam', cls: 'on' },
  receiving: { label: 'receiving', cls: 'on live' },
};

const hex2 = (b: number) => b.toString(16).padStart(2, '0').toUpperCase();

export default function ReceiverPage() {
  const [bitMs, setBitMs] = useState(120);
  const traceRef = useRef<HTMLDivElement | null>(null);
  const rx = useLaserReceiver(bitMs);

  useEffect(() => {
    const el = traceRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [rx.events]);

  const s = STATE_TEXT[rx.state] ?? STATE_TEXT.off;
  const samplesPerBit = (rx.fps * bitMs) / 1000;
  const pct =
    rx.progress.total > 0 ? Math.min(100, (rx.progress.got / rx.progress.total) * 100) : 0;
  const supported = Object.entries(rx.camSupports)
    .filter(([, v]) => v)
    .map(([k]) => k)
    .join(', ');
  const noExposureControl = !rx.camSupports.exposure && !rx.camSupports.exposureCompensation;

  return (
    <>
      <h1 className="page">Receiver</h1>
      <p className="lede">
        Hold the phone still and point it at the laser spot. <b>Tap the spot in the picture</b> to
        aim and focus there, then drag the brightness slider down until only the dot stands out.
      </p>

      {/* Mounted at all times: start() needs this ref before the stream exists. */}
      <div
        className="videoWrap"
        onClick={(e) => {
          if (!rx.cameraOn) return;
          const r = e.currentTarget.getBoundingClientRect();
          const nx = (e.clientX - r.left) / r.width;
          const ny = (e.clientY - r.top) / r.height;
          rx.pinTo(nx, ny);
          rx.focusAt(nx, ny);
        }}
        style={{ cursor: rx.cameraOn ? 'crosshair' : 'default' }}
      >
        <video ref={rx.videoRef} playsInline muted />
        <canvas ref={rx.overlayRef} className="overlay" />
        {rx.cameraOn ? (
          <div className="videoBadge">
            <span className={'pill ' + s.cls}>
              <span className="dot" />
              {s.label}
            </span>
            {rx.manual && (
              <span className="pill on">
                <span className="dot" />
                aimed by tap
              </span>
            )}
          </div>
        ) : (
          <div className="videoCover">
            <p>
              Point this phone at the laser spot on the paper, about 30 to 50 cm away and off to
              one side so you are not in the beam.
            </p>
            <button className="primary" onClick={rx.start}>
              Start camera
            </button>
            {rx.error && <p className="err">{rx.error}</p>}
          </div>
        )}
      </div>

      {rx.cameraOn && (
        <>
          <div className="statRow" style={{ marginTop: 12 }}>
            <div className="stat">
              <div className="k">fps</div>
              <div className="v" style={{ color: rx.fps < 24 ? 'var(--warn)' : undefined }}>
                {rx.fps}
              </div>
            </div>
            <div className="stat">
              <div className="k">Samples/bit</div>
              <div className="v" style={{ color: samplesPerBit < 3 ? 'var(--bad)' : 'var(--ok)' }}>
                {samplesPerBit.toFixed(1)}
              </div>
            </div>
            <div className="stat">
              <div className="k">Signal</div>
              <div className="v" style={{ color: rx.red >= 20 ? 'var(--ok)' : 'var(--bad)' }}>
                {rx.red}
              </div>
            </div>
          </div>

          <canvas ref={rx.scopeRef} className="scope" style={{ marginTop: 12 }} />
          <p className="hint" style={{ marginTop: 6 }}>
            Red bars are the beam read as ON. If this never changes while the sender is
            transmitting, the camera is not seeing the dot - tap it, or lower the brightness.
          </p>

          <div className="card">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <h2 style={{ margin: 0 }}>Camera</h2>
              <span className={'pill ' + (rx.camAuto ? '' : 'on')}>
                <span className="dot" />
                {rx.camAuto ? 'auto' : 'manual'}
              </span>
            </div>

            <label className="field" style={{ marginTop: 12 }} htmlFor="exp">
              Brightness - drag down until only the dot is bright
            </label>
            <input
              id="exp"
              type="range"
              min={0}
              max={100}
              value={Math.round(rx.exposure * 100)}
              onChange={(e) => rx.setExposure(Number(e.target.value) / 100)}
              disabled={noExposureControl}
            />

            {rx.camSupports.zoom && (
              <>
                <label className="field" style={{ marginTop: 12 }} htmlFor="zoom">
                  Zoom
                </label>
                <input
                  id="zoom"
                  type="range"
                  min={0}
                  max={100}
                  value={Math.round(rx.zoom * 100)}
                  onChange={(e) => rx.setZoom(Number(e.target.value) / 100)}
                />
              </>
            )}

            <div className="row" style={{ marginTop: 12 }}>
              {rx.manual ? (
                <button onClick={rx.resumeAuto}>Auto aim</button>
              ) : (
                <button onClick={rx.reacquire}>Re-acquire</button>
              )}
              {!rx.camAuto && <button onClick={rx.restoreCameraAuto}>Auto camera</button>}
              <button onClick={rx.stop}>Stop camera</button>
            </div>

            {noExposureControl && (
              <p className="hint" style={{ marginTop: 10, color: 'var(--warn)' }}>
                This browser exposes no exposure control for your camera. Dim the room instead,
                and tap the dot to aim.
              </p>
            )}
            <p className="hint" style={{ marginTop: 10 }}>
              Controls available here: {supported || 'none'}
            </p>
          </div>

          <div className="card">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <h2 style={{ margin: 0 }}>What the decoder is reading</h2>
              {rx.decoding && (
                <span className="pill on live">
                  <span className="dot" />
                  {rx.progress.total > 0
                    ? rx.progress.got + '/' + rx.progress.total + ' bytes'
                    : 'reading header'}
                </span>
              )}
            </div>

            {rx.decoding && (
              <div className="progressbar" style={{ marginTop: 10 }}>
                <i style={{ width: pct + '%' }} />
              </div>
            )}

            {rx.partial.length > 0 && (
              <>
                <label className="field" style={{ marginTop: 12 }}>
                  Bytes so far
                </label>
                <div className="log" style={{ height: 'auto', maxHeight: 70 }}>
                  <span className="rx">{rx.partial.map(hex2).join(' ')}</span>
                </div>
              </>
            )}

            <label className="field" style={{ marginTop: 12 }}>
              Trace
            </label>
            <div className="log" ref={traceRef}>
              {rx.events.length === 0 && (
                <span className="sys">
                  Nothing decoded yet. Every preamble, byte and CRC check appears here as it
                  happens, so you can see exactly how far each attempt gets.
                </span>
              )}
              {rx.events.map((e) => (
                <div key={e.id}>
                  <span className="t">{new Date(e.t).toLocaleTimeString()} </span>
                  <span
                    className={
                      e.kind === 'ok'
                        ? 'ok'
                        : e.kind === 'bad' || e.kind === 'abort'
                          ? 'err'
                          : 'rx'
                    }
                  >
                    {e.text}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      <div className="card">
        <h2>Messages</h2>
        <div className="thread">
          {rx.messages.length === 0 && (
            <div className="empty">
              {rx.cameraOn
                ? 'Nothing decoded yet. Watch the trace above to see how far each attempt gets.'
                : 'No messages yet.'}
            </div>
          )}
          {rx.messages.map((m) => (
            <div
              key={m.id}
              className={
                'bubble in ' + (m.ok ? '' : 'bad ') + (m.source === 'self test' ? 'sim' : '')
              }
            >
              <div className="btext">{m.text}</div>
              <div className="bmeta">
                {m.ok ? 'CRC ok' : 'CRC FAILED'} · {m.len}B ·{' '}
                {new Date(m.at).toLocaleTimeString()}
                {m.source === 'self test' && ' · simulated'}
              </div>
            </div>
          ))}
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <button onClick={() => rx.runSelfTest()}>Test without hardware</button>
          {(rx.messages.length > 0 || rx.events.length > 0) && (
            <button className="ghost" onClick={rx.clear}>
              Clear
            </button>
          )}
        </div>
      </div>

      <details className="more card">
        <summary>Settings</summary>
        <label className="field" style={{ marginTop: 12 }} htmlFor="rbit">
          Bit time - must match the sender
        </label>
        <select id="rbit" value={bitMs} onChange={(e) => setBitMs(Number(e.target.value))}>
          {BIT_TIME_OPTIONS.map((ms) => (
            <option key={ms} value={ms}>
              {ms} ms{ms === 120 ? ' (default)' : ''}
            </option>
          ))}
        </select>
        <p className="hint" style={{ marginTop: 12 }}>
          <b>Signal</b> is how strongly the tracked spot stands out, measured as red excess
          (<code>R - max(G,B)</code>) so bright white paper scores near zero while a red laser
          scores high. About 20 and up is usable.
          <br />
          <br />
          <b>Samples per bit</b> decides whether decoding is possible at all. Below 3 the camera
          cannot see the bits - raise the bit time on both sides.
        </p>
        {rx.cameraNotes.length > 0 && (
          <p className="hint" style={{ marginTop: 10 }}>
            Camera: {rx.cameraNotes.join(', ')}
          </p>
        )}
      </details>
    </>
  );
}
