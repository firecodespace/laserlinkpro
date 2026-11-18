import Link from 'next/link';

const WIRING: [string, string][] = [
  ['Uno 5V', 'breadboard + rail'],
  ['Uno GND', 'breadboard - rail'],
  ['Laser S', 'Uno D8'],
  ['Laser -', '- rail  (middle pin unused)'],
  ['MH VCC', '+ rail'],
  ['MH GND', '- rail'],
  ['MH D0', 'Uno D3  (A0 unused)'],
  ['NodeMCU D5', 'Uno D10'],
  ['NodeMCU G', '- rail  (shared ground required)'],
];

export default function Home() {
  return (
    <>
      <h1 className="page">LaserLink</h1>
      <p className="lede">
        A Phase-0 prototype of an optical data link. An Arduino Uno flashes text through a KY-008
        laser onto white paper; a camera reads the spot and decodes the message, checking a CRC-8
        on every frame. A NodeMCU serves a Wi-Fi page that injects messages into the link, and a
        slot sensor fires an automatic alert.
      </p>

      <div className="safety">
        <strong>Before anything is powered.</strong> The KY-008 is a Class 3R laser. Keep the beam
        at table height and pointed at the white paper. Never aim it at eyes, and never at a
        mirror, phone screen, metal or glossy surface. Leave the link on <code>#OFF</code> while
        you are wiring or adjusting anything.
      </div>

      <div className="card" style={{ marginBottom: 16, borderColor: '#35486b' }}>
        <h2>Chat demo - start here</h2>
        <p className="sub">
          One page, two windows. Open it on the laptop as the <b>sender</b> and on a phone as the{' '}
          <b>receiver</b>. Type a message on the laptop; it leaves as light and arrives on the
          phone because the camera read it off the paper. No network path exists between the two
          devices, which is the whole point.
        </p>
        <Link className="btn" href="/chat/">
          Open chat
        </Link>
      </div>

      <div className="grid cols-3">
        <div className="card">
          <h2>1. Transmit</h2>
          <p className="sub">
            Connect the Uno over USB from the browser and send messages or commands. No Serial
            Monitor needed.
          </p>
          <Link className="btn" href="/transmit/">
            Open console
          </Link>
        </div>
        <div className="card">
          <h2>2. Receive</h2>
          <p className="sub">
            Camera decoder with dot finder, exposure lock and a live signal scope. Works on the
            phone over https.
          </p>
          <Link className="btn" href="/receive/">
            Open receiver
          </Link>
        </div>
        <div className="card">
          <h2>3. Protocol</h2>
          <p className="sub">
            Frame layout, CRC-8 calculator and a decoder bench you can run with simulated camera
            noise.
          </p>
          <Link className="btn" href="/protocol/">
            Inspect protocol
          </Link>
        </div>
      </div>

      <div className="grid cols-2" style={{ marginTop: 16 }}>
        <div className="card">
          <h2>Wiring</h2>
          <p className="sub">Do all of this with every USB cable unplugged.</p>
          <table className="kv">
            <tbody>
              {WIRING.map(([a, b]) => (
                <tr key={a}>
                  <td>{a}</td>
                  <td>{b}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="hint" style={{ marginTop: 12 }}>
            Never connect NodeMCU 3V3 or Vin to the Uno, and never connect Uno D11 to the NodeMCU.
            The Uno drives 5 V logic and the NodeMCU is a 3.3 V part. The NodeMCU takes power from
            its own USB cable.
          </p>
        </div>

        <div className="card">
          <h2>Honest performance</h2>
          <p className="sub">What this prototype actually does.</p>
          <table className="kv">
            <tbody>
              <tr>
                <td>Line rate</td>
                <td>8.3 bits/s at 120 ms per bit</td>
              </tr>
              <tr>
                <td>Useful throughput</td>
                <td>about 0.8 characters/s</td>
              </tr>
              <tr>
                <td>Limit</td>
                <td>camera sampling, roughly 30 fps</td>
              </tr>
              <tr>
                <td>&quot;HELLO IOT&quot; airtime</td>
                <td>about 18 s</td>
              </tr>
              <tr>
                <td>Range tested</td>
                <td>0.5 - 1.5 m onto paper</td>
              </tr>
              <tr>
                <td>Error check</td>
                <td>CRC-8, detect only, no retry</td>
              </tr>
            </tbody>
          </table>
          <p className="hint" style={{ marginTop: 12 }}>
            The bottleneck is the receiver, not the laser. A photodiode instead of a camera would
            move this into the kilobit range; that is Phase 1, not this build.
          </p>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h2>Two minute run sheet</h2>
        <ol className="steps">
          <li>Room lights down. Laser 0.5 - 1.5 m from the paper, beam at table height.</li>
          <li>
            Laptop: <Link href="/chat/">Chat</Link> in Sender mode, Connect to Uno, wait for
            &quot;LaserLink TX ready&quot;.
          </li>
          <li>
            Phone: <Link href="/chat/">Chat</Link> in Receiver mode, Start camera, Find dot, Lock
            exposure. Check fps is 24 or better.
          </li>
          <li>
            Type a message on the laptop and send it. It appears on the phone about 18 s later,
            marked CRC ok - carried only by the beam.
          </li>
          <li>Block the slot sensor. &quot;SENSOR ALERT&quot; goes out by itself.</li>
          <li>
            Join Wi-Fi <code>LaserLink-Node</code>, open <code>192.168.4.1</code>, press Sensor
            reading. &quot;TEMP 27.5C&quot; arrives over the beam.
          </li>
          <li>
            Press <code>#OFF</code>. Explain that the camera&apos;s frame rate is the ceiling.
          </li>
        </ol>
      </div>
    </>
  );
}
