'use client';

import { useEffect, useRef, useState } from 'react';
import { BIT_TIME_OPTIONS, MAX_PAYLOAD } from '../../lib/protocol';
import { useLaserSender } from '../../lib/useLaserSender';
import { useLaserReceiver } from '../../lib/useLaserReceiver';

type Mode = 'sender' | 'receiver';

export default function ChatPage() {
  const [mode, setMode] = useState<Mode>('sender');
  const [bitMs, setBitMs] = useState(120);
  const [draft, setDraft] = useState('');
  const threadRef = useRef<HTMLDivElement | null>(null);

  const tx = useLaserSender(bitMs);
  const rx = useLaserReceiver(bitMs);

  // Remember which window this device is, so the phone stays the receiver.
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem('laserlink.mode');
      if (saved === 'sender' || saved === 'receiver') setMode(saved);
    } catch {
      /* private window */
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem('laserlink.mode', mode);
    } catch {
      /* private window */
    }
  }, [mode]);

  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [tx.outgoing, rx.messages, rx.locked]);

  // Keep the Uno's bit time in step with the dropdown while connected.
  useEffect(() => {
    if (mode === 'sender' && tx.ready) void tx.sendCommand('#BIT=' + bitMs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bitMs]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!draft.trim()) return;
    tx.send(draft);
    setDraft('');
  }

  const progressPct =
    rx.progress.total > 0 ? Math.min(100, (rx.progress.got / rx.progress.total) * 100) : 0;

  return (
    <>
      <h1 className="page">Chat over the laser</h1>
      <p className="lede">
        Two windows, one beam. Open this page as the sender on the laptop and as the receiver on a
        phone. Nothing travels between them over the network - every message you see arrive was
        read off the laser spot by the phone camera.
      </p>

      <div className="modebar">
        <button data-on={mode === 'sender'} onClick={() => setMode('sender')}>
          Sender
        </button>
        <button data-on={mode === 'receiver'} onClick={() => setMode('receiver')}>
          Receiver
        </button>
      </div>

      {mode === 'sender' ? (
        <SenderView
          tx={tx}
          bitMs={bitMs}
          setBitMs={setBitMs}
          draft={draft}
          setDraft={setDraft}
          submit={submit}
          threadRef={threadRef}
        />
      ) : (
        <ReceiverView rx={rx} bitMs={bitMs} setBitMs={setBitMs} threadRef={threadRef} progressPct={progressPct} />
      )}
    </>
  );
}

/* ------------------------------------------------------------------ sender */

function SenderView({
  tx,
  bitMs,
  setBitMs,
  draft,
  setDraft,
  submit,
  threadRef,
}: {
  tx: ReturnType<typeof useLaserSender>;
  bitMs: number;
  setBitMs: (n: number) => void;
  draft: string;
  setDraft: (s: string) => void;
  submit: (e: React.FormEvent) => void;
  threadRef: React.RefObject<HTMLDivElement | null>;
}) {
  return (
    <>
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div className="row">
            <span className={'pill ' + (tx.ready ? 'on' : 'off')}>
              <span className="dot" />
              {tx.transport === 'usb'
                ? tx.connected
                  ? 'Uno over USB'
                  : 'USB offline'
                : tx.wifiBlocked
                  ? 'Wi-Fi blocked on https'
                  : 'NodeMCU ' + tx.nodeIp}
            </span>
            {tx.sending && (
              <span className="pill warn">
                <span className="dot" />
                beam busy {Math.ceil(tx.remainingMs / 1000)}s
              </span>
            )}
            {tx.pending > 0 && (
              <span className="pill">
                <span className="dot" />
                {tx.pending} queued
              </span>
            )}
          </div>
          <div className="row">
            <select
              value={tx.transport}
              onChange={(e) => tx.setTransport(e.target.value as 'usb' | 'wifi')}
              style={{ width: 'auto' }}
            >
              <option value="usb">USB cable</option>
              <option value="wifi">Wi-Fi via NodeMCU</option>
            </select>
            <select
              value={bitMs}
              onChange={(e) => setBitMs(Number(e.target.value))}
              style={{ width: 'auto' }}
            >
              {BIT_TIME_OPTIONS.map((ms) => (
                <option key={ms} value={ms}>
                  {ms} ms/bit
                </option>
              ))}
            </select>
          </div>
        </div>

        {tx.transport === 'usb' ? (
          <div className="row" style={{ marginTop: 12 }}>
            {tx.connected ? (
              <button onClick={tx.disconnectUsb}>Disconnect</button>
            ) : (
              <button className="primary" onClick={tx.connectUsb} disabled={!tx.supported}>
                Connect to Uno
              </button>
            )}
            <button onClick={() => tx.sendCommand('#ON')} disabled={!tx.ready}>
              Laser on
            </button>
            <button onClick={() => tx.sendCommand('#OFF')} disabled={!tx.ready}>
              Laser off
            </button>
            {!tx.supported && (
              <span className="hint">
                This browser has no Web Serial. Use Chrome or Edge on the laptop.
              </span>
            )}
          </div>
        ) : (
          <div className="row" style={{ marginTop: 12 }}>
            <input
              type="text"
              value={tx.nodeIp}
              onChange={(e) => tx.setNodeIp(e.target.value)}
              placeholder="192.168.4.1"
              style={{ maxWidth: 200 }}
            />
            <button onClick={() => tx.sendCommand('#ON')} disabled={!tx.ready}>
              Laser on
            </button>
            <button onClick={() => tx.sendCommand('#OFF')} disabled={!tx.ready}>
              Laser off
            </button>
          </div>
        )}

        {tx.wifiBlocked && (
          <p className="hint" style={{ marginTop: 10, color: 'var(--warn)' }}>
            This page is on https, and the NodeMCU only speaks plain http, so the browser blocks
            the request as mixed content. Either switch to the USB transport, or run the sender
            from <code>npm run dev</code> at <code>http://localhost:3000/chat/</code>, which is
            allowed to reach it.
          </p>
        )}
      </div>

      <div className="card">
        <div className="thread" ref={threadRef}>
          {tx.outgoing.length === 0 && (
            <div className="empty">
              Nothing sent yet.
              <br />
              Type a message below - it goes out as light, one bit at a time.
            </div>
          )}
          {tx.outgoing.map((m) => {
            const pct =
              m.state === 'sending' && m.startedAt
                ? Math.min(100, ((Date.now() - m.startedAt) / m.airtimeMs) * 100)
                : 0;
            return (
              <div key={m.id} className={'bubble out ' + (m.state === 'failed' ? 'failed' : '')}>
                <div className="btext">{m.text}</div>
                <div className="bmeta">
                  {m.state === 'queued' && 'waiting for the beam'}
                  {m.state === 'sending' && 'transmitting, ' + (m.airtimeMs / 1000).toFixed(1) + 's'}
                  {m.state === 'sent' && 'sent  ' + new Date(m.at).toLocaleTimeString()}
                  {m.state === 'failed' && 'failed: ' + m.error}
                </div>
                {m.state === 'sending' && (
                  <div className="progressbar">
                    <i style={{ width: pct + '%' }} />
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <form className="composer" onSubmit={submit}>
          <input
            type="text"
            value={draft}
            maxLength={MAX_PAYLOAD}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={tx.ready ? 'Type a message and press Send' : 'Connect the Uno first'}
          />
          <button className="primary" type="submit" disabled={!tx.ready || !draft.trim()}>
            Send
          </button>
        </form>
        <p className="hint" style={{ marginTop: 8 }}>
          Messages are queued and released one at a time - the beam carries one message at a time,
          and a short one occupies it for about {(18).toFixed(0)} seconds at 120 ms per bit.
          Letters are sent as upper case ASCII, {MAX_PAYLOAD} characters maximum.
        </p>
      </div>
    </>
  );
}

/* ---------------------------------------------------------------- receiver */

function ReceiverView({
  rx,
  bitMs,
  setBitMs,
  threadRef,
  progressPct,
}: {
  rx: ReturnType<typeof useLaserReceiver>;
  bitMs: number;
  setBitMs: (n: number) => void;
  threadRef: React.RefObject<HTMLDivElement | null>;
  progressPct: number;
}) {
  return (
    <>
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="camStrip">
          <div>
            <div className="videoWrap">
              <video ref={rx.videoRef} playsInline muted />
              <canvas ref={rx.overlayRef} className="overlay" />
            </div>
          </div>
          <div>
            <div className="row">
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
              <select
                value={bitMs}
                onChange={(e) => setBitMs(Number(e.target.value))}
                style={{ width: 'auto' }}
              >
                {BIT_TIME_OPTIONS.map((ms) => (
                  <option key={ms} value={ms}>
                    {ms} ms/bit
                  </option>
                ))}
              </select>
            </div>

            <div className="grid cols-3" style={{ marginTop: 12 }}>
              <div className="stat">
                <div className="k">fps</div>
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
                <div className="k">Samples/bit</div>
                <div
                  className="v"
                  style={{
                    color:
                      rx.fps > 0 && (rx.fps * bitMs) / 1000 < 3 ? 'var(--bad)' : 'var(--ok)',
                  }}
                >
                  {((rx.fps * bitMs) / 1000).toFixed(1)}
                </div>
              </div>
            </div>

            <canvas ref={rx.scopeRef} className="scope" style={{ marginTop: 12 }} />
            <p className="hint" style={{ marginTop: 8 }}>
              Samples per bit is the one number that decides whether this works. Below 3 the
              camera cannot see the bits at all - raise the bit time until it is 3 or more.
            </p>
            {rx.error && (
              <p className="hint" style={{ marginTop: 8, color: 'var(--bad)' }}>
                {rx.error}
              </p>
            )}
            {rx.exposureNote && (
              <p className="hint" style={{ marginTop: 8 }}>
                {rx.exposureNote}
              </p>
            )}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="thread" ref={threadRef}>
          {rx.messages.length === 0 && !rx.locked && (
            <div className="empty">
              Listening.
              <br />
              Start the camera, press Find dot on the laser spot, then send from the laptop.
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
                {m.ok ? 'CRC ok' : 'CRC FAILED'} &middot; {m.len}B &middot;{' '}
                {new Date(m.at).toLocaleTimeString()}
                {m.source === 'self test' && ' · simulated'}
              </div>
            </div>
          ))}
          {rx.locked && (
            <div className="typing">
              <span className="blink" />
              incoming transmission
              {rx.progress.total > 0 ? ' ' + rx.progress.got + '/' + rx.progress.total + ' bytes' : ''}
              {progressPct > 0 && (
                <span style={{ display: 'inline-block', width: 90 }}>
                  <span className="progressbar">
                    <i style={{ width: progressPct + '%' }} />
                  </span>
                </span>
              )}
            </div>
          )}
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <button onClick={() => rx.runSelfTest(['HELLO IOT', 'LASERLINK OK'])}>
            Test without hardware
          </button>
          <button className="ghost" onClick={rx.clear}>
            Clear
          </button>
          <span className="hint">
            Dashed bubbles are simulated, solid ones came off the beam.
          </span>
        </div>
      </div>
    </>
  );
}
