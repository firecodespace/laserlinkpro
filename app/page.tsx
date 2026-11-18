import Link from 'next/link';

export default function Home() {
  return (
    <>
      <h1 className="page">Pick this device&apos;s role</h1>
      <p className="lede">
        Two windows, one laser beam between them. Open the sender on the laptop that has the
        Arduino plugged in, and the receiver on a phone. Nothing passes between the two over the
        network - every message that arrives was read off the laser spot by the camera.
      </p>

      <div className="roleGrid">
        <Link className="roleCard" href="/sender/">
          <div className="icon">💻</div>
          <h2>Sender</h2>
          <p>
            The laptop with the Uno on USB. Type a message, it goes out as light. Needs Chrome or
            Edge on a desktop.
          </p>
          <span className="go">Open sender →</span>
        </Link>

        <Link className="roleCard" href="/receiver/">
          <div className="icon">📷</div>
          <h2>Receiver</h2>
          <p>
            The phone. Point the camera at the spot on the paper; it finds the beam, locks on and
            decodes by itself. Nothing to press.
          </p>
          <span className="go">Open receiver →</span>
        </Link>
      </div>

      <div className="safety">
        <strong>Laser safety.</strong> The KY-008 is a Class 3R module. Keep the beam at table
        height, pointed at the white paper, and never at anyone&apos;s eyes or at a mirror, screen,
        metal or glossy surface. The sender has a <b>Laser off</b> button - use it whenever the
        link is idle.
      </div>

      <div className="card">
        <h2>How a message travels</h2>
        <ol className="steps">
          <li>
            You press Send. The laser first <b>blinks slowly for a few seconds</b> - that is the
            beacon, and it is your time to aim the phone.
          </li>
          <li>
            The receiver spots the blinking and locks onto it. Nothing in a room blinks like that,
            so a lamp or a reflection cannot fool it.
          </li>
          <li>
            A preamble marks the start, then the text goes out one bit at a time, about eight bits
            a second.
          </li>
          <li>
            The receiver checks a CRC-8 over every frame and shows the message, or says the check
            failed. It never guesses.
          </li>
        </ol>
        <p className="hint" style={{ marginTop: 12 }}>
          A short message takes roughly 18 seconds plus the beacon. The camera&apos;s frame rate is
          the ceiling here, not the laser.
        </p>
      </div>

      <div className="row" style={{ marginTop: 14 }}>
        <Link className="linkBtn" href="/protocol/">
          Protocol reference and decoder bench
        </Link>
      </div>
    </>
  );
}
