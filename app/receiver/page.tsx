'use client';

import { useEffect, useRef, useState } from 'react';
import { BIT_TIME_OPTIONS } from '../../lib/protocol';
import { useLaserReceiver } from '../../lib/useLaserReceiver';

const STATE_TEXT: Record<string, { label: string; cls: string }> = {
  off: { label: 'camera off', cls: 'off' },
  searching: { label: 'looking for the beam', cls: 'warn live' },
  tracking: { label: 'locked on the beam', cls: 'on' },
  receiving: { label: 'receiving a message', cls: 'on live' },
};

export default function ReceiverPage() {
  const [bitMs, setBitMs] = useState(120);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const threadRef = useRef<HTMLDivElement | null>(null);
  const rx = useLaserReceiver(bitMs);

  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [rx.messages, rx.decoding]);

  const s = STATE_TEXT[rx.state] ?? STATE_TEXT.off;
  const samplesPerBit = (rx.fps * bitMs) / 1000;
  const pct =
    rx.progress.total > 0 ? Math.min(100, (rx.progress.got / rx.progress.total) * 100) : 0;

  return (
    <>
      <h1 className="page">Receiver</h1>
      <p className="lede">
        Point the camera at the laser spot on the paper. It finds the beam, locks on and decodes
        by itself - there is nothing to adjust.
      </p>

      {!rx.cameraOn && (
        <div className="card">
          <h2>Start the camera</h2>
          <p className="sub">
            The browser will ask for camera permission. Hold the phone steady, roughly 30 to 50 cm
            from the paper and off to one side so you are not in the beam.
          </p>
          <button className="primary wide" onClick={rx.start}>
            Start camera
          </button>
          {rx.error && (
            <p className="hint" style={{ marginTop: 10, color: 'var(--bad)' }}>
              {rx.error}
            </p>
          )}
        </div>
      )}

      {rx.cameraOn && (
        <>
          <div className="videoWrap">
            <video ref={rx.videoRef} playsInline muted />
            <canvas ref={rx.overlayRef} className="overlay" />
            <div className="videoBadge">
              <span className={'pill ' + s.cls}>
                <span className="dot" />
                {s.label}
              </span>
            </div>
          </div>

          {rx.decoding && (
            <div className="card" style={{ marginTop: 12 }}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <b style={{ fontSize: 14 }}>Incoming message</b>
                <span className="hint">
                  {rx.progress.total > 0
                    ? rx.progress.got + ' / ' + rx.progress.total + ' bytes'
                    : 'reading header'}
                </span>
              </div>
              <div className="progressbar">
                <i style={{ width: pct + '%' }} />
              </div>
            </div>
          )}

          <div className="statRow" style={{ marginTop: 12 }}>
            <div className="stat">
              <div className="k">fps</div>
              <div className="v" style={{ color: rx.fps < 24 ? 'var(--warn)' : undefined }}>
                {rx.fps}
              </div>
            </div>
            <div className="stat">
              <div className="k">Samples/bit</div>
              <div
                className="v"
                style={{ color: samplesPerBit < 3 ? 'var(--bad)' : 'var(--ok)' }}
              >
                {samplesPerBit.toFixed(1)}
              </div>
            </div>
            <div className="stat">
              <div className="k">Lock</div>
              <div className="v" style={{ color: rx.locked ? 'var(--ok)' : 'var(--muted)' }}>
                {rx.lockScore}
              </div>
            </div>
          </div>

          <canvas ref={rx.scopeRef} className="scope" style={{ marginTop: 12 }} />
        </>
      )}

      <div className="card">
        <div className="thread" ref={threadRef}>
          {rx.messages.length === 0 && (
            <div className="empty">
              {rx.cameraOn
                ? 'Waiting for a transmission. When the sender starts, the laser blinks first - that is the beacon, and the circle will turn green once it locks on.'
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
          {rx.cameraOn && <button onClick={rx.reacquire}>Re-acquire</button>}
          <button onClick={() => rx.runSelfTest()}>Test without hardware</button>
          {rx.messages.length > 0 && (
            <button className="ghost" onClick={rx.clear}>
              Clear
            </button>
          )}
        </div>
      </div>

      <details className="more card" open={showAdvanced}>
        <summary onClick={() => setShowAdvanced((s2) => !s2)}>Settings and diagnostics</summary>
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
          <b>Samples per bit</b> is the number that decides whether this can work at all. Below 3
          the camera physically cannot see the bits - raise the bit time on both sides until it
          reads 3 or more.
          <br />
          <br />
          <b>Lock</b> is how strongly the tracked spot is blinking. The tracker follows whatever
          part of the picture changes the most, which is why a lamp or a reflection cannot steal
          it. Press <b>Re-acquire</b> if it ever settles on the wrong thing.
        </p>

        {rx.cameraOn && rx.cameraNotes.length > 0 && (
          <>
            <label className="field" style={{ marginTop: 12 }}>
              Camera controls applied
            </label>
            <p className="hint">{rx.cameraNotes.join(', ')}</p>
          </>
        )}

        {rx.cameraOn && (
          <div className="row" style={{ marginTop: 12 }}>
            <button onClick={rx.stop}>Stop camera</button>
          </div>
        )}
      </details>
    </>
  );
}
