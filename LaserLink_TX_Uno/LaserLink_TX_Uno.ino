/*
  LaserLink - Uno transmitter
  IoT-Based Product Design, AIDC. Phase-0 prototype.

  Flashes text messages through a KY-008 laser module. The receiver is a
  camera running LaserLink_Receiver (the web app's Receive page), so the bit
  rate is deliberately slow: a phone camera only samples about 30 times a
  second.

  Wiring
    Laser S      -> D8          (middle pin of the KY-008 stays unconnected)
    Laser -      -> GND rail
    MH slot D0   -> D3          (A0 unconnected)
    MH VCC/GND   -> 5V / GND rails
    NodeMCU D5   -> D10         (NodeMCU talks to us; shared ground required)
    Do NOT wire D11 to the NodeMCU and do NOT feed it 5 V - it is a 3.3 V part.

  Serial: 9600 baud, line ending "Newline".
    #BIT=n      set bit time, 50..300 ms          (default 120)
    #ON         laser on, idle state
    #OFF        laser off
    #TEST       send "HELLO IOT"
    #SENSOR=1   enable the slot sensor alert      (#SENSOR=0 disables)
    #STATUS     print current settings
    anything else: sent over the laser, up to 60 characters

  Light protocol - must match lib/protocol.ts in the web app.
    idle            laser ON
    byte            start bit OFF, 8 data bits LSB first (ON = 1), stop bit ON
    frame           0xFF 0x7E LEN payload CRC8(LEN+payload), poly 0x07 init 0
    before a frame  ON 500 ms, OFF 500 ms, ON max(1000 ms, 12 bit times)

  SAFETY: Class 3R laser. Beam at table height, onto white paper only.
  Never at eyes, mirrors, screens or metal. Use #OFF when idle.
*/

#include <SoftwareSerial.h>

// ---------------------------------------------------------------- pins
const uint8_t PIN_LASER  = 8;
const uint8_t PIN_SENSOR = 3;
const uint8_t PIN_MIRROR = LED_BUILTIN;   // on-board LED copies the beam
const uint8_t PIN_NODE_RX = 10;           // from NodeMCU D5
const uint8_t PIN_NODE_TX = 11;           // NOT CONNECTED - 5 V would damage the NodeMCU

// ------------------------------------------------------------ protocol
const uint8_t  SOF0 = 0xFF;
const uint8_t  SOF1 = 0x7E;
const uint8_t  MAX_PAYLOAD = 60;
const uint16_t PREAMBLE_ON_MS  = 500;
const uint16_t PREAMBLE_OFF_MS = 500;

// ------------------------------------------------------------- sensor
// CHANGE THIS LINE if the alert fires when you REMOVE the card instead of
// when you insert it: swap LOW for HIGH.
const uint8_t SENSOR_ACTIVE_STATE = LOW;

const unsigned long SENSOR_COOLDOWN_MS = 15000UL;
const unsigned long SENSOR_DEBOUNCE_MS = 40UL;

// --------------------------------------------------------------- state
SoftwareSerial nodeSerial(PIN_NODE_RX, PIN_NODE_TX);

uint16_t bitMs = 120;
bool laserIdleOn = true;
bool sensorEnabled = true;

uint8_t  sensorStable = HIGH;
uint8_t  sensorLastRead = HIGH;
unsigned long sensorChangedAt = 0;
unsigned long sensorLastFire = 0;

String usbLine;
String nodeLine;

// ------------------------------------------------------------- helpers
void laserWrite(bool on) {
  digitalWrite(PIN_LASER, on ? HIGH : LOW);
  digitalWrite(PIN_MIRROR, on ? HIGH : LOW);
}

// Hold a light level for ms milliseconds. millis() based rather than
// delay() so that a SoftwareSerial byte arriving mid-frame cannot stretch
// the bit: the loop simply catches up.
void hold(bool level, unsigned long ms) {
  laserWrite(level);
  unsigned long start = millis();
  while (millis() - start < ms) {
    // nothing - SoftwareSerial keeps buffering in the background
  }
}

uint8_t crc8(const uint8_t *data, uint8_t len) {
  uint8_t crc = 0;
  for (uint8_t i = 0; i < len; i++) {
    crc ^= data[i];
    for (uint8_t b = 0; b < 8; b++) {
      crc = (crc & 0x80) ? (uint8_t)((crc << 1) ^ 0x07) : (uint8_t)(crc << 1);
    }
  }
  return crc;
}

unsigned long guardMs() {
  unsigned long twelve = 12UL * bitMs;
  return twelve > 1000UL ? twelve : 1000UL;
}

void sendByte(uint8_t b) {
  hold(false, bitMs);                       // start bit
  for (uint8_t i = 0; i < 8; i++) {         // 8 data bits, LSB first
    hold((b >> i) & 0x01, bitMs);
  }
  hold(true, bitMs);                        // stop bit
}

void sendMessage(const String &textIn) {
  String text = textIn;
  if (text.length() > MAX_PAYLOAD) text = text.substring(0, MAX_PAYLOAD);
  uint8_t len = (uint8_t)text.length();
  if (len == 0) return;

  uint8_t body[MAX_PAYLOAD + 1];
  body[0] = len;
  for (uint8_t i = 0; i < len; i++) {
    char c = text.charAt(i);
    body[i + 1] = (c >= 32 && c <= 126) ? (uint8_t)c : (uint8_t)'?';
  }
  uint8_t crc = crc8(body, len + 1);

  Serial.print(F("TX start: \""));
  Serial.print(text);
  Serial.print(F("\"  len="));
  Serial.print(len);
  Serial.print(F(" crc=0x"));
  if (crc < 16) Serial.print('0');
  Serial.println(crc, HEX);

  // preamble
  hold(true,  PREAMBLE_ON_MS);
  hold(false, PREAMBLE_OFF_MS);
  hold(true,  guardMs());

  sendByte(SOF0);
  sendByte(SOF1);
  for (uint8_t i = 0; i <= len; i++) sendByte(body[i]);   // LEN + payload
  sendByte(crc);

  // Hold the idle level for a few bit times before honouring #OFF. Without
  // this the beam goes dark the instant the last stop bit ends, and the
  // receiver samples that stop bit against an already dark line. Matches the
  // trailing segment in frameToSegments() in lib/protocol.ts.
  hold(true, (unsigned long)bitMs * 4);

  laserWrite(laserIdleOn);
  Serial.println(F("TX done"));
}

void printStatus() {
  Serial.print(F("STATUS bit="));
  Serial.print(bitMs);
  Serial.print(F("ms laser="));
  Serial.print(laserIdleOn ? F("ON") : F("OFF"));
  Serial.print(F(" sensor="));
  Serial.print(sensorEnabled ? F("on") : F("off"));
  Serial.print(F(" guard="));
  Serial.print(guardMs());
  Serial.println(F("ms"));
}

// Returns true if the line was a command.
bool handleCommand(const String &line) {
  if (!line.startsWith("#")) return false;

  if (line.startsWith("#BIT=")) {
    long v = line.substring(5).toInt();
    if (v >= 50 && v <= 300) {
      bitMs = (uint16_t)v;
      Serial.print(F("OK bit="));
      Serial.println(bitMs);
    } else {
      Serial.println(F("ERR bit time must be 50..300"));
    }
  } else if (line == "#ON") {
    laserIdleOn = true;
    laserWrite(true);
    Serial.println(F("OK laser on"));
  } else if (line == "#OFF") {
    laserIdleOn = false;
    laserWrite(false);
    Serial.println(F("OK laser off"));
  } else if (line == "#TEST") {
    sendMessage("HELLO IOT");
  } else if (line.startsWith("#SENSOR=")) {
    sensorEnabled = line.substring(8).toInt() != 0;
    Serial.print(F("OK sensor "));
    Serial.println(sensorEnabled ? F("enabled") : F("disabled"));
  } else if (line == "#STATUS") {
    printStatus();
  } else {
    Serial.print(F("ERR unknown command "));
    Serial.println(line);
  }
  return true;
}

void handleLine(String line) {
  line.trim();
  if (line.length() == 0) return;
  if (handleCommand(line)) return;
  sendMessage(line);
}

void pollSensor() {
  if (!sensorEnabled) return;
  uint8_t raw = digitalRead(PIN_SENSOR);
  if (raw != sensorLastRead) {
    sensorLastRead = raw;
    sensorChangedAt = millis();
    return;
  }
  if (raw == sensorStable) return;
  if (millis() - sensorChangedAt < SENSOR_DEBOUNCE_MS) return;

  sensorStable = raw;
  if (sensorStable != SENSOR_ACTIVE_STATE) return;

  unsigned long now = millis();
  if (sensorLastFire != 0 && now - sensorLastFire < SENSOR_COOLDOWN_MS) {
    Serial.println(F("sensor triggered, still in cooldown"));
    return;
  }
  sensorLastFire = now;
  Serial.println(F("sensor triggered"));
  sendMessage("SENSOR ALERT");
}

void pumpSerial(Stream &s, String &buf, const char *tag) {
  while (s.available()) {
    char c = (char)s.read();
    if (c == '\n' || c == '\r') {
      if (buf.length() > 0) {
        Serial.print(F("<- "));
        Serial.print(tag);
        Serial.print(F(": "));
        Serial.println(buf);
        String line = buf;
        buf = "";
        handleLine(line);
      }
    } else if (buf.length() < 80) {
      buf += c;
    }
  }
}

// ---------------------------------------------------------------- setup
void setup() {
  pinMode(PIN_LASER, OUTPUT);
  pinMode(PIN_MIRROR, OUTPUT);
  pinMode(PIN_SENSOR, INPUT_PULLUP);

  Serial.begin(9600);
  nodeSerial.begin(9600);

  usbLine.reserve(96);
  nodeLine.reserve(96);

  sensorLastRead = digitalRead(PIN_SENSOR);
  sensorStable = sensorLastRead;

  laserWrite(true);
  delay(200);
  Serial.println(F("LaserLink TX ready"));
  printStatus();
  Serial.println(F("Commands: #BIT=n #ON #OFF #TEST #SENSOR=0/1 #STATUS"));
}

void loop() {
  pumpSerial(Serial, usbLine, "usb");
  pumpSerial(nodeSerial, nodeLine, "node");
  pollSensor();
}
