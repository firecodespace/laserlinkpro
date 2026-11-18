'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SerialLink, serialSupported } from '../../lib/serial';
import {
  BIT_TIME_OPTIONS,
  MAX_PAYLOAD,
  buildFrame,
  frameDurationMs,
  frameToSegments,
} from '../../lib/protocol';
import { WaveformPreview } from '../../components/WaveformPreview';

type LogLine = { t: number; kind: 'tx' | 'rx' | 'sys' | 'err'; text: string };

export default function TransmitPage() {
  const linkRef = useRef<SerialLink | null>(null);
  const [connected, setConnected] = useState(false);
  const [supported, setSupported] = useState(true);
  const [bitMs, setBitMs] = useState(120);
  const [message, setMessage] = useState('HELLO IOT');
  const [lines, setLines] = useState<LogLine[]>([]);
  const [busyUntil, setBusyUntil] = useState(0);
  const [now, setNow] = useState(0);
  const [sentCount, setSentCount] = useState(0);
  const logRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => setSupported(serialSupported()), []);

  const log = useCallback((kind: LogLine['kind'], text: string) => {
    setLines((prev) => [...prev.slice(-300), { t: Date.now(), kind, text }]);
  }, []);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  // Drives the "sending" countdown.
  useEffect(() => {
    if (busyUntil === 0) return;
    const id = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(id);
  }, [busyUntil]);

  const frame = useMemo(() => buildFrame(message || ' '), [message]);
  const airtime = useMemo(() => frameDurationMs(frame, bitMs), [frame, bitMs]);
  const segments = useMemo(() => frameToSegments(frame, bitMs), [frame, bitMs]);
  const sending = busyUntil > now;
  const remaining = Math.max(0, Math.ceil((busyUntil - now) / 1000));

  async function connect() {
    try {
      const link = new SerialLink();
      link.onLine = (l) => {
        const trimmed = l.trim();
        if (trimmed) log('rx', trimmed);
      };
      link.onStatus = (ok, detail) => {
        setConnected(ok);
        log(ok ? 'sys' : 'err', ok ? 'Port open (' + detail + ')' : 'Port closed: ' + detail);
      };
      await link.connect(9600);
      linkRef.current = link;
    } catch (err) {
      log('err', String(err instanceof Error ? err.message : err));
    }
  }

  async function disconnect() {
    await linkRef.current?.disconnect();
    linkRef.current = null;
    setConnected(false);
  }

  const send = useCallback(
    async (text: string, countAirtime = false) => {
      const link = linkRef.current;
      if (!link?.connected) {
        log('err', 'Not connected - click Connect to Uno first');
        return;
      }
      try {
        await link.sendLine(text);
        log('tx', text);
        if (countAirtime) {
          const ms = frameDurationMs(buildFrame(text), bitMs);
          setNow(Date.now());
          setBusyUntil(Date.now() + ms);
          setSentCount((c) => c + 1);
        }
      } catch (err) {
        log('err', String(err instanceof Error ? err.message : err));
      }
    },
    [bitMs, log],
  );

  async function changeBit(ms: number) {
    setBitMs(ms);
    if (linkRef.current?.connected) await send('#BIT=' + ms);
  }

  return (
    <>
      <h1 className="page">Transmit</h1>
      <p className="lede">
        Drives the Arduino Uno over USB straight from this page using Web Serial - no Arduino
        Serial Monitor needed. Type a message, press Send, and the Uno flashes it through the
        KY-008 laser onto the paper.
      </p>

      <div className="safety">
        <strong>Laser safety.</strong> The KY-008 is a Class 3R module. Keep the beam at table
        height, pointed at the white paper, and never at anyone&apos;s eyes or at a shiny surface
        (phone screen, metal, mirror, glossy table). Press <code>#OFF</code> whenever the link is
        idle.
      </div>

      {!supported && (
        <div className="card" style={{ borderColor: 'var(--warn)', marginBottom: 16 }}>
          <h2>Web Serial not available in this browser</h2>
          <p className="sub" style={{ marginBottom: 0 }}>
            Open this page in Chrome or Edge on the laptop. On a phone, or in any other browser,
            you can still use the Receive page - just drive the Uno from the Arduino IDE Serial
            Monitor at 9600 baud with the line ending set to Newline.
          </p>
        </div>
      )}

      <div className="grid cols-2">
        <div className="card">
          <h2>Link</h2>
          <p className="sub">USB serial to the Uno, 9600 baud.</p>
          <div className="row" style={{ marginBottom: 14 }}>
            {connected ? (
              <button onClick={disconnect}>Disconnect</button>
            ) : (
              <button className="primary" onClick={connect} disabled={!supported}>
                Connect to Uno
              </button>
            )}
            <span className={'pill ' + (connected ? 'on' : 'off')}>
              <span className="dot" />
              {connected ? 'connected' : 'offline'}
            </span>
            {sending && (
              <span className="pill warn">
                <span className="dot" />
                sending, {remaining}s left
              </span>
            )}
          </div>

          <label className="field" htmlFor="msg">
            Message ({message.length}/{MAX_PAYLOAD})
          </label>
          <input
            id="msg"
            type="text"
            value={message}
            maxLength={MAX_PAYLOAD}
            onChange={(e) => setMessage(e.target.value.toUpperCase())}
            placeholder="HELLO IOT"
          />
          <div className="row" style={{ marginTop: 10, marginBottom: 16 }}>
            <button
              className="primary"
              disabled={!connected || message.trim().length === 0}
              onClick={() => send(message.trim(), true)}
            >
              Send over laser
            </button>
            <span className="hint">
              airtime {(airtime / 1000).toFixed(1)}s at {bitMs} ms/bit
            </span>
          </div>

          <label className="field">Commands</label>
          <div className="row">
            <button disabled={!connected} onClick={() => send('#TEST', true)}>
              #TEST
            </button>
            <button disabled={!connected} onClick={() => send('#ON')}>
              #ON
            </button>
            <button disabled={!connected} onClick={() => send('#OFF')}>
              #OFF
            </button>
            <button disabled={!connected} onClick={() => send('#SENSOR=1')}>
              sensor on
            </button>
            <button disabled={!connected} onClick={() => send('#SENSOR=0')}>
              sensor off
            </button>
          </div>

          <label className="field" style={{ marginTop: 16 }} htmlFor="bit">
            Bit time - must match the Receive page
          </label>
          <select id="bit" value={bitMs} onChange={(e) => changeBit(Number(e.target.value))}>
            {BIT_TIME_OPTIONS.map((ms) => (
              <option key={ms} value={ms}>
                {ms} ms per bit{ms === 120 ? '  (default)' : ''}
              </option>
            ))}
          </select>
          <p className="hint" style={{ marginTop: 8 }}>
            Changing this sends <code>#BIT={bitMs}</code> to the Uno. Set the same value on the
            receiver, otherwise nothing decodes.
          </p>
        </div>

        <div className="card">
          <h2>Serial log</h2>
          <p className="sub">Everything the Uno prints back, plus what this page sent.</p>
          <div className="log" ref={logRef}>
            {lines.length === 0 && (
              <span className="sys">
                Waiting for a connection. Expect &quot;LaserLink TX ready&quot; once the Uno
                resets.
              </span>
            )}
            {lines.map((l, i) => (
              <div key={i}>
                <span className="t">{new Date(l.t).toLocaleTimeString()} </span>
                <span className={l.kind}>
                  {l.kind === 'tx' ? '> ' : l.kind === 'rx' ? '< ' : '  '}
                  {l.text}
                </span>
              </div>
            ))}
          </div>
          <div className="grid cols-3" style={{ marginTop: 14 }}>
            <div className="stat">
              <div className="k">Messages sent</div>
              <div className="v">{sentCount}</div>
            </div>
            <div className="stat">
              <div className="k">Frame bytes</div>
              <div className="v">{frame.length}</div>
            </div>
            <div className="stat">
              <div className="k">Throughput</div>
              <div className="v">{(1000 / bitMs).toFixed(1)} bps</div>
            </div>
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h2>Waveform this message will put on the beam</h2>
        <p className="sub">
          Preamble, then every byte as start bit, eight data bits LSB first, and a stop bit. Red
          blocks are laser ON.
        </p>
        <WaveformPreview segments={segments} />
        <p className="hint" style={{ marginTop: 10 }}>
          Frame bytes:{' '}
          <code>{frame.map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ')}</code>
        </p>
      </div>
    </>
  );
}
