# LaserLink — demo notes

Phase-0 prototype of an IoT laser communication link.
Course: IoT-Based Product Design, AIDC.

> Fill in the **Measured on the day** section during setup. Everything else is
> already verified.

---

## 1. What it is

An Arduino Uno flashes text through a KY-008 laser onto white paper. A phone
camera watches the spot, recovers the bits, and checks a CRC-8 on every frame.
A NodeMCU (ESP8266) serves a Wi-Fi page that injects messages into the link,
and an MH slot sensor fires an automatic alert.

The web app is a Next.js 15 site with four working pages:

| Page | What it does |
|---|---|
| `/chat` | **The demo.** Sender window (laptop) and receiver window (phone), one beam between them |
| `/transmit` | Engineering console: Web Serial to the Uno, command buttons, waveform preview |
| `/receive` | Camera decoder with signal scope, fps and contrast meters |
| `/protocol` | Frame builder showing every byte, plus a decoder bench with simulated noise |

---

## 2. Light protocol

| Item | Value |
|---|---|
| Idle | laser ON |
| Byte | start bit OFF, 8 data bits LSB first (ON = 1), stop bit ON |
| Frame | `0xFF 0x7E LEN payload CRC8` |
| CRC-8 | poly `0x07`, init `0x00`, over LEN + payload |
| Preamble | ON 500 ms, OFF 500 ms, then ON for max(1 s, 12 bit times) |
| Default bit time | 120 ms |
| Max payload | 60 characters, upper-case ASCII |

The guard period is deliberately longer than the longest ON run a frame can
contain (nine bit times, from byte `0xFF`), so payload can never be mistaken
for a preamble.

`HELLO IOT` on the wire: `FF 7E 09 48 45 4C 4C 4F 20 49 4F 54 87`

---

## 3. Verified before the demo

**CRC-8** matches the standard check vector: `"123456789"` → `0xF4`. ✓

**Decoder delivery rate**, 40 messages per cell, simulated camera samples
(`lib/simulate.ts` replaying real waveforms through the real decoder):

| bit time | clean | 1% noise | 3% noise | 5% noise | samples/bit |
|---|---|---|---|---|---|
| 66 ms @ 30 fps | 23% | 0% | 0% | 0% | 2.0 |
| 100 ms @ 30 fps | 100% | 35% | 5% | 0% | 3.0 |
| **120 ms @ 30 fps** | **100%** | **78%** | 30% | 8% | 3.6 |
| 150 ms @ 30 fps | 100% | 73% | 25% | 13% | 4.5 |
| 200 ms @ 30 fps | 100% | 88% | 50% | 13% | 6.0 |
| 300 ms @ 30 fps | 100% | 73% | 45% | 28% | 9.0 |
| 66 ms @ 60 fps | 100% | 80% | 35% | 15% | 4.0 |
| 120 ms @ 60 fps | 100% | 88% | 55% | 20% | 7.2 |

**Firmware build sizes**

| Sketch | Flash | RAM |
|---|---|---|
| `LaserLink_TX_Uno` | 8 272 B (25%) | 413 B (20%) |
| `LaserLink_WiFi_NodeMCU` | 279 364 B (26%) | 29 100 B (36%) |

---

## 4. Honest limits

- **Throughput is about 8.3 bits/s** at 120 ms per bit, so roughly 0.8
  characters per second. `HELLO IOT` takes about 18 seconds end to end.
- **The camera is the bottleneck, not the laser.** A phone samples at about
  30 fps, which is 3.6 samples per bit. The laser itself would switch orders
  of magnitude faster.
- **`#BIT=66` does not work on a 30 fps camera.** That is 2 samples per bit,
  below the Nyquist limit — measured 23% delivery even with a clean signal,
  0% with any noise. It only reaches 100% if the camera runs at 60 fps.
- **CRC-8 detects errors, it does not correct them.** There is no
  retransmission. A corrupted message is reported as `CRC FAILED`, not fixed.
- **The link is one-way.** Laptop to phone only. The chat is a chat in
  presentation, not a two-way protocol.
- Decoder robustness comes from three things added after the first version
  failed under noise: a one-frame glitch filter, triangular-weighted bit
  voting across the whole bit, and letting CRC-8 judge frames whose stop bit
  was misread rather than discarding them.

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

## 6. Ports and toolchain

| Item | Value |
|---|---|
| arduino-cli | 1.6.0, `C:\Program Files\Arduino CLI\arduino-cli.exe` |
| Cores | `arduino:avr` 1.8.7, `esp8266:esp8266` 3.1.2 |
| Uno FQBN | `arduino:avr:uno` |
| NodeMCU FQBN | `esp8266:esp8266:nodemcuv2` |
| Uno port | _fill in — was COM14 previously_ |
| NodeMCU port | _fill in_ |

Upload commands:

```powershell
& "C:\Program Files\Arduino CLI\arduino-cli.exe" compile --fqbn arduino:avr:uno LaserLink_TX_Uno
```

```powershell
& "C:\Program Files\Arduino CLI\arduino-cli.exe" upload -p COM14 --fqbn arduino:avr:uno LaserLink_TX_Uno
```

---

## 7. Known environment quirks

- **`D:` is exFAT.** Node's `readlink` returns `EISDIR` there where NTFS
  returns `EINVAL`, which Next.js treats as fatal. So `npm run build` fails
  locally while `npm run dev` works fine. This does **not** affect Vercel,
  which builds on Linux. Production builds were verified by building a copy of
  the project on `C:`.
- **Next.js was pinned to 15.5.4**, which has CVE-2025-66478. Vercel's security
  gate blocked the deployment even though the build itself succeeded. Fixed by
  moving to **15.5.29** (the advisory names 15.5.7 as the patched 15.5.x).
  `package-lock.json` is committed, so the lockfile had to be updated too.

---

## 8. Two-minute run sheet

1. Room lights down. Laser 0.5–1.5 m from the paper, beam at table height,
   pointed at the white sheet.
2. **Laptop** — open `/chat`, mode **Sender**, press *Connect to Uno*, pick the
   serial port. Wait for `LaserLink TX ready` in the log.
3. **Phone** — open the same `/chat` URL, mode **Receiver**, *Start camera*,
   aim at the spot, *Find dot*, *Lock exposure*. Check fps ≥ 24 and
   contrast ≥ 12.
4. Type a message on the laptop and send. Point out the progress bar: the beam
   is busy for ~18 s, and the phone shows *incoming transmission n/13 bytes*
   as the bytes land.
5. Message appears on the phone marked **CRC ok**. Say plainly: the two devices
   share no network, only the beam.
6. Block the MH slot sensor → `SENSOR ALERT` is sent on its own (rate limited
   to one per 15 s).
7. Join Wi-Fi `LaserLink-Node` (password `laserlink`) on a second phone, open
   `192.168.4.1`, press *Sensor reading* → `TEMP 27.5C` arrives over the beam.
8. Press *Laser off*. Close with the honest limit: the camera's frame rate is
   the ceiling, and a photodiode would move this into the kilobit range —
   that is Phase 1.

**Safety line to say out loud:** the KY-008 is a Class 3R laser; the beam stays
at table height on the paper, never toward eyes or shiny surfaces.

---

## 9. Measured on the day

_Fill these in during setup._

| Measurement | Value |
|---|---|
| Laser-to-paper distance | |
| Phone-to-paper distance | |
| Room lighting | |
| Camera fps observed | |
| Contrast observed | |
| Bit time used | |
| Messages sent | |
| Messages delivered with CRC ok | |
| Delivery rate | |
| Sensor alert fired correctly | |
| NodeMCU message delivered | |

### If it does not decode

| Symptom | Fix |
|---|---|
| fps below 24 | Set bit time to 150 ms on **both** sides |
| Contrast below 12 | Dim the room, move the phone closer, re-run *Find dot* |
| Decoder never locks | Check both sides show the same bit time |
| Spot drifts out of the circle | Steady the phone, press *Find dot* again |
| Exposure keeps hunting | Press *Lock exposure* after *Find dot* |
| Sensor fires on removal | Swap `LOW` for `HIGH` on the marked line in the Uno sketch, re-upload |
