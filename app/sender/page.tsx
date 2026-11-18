'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { BIT_TIME_OPTIONS, MAX_PAYLOAD } from '../../lib/protocol';
import { useLaserSender } from '../../lib/useLaserSender';

const BEACON_OPTIONS = [
  { ms: 0, label: 'none' },
  { ms: 2000, label: '2 s' },
  { ms: 4000, label: '4 s' },
  { ms: 6000, label: '6 s' },
  { ms: 8000, label: '8 s' },
  { ms: 10000, label: '10 s' },
  { ms: 15000, label: '15 s' },
];

export default function SenderPage() {
  const [bitMs, setBitMs] = useState(120);
  const [draft, setDraft] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const threadRef = useRef<HTMLDivElement | null>(null);
  const tx = useLaserSender(bitMs);

  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [tx.outgoing, tx.phase]);

  // Push both settings to the Uno as soon as the link is up, and whenever
  // they change, so the countdown on screen matches what the laser does.
  useEffect(() => {
    if (!tx.ready) return;
    void tx.sendCommand('#BIT=' + bitMs);
    void tx.sendCommand('#BEACON=' + tx.beaconMs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bitMs, tx.ready, tx.beaconMs]);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!draft.trim()) return;
    tx.send(draft);
    setDraft('');
  }

  return (
    <>
      <h1 className="page">Sender</h1>
      <p className="lede">
        The laptop side. Connect the Uno over USB, type a message, and it leaves as light.
      </p>

      {tx.phase === 'beacon' && (
        <div className="aimBanner">
          <div className="big">{Math.ceil(tx.beaconLeftMs / 1000)}</div>
          <div className="txt">
            <b>Beacon running - aim the phone at the spot now.</b>
            <br />
            The laser is blinking so the receiver can find it. Transmission starts when this hits
            zero.
          </div>
        </div>
      )}

      <div className="card">
        <div className="row" style={{ marginBottom: 12 }}>
          <span className={'pill ' + (tx.ready ? 'on' : 'off')}>
            <span className="dot" />
            {tx.transport === 'usb'
              ? tx.connected
                ? 'Uno connected'
                : 'not connected'
              : tx.wifiBlocked
                ? 'Wi-Fi blocked on https'
                : 'NodeMCU ' + tx.nodeIp}
          </span>
          {tx.sending && (
            <span className="pill warn live">
              <span className="dot" />
              {tx.phase === 'beacon' ? 'beacon' : 'transmitting'} ·{' '}
              {Math.ceil(tx.totalLeftMs / 1000)}s left
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
          {tx.transport === 'usb' &&
            (tx.connected ? (
              <button onClick={tx.disconnectUsb}>Disconnect</button>
            ) : (
              <button className="primary" onClick={tx.connectUsb} disabled={!tx.supported}>
                Connect to Uno
              </button>
            ))}
          <button onClick={() => tx.sendCommand('#ON')} disabled={!tx.ready}>
            Laser on
          </button>
          <button onClick={() => tx.sendCommand('#OFF')} disabled={!tx.ready}>
            Laser off
          </button>
        </div>

        {!tx.supported && tx.transport === 'usb' && (
          <p className="hint" style={{ marginTop: 10, color: 'var(--warn)' }}>
            This browser has no Web Serial. Use Chrome or Edge on a desktop, or switch to the
            Wi-Fi transport below.
          </p>
        )}

        <form className="composer" onSubmit={submit}>
          <input
            type="text"
            value={draft}
            maxLength={MAX_PAYLOAD}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={tx.ready ? 'Type a message' : 'Connect the Uno first'}
            aria-label="Message to send"
          />
          <button className="primary" type="submit" disabled={!tx.ready || !draft.trim()}>
            Send
          </button>
        </form>
        <p className="hint" style={{ marginTop: 8 }}>
          Upper case ASCII, {MAX_PAYLOAD} characters max. Messages queue and go one at a time.
        </p>
      </div>

      <div className="card">
        <div className="thread" ref={threadRef}>
          {tx.outgoing.length === 0 && (
            <div className="empty">
              Nothing sent yet.
              <br />
              Each message blinks a beacon first, then transmits.
            </div>
          )}
          {tx.outgoing.map((m) => (
            <div key={m.id} className={'bubble out ' + (m.state === 'failed' ? 'failed' : '')}>
              <div className="btext">{m.text}</div>
              <div className="bmeta">
                {m.state === 'queued' && 'waiting for the beam'}
                {m.state === 'sending' &&
                  (tx.phase === 'beacon'
                    ? 'beacon, aim the camera'
                    : 'transmitting, ' + Math.ceil(tx.totalLeftMs / 1000) + 's left')}
                {m.state === 'sent' && 'sent · ' + new Date(m.at).toLocaleTimeString()}
                {m.state === 'failed' && 'failed: ' + m.error}
              </div>
              {m.state === 'sending' && (
                <div className={'progressbar ' + (tx.phase === 'beacon' ? 'beacon' : '')}>
                  <i style={{ width: tx.progressPct + '%' }} />
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      <details className="more card" open={showAdvanced}>
        <summary onClick={() => setShowAdvanced((s) => !s)}>Settings and link log</summary>

        <div className="field-row" style={{ marginTop: 12 }}>
          <div>
            <label className="field" htmlFor="bit">
              Bit time
            </label>
            <select id="bit" value={bitMs} onChange={(e) => setBitMs(Number(e.target.value))}>
              {BIT_TIME_OPTIONS.map((ms) => (
                <option key={ms} value={ms}>
                  {ms} ms{ms === 120 ? ' (default)' : ''}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="field" htmlFor="beacon">
              Beacon before each message
            </label>
            <select
              id="beacon"
              value={tx.beaconMs}
              onChange={(e) => tx.setBeaconMs(Number(e.target.value))}
            >
              {BEACON_OPTIONS.map((b) => (
                <option key={b.ms} value={b.ms}>
                  {b.label}
                </option>
              ))}
            </select>
          </div>
        </div>
        <p className="hint" style={{ marginTop: 8 }}>
          The bit time must match the receiver. 66 ms cannot work on a 30 fps camera - that is
          only two samples per bit.
        </p>

        <div className="field-row" style={{ marginTop: 12 }}>
          <div>
            <label className="field" htmlFor="transport">
              Transport
            </label>
            <select
              id="transport"
              value={tx.transport}
              onChange={(e) => tx.setTransport(e.target.value as 'usb' | 'wifi')}
            >
              <option value="usb">USB cable</option>
              <option value="wifi">Wi-Fi via NodeMCU</option>
            </select>
          </div>
          {tx.transport === 'wifi' && (
            <div>
              <label className="field" htmlFor="ip">
                NodeMCU address
              </label>
              <input
                id="ip"
                type="text"
                value={tx.nodeIp}
                onChange={(e) => tx.setNodeIp(e.target.value)}
              />
            </div>
          )}
        </div>

        {tx.wifiBlocked && (
          <p className="hint" style={{ marginTop: 10, color: 'var(--warn)' }}>
            This page is on https and the NodeMCU only speaks plain http, so the browser blocks
            the request as mixed content. Use the USB transport here, or run the sender from{' '}
            <code>npm run dev</code> on <code>http://localhost:3000</code>.
          </p>
        )}

        <label className="field" style={{ marginTop: 14 }}>
          Link log
        </label>
        <div className="log">
          {tx.lines.length === 0 && <span className="sys">Nothing yet.</span>}
          {tx.lines.map((l, i) => (
            <div key={i}>
              <span className="t">{new Date(l.t).toLocaleTimeString()} </span>
              <span className={l.kind}>
                {l.kind === 'tx' ? '> ' : l.kind === 'rx' ? '< ' : '  '}
                {l.text}
              </span>
            </div>
          ))}
        </div>
      </details>
    </>
  );
}
