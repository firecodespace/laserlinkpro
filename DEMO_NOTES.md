# LaserLink — demo notes

Phase-0 prototype of an IoT laser communication link.
Course: IoT-Based Product Design, AIDC.

> Fill in **Section 9** during setup. Everything else is already verified.

---

## 1. What it is

An Arduino Uno flashes text through a KY-008 laser onto white paper. A phone
camera watches the spot, finds it automatically, recovers the bits, and checks
a CRC-8 on every frame. A NodeMCU (ESP8266, ESP-12E) can inject messages over
Wi-Fi, and an MH slot sensor fires an automatic alert.

The web app is deliberately just **two windows**:

| Route | Device | What it does |
|---|---|---|
| `/` | either | Pick this device's role |
| `/sender` | laptop | Uno over USB. Type a message, it leaves as light. |
| `/receiver` | phone | Camera. Finds the beam and decodes by itself. |
| `/protocol` | — | Reference and decoder bench, linked from the home page |

There is nothing to tune on the receiver. The old build had *Find dot* and
*Lock exposure* buttons; both are now continuous and automatic.

---

## 2. Light protocol

| Item | Value |
|---|---|
| Idle | laser ON |
| Byte | start bit OFF, 8 data bits LSB first (ON = 1), stop bit ON |
| Frame | `0xFF 0x7E LEN payload CRC8` |
| CRC-8 | poly `0x07`, init `0x00`, over LEN + payload |
| **Beacon** | **blink 200 ms on / 200 ms off, default 4 s, before every message** |
| Preamble | ON 500 ms, OFF 500 ms, then ON for max(1 s, 12 bit times) |
| Default bit time | 120 ms |
| Max payload | 60 characters, upper-case ASCII |
| Idle tail | 4 bit times of ON after the last stop bit |

`HELLO IOT` on the wire: `FF 7E 09 48 45 4C 4C 4F 20 49 4F 54 87`

### Why the beacon exists

It does two jobs at once:

1. **Human time.** It gives whoever holds the phone a few seconds to aim
   before any data moves. The sender shows a countdown.
2. **Machine acquisition.** The receiver finds the spot by looking for the
   part of the picture that is *blinking*, not the part that is brightest. A
   lamp or a reflection is bright but constant, so it scores zero. Nothing in
   a room blinks at 2.5 Hz, so the lock is unambiguous.

Each blink (200 ms) is far shorter than the preamble guard (1440 ms at the
default bit time), so the decoder can never mistake the beacon for a frame.
Measured: **zero false frames** across every bit time and noise level tested.

---

## 3. Verified before the demo

**CRC-8** matches the standard check vector: `"123456789"` → `0xF4`. ✓

**Firmware and web app agree.** The Uno independently computed `crc=0x87` for
`HELLO IOT`, matching the TypeScript implementation byte for byte.

**Transmit timing measured on the real Uno** (serial timestamps):

| Message | Predicted | Measured |
|---|---|---|
| `HELLO IOT`, no beacon | 18.04 s | **18.07 s** |
| `A`, no beacon | 8.92 s | **8.94 s** |

0.2% error over 18 seconds.

**Decoder delivery rate**, simulated camera samples replayed through the real
decoder, 30 messages per cell, 30 fps, 4 s beacon:

| bit time | clean | 1% noise | 3% noise | samples/bit |
|---|---|---|---|---|
| 100 ms | 100% | 37% | 0% | 3.0 |
| **120 ms** | **100%** | **83%** | 37% | 3.6 |
| 150 ms | 100% | 77% | 47% | 4.5 |
| 200 ms | 100% | 93% | 43% | 6.0 |
| 66 ms | fails | fails | fails | 2.0 |

**Firmware build sizes**

| Sketch | Flash | RAM |
|---|---|---|
| `LaserLink_TX_Uno` | 8 656 B (26%) | 423 B (20%) |
| `LaserLink_WiFi_NodeMCU` | 279 364 B (26%) | 29 100 B (36%) |

---

## 4. Honest limits

- **Throughput is about 8.3 bits/s** at 120 ms per bit, so roughly 0.8
  characters per second. `HELLO IOT` takes about 18 seconds, plus the beacon.
- **The camera is the bottleneck, not the laser.** A phone samples at about
  30 fps, which is 3.6 samples per bit at the default setting.
- **`#BIT=66` cannot work on a 30 fps camera** — 2 samples per bit is below
  the Nyquist limit. Measured 0–33% even with a clean signal. It only works if
  the camera genuinely runs at 60 fps.
- **CRC-8 detects errors, it does not correct them.** There is no
  retransmission. A corrupted message is reported as `CRC FAILED`, never
  guessed at.
- **The link is one-way**, laptop to phone. The chat is a chat in
  presentation, not a two-way protocol.

### Decoder fixes made after measurement

Each of these was found by measuring, not by reading the code:

1. **Glitch filter.** One mis-read video frame used to split the preamble
   guard in two, so sync never happened. A level change is now only believed
   after two samples agree.
2. **Triangular-weighted bit voting.** Sampling only at the bit centre wasted
   most of the bit. Weighting every sample across the bit by distance from the
   centre lifted 100 ms from 65% to 100%.
3. **CRC judges framing errors.** A stop bit misread by one frame used to
   discard a whole good message; now the frame is kept and CRC-8 decides.
4. **Midpoint edge timing.** Edges were dated at the first sample of the new
   level, biasing the byte clock late by up to a full frame — a third of a bit
   at 100 ms. Taking the midpoint between the last old-level and first
   new-level sample took 100 ms with beacon from 63% back to 100%.
5. **Idle tail.** With the laser idling off, the beam went dark the instant
   the last stop bit ended, leaving the final CRC byte's stop bit ambiguous.
6. **Silent aborts.** A failure on the very first header byte emitted no
   event, which hid fault 4 for a while. Aborts are always reported now.

---

## 5. Wiring

Do all of this with **every USB cable unplugged**.

| From | To |
|---|---|
| Uno `5V` | breadboard **+** rail |
| Uno `GND` | breadboard **−** rail |
| Laser `S` | Uno `D8` |
| Laser `−` | **−** rail (middle pin unconnected) |
| MH `VCC` | **+** rail |
| MH `GND` | **−** rail |
| MH `D0` | Uno `D3` (A0 unconnected) |
| NodeMCU `D5` | Uno `D10` |
| NodeMCU `G` | **−** rail (shared ground is required) |

**Never** connect NodeMCU `3V3` or `Vin` to the Uno, and **never** connect Uno
`D11` to the NodeMCU — the Uno is 5 V logic, the NodeMCU is 3.3 V. The NodeMCU
takes power from its own USB cable.

---

## 6. Serial commands

9600 baud, line ending **Newline**.

| Command | Effect |
|---|---|
| `#BIT=n` | bit time, 50–300 ms (default 120) |
| `#BEACON=ms` | beacon length, 0–15000 ms (default 4000) |
| `#ON` / `#OFF` | laser idle state |
| `#TEST` | send `HELLO IOT` |
| `#SENSOR=0/1` | enable the slot sensor alert |
| `#STATUS` | print current settings |
| anything else | sent over the laser, up to 60 characters |

---

## 7. Toolchain

| Item | Value |
|---|---|
| arduino-cli | 1.6.0, `C:\Program Files\Arduino CLI\arduino-cli.exe` |
| Cores | `arduino:avr` 1.8.7, `esp8266:esp8266` 3.1.2 |
| Uno FQBN | `arduino:avr:uno` |
| NodeMCU FQBN | `esp8266:esp8266:nodemcuv2` |
| Uno port | COM14 (CH340) |

```powershell
& "C:\Program Files\Arduino CLI\arduino-cli.exe" upload -p COM14 --fqbn arduino:avr:uno LaserLink_TX_Uno
```

**If upload says "Access is denied"**, a browser tab has the port open over
Web Serial. Press **Disconnect** on the sender page first.

---

## 8. Environment quirks

- **`D:` is exFAT.** Node's `readlink` returns `EISDIR` there where NTFS
  returns `EINVAL`, which Next.js treats as fatal. `npm run build` therefore
  fails locally while `npm run dev` works. This does **not** affect Vercel,
  which builds on Linux. Production builds are verified by building a copy of
  the project on `C:`.
- **Next.js 15.5.4 had CVE-2025-66478.** Vercel's security gate blocked the
  deployment even though the build itself succeeded. Fixed by moving to
  **15.5.29**. `package-lock.json` is committed, so the lockfile had to move
  too — bumping `package.json` alone would not have worked.
- npm on this exFAT volume sometimes reports "up to date" while packages are
  physically missing, and leaves locked `node_modules/.next-XXXX` staging
  folders behind if interrupted. `npm ci` is the reliable repair.

---

## 9. Measured on the day

| Measurement | Value |
|---|---|
| Laser-to-paper distance | |
| Phone-to-paper distance | |
| Room lighting | |
| Camera fps observed | |
| Samples/bit observed | |
| Lock score observed | |
| Bit time used | |
| Beacon length used | |
| Messages sent | |
| Messages delivered with CRC ok | |
| Delivery rate | |
| Sensor alert fired correctly | |
| NodeMCU message delivered | |

---

## 10. Two-minute run sheet

1. Room lights down. Laser 0.5–1.5 m from the paper, beam at table height,
   pointed at the white sheet.
2. **Laptop** — open the site, choose **Sender**, press *Connect to Uno*, pick
   COM14. Wait for `LaserLink TX ready` in the link log.
3. **Phone** — open the same URL, choose **Receiver**, press *Start camera*,
   point it at the paper. Check **samples/bit reads 3 or more**.
4. Type a message and send. Say what is happening: *the laser is blinking now,
   that is the beacon, and the phone is using it to find the beam.* The circle
   on the phone turns green when it locks.
5. The message lands marked **CRC ok**. Make the point plainly: the two devices
   share no network, only the beam.
6. Block the MH slot sensor → `SENSOR ALERT` goes out by itself, rate limited
   to one per 15 s.
7. Join Wi-Fi `LaserLink-Node` (password `laserlink`) on a second phone, open
   `192.168.4.1`, press *Sensor reading* → `TEMP 27.5C` arrives over the beam.
8. Press *Laser off*. Close on the honest limit: the camera's frame rate is the
   ceiling, and a photodiode would move this into the kilobit range. That is
   Phase 1.

**Safety line to say out loud:** the KY-008 is a Class 3R laser; the beam stays
at table height on the paper, never toward eyes or shiny surfaces.

### If it does not decode

| Symptom | Fix |
|---|---|
| Samples/bit below 3 | Raise bit time to 150 ms on **both** sides |
| Circle never turns green | Make sure a message is actually sending — the lock needs the beacon's blink |
| Circle locks on the wrong thing | Press *Re-acquire* |
| fps below 24 | Close other apps, brighten nothing, raise bit time |
| Decoder never locks | Check both sides show the same bit time |
| Sensor fires on removal | Swap `LOW` for `HIGH` on the marked line in the Uno sketch, re-upload |
| Upload says access denied | Press *Disconnect* on the sender page |
