'use client';

import { useMemo, useState } from 'react';
import {
  BIT_TIME_OPTIONS,
  MAX_PAYLOAD,
  buildFrame,
  byteToBits,
  crc8,
  frameDurationMs,
  frameToSegments,
  guardMs,
} from '../../lib/protocol';
import { selfTest } from '../../lib/simulate';
import { WaveformPreview } from '../../components/WaveformPreview';

type BenchRow = { text: string; bitMs: number; noise: number; ok: boolean; got: string };

export default function ProtocolPage() {
  const [text, setText] = useState('HELLO IOT');
  const [bitMs, setBitMs] = useState(120);
  const [noise, setNoise] = useState(0);
  const [benchFps, setBenchFps] = useState(30);
  const [rows, setRows] = useState<BenchRow[]>([]);

  const frame = useMemo(() => buildFrame(text || ' '), [text]);
  const segments = useMemo(() => frameToSegments(frame, bitMs), [frame, bitMs]);
  const payload = useMemo(() => frame.slice(3, frame.length - 1), [frame]);
  const body = useMemo(() => [payload.length, ...payload], [payload]);

  function runBench() {
    const cases = ['HELLO IOT', 'SENSOR ALERT', 'TEMP 27.5C', text || 'A'];
    const out: BenchRow[] = [];
    for (const c of cases) {
      const events = selfTest(c, bitMs, { fps: benchFps, jitterMs: 5, noise });
      const f = events.find((e) => e.kind === 'frame');
      out.push({
        text: c,
        bitMs,
        noise,
        ok: f?.kind === 'frame' ? f.frame.ok : false,
        got: f?.kind === 'frame' ? f.frame.text : '(no frame)',
      });
    }
    setRows(out);
  }

  const hex = (b: number) => b.toString(16).padStart(2, '0').toUpperCase();

  return (
    <>
      <h1 className="page">Protocol</h1>
      <p className="lede">
        The exact bytes and light timings the Uno sketch and the camera receiver agree on. Change
        the message below and watch the frame rebuild itself.
      </p>

      <div className="grid cols-2">
        <div className="card">
          <h2>Frame layout</h2>
          <p className="sub">Every message on the beam looks like this.</p>
          <table className="kv">
            <tbody>
              <tr>
                <td>Byte 0</td>
                <td>0xFF - start of frame</td>
              </tr>
              <tr>
                <td>Byte 1</td>
                <td>0x7E - start of frame</td>
              </tr>
              <tr>
                <td>Byte 2</td>
                <td>LEN - payload length, 1 to {MAX_PAYLOAD}</td>
              </tr>
              <tr>
                <td>Bytes 3..</td>
                <td>payload, 7 bit ASCII</td>
              </tr>
              <tr>
                <td>Last byte</td>
                <td>CRC-8 over LEN + payload</td>
              </tr>
              <tr>
                <td>CRC</td>
                <td>poly 0x07, init 0x00, no reflection</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div className="card">
          <h2>Line coding</h2>
          <p className="sub">How each byte becomes light.</p>
          <table className="kv">
            <tbody>
              <tr>
                <td>Idle</td>
                <td>laser ON</td>
              </tr>
              <tr>
                <td>Start bit</td>
                <td>OFF, one bit time</td>
              </tr>
              <tr>
                <td>Data</td>
                <td>8 bits, LSB first, ON = 1</td>
              </tr>
              <tr>
                <td>Stop bit</td>
                <td>ON, one bit time</td>
              </tr>
              <tr>
                <td>Preamble</td>
                <td>ON 500 ms, OFF 500 ms</td>
              </tr>
              <tr>
                <td>Guard</td>
                <td>ON {guardMs(bitMs)} ms at {bitMs} ms/bit</td>
              </tr>
            </tbody>
          </table>
          <p className="hint" style={{ marginTop: 12 }}>
            The guard is deliberately longer than the longest ON run a frame can contain (nine bit
            times, from byte 0xFF), so the receiver can never mistake payload for a preamble.
          </p>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h2>Frame builder</h2>
        <div className="grid cols-2" style={{ marginBottom: 14 }}>
          <div>
            <label className="field" htmlFor="ptext">
              Message
            </label>
            <input
              id="ptext"
              type="text"
              value={text}
              maxLength={MAX_PAYLOAD}
              onChange={(e) => setText(e.target.value.toUpperCase())}
            />
          </div>
          <div>
            <label className="field" htmlFor="pbit">
              Bit time
            </label>
            <select id="pbit" value={bitMs} onChange={(e) => setBitMs(Number(e.target.value))}>
              {BIT_TIME_OPTIONS.map((ms) => (
                <option key={ms} value={ms}>
                  {ms} ms per bit
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="grid cols-3" style={{ marginBottom: 14 }}>
          <div className="stat">
            <div className="k">Frame length</div>
            <div className="v">{frame.length} B</div>
          </div>
          <div className="stat">
            <div className="k">CRC-8</div>
            <div className="v">0x{hex(crc8(body))}</div>
          </div>
          <div className="stat">
            <div className="k">Airtime</div>
            <div className="v">{(frameDurationMs(frame, bitMs) / 1000).toFixed(1)} s</div>
          </div>
        </div>

        <label className="field">Bytes on the wire</label>
        <div className="log" style={{ height: 'auto', maxHeight: 180 }}>
          {frame.map((b, i) => {
            const role =
              i === 0 ? 'SOF0' : i === 1 ? 'SOF1' : i === 2 ? 'LEN' : i === frame.length - 1 ? 'CRC' : 'payload';
            const ch = b >= 32 && b <= 126 ? String.fromCharCode(b) : '.';
            return (
              <div key={i}>
                <span className="t">{String(i).padStart(2, '0')} </span>
                <span className="rx">
                  0x{hex(b)}  {b.toString(2).padStart(8, '0')}  {role === 'payload' ? "'" + ch + "'" : role}
                </span>
                <span className="sys">   line: {byteToBits(b).join('')}</span>
              </div>
            );
          })}
        </div>

        <label className="field" style={{ marginTop: 14 }}>
          Waveform
        </label>
        <WaveformPreview segments={segments} />
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h2>Decoder bench</h2>
        <p className="sub">
          Replays the waveform as simulated camera samples and runs the real decoder on them. Push
          the noise up to see where the link gives out.
        </p>
        <div className="grid cols-2" style={{ marginBottom: 14 }}>
          <div>
            <label className="field" htmlFor="fps">
              Simulated camera: {benchFps} fps
            </label>
            <input
              id="fps"
              type="range"
              min={10}
              max={60}
              value={benchFps}
              onChange={(e) => setBenchFps(Number(e.target.value))}
              style={{ width: '100%' }}
            />
          </div>
          <div>
            <label className="field" htmlFor="noise">
              Sample error rate: {(noise * 100).toFixed(0)}%
            </label>
            <input
              id="noise"
              type="range"
              min={0}
              max={30}
              value={Math.round(noise * 100)}
              onChange={(e) => setNoise(Number(e.target.value) / 100)}
              style={{ width: '100%' }}
            />
          </div>
        </div>
        <button className="primary" onClick={runBench}>
          Run bench
        </button>

        {rows.length > 0 && (
          <div style={{ marginTop: 14 }}>
            {rows.map((r, i) => (
              <div key={i} className={'msg ' + (r.ok ? 'ok' : 'bad')}>
                <div className="text">{r.got}</div>
                <div className="meta">
                  sent &quot;{r.text}&quot; &middot; {r.bitMs} ms/bit &middot; {benchFps} fps &middot;{' '}
                  {(r.noise * 100).toFixed(0)}% sample errors &middot; {r.ok ? 'CRC ok' : 'failed'}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
