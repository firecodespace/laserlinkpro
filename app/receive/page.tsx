'use client';

import { useState } from 'react';
import { BIT_TIME_OPTIONS } from '../../lib/protocol';
import { useLaserReceiver } from '../../lib/useLaserReceiver';

export default function ReceivePage() {
  const [bitMs, setBitMs] = useState(120);
  const rx = useLaserReceiver(bitMs);
  const okCount = rx.messages.filter((m) => m.ok).length;
  const newest = [...rx.messages].reverse();

  return (
    <>
      <h1 className="page">Receive</h1>
      <p className="lede">
        Point the camera at the laser spot on the paper. This page samples the spot once per video
        frame, recovers the bits, and checks the CRC-8 on every frame before showing a message.
        For the two-window demo use the <a href="/chat/">Chat</a> page instead.
      </p>

      <div className="grid cols-2">
        <div className="card">
          <h2>Camera</h2>
          <p className="sub">Rear camera, 640x480. Dim the room and keep the phone still.</p>
          <div className="videoWrap">
            <video ref={rx.videoRef} playsInline muted />
            <canvas ref={rx.overlayRef} className="overlay" />
          </div>
          <div className="row" style={{ marginTop: 12 }}>
            {rx.cameraOn ? (
              <button onClick={rx.stopCamera}>Stop camera</button>
            ) : (
              <button className="primary" onClick={rx.startCamera}>
                Start camera
              </button>
            )}
            <button onClick={rx.findDot} disabled={!rx.cameraOn}>
              Find dot
            </button>
            <button onClick={rx.lockExposure} disabled={!rx.cameraOn}>
              Lock exposure
            </button>
            <button onClick={() => rx.runSelfTest()}>Test without hardware</button>
          </div>
          {rx.exposureNote && (
            <p className="hint" style={{ marginTop: 8 }}>
              {rx.exposureNote}
            </p>
          )}
          {rx.error && (
            <p className="hint" style={{ marginTop: 8, color: 'var(--bad)' }}>
              {rx.error}
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
          <canvas ref={rx.scopeRef} className="scope" />
          <div className="grid cols-3" style={{ marginTop: 14 }}>
            <div className="stat">
              <div className="k">Camera fps</div>
              <div
                className="v"
                style={{ color: rx.fps > 0 && rx.fps < 24 ? 'var(--warn)' : undefined }}
              >
                {rx.fps}
              </div>
            </div>
            <div className="stat">
              <div className="k">Contrast</div>
              <div className="v" style={{ color: rx.range < 12 ? 'var(--warn)' : 'var(--ok)' }}>
                {rx.range}
              </div>
            </div>
            <div className="stat">
              <div className="k">Frames ok</div>
              <div className="v">
                {okCount}/{rx.messages.length}
              </div>
            </div>
          </div>
          <div className="row" style={{ marginTop: 12 }}>
            <span className={'pill ' + (rx.locked ? 'on' : '')}>
              <span className="dot" />
              {rx.locked ? 'locked on preamble' : 'hunting for preamble'}
            </span>
            {rx.progress.total > 0 && rx.locked && (
              <span className="pill warn">
                <span className="dot" />
                {rx.progress.got}/{rx.progress.total} bytes
              </span>
            )}
            {rx.aborts > 0 && (
              <span className="pill warn">
                <span className="dot" />
                {rx.aborts} aborted
              </span>
            )}
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
        {rx.messages.length === 0 && (
          <p className="hint">
            Nothing yet. Press &quot;Test without hardware&quot; to prove the decoder works before
            you set the optics up.
          </p>
        )}
        {newest.map((m) => (
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
