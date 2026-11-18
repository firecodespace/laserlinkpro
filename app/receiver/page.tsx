'use client';

import { useEffect, useRef, useState } from 'react';
import { BIT_TIME_OPTIONS } from '../../lib/protocol';
import { useLaserReceiver } from '../../lib/useLaserReceiver';

const STATE_TEXT: Record<string, { label: string; cls: string }> = {
  off: { label: 'camera off', cls: 'off' },
  searching: { label: 'no red spot - tap it', cls: 'warn live' },
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
        Point the camera at the laser spot on the paper. It looks for red, not for bright, so a
        lamp or white paper will not fool it. If it picks the wrong thing, just tap the dot.
      </p>

      {/*
        The video element is mounted at all times, never conditionally. It has
        to exist in the DOM before start() can attach the MediaStream to it -
        rendering it only once the camera is running is a deadlock, because
        the ref is still null at the moment the stream arrives.
      */}
      <div
        className="videoWrap"
        onClick={(e) => {
          if (!rx.cameraOn) return;
          const r = e.currentTarget.getBoundingClientRect();
          rx.pinTo((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
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
              <span className="pill">
                <span className="dot" />
                pinned by tap
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
              <div className="k">Redness</div>
              <div className="v" style={{ color: rx.red >= 20 ? 'var(--ok)' : 'var(--bad)' }}>
                {rx.red}
              </div>
            </div>
          </div>

          {!rx.locked && (
            <p className="hint" style={{ marginTop: 10, color: 'var(--warn)' }}>
              No red spot found yet. <b>Tap the dot in the picture</b> to pin it. If redness stays
              under 20, dim the room or move closer - the camera has to see the dot as red, not
              just bright.
            </p>
          )}
          {rx.saturated && (
            <p className="hint" style={{ marginTop: 10, color: 'var(--warn)' }}>
              The spot is blown out to white, so it has no colour left to detect. Dim the room or
              angle the phone further off the beam.
            </p>
          )}

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
          {rx.cameraOn &&
            (rx.manual ? (
              <button onClick={rx.resumeAuto}>Back to auto</button>
            ) : (
              <button onClick={rx.reacquire}>Re-acquire</button>
            ))}
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
          <b>Redness</b> is <code>R - max(G, B)</code> at the tracked spot. This is measured
          instead of brightness on purpose: white paper is bright in all three channels, so a
          brightness search cannot tell the paper from the dot, while red excess is near zero for
          white, grey or black and high only where the laser is. Anything from about 20 up is
          usable.
          <br />
          <br />
          The tracker scores every part of the picture on how red it is plus how much that
          redness blinks, and only switches when a rival wins several frames running. If it still
          picks the wrong thing, <b>tap the dot</b> to pin it by hand.
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
